// Simplified protocol controller for CoDeSys WebVisu.
// Strategy:
// - Poll for current paint state via viewport event after each UI step.
// - Use only explicit lamp image IDs for status detection.
// - Reconnect automatically when consecutive empty renders exceed threshold.

import {
  config,
  uiCoordinates,
  lightSwitches,
  lightSwitchNames,
  lightSwitchPlcLabels,
  lightSwitchById,
  lightSwitchList,
} from './config';
import { IWebVisuController, LightStatus } from './controller-interface';
import { WebVisuProtocolClient } from './protocol/client';
import { buildViewportEvent } from './protocol/messages';
import {
  PaintCommand,
  ImageDrawCommand,
  extractDrawImages,
  extractTextLabels,
} from './protocol/paint-commands';
import { ProtocolDebugRenderer } from './protocol/debug-renderer';
import pino from 'pino';

const logger = pino({ name: 'protocol-controller' });

const LAMP_IMAGE_OFF = '__visualizationstyle.element-lamp-lamp1-yellow-off';
const LAMP_IMAGE_ON = '__visualizationstyle.element-lamp-lamp1-yellow-on';

export class ProtocolController implements IWebVisuController {
  private static readonly MIN_INITIAL_RENDER_TIMEOUT_MS = 3500;
  private static readonly DEFAULT_INITIAL_RENDER_TIMEOUT_MS = 7000;
  private static readonly MIN_INITIAL_RENDER_POLL_INTERVAL_MS = 50;
  private static readonly DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS = 200;
  private static readonly RECONNECT_EMPTY_THRESHOLD = 10;
  private static readonly RECONNECT_COOLDOWN_MS = 30_000;

  private client: WebVisuProtocolClient;
  private debugRenderer: ProtocolDebugRenderer | null = null;
  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;

  // Dropdown scroll tracking.
  private dropdownFirstVisible = 0;
  private dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;

  // Cache status by physical light name (normalised firstPress/secondPress text).
  // Keyed this way so that multiple switches controlling the same light share one entry.
  private lastStatusByLight = new Map<string, boolean>();

  // Reconnection state.
  private consecutiveEmptyRenders = 0;
  private lastReconnectAt = 0;

  constructor() {
    const protocolHost = config.protocol?.host || '192.168.1.10';
    const protocolPort = config.protocol?.port || 443;
    const debugRenderEnabled = config.protocol?.debugRenderEnabled ?? false;
    try {
      this.debugRenderer = new ProtocolDebugRenderer({
        // noDisk=true when debug render is not explicitly enabled — the renderer still
        // accumulates paint state in memory so getRenderedUiImage() always works.
        noDisk: !debugRenderEnabled,
        outputDir: config.protocol?.debugRenderDir || '/data/protocol-render-debug',
        width: config.browser.viewport.width,
        height: config.browser.viewport.height,
        maxFrames: config.protocol?.debugRenderMaxFrames ?? 400,
        minIntervalMs: config.protocol?.debugRenderMinIntervalMs ?? 0,
        includeEmptyFrames: config.protocol?.debugRenderIncludeEmptyFrames ?? true,
        ...(debugRenderEnabled
          ? {
            imageSource: {
              enabled: config.protocol?.debugRenderFetchImages ?? true,
              host: protocolHost,
              port: protocolPort,
              rejectUnauthorized: false,
              referer: `https://${protocolHost}/webvisu/webvisu.htm`,
              basePath: '/webvisu',
              timeoutMs: config.protocol?.debugRenderImageFetchTimeoutMs ?? 1200,
            },
          }
          : {}),
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize protocol debug renderer; rendered-ui endpoint will return empty');
      this.debugRenderer = null;
    }

    this.client = new WebVisuProtocolClient({
      host: protocolHost,
      port: protocolPort,
      requestTimeout: config.protocol?.requestTimeout || 5000,
      reconnectDelay: config.protocol?.reconnectDelay || 5000,
      postClickDelay: config.protocol?.postClickDelay || 50,
      postSelectDelay: config.protocol?.postSelectDelay || 100,
      debugHttp: config.protocol?.debugHttp || false,
      sessionTraceEnabled: config.protocol?.sessionTraceEnabled ?? true,
      sessionTraceDir: config.protocol?.sessionTraceDir || '/data/protocol-trace',
      logRawFrameData: config.protocol?.logRawFrameData || false,
      postDataInHeader: config.protocol?.postDataInHeader || 'auto',
      deviceUsername: config.protocol?.deviceUsername || '',
      devicePassword: config.protocol?.devicePassword || '',
      // Always feed paint frames into the renderer so the surface state stays current.
      onPaintFrame: this.debugRenderer
        ? (frame) => {
          this.debugRenderer?.record(frame);
        }
        : undefined,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Initializing protocol controller...');
    await this.client.connect();

    // Wait until initial screen has visible paint data before any tab click.
    await this.waitForInitialRenderReady();

    logger.info('Navigating to Napit tab...');
    await this.navigateToNapitTab();

    this.initialized = true;
    logger.info('Protocol controller initialized successfully');
  }

  async close(): Promise<void> {
    await this.client.disconnect();
    if (this.debugRenderer) {
      try {
        await this.debugRenderer.close();
      } catch (error) {
        logger.warn({ error }, 'Failed to close protocol debug renderer cleanly');
      }
    }
    this.initialized = false;
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    this.lastStatusByLight.clear();
    this.consecutiveEmptyRenders = 0;
    logger.info('Protocol controller closed');
  }

  resetDropdownState(): void {
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    logger.info('Dropdown state reset to top');
  }

  getPendingOperationCount(): number {
    return this.pendingOperations;
  }

  async navigateToTab(tabName: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doNavigateToTab(tabName);
    });
  }

  private async doNavigateToTab(tabName: string): Promise<void> {
    const coords = (uiCoordinates.tabs as Record<string, { x: number; y: number }>)[tabName];
    if (!coords) {
      throw new Error(`Unknown tab: ${tabName}`);
    }

    if (tabName === 'napit') {
      await this.navigateToNapitTab();
      return;
    }

    logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
    await this.client.clickAndCollect(coords.x, coords.y);
    await this.pollPaintCommands(`navigate:${tabName}`);
  }

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string): Promise<{ allCommands: PaintCommand[]; postSelectionCommands: PaintCommand[] }> {
    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    const maxAttempts = config.protocol?.maxSelectionAttempts ?? 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doSelectLightSwitchOnce(lightId, index);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn({ err: lastError, lightId, attempt, maxAttempts }, 'Selection attempt failed, retrying without reconnect');
        // Reset dropdown state so the next attempt discovers the scroll
        // position from paint data rather than using stale tracked state.
        this.resetDropdownState();
      }
    }

    throw lastError!;
  }

  private async doSelectLightSwitchOnce(lightId: string, index: number): Promise<{ allCommands: PaintCommand[]; postSelectionCommands: PaintCommand[] }> {
    logger.info(`Selecting light switch: ${lightId} (index: ${index})`);

    // Step 1: Open dropdown with verification.
    // The dropdown opens on mouseDown. pressAndCollect captures mouseDown + mouseUp responses.
    // Assumption: dropdown is closed at operation start (operations are serialized).
    const allDropdownCommands: PaintCommand[] = [];

    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();

    const dropdownOpenTimeoutMs = config.protocol?.dropdownOpenTimeoutMs ?? 6000;
    const maxOpenAttempts = 3;
    let dropdownOpened = false;
    // Commands accumulated within the current open attempt. Used for
    // isDropdownOpen (which needs accumulated data since the dropdown content
    // arrives across multiple render cycles) and for snapshot/sync (safe
    // because all commands within one attempt share the same scroll state).
    let attemptCommands: PaintCommand[] = [];

    for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
      attemptCommands = [];
      const clickCommands = await this.client.pressAndCollect(arrowX, arrowY);
      attemptCommands.push(...clickCommands);
      allDropdownCommands.push(...clickCommands);
      logger.info({
        openAttempt,
        commandCount: clickCommands.length,
        labelCount: extractTextLabels(clickCommands).length,
      }, 'Dropdown open: pressAndCollect response');

      if (this.isDropdownOpen(attemptCommands)) {
        dropdownOpened = true;
        break;
      }

      // Poll with heartbeat until dropdown content arrives or timeout.
      // The dropdown takes multiple render cycles to open fully — accumulate
      // all commands and check the running total against isDropdownOpen.
      const deadline = Date.now() + dropdownOpenTimeoutMs;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.pollPaintCommands(`dropdown-open-verify:${openAttempt}:${poll}:${lightId}`);
        attemptCommands.push(...cmds);
        allDropdownCommands.push(...cmds);
        if (this.isDropdownOpen(attemptCommands)) {
          dropdownOpened = true;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(200, remaining));
        }
      }

      if (dropdownOpened) break;

      // Dropdown didn't open — click arrow again to close (in case it partially opened), then retry.
      if (openAttempt < maxOpenAttempts) {
        logger.warn({ lightId, openAttempt }, 'Dropdown not verified as open; closing and retrying');
        await this.client.pressAndCollect(arrowX, arrowY);
      }
    }

    if (!dropdownOpened) {
      throw new Error(`Dropdown failed to open after ${maxOpenAttempts} attempts for light=${lightId}`);
    }

    // Step 2: Dropdown is open — sync scroll state from this attempt's commands.
    // All commands within one attempt share the same scroll position, so
    // accumulated data is safe for resolving the snapshot.
    this.syncDropdownStateFromCommands(attemptCommands, 'on-open');
    let latestSnapshot = this.resolveDropdownSnapshot(attemptCommands);
    logger.info({
      hasSnapshot: !!latestSnapshot,
      firstVisible: latestSnapshot?.firstVisible,
      labelCount: latestSnapshot?.labels.length,
      labels: latestSnapshot?.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top })),
    }, 'Initial dropdown snapshot');

    const stepCommands: PaintCommand[] = [...allDropdownCommands];

    // Step 3: Scroll to bring the target into view.
    const targetFirstVisible = this.getTargetFirstVisible(index, maxFirstVisible);
    const scrollbarX = scrollbarConfig.x;

    // 3b: Scroll loop — arrow clicks for small deltas, drag for large ones.
    const ARROW_THRESHOLD = 5;
    const dragStartHoldMs = config.protocol?.dragStartHoldMs ?? 60;
    const maxScrollAttempts = 6;

    for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts && !this.isDropdownIndexVisible(index); scrollAttempt++) {
      const delta = targetFirstVisible - this.dropdownFirstVisible;
      const absDelta = Math.abs(delta);

      if (absDelta <= ARROW_THRESHOLD) {
        // Arrow-click path: click the up or down arrow button |delta| times.
        // Each click scrolls by exactly 1 item. Works reliably for both
        // forward and backward scrolling without needing close/reopen.
        const arrowBtn = delta > 0 ? scrollbarConfig.arrowDown : scrollbarConfig.arrowUp;
        const arrowAllCmds: PaintCommand[] = [];

        logger.info({
          lightId, index, scrollAttempt, delta, absDelta,
          direction: delta > 0 ? 'down' : 'up',
          arrowX: arrowBtn.x, arrowY: arrowBtn.y,
        }, 'Arrow-click scroll');

        for (let i = 0; i < absDelta; i++) {
          const clickCmds = await this.client.pressAndCollect(arrowBtn.x, arrowBtn.y);
          arrowAllCmds.push(...clickCmds);
          stepCommands.push(...clickCmds);
          if (i < absDelta - 1) await this.delay(150);
        }

        // Poll for any remaining paint updates after the last arrow click.
        await this.delay(150);
        const arrowPollCmds = await this.pollPaintCommands(`arrow-scroll:${scrollAttempt}`);
        arrowAllCmds.push(...arrowPollCmds);
        stepCommands.push(...arrowPollCmds);

        // Sync state from the arrow-click responses.
        const snapshot = this.resolveDropdownSnapshot(arrowAllCmds);
        if (snapshot) {
          this.dropdownFirstVisible = snapshot.firstVisible;
          this.dropdownHandleCenterY = snapshot.handleCenterY;
          latestSnapshot = snapshot;
          logger.info({ scrollAttempt, firstVisible: snapshot.firstVisible }, 'Arrow-scroll snapshot synced');
        } else {
          // Trust arithmetic: each arrow click moves by 1
          this.dropdownFirstVisible += delta;
          logger.info({ scrollAttempt, firstVisible: this.dropdownFirstVisible }, 'Arrow-scroll: no snapshot, trusting arithmetic');
        }
        continue;  // Re-check visibility at top of loop
      }

      // Drag path for large deltas (both forward and backward).
      // Uses a drag → mouseUp → close/reopen loop. Re-dragging from the actual
      // position converges quickly (each retry has a shorter distance).
      const currentHandleY = Math.round(this.dropdownHandleCenterY);
      const targetHandleY = Math.round(this.getDropdownScrollY(targetFirstVisible));

      logger.info({
        lightId, index, scrollAttempt,
        currentFirstVisible: this.dropdownFirstVisible, targetFirstVisible,
        delta, currentHandleY, targetHandleY,
      }, 'Dragging scrollbar thumb');

      await this.client.mouseDown(scrollbarX, currentHandleY);
      await this.delay(dragStartHoldMs);

      const dragCmds = await this.client.mouseMoveAndCollect(scrollbarX, targetHandleY);
      stepCommands.push(...dragCmds);

      // Let the PLC fully settle the scrollbar at the target position before
      // releasing the mouse button. Without this delay the mouseUp can arrive
      // before the PLC has finished processing the mouseMove.
      await this.delay(300);

      // Release the scrollbar handle.
      const dragUpCmds = await this.client.mouseUpAndCollect(scrollbarX, targetHandleY);
      stepCommands.push(...dragUpCmds);

      // After scrollbar drag + mouseUp, the PLC's rendered labels and click
      // targets can be out of sync. Close and reopen the dropdown to force
      // a full resync of both layers.
      await this.delay(200);

      // Close: click the dropdown arrow.
      const closeCmds = await this.client.pressAndCollect(arrowX, arrowY);
      stepCommands.push(...closeCmds);
      await this.delay(300);

      // Reopen: click the dropdown arrow again.
      const reopenAccum: PaintCommand[] = [];
      const reopenCmds = await this.client.pressAndCollect(arrowX, arrowY);
      reopenAccum.push(...reopenCmds);
      stepCommands.push(...reopenCmds);

      // Wait for the dropdown to fully open (5 text labels).
      if (!this.isDropdownOpen(reopenAccum)) {
        const reopenDeadline = Date.now() + 4000;
        while (Date.now() < reopenDeadline) {
          const cmds = await this.pollPaintCommands(`reopen:${scrollAttempt}`);
          reopenAccum.push(...cmds);
          stepCommands.push(...cmds);
          if (this.isDropdownOpen(reopenAccum)) break;
          const remaining = reopenDeadline - Date.now();
          if (remaining > 0) await this.delay(Math.min(150, remaining));
        }
      }

      // Sync actual scroll position from the freshly reopened dropdown.
      const reopenSnapshot = this.resolveDropdownSnapshot(reopenAccum);
      if (reopenSnapshot) {
        this.dropdownFirstVisible = reopenSnapshot.firstVisible;
        this.dropdownHandleCenterY = reopenSnapshot.handleCenterY;
        latestSnapshot = reopenSnapshot;
        logger.info({ scrollAttempt, firstVisible: reopenSnapshot.firstVisible, handleY: Math.round(reopenSnapshot.handleCenterY) }, 'Post-drag reopen snapshot synced');
      } else {
        this.dropdownFirstVisible = targetFirstVisible;
      }

      if (this.isDropdownIndexVisible(index)) {
        logger.info({ scrollAttempt, firstVisible: this.dropdownFirstVisible, index }, 'Target visible after scroll');
      } else {
        logger.warn({ scrollAttempt, firstVisible: this.dropdownFirstVisible, targetFirstVisible, index }, 'Target not visible after reopen — will re-drag');
      }
    }

    if (!this.isDropdownIndexVisible(index)) {
      throw new Error(`Scroll failed after ${maxScrollAttempts} drag attempts: light=${lightId}, index=${index}, firstVisible=${this.dropdownFirstVisible}, target=${targetFirstVisible}`);
    }

    // Step 4: Resolve click coordinates from the latest snapshot.
    // Use the label positions already captured from the dropdown open or
    // post-drag reopen response. If the target label isn't in the snapshot,
    // poll once more and combine with accumulated commands.
    const positionInView = index - this.dropdownFirstVisible;
    const visibleItems = dropdownConfig.visibleItems;
    if (positionInView < 0 || positionInView >= visibleItems) {
      throw new Error(`Dropdown row out of view after scroll: light=${lightId}, position=${positionInView}`);
    }

    let itemY: number;
    let clickSource: string;

    // Try to find the target label in the latest snapshot.
    // Do NOT send additional viewport events here — doing so while the dropdown
    // is open can cause the PLC to close it before we click.
    const targetLabel = latestSnapshot?.labels.find(l => l.index === index) ?? null;

    if (targetLabel) {
      // Click at the vertical center of the text label. The PLC renders text
      // in the upper portion of each item row — the text center is the most
      // reliable click target.
      itemY = Math.round((targetLabel.top + targetLabel.bottom) / 2);
      clickSource = 'snapshot-label-center';
    } else {
      // Fallback: compute from the item grid with a 1/3-height offset
      // (text sits in the upper portion of each row).
      itemY = dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight) + Math.round(dropdownConfig.itemHeight / 3);
      clickSource = 'computed-row';
    }

    logger.info({
      lightId,
      index,
      positionInView,
      clickY: itemY,
      clickSource,
    }, 'Selecting dropdown item');

    // Step 5: Click item → mouseDown selects the item and closes the dropdown.
    // Use mouseDownAndCollect to capture the lamp icon redraws that the PLC
    // sends immediately on selection (these are lost with plain mouseDown).
    // After a settle delay, mouseUp goes to the dropdown arrow (safe area) to
    // avoid hitting Ohjaus/panel buttons.
    const itemClickCmds = await this.client.mouseDownAndCollect(dropdownConfig.itemX, itemY);
    const selectionSettleMs = config.protocol?.selectionSettleDelayMs ?? 200;
    await this.delay(selectionSettleMs);
    await this.client.mouseUp(arrowX, arrowY);

    // Poll for the header label to appear. The PLC may need several render
    // cycles after mouseUp to redraw the header with the selected item.
    // Start with the commands captured from the item click mouseDown.
    const selectCommands: PaintCommand[] = [...itemClickCmds];
    const headerPollTimeoutMs = 3000;
    const headerPollDeadline = Date.now() + headerPollTimeoutMs;
    let headerLabel: string | null = null;
    let headerPolls = 0;
    // Check if the header label is already in the mouseDown response.
    headerLabel = this.extractDropdownHeaderLabel(selectCommands);
    while (headerLabel === null && Date.now() < headerPollDeadline) {
      headerPolls++;
      const cmds = await this.pollPaintCommands(`select-settle:${headerPolls}:${lightId}`);
      selectCommands.push(...cmds);
      headerLabel = this.extractDropdownHeaderLabel(selectCommands);
      if (headerLabel !== null) break;
      const remaining = headerPollDeadline - Date.now();
      if (remaining > 0) await this.delay(Math.min(150, remaining));
    }

    // After finding the header, do one more poll to capture any remaining
    // lamp icon redraws that arrive in a separate render cycle.
    if (headerLabel !== null) {
      const extraCmds = await this.pollPaintCommands(`select-extra:${lightId}`);
      selectCommands.push(...extraCmds);
    }
    stepCommands.push(...selectCommands);

    // Step 6: Verify the dropdown header now shows the expected item.
    // If mismatch — opportunistically cache status for the switch that WAS selected,
    // then throw to trigger reconnect+retry.
    if (headerLabel !== null) {
      const expectedLabel = lightSwitchPlcLabels[index];
      if (this.normalizeVisuText(headerLabel) !== this.normalizeVisuText(expectedLabel)) {
        this.opportunisticallyCacheStatus(selectCommands, headerLabel);
      }
    }
    this.verifyDropdownHeader(selectCommands, lightId, index);

    logger.info(`Light switch ${lightId} selected`);
    return { allCommands: stepCommands, postSelectionCommands: selectCommands };
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

      const togglePostClickDelayMs = Math.max(0, config.protocol?.togglePostClickDelayMs ?? 500);

      const firstButton = uiCoordinates.lightSwitches.ohjausButton;
      const lightSwitchUi = uiCoordinates.lightSwitches as typeof uiCoordinates.lightSwitches & {
        ohjausButton2?: { x: number; y: number };
      };
      const configuredSecondButton = lightSwitchUi.ohjausButton2;
      const secondButton = configuredSecondButton ?? { x: firstButton.x, y: firstButton.y + 30 };
      const targetButton = functionNumber === 2 ? secondButton : firstButton;
      const buttonSource = functionNumber === 2
        ? (configuredSecondButton ? 'configured-second' : 'estimated-second')
        : 'primary';
      if (functionNumber === 2 && !configuredSecondButton) {
        logger.warn({ lightId, x: targetButton.x, y: targetButton.y }, 'Function 2 toggle using estimated second button coordinate');
      }

      logger.info({
        lightId,
        functionNumber,
        x: targetButton.x,
        y: targetButton.y,
        buttonSource,
      }, 'Dispatching toggle button click');

      const clickCommands = await this.client.pressAndCollect(targetButton.x, targetButton.y);

      if (togglePostClickDelayMs > 0) {
        await this.delay(togglePostClickDelayMs);
      }

      const postRenderPolls = config.protocol?.togglePostRenderPolls ?? 2;
      const postRenderPollDelayMs = config.protocol?.togglePostRenderPollDelayMs ?? 0;
      let totalPostCommands = 0;
      for (let i = 0; i < postRenderPolls; i++) {
        if (i > 0 && postRenderPollDelayMs > 0) await this.delay(postRenderPollDelayMs);
        const postCommands = await this.pollPaintCommands(`toggle-post:${lightId}:${i}`);
        totalPostCommands += postCommands.length;
      }

      logger.info({
        lightId,
        functionNumber,
        clickCommandCount: clickCommands.length,
        postRenderPolls,
        totalPostCommands,
      }, 'Toggle render settle complete');

      logger.info(`Light ${lightId} function ${functionNumber} toggled`);
    });
  }

  async getLightStatus(lightId: string): Promise<LightStatus> {
    return this.queueOperation(async () => {
      this.ensureInitialized();

      const index = lightSwitches[lightId];
      if (index === undefined) {
        throw new Error(`Unknown light switch: ${lightId}`);
      }

      const switchInfo = lightSwitchById[lightId];
      const firstPressLightId = (switchInfo as any)?.firstPressLightId as string | undefined;
      const secondPressLightId = (switchInfo as any)?.secondPressLightId as string | undefined;
      const hasDualFunction = !!secondPressLightId;
      const switchName = lightSwitchNames[index] || lightId;

      const { postSelectionCommands } = await this.doSelectLightSwitch(lightId);
      const selectionSettleDelayMs = config.protocol?.selectionSettleDelayMs ?? 200;
      if (selectionSettleDelayMs > 0) {
        await this.delay(selectionSettleDelayMs);
      }
      const statusCommands = await this.pollPaintCommands(`status:${lightId}`);

      // Only use post-selection commands + status poll for lamp resolution.
      // Using the full command history (including drag/reopen phases) would
      // pick up stale lamp images from before the correct item was selected.
      const statusRelevantCommands = [...postSelectionCommands, ...statusCommands];

      const indicatorImages = this.resolveIndicatorImages(statusRelevantCommands);

      // Use physical light IDs as cache keys so that multiple switches controlling
      // the same light share one entry (cache hits propagate between switches).
      const key1 = firstPressLightId ?? `${lightId}:1`;
      const key2 = secondPressLightId ?? `${lightId}:2`;

      let isOn1 = this.resolveLampStatus(indicatorImages.indicator1);
      if (isOn1 === null) {
        const cached = this.lastStatusByLight.get(key1);
        if (cached !== undefined) {
          isOn1 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 1 (light: ${key1}), using cached=${cached}`);
        } else {
          isOn1 = false;
          logger.warn(`No lamp image found for ${lightId} indicator 1 (light: ${key1}), defaulting to OFF`);
        }
      }
      this.lastStatusByLight.set(key1, isOn1);
      logger.info(`Status indicator 1 for ${lightId} (light: ${key1}): images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator1))}, isOn=${isOn1}`);

      let resolved2 = this.resolveLampStatus(indicatorImages.indicator2);
      if (resolved2 === null) {
        const cached = this.lastStatusByLight.get(key2);
        if (cached !== undefined) {
          resolved2 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 2 (light: ${key2}), using cached=${cached}`);
        } else {
          resolved2 = false;
        }
      }
      this.lastStatusByLight.set(key2, resolved2);
      logger.info(`Status indicator 2 for ${lightId} (light: ${key2}): images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator2))}, isOn=${resolved2}`);

      // indicator3 has no light ID mapping — cache under switch-specific key
      let resolved3 = this.resolveLampStatus(indicatorImages.indicator3);
      if (resolved3 === null) {
        const cached = this.lastStatusByLight.get(`${lightId}:3`);
        if (cached !== undefined) {
          resolved3 = cached;
        } else {
          resolved3 = false;
        }
      }
      this.lastStatusByLight.set(`${lightId}:3`, resolved3);

      let isOn2: boolean | undefined;
      if (hasDualFunction) {
        isOn2 = resolved2;
      }

      return {
        id: lightId,
        name: switchName,
        isOn: isOn1,
        ...(isOn2 !== undefined ? { isOn2 } : {}),
      };
    });
  }

  async getAllLights(): Promise<LightStatus[]> {
    const lights: LightStatus[] = [];

    for (const [id, index] of Object.entries(lightSwitches)) {
      try {
        const status = await this.getLightStatus(id);
        lights.push(status);
      } catch (error) {
        logger.error(`Error getting status for light ${id}: ${error}`);
        lights.push({
          id,
          name: lightSwitchNames[index] || id,
          isOn: false,
        });
      }
    }

    return lights;
  }

  async takeScreenshot(): Promise<Buffer> {
    if (!this.debugRenderer) {
      logger.warn('takeScreenshot() requires PROTOCOL_DEBUG_RENDER=true in protocol mode');
      return Buffer.alloc(0);
    }

    let latest = this.debugRenderer.getLatestPng();

    if (!this.initialized) {
      logger.warn('takeScreenshot() requested before protocol controller initialization');
      return latest ?? Buffer.alloc(0);
    }

    try {
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const commands = await this.pollPaintCommands(`manual-screenshot:${attempt}`);
        const rendered = await this.debugRenderer.renderPreview(commands);
        latest = rendered;

        if (commands.length > 0) {
          return rendered;
        }

      }
      return latest ?? Buffer.alloc(0);
    } catch (error) {
      logger.warn({ error }, 'Failed to generate protocol debug screenshot');
      return latest ?? Buffer.alloc(0);
    }
  }

  async getRenderedUiImage(): Promise<Buffer | null> {
    if (!this.debugRenderer) {
      return null;
    }
    // renderPreview([]) renders the current accumulated surface state without
    // applying any new commands. Always returns a PNG even in no-disk mode.
    return this.debugRenderer.renderPreview([]);
  }

  async isConnected(): Promise<boolean> {
    return this.client.isConnected();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Protocol controller not initialized. Call initialize() first.');
    }
  }

  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    try {
      const result = this.operationQueue.then(operation);
      this.operationQueue = result.catch(() => {});
      return await result;
    } finally {
      this.pendingOperations--;
    }
  }

  private normalizeImageId(imageId: string): string {
    return imageId.toLowerCase().replace(/\x00+$/g, '').trim();
  }

  private isLampStatusImageId(imageId: string): boolean {
    const normalized = this.normalizeImageId(imageId);
    return normalized === LAMP_IMAGE_OFF || normalized === LAMP_IMAGE_ON;
  }

  private normalizeVisuText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\x00+$/g, '')
      .replace(/\s+/g, '')  // Collapse all whitespace — the PLC often strips spaces in text rendering
      .trim();
  }

  private async waitForInitialRenderReady(): Promise<PaintCommand[]> {
    const timeoutMs = Math.max(
      ProtocolController.MIN_INITIAL_RENDER_TIMEOUT_MS,
      config.protocol?.initialRenderTimeoutMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(
      ProtocolController.MIN_INITIAL_RENDER_POLL_INTERVAL_MS,
      config.protocol?.initialRenderPollIntervalMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS,
    );
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const accumulated: PaintCommand[] = [];
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt++;
      const commands = await this.pollPaintCommands(`initial-render:${attempt}`);
      accumulated.push(...commands);
      const images = extractDrawImages(accumulated);
      const labels = extractTextLabels(accumulated);
      const topLabels = labels.filter((label) => label.top <= 55 && label.bottom <= 75);
      logger.info({
        reason: 'initialize',
        attempt,
        imageCount: images.length,
        topLabelCount: topLabels.length,
      }, 'Initial render probe');

      if (images.length > 0 || topLabels.length > 0) {
        logger.info({ attempts: attempt, elapsedMs: Date.now() - startedAt }, 'Initial render ready');
        return accumulated;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await this.delay(Math.min(pollIntervalMs, remainingMs));
    }

    logger.warn({
      attempts: attempt,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
    }, 'Initial render did not become ready; continuing');
    return accumulated;
  }

  private getDropdownMaxFirstVisible(): number {
    return Math.max(0, lightSwitchList.length - uiCoordinates.lightSwitches.dropdownList.visibleItems);
  }

  private isDropdownIndexVisible(index: number): boolean {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    return index >= this.dropdownFirstVisible && index < this.dropdownFirstVisible + visibleItems;
  }

  private getTargetFirstVisible(index: number, maxFirstVisible: number): number {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    // Center the target in the visible range. This gives ±2 positions of tolerance
    // for the reopen overshoot (the PLC often jumps 1-2 positions when the dropdown
    // is closed and reopened after a scrollbar drag).
    const centerOffset = Math.floor(visibleItems / 2);
    const preferredFirstVisible = Math.min(Math.max(0, index - centerOffset), maxFirstVisible);
    const minimumFirstVisible = Math.max(0, index - (visibleItems - 1));
    return Math.max(minimumFirstVisible, Math.min(preferredFirstVisible, maxFirstVisible));
  }

  private extractDropdownHeaderLabel(commands: PaintCommand[]): string | null {
    const { dropdownList, dropdownArrow } = uiCoordinates.lightSwitches;
    const labels = extractTextLabels(commands);
    // Header area: above the list (bottom < firstItemY), below the tab bar (top > 50),
    // and within the dropdown width (left < arrow button X).
    const headerLabels = labels.filter(
      (label) =>
        label.bottom < dropdownList.firstItemY &&
        label.top > 50 &&
        label.left < dropdownArrow.x
    );
    if (headerLabels.length === 0) return null;
    // Return the last (most recently drawn) label in case of duplicates.
    return headerLabels[headerLabels.length - 1].text;
  }

  private verifyDropdownHeader(commands: PaintCommand[], lightId: string, index: number): void {
    const expectedPlcLabel = lightSwitchPlcLabels[index];
    const expectedName = lightSwitchNames[index];
    const headerLabel = this.extractDropdownHeaderLabel(commands);
    if (headerLabel === null) {
      logger.warn({ lightId, index, expectedPlcLabel, expectedName }, 'Header text not found in selection commands; cannot verify');
      return;
    }
    const normalizedHeader = this.normalizeVisuText(headerLabel);
    // Accept either the plcLabel or the system name — the PLC may show either in the header.
    const matchesPlcLabel = expectedPlcLabel && this.normalizeVisuText(expectedPlcLabel) === normalizedHeader;
    const matchesName = expectedName && this.normalizeVisuText(expectedName) === normalizedHeader;
    if (!matchesPlcLabel && !matchesName) {
      throw new Error(
        `Header verification failed: expected="${expectedPlcLabel}" or "${expectedName}", got="${headerLabel}", light=${lightId}, index=${index}`
      );
    }
    logger.info({ lightId, index, headerText: headerLabel }, 'Header verification passed');
  }

  private opportunisticallyCacheStatus(commands: PaintCommand[], actualHeaderLabel: string): void {
    const actualIndex = this.resolveLightIndexFromLabel(actualHeaderLabel);
    if (actualIndex === null) {
      logger.warn({ actualHeaderLabel }, 'Opportunistic cache: could not resolve switch index from header label');
      return;
    }

    const sw = lightSwitchList.find(s => s.index === actualIndex);
    if (!sw) {
      logger.warn({ actualIndex, actualHeaderLabel }, 'Opportunistic cache: switch not found in list');
      return;
    }

    const indicatorImages = this.resolveIndicatorImages(commands);
    const firstPressLightId = (sw as any).firstPressLightId as string | undefined;
    const secondPressLightId = (sw as any).secondPressLightId as string | undefined;

    const key1 = firstPressLightId ?? `${sw.id}:1`;
    const isOn1 = this.resolveLampStatus(indicatorImages.indicator1);
    if (isOn1 !== null) this.lastStatusByLight.set(key1, isOn1);

    const key2 = secondPressLightId ?? `${sw.id}:2`;
    const isOn2 = secondPressLightId ? this.resolveLampStatus(indicatorImages.indicator2) : null;
    if (isOn2 !== null) this.lastStatusByLight.set(key2, isOn2);

    logger.info({
      switchId: sw.id,
      actualHeaderLabel,
      indicator1: { key: key1, isOn: isOn1 },
      ...(secondPressLightId ? { indicator2: { key: key2, isOn: isOn2 } } : {}),
    }, 'Opportunistically cached status for accidentally-selected switch');
  }

  private getDropdownScrollY(firstVisible: number, maxFirstVisible: number = this.getDropdownMaxFirstVisible()): number {
    const topY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;
    const bottomY = uiCoordinates.lightSwitches.scrollbar.thumbRange.bottomY;
    if (maxFirstVisible <= 0 || firstVisible <= 0) return topY;
    if (firstVisible >= maxFirstVisible) return bottomY;
    return topY + (((bottomY - topY) * firstVisible) / maxFirstVisible);
  }

  private resolveLightIndexFromLabel(text: string): number | null {
    const normalized = this.normalizeVisuText(text);
    if (!normalized) {
      return null;
    }
    for (const light of lightSwitchList) {
      if (this.normalizeVisuText(light.name) === normalized) return light.index;
      const plcLabel = (light as { plcLabel?: string }).plcLabel;
      if (plcLabel && this.normalizeVisuText(plcLabel) === normalized) return light.index;
    }
    return null;
  }

  private resolveDropdownSnapshot(commands: PaintCommand[]): {
    firstVisible: number;
    handleCenterY: number;
    labels: Array<{ text: string; index: number; top: number; bottom: number; row: number }>;
  } | null {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const labels = extractTextLabels(commands);
    // Use the same tight Y bounds as isDropdownOpen to avoid header/panel label contamination.
    const listTop = dropdown.firstItemY;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems);
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();

    const matched = labels
      .filter((label) => label.top >= listTop && label.bottom <= listBottom)
      .filter((label) => label.right >= listLeft && label.left <= listRight)
      .map((label) => {
        const index = this.resolveLightIndexFromLabel(label.text);
        if (index === null) return null;
        const centerY = Math.round((label.top + label.bottom) / 2);
        // Use Math.floor: text centers are in the upper portion of each row,
        // so floor correctly assigns them (round could overshoot at 0.5 boundary).
        const row = Math.floor((centerY - dropdown.firstItemY) / dropdown.itemHeight);
        return {
          text: label.text,
          index,
          top: label.top,
          bottom: label.bottom,
          row,
          candidate: index - row,
        };
      })
      .filter((item): item is {
        text: string;
        index: number;
        top: number;
        bottom: number;
        row: number;
        candidate: number;
      } => !!item)
      .filter((item) => item.row >= 0 && item.row < dropdown.visibleItems)
      .filter((item) => item.candidate >= 0 && item.candidate <= maxFirstVisible)
      .sort((a, b) => a.top - b.top || a.index - b.index);

    if (matched.length === 0) {
      logger.debug({ totalLabels: labels.length, listTop, listBottom, listLeft, listRight }, 'resolveDropdownSnapshot: no matched labels');
      return null;
    }

    const groups = new Map<number, typeof matched>();
    for (const item of matched) {
      const existing = groups.get(item.candidate);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.candidate, [item]);
      }
    }

    const ranked = [...groups.entries()]
      .map(([candidate, items]) => {
        const rows = new Set(items.map((item) => item.row));
        return {
          candidate,
          items,
          distinctRows: rows.size,
        };
      })
      .sort((a, b) => {
        if (b.distinctRows !== a.distinctRows) return b.distinctRows - a.distinctRows;
        if (b.items.length !== a.items.length) return b.items.length - a.items.length;
        return Math.abs(a.candidate - this.dropdownFirstVisible) - Math.abs(b.candidate - this.dropdownFirstVisible);
      });

    const best = ranked[0];
    if (!best || best.distinctRows < 2) {
      logger.debug({
        matchedCount: matched.length,
        matched: matched.map(m => ({ text: m.text, index: m.index, row: m.row, top: m.top, candidate: m.candidate })),
        bestCandidate: best?.candidate,
        bestDistinctRows: best?.distinctRows,
        bestItemCount: best?.items.length,
      }, 'resolveDropdownSnapshot: insufficient distinct rows');
      return null;
    }

    const firstVisible = best.candidate;
    const rowMap = new Map<number, (typeof matched)[number]>();
    for (const item of best.items) {
      const expectedIndex = firstVisible + item.row;
      const existing = rowMap.get(item.row);
      if (!existing) {
        rowMap.set(item.row, item);
        continue;
      }
      const existingDelta = Math.abs(existing.index - expectedIndex);
      const candidateDelta = Math.abs(item.index - expectedIndex);
      if (candidateDelta < existingDelta || (candidateDelta === existingDelta && item.top > existing.top)) {
        rowMap.set(item.row, item);
      }
    }

    const labelsForSnapshot = [...rowMap.values()]
      .sort((a, b) => a.row - b.row || a.top - b.top || a.index - b.index)
      .map((item) => ({
        text: item.text,
        index: item.index,
        top: item.top,
        bottom: item.bottom,
        row: item.row,
      }));

    return {
      firstVisible,
      handleCenterY: this.getDropdownScrollY(firstVisible, maxFirstVisible),
      labels: labelsForSnapshot,
    };
  }

  private syncDropdownStateFromCommands(commands: PaintCommand[], reason: string): boolean {
    const snapshot = this.resolveDropdownSnapshot(commands);
    if (!snapshot) {
      return false;
    }

    const previousFirstVisible = this.dropdownFirstVisible;
    this.dropdownFirstVisible = snapshot.firstVisible;
    this.dropdownHandleCenterY = snapshot.handleCenterY;

    if (previousFirstVisible !== snapshot.firstVisible) {
      const handleTop = Math.round(snapshot.handleCenterY - 4);
      const handleBottom = handleTop + 9;
      logger.info({
        reason,
        firstVisible: snapshot.firstVisible,
        handleCenterY: Math.round(snapshot.handleCenterY),
        handleTopY: handleTop,
        handleBottomY: handleBottom,
        labels: snapshot.labels.slice(0, 5),
      }, 'Detected dropdown scrollbar handle');
    }
    return true;
  }

  private collectLampImages(commands: PaintCommand[]): ImageDrawCommand[] {
    return extractDrawImages(commands)
      .filter((image) => this.isLampStatusImageId(image.imageId))
      .slice(-36);
  }

  private isPlausibleLampGeometry(image: ImageDrawCommand): boolean {
    const viewportWidth = config.browser.viewport.width;
    const viewportHeight = config.browser.viewport.height;
    return image.width > 0 &&
      image.height > 0 &&
      image.width <= 160 &&
      image.height <= 160 &&
      image.x >= -120 &&
      image.y >= -120 &&
      image.x <= viewportWidth + 120 &&
      image.y <= viewportHeight + 120;
  }

  private imageCenterDistance(image: ImageDrawCommand, at: { x: number; y: number }): number {
    const centerX = image.x + (image.width / 2);
    const centerY = image.y + (image.height / 2);
    const dx = centerX - at.x;
    const dy = centerY - at.y;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  private resolveIndicatorImages(commands: PaintCommand[]): {
    indicator1: ImageDrawCommand[];
    indicator2: ImageDrawCommand[];
    indicator3: ImageDrawCommand[];
  } {
    const lamps = this.collectLampImages(commands);
    const indexed = lamps.map((image, index) => ({ image, index }));
    const used = new Set<number>();

    const indicators = [
      { key: 'indicator1' as const, at: uiCoordinates.lightSwitches.statusIndicator },
      { key: 'indicator2' as const, at: uiCoordinates.lightSwitches.statusIndicator2 },
      { key: 'indicator3' as const, at: uiCoordinates.lightSwitches.statusIndicator3 },
    ];

    const resolved: {
      indicator1: ImageDrawCommand[];
      indicator2: ImageDrawCommand[];
      indicator3: ImageDrawCommand[];
    } = {
      indicator1: [],
      indicator2: [],
      indicator3: [],
    };

    for (const indicator of indicators) {
      const candidate = indexed
        .filter((entry) => !used.has(entry.index))
        .filter((entry) => this.isPlausibleLampGeometry(entry.image))
        .map((entry) => ({
          entry,
          distance: this.imageCenterDistance(entry.image, indicator.at),
        }))
        .filter((entry) => entry.distance <= 24)
        .sort((a, b) => a.distance - b.distance || b.entry.index - a.entry.index)[0];

      if (candidate) {
        used.add(candidate.entry.index);
        resolved[indicator.key] = [candidate.entry.image];
      }
    }

    const unresolved = indicators.filter((indicator) => resolved[indicator.key].length === 0);
    const remaining = indexed
      .filter((entry) => !used.has(entry.index))
      .filter((entry) => this.isPlausibleLampGeometry(entry.image));
    if (unresolved.length > 0 && remaining.length > 0) {
      const ordered = remaining.length === unresolved.length
        ? [...remaining].sort((a, b) => a.index - b.index)
        : [...remaining].sort((a, b) => b.index - a.index);
      const count = Math.min(unresolved.length, ordered.length);
      for (let i = 0; i < count; i++) {
        resolved[unresolved[i].key] = [ordered[i].image];
      }
    }

    return resolved;
  }

  private formatImageSummary(images: ImageDrawCommand[]): Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    return images.map((image) => ({
      id: image.imageId,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
    }));
  }

  private resolveLampStatus(images: ImageDrawCommand[]): boolean | null {
    if (images.length === 0) return null;
    for (let i = images.length - 1; i >= 0; i--) {
      const id = this.normalizeImageId(images[i].imageId);
      if (id === LAMP_IMAGE_ON) return true;
      if (id === LAMP_IMAGE_OFF) return false;
    }
    return null;
  }

  /**
   * Request current paint state from the PLC via a viewport event.
   * This is the protocol's standard polling mechanism — the PLC responds
   * with paint commands for all visible elements.
   */
  private async pollPaintCommands(reason: string): Promise<PaintCommand[]> {
    const request = buildViewportEvent(
      this.client.getClientId(),
      config.browser.viewport.width,
      config.browser.viewport.height,
      1.0,
      this.client.getSessionId()
    );

    const { paintData, allCommands } = await this.client.sendEventAndCollect(request);

    if (allCommands.length === 0) {
      this.consecutiveEmptyRenders++;
      if (this.consecutiveEmptyRenders >= ProtocolController.RECONNECT_EMPTY_THRESHOLD) {
        const cooldownElapsed = (Date.now() - this.lastReconnectAt) >= ProtocolController.RECONNECT_COOLDOWN_MS;
        if (cooldownElapsed) {
          await this.doReconnect('consecutive-empty-renders');
        }
      }
    } else {
      this.consecutiveEmptyRenders = 0;
    }

    return allCommands;
  }

  private static readonly NAPIT_REQUIRED_LABELS = [
    'ohjaus',
    'tallenna asetukset',
    'lue asetukset',
    '1. painallus',
    '2. painallus',
  ];

  private isNapitTabLoaded(commands: PaintCommand[]): boolean {
    const lampCount = extractDrawImages(commands)
      .filter(img => this.isLampStatusImageId(img.imageId))
      .length;
    if (lampCount < 3) return false;

    const labels = extractTextLabels(commands);
    const normalizedTexts = new Set(labels.map(l => this.normalizeVisuText(l.text)));
    return ProtocolController.NAPIT_REQUIRED_LABELS.every(req => normalizedTexts.has(this.normalizeVisuText(req)));
  }

  private isDropdownOpen(commands: PaintCommand[]): boolean {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const listTop = dropdown.firstItemY;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems);
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;

    const labels = extractTextLabels(commands);
    const dropdownLabels = labels
      .filter(l => l.top >= listTop && l.bottom <= listBottom)
      .filter(l => l.right >= listLeft && l.left <= listRight)
      .filter(l => this.resolveLightIndexFromLabel(l.text) !== null);

    // A fully opened dropdown always redraws 5 dropdown item text labels.
    return dropdownLabels.length >= 5;
  }

  private async navigateToNapitTab(): Promise<void> {
    const coords = uiCoordinates.tabs.napit;
    const timeoutMs = config.protocol?.initialRenderTimeoutMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_TIMEOUT_MS;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info({ attempt }, `Clicking Napit tab at (${coords.x}, ${coords.y})`);
      const accumulated: PaintCommand[] = [];

      const clickCommands = await this.client.pressAndCollect(coords.x, coords.y);
      accumulated.push(...clickCommands);

      if (this.isNapitTabLoaded(accumulated)) {
        logger.info({ attempt, commandCount: accumulated.length }, 'Napit tab loaded after click');
        return;
      }

      // Poll with forceRender until the tab content arrives or timeout.
      const deadline = Date.now() + timeoutMs;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.pollPaintCommands(`napit-verify:${attempt}:${poll}`);
        accumulated.push(...cmds);
        if (this.isNapitTabLoaded(accumulated)) {
          logger.info({ attempt, poll, commandCount: accumulated.length }, 'Napit tab loaded after polling');
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(200, remaining));
        }
      }

      logger.warn({ attempt, commandCount: accumulated.length }, 'Napit tab not verified within timeout');
    }

    throw new Error(`Napit tab navigation failed after ${maxAttempts} attempts`);
  }

  private async doReconnect(reason: string): Promise<void> {
    logger.warn({ reason }, 'Reconnecting to PLC...');
    try {
      await this.client.disconnect();
    } catch (error) {
      logger.warn({ error }, 'Error during disconnect before reconnect');
    }

    // Reset controller state
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    this.lastStatusByLight.clear();
    this.consecutiveEmptyRenders = 0;
    this.lastReconnectAt = Date.now();

    await this.client.connect();
    await this.waitForInitialRenderReady();
    await this.navigateToNapitTab();

    logger.info({ reason }, 'Reconnected successfully');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
