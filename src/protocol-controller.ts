// Simplified protocol controller for CoDeSys WebVisu.
// Strategy:
// - Execute one forced render (viewport event) after each UI step.
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
    await this.forceRenderOnce(`navigate:${tabName}`);
  }

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string): Promise<PaintCommand[]> {
    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    try {
      return await this.doSelectLightSwitchOnce(lightId, index);
    } catch (error) {
      logger.warn({ err: error, lightId }, 'Selection failed, reconnecting and retrying once');
      await this.doReconnect('select-retry');
      return this.doSelectLightSwitchOnce(lightId, index);
    }
  }

  private async doSelectLightSwitchOnce(lightId: string, index: number): Promise<PaintCommand[]> {
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
    // Track the most recent command batch that confirmed the dropdown is open.
    // Used for scroll sync and click positioning — must be from a single render
    // to avoid mixing stale labels from different states.
    let openConfirmCmds: PaintCommand[] = [];

    for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
      const clickCommands = await this.client.pressAndCollect(arrowX, arrowY);
      allDropdownCommands.push(...clickCommands);
      logger.info({
        openAttempt,
        commandCount: clickCommands.length,
        labelCount: extractTextLabels(clickCommands).length,
      }, 'Dropdown open: pressAndCollect response');

      if (this.isDropdownOpen(clickCommands)) {
        dropdownOpened = true;
        openConfirmCmds = clickCommands;
        break;
      }

      // Poll with forceRender until dropdown content arrives or timeout.
      const deadline = Date.now() + dropdownOpenTimeoutMs;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.forceRenderOnce(`dropdown-open-verify:${openAttempt}:${poll}:${lightId}`);
        allDropdownCommands.push(...cmds);
        if (this.isDropdownOpen(cmds)) {
          dropdownOpened = true;
          openConfirmCmds = cmds;
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

    // Step 2: Dropdown is open — sync scroll state from the confirmed open response.
    // Use only the single response that confirmed the dropdown (not accumulated)
    // to avoid stale labels from prior renders polluting the scroll position.
    this.syncDropdownStateFromCommands(openConfirmCmds, 'on-open');
    let latestSnapshot = this.resolveDropdownSnapshot(openConfirmCmds);

    const stepCommands: PaintCommand[] = [...allDropdownCommands];

    // Step 3: If target not visible, scroll to bring it into view.
    if (!this.isDropdownIndexVisible(index)) {
      const targetFirstVisible = this.getTargetFirstVisible(index, maxFirstVisible);
      const delta = targetFirstVisible - this.dropdownFirstVisible;
      const absDelta = Math.abs(delta);

      // Drag the scrollbar thumb to the target position. The mouseUp on the thumb
      // CLOSES the dropdown (observed behavior). After drag, reopen to proceed with item click.
      const dragStartHoldMs = config.protocol?.dragStartHoldMs ?? 60;
      const dragStepDelayMs = config.protocol?.dragStepDelayMs ?? 45;
      const dragEndHoldMs = config.protocol?.dragEndHoldMs ?? 50;
      const scrollbarX = scrollbarConfig.x;
      const currentHandleY = Math.round(this.getDropdownScrollY(this.dropdownFirstVisible));
      const targetHandleY = Math.round(this.getDropdownScrollY(targetFirstVisible));

      logger.info({
        lightId, index,
        currentFirstVisible: this.dropdownFirstVisible, targetFirstVisible,
        delta, direction: delta >= 0 ? 'down' : 'up',
        currentHandleY, targetHandleY,
      }, 'Dragging scrollbar thumb');

      await this.client.mouseDown(scrollbarX, currentHandleY);
      await this.delay(dragStartHoldMs);
      const step = delta > 0 ? 2 : -2;
      for (let y = currentHandleY + step; delta > 0 ? y < targetHandleY : y > targetHandleY; y += step) {
        await this.client.mouseMove(scrollbarX, y);
        await this.delay(dragStepDelayMs);
      }
      // Final move at targetHandleY, then verify the PLC has settled to the
      // correct position by reading paint data. If it undershot, nudge further.
      const finalMoveCmds = await this.client.mouseMoveAndCollect(scrollbarX, targetHandleY);
      stepCommands.push(...finalMoveCmds);
      await this.delay(dragEndHoldMs);

      // Poll to verify the scroll position from paint data while mouse is still held.
      // The dropdown is open during drag — items redraw as the thumb moves, so
      // resolveDropdownSnapshot can read the actual firstVisible.
      const dragVerifyTimeoutMs = 3000;
      const dragVerifyDeadline = Date.now() + dragVerifyTimeoutMs;
      let verifyPolls = 0;
      let dragY = targetHandleY;
      while (Date.now() < dragVerifyDeadline) {
        verifyPolls++;
        const settleCmds = await this.forceRenderOnce(`drag-verify:${verifyPolls}:${lightId}`);
        stepCommands.push(...settleCmds);
        const snapshot = this.resolveDropdownSnapshot(settleCmds);
        if (snapshot) {
          const actualFirst = snapshot.firstVisible;
          logger.info({
            verifyPolls,
            actualFirst,
            targetFirstVisible,
            delta: targetFirstVisible - actualFirst,
          }, 'Drag position verified from paint data');

          if (actualFirst === targetFirstVisible) {
            // Perfect — handle is at the right position.
            break;
          }
          // Undershot or overshot — nudge the mouse to compensate.
          const correction = this.getDropdownScrollY(targetFirstVisible) - this.getDropdownScrollY(actualFirst);
          dragY = Math.round(dragY + correction);
          // Clamp to thumb range.
          dragY = Math.max(scrollbarConfig.thumbRange.topY, Math.min(dragY, scrollbarConfig.thumbRange.bottomY));
          logger.info({ actualFirst, targetFirstVisible, correctionPx: Math.round(correction), newDragY: dragY }, 'Nudging drag to correct position');
          const nudgeCmds = await this.client.mouseMoveAndCollect(scrollbarX, dragY);
          stepCommands.push(...nudgeCmds);
          await this.delay(dragEndHoldMs);
          continue;
        }
        // No parseable labels yet — wait and retry.
        const remaining = dragVerifyDeadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(150, remaining));
        }
      }

      const dragUpCmds = await this.client.mouseUpAndCollect(scrollbarX, dragY);
      stepCommands.push(...dragUpCmds);

      // Dropdown CLOSED after drag mouseUp. Reopen to proceed with item click.
      const reopenCmds = await this.client.pressAndCollect(arrowX, arrowY);
      stepCommands.push(...reopenCmds);
      // Sync actual scroll position from reopen paint response.
      // Falls back to targetFirstVisible if the response has no parseable labels.
      const reopenSnapshot = this.resolveDropdownSnapshot(reopenCmds);
      if (reopenSnapshot) {
        this.dropdownFirstVisible = reopenSnapshot.firstVisible;
        this.dropdownHandleCenterY = reopenSnapshot.handleCenterY;
        latestSnapshot = reopenSnapshot;
      } else {
        this.dropdownFirstVisible = targetFirstVisible;
      }

      // After drag, check if target is visible. If not, use arrow clicks to
      // correct — supports both undershot (scroll down) and overshot (scroll up).
      if (!this.isDropdownIndexVisible(index)) {
        const drift = targetFirstVisible - this.dropdownFirstVisible;
        const absDrift = Math.abs(drift);
        const arrowCorrectMax = 15;
        if (absDrift > 0 && absDrift <= arrowCorrectMax) {
          const scrollArrowX = scrollbarConfig.x;
          const arrowY = drift > 0
            ? scrollbarConfig.scanRange.bottomY   // down arrow
            : scrollbarConfig.scanRange.topY;      // up arrow
          logger.info({ lightId, drift, firstVisible: this.dropdownFirstVisible, targetFirstVisible, direction: drift > 0 ? 'down' : 'up' }, 'Post-drag drift — correcting with arrow clicks');
          for (let click = 0; click < absDrift; click++) {
            await this.client.mouseDown(scrollArrowX, arrowY);
            const upCmds = await this.client.mouseUpAndCollect(scrollArrowX, arrowY);
            stepCommands.push(...upCmds);
          }
          this.dropdownFirstVisible = targetFirstVisible;
        }
      }

      if (!this.isDropdownIndexVisible(index)) {
        throw new Error(`Scroll failed (drag+arrow): light=${lightId}, index=${index}, firstVisible=${this.dropdownFirstVisible}, targetFirstVisible=${targetFirstVisible}`);
      }
    }

    // Step 4: Resolve click coordinates from the latest snapshot.
    // Use the label positions already captured from the dropdown open or
    // post-drag reopen response. If the target label isn't in the snapshot,
    // do one more forceRender to try to get it.
    const positionInView = index - this.dropdownFirstVisible;
    const visibleItems = dropdownConfig.visibleItems;
    if (positionInView < 0 || positionInView >= visibleItems) {
      throw new Error(`Dropdown row out of view after scroll: light=${lightId}, position=${positionInView}`);
    }

    let itemY: number;
    let clickSource: string;

    // Try to find the target label in the latest snapshot.
    let targetLabel = latestSnapshot?.labels.find(l => l.index === index) ?? null;
    if (!targetLabel) {
      // One more render attempt to get the label.
      const extraCmds = await this.forceRenderOnce(`click-resolve:${lightId}`);
      stepCommands.push(...extraCmds);
      const extraSnap = this.resolveDropdownSnapshot(extraCmds);
      if (extraSnap) {
        targetLabel = extraSnap.labels.find(l => l.index === index) ?? null;
      }
    }

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
    // The mouseDown is fire-and-forget (the PLC queues the selection event; the
    // HTTP response returns the INTERMEDIATE render state, not the final header).
    // After a settle delay, mouseUp goes to the dropdown arrow (safe area) to avoid
    // hitting Ohjaus/panel buttons. Then TWO forced renders ensure the PLC has
    // processed the selection and the header has settled to its final value.
    await this.client.mouseDown(dropdownConfig.itemX, itemY);
    const selectionSettleMs = config.protocol?.selectionSettleDelayMs ?? 200;
    await this.delay(selectionSettleMs);
    await this.client.mouseUp(arrowX, arrowY);
    const render1 = await this.forceRenderOnce(`select-settle1:${lightId}`);
    const render2 = await this.forceRenderOnce(`select-settle2:${lightId}`);
    const selectCommands = [...render1, ...render2];
    stepCommands.push(...selectCommands);

    // Step 6: Verify the dropdown header now shows the expected item.
    // The item-click response redraws the header with the selected label.
    // If mismatch — opportunistically cache status for the switch that WAS selected,
    // then throw to trigger reconnect+retry.
    const actualLabel = this.extractDropdownHeaderLabel(selectCommands);
    if (actualLabel !== null) {
      const expectedLabel = lightSwitchPlcLabels[index];
      if (this.normalizeVisuText(actualLabel) !== this.normalizeVisuText(expectedLabel)) {
        this.opportunisticallyCacheStatus(selectCommands, actualLabel);
      }
    }
    this.verifyDropdownHeader(selectCommands, lightId, index);

    logger.info(`Light switch ${lightId} selected`);
    return stepCommands;
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

      const togglePressHoldMs = Math.max(0, config.protocol?.togglePressHoldMs ?? 140);
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
        holdMs: togglePressHoldMs,
      }, 'Dispatching toggle button click');

      await this.client.mouseMove(targetButton.x, targetButton.y);
      await this.client.mouseDown(targetButton.x, targetButton.y);
      if (togglePressHoldMs > 0) {
        await this.delay(togglePressHoldMs);
      }
      await this.client.mouseUp(targetButton.x, targetButton.y);

      if (togglePostClickDelayMs > 0) {
        await this.delay(togglePostClickDelayMs);
      }
      const postCommands = await this.forceRenderOnce(`toggle-post:${lightId}`);

      logger.info({
        lightId,
        functionNumber,
        postCommandCount: postCommands.length,
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

      const selectionCommands = await this.doSelectLightSwitch(lightId);
      const selectionSettleDelayMs = config.protocol?.selectionSettleDelayMs ?? 200;
      if (selectionSettleDelayMs > 0) {
        await this.delay(selectionSettleDelayMs);
      }
      const statusCommands = await this.forceRenderOnce(`status:${lightId}`);
      const allCommands = [...selectionCommands, ...statusCommands];

      const indicatorImages = this.resolveIndicatorImages(allCommands);

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
        const commands = await this.forceRenderOnce(`manual-screenshot:${attempt}`);
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
    let lastCommands: PaintCommand[] = [];
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt++;
      const commands = await this.forceRenderOnce(`initial-render:${attempt}`);
      lastCommands = commands;
      const images = extractDrawImages(commands);
      const labels = extractTextLabels(commands);
      const topLabels = labels.filter((label) => label.top <= 55 && label.bottom <= 75);
      logger.info({
        reason: 'initialize',
        attempt,
        imageCount: images.length,
        topLabelCount: topLabels.length,
      }, 'Initial render probe');

      if (images.length > 0 || topLabels.length > 0) {
        logger.info({ attempts: attempt, elapsedMs: Date.now() - startedAt }, 'Initial render ready');
        return commands;
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
    return lastCommands;
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
    const preferredFirstVisible = Math.min(index, maxFirstVisible);
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
    const headerLabel = this.extractDropdownHeaderLabel(commands);
    if (headerLabel === null) {
      logger.warn({ lightId, index, expectedPlcLabel }, 'Header text not found in selection commands; cannot verify');
      return;
    }
    const normalizedHeader = this.normalizeVisuText(headerLabel);
    const normalizedExpected = this.normalizeVisuText(expectedPlcLabel);
    if (normalizedHeader !== normalizedExpected) {
      throw new Error(
        `Header verification failed: expected="${expectedPlcLabel}", got="${headerLabel}", light=${lightId}, index=${index}`
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
    const listTop = dropdown.firstItemY - dropdown.itemHeight;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * (dropdown.visibleItems + 1));
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();

    const matched = labels
      .filter((label) => label.bottom >= listTop && label.top <= listBottom)
      .filter((label) => label.right >= listLeft && label.left <= listRight)
      .map((label) => {
        const index = this.resolveLightIndexFromLabel(label.text);
        if (index === null) return null;
        const centerY = Math.round((label.top + label.bottom) / 2);
        const row = Math.round((centerY - dropdown.firstItemY) / dropdown.itemHeight);
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

  private async forceRenderOnce(reason: string): Promise<PaintCommand[]> {
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
      logger.info({
        reason,
        consecutiveEmptyRenders: this.consecutiveEmptyRenders,
        commandCount: paintData.commandCount,
        paintError: paintData.error,
      }, 'Forced render returned zero commands');

      const cooldownElapsed = (Date.now() - this.lastReconnectAt) >= ProtocolController.RECONNECT_COOLDOWN_MS;
      if (this.consecutiveEmptyRenders >= ProtocolController.RECONNECT_EMPTY_THRESHOLD && cooldownElapsed) {
        await this.doReconnect('consecutive-empty-renders');
      }
    } else {
      this.consecutiveEmptyRenders = 0;
      logger.debug({ reason, commandCount: allCommands.length }, 'Forced render');
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
    return ProtocolController.NAPIT_REQUIRED_LABELS.every(req => normalizedTexts.has(req));
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
        const cmds = await this.forceRenderOnce(`napit-verify:${attempt}:${poll}`);
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
