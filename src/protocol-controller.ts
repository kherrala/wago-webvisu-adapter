// Protocol controller for CoDeSys WebVisu — slim orchestrator.
// Delegates UI interactions to command modules in src/commands/.

import {
  config,
  uiCoordinates,
  lightSwitches,
  lightSwitchNames,
  lightSwitchById,
} from './config';
import { IWebVisuController, LightStatus } from './controller-interface';
import { WebVisuProtocolClient } from './protocol/client';
import { buildViewportEvent } from './events';
import { PaintCommand } from './protocol/paint-commands';
import { ProtocolDebugRenderer } from './renderer';
import pino from 'pino';

// Model & utilities
import { UIState } from './model/ui-state';
import { CommandContext, CommandWindow } from './model/command-context';
import { isViewReadyForClick } from './model/dropdown-labels';
import { DropdownHeaderMismatchError, verifyDropdownHeader } from './model/header-verification';
import { resolveTouchValidatedDropdownClickY } from './model/touch-validation';
import { waitForDropdownReady } from './model/wait-for-dropdown';

// Commands
import { ensureDropdownClosed, reopenDropdownFromClosed } from './commands/ensure-dropdown-closed';
import { openDropdown } from './commands/open-dropdown';
import { scrollToTarget } from './commands/scroll-to-target';
import { selectDropdownItemAndCollect } from './commands/select-dropdown-item';
import { resolveIndicatorImages, resolveLampStatus, formatImageSummary } from './commands/resolve-light-status';
import { waitForInitialRenderReady, navigateToNapitTab, navigateToTab as doNavigateToTabCmd } from './commands/navigate-to-tab';

const logger = pino({ name: 'protocol-controller' });

export interface DebugSnapshot {
  label: string;
  png: Buffer;
}

export class ProtocolController implements IWebVisuController, CommandContext {
  private static readonly RECONNECT_EMPTY_THRESHOLD = 10;
  private static readonly RECONNECT_COOLDOWN_MS = 30_000;

  readonly client: WebVisuProtocolClient;
  readonly state: UIState;
  readonly window: CommandWindow;
  debugRenderer: ProtocolDebugRenderer | null = null;
  readonly logger = logger;

  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private collectedSnapshots: DebugSnapshot[] = [];
  private snapshotSequence = 0;

  constructor() {
    this.state = new UIState();
    this.window = new CommandWindow(2000);
    const protocolHost = config.protocol?.host ?? '192.168.1.10';
    const protocolPort = config.protocol?.port ?? 443;
    const debugRenderEnabled = config.protocol?.debugRenderEnabled ?? false;
    this.debugRenderer = this.createDebugRenderer(protocolHost, protocolPort, debugRenderEnabled);

    this.client = new WebVisuProtocolClient({
      host: protocolHost,
      port: protocolPort,
      requestTimeout: config.protocol?.requestTimeout ?? 5000,
      reconnectDelay: config.protocol?.reconnectDelay ?? 5000,
      postClickDelay: config.protocol?.postClickDelay ?? 50,
      postSelectDelay: config.protocol?.postSelectDelay ?? 100,
      debugHttp: config.protocol?.debugHttp ?? false,
      sessionTraceEnabled: config.protocol?.sessionTraceEnabled ?? true,
      sessionTraceDir: config.protocol?.sessionTraceDir ?? '/data/protocol-trace',
      logRawFrameData: config.protocol?.logRawFrameData ?? false,
      postDataInHeader: config.protocol?.postDataInHeader ?? 'auto',
      deviceUsername: config.protocol?.deviceUsername ?? '',
      devicePassword: config.protocol?.devicePassword ?? '',
      strictPaintValidation: config.protocol?.strictPaintValidation ?? true,
      renderSettleMinEmptyPolls: config.protocol?.renderSettleMinEmptyPolls ?? 2,
      renderSettleMaxPolls: config.protocol?.renderSettleMaxPolls ?? 8,
      renderSettlePollIntervalMs: config.protocol?.renderSettlePollIntervalMs ?? 80,
      renderSettleHashStreak: config.protocol?.renderSettleHashStreak ?? 0,
      renderSettleTimeoutMs: config.protocol?.renderSettleTimeoutMs ?? 0,
      onPaintFrame: (frame) => {
        this.debugRenderer?.record(frame);
      },
    });
  }

  private createDebugRenderer(protocolHost: string, protocolPort: number, debugRenderEnabled: boolean): ProtocolDebugRenderer | null {
    try {
      return new ProtocolDebugRenderer({
        noDisk: !debugRenderEnabled,
        outputDir: config.protocol?.debugRenderDir ?? '/data/protocol-render-debug',
        width: config.browser.viewport.width,
        height: config.browser.viewport.height,
        maxFrames: config.protocol?.debugRenderMaxFrames ?? 400,
        minIntervalMs: config.protocol?.debugRenderMinIntervalMs ?? 0,
        includeEmptyFrames: config.protocol?.debugRenderIncludeEmptyFrames ?? true,
        imageSource: {
          enabled: config.protocol?.debugRenderFetchImages ?? true,
          host: protocolHost,
          port: protocolPort,
          rejectUnauthorized: false,
          referer: `https://${protocolHost}/webvisu/webvisu.htm`,
          basePath: '/webvisu',
          timeoutMs: config.protocol?.debugRenderImageFetchTimeoutMs ?? 1200,
        },
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize protocol debug renderer; rendered-ui endpoint will return empty');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // CommandContext implementation
  // ---------------------------------------------------------------------------

  async pollPaintCommands(reason: string): Promise<PaintCommand[]> {
    const request = buildViewportEvent(
      this.client.getClientId(),
      config.browser.viewport.width,
      config.browser.viewport.height,
      1.0,
      this.client.getSessionId()
    );

    const { allCommands } = await this.client.sendEventAndCollect(request);
    this.window.append(allCommands);

    if (allCommands.length === 0) {
      this.state.consecutiveEmptyRenders++;
      if (this.state.consecutiveEmptyRenders >= ProtocolController.RECONNECT_EMPTY_THRESHOLD) {
        const cooldownElapsed = (Date.now() - this.state.lastReconnectAt) >= ProtocolController.RECONNECT_COOLDOWN_MS;
        if (cooldownElapsed) {
          await this.doReconnect('consecutive-empty-renders');
        }
      }
    } else {
      this.state.consecutiveEmptyRenders = 0;
    }

    return allCommands;
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // IWebVisuController lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Initializing protocol controller...');
    if (!this.debugRenderer) {
      const protocolHost = config.protocol?.host ?? '192.168.1.10';
      const protocolPort = config.protocol?.port ?? 443;
      const debugRenderEnabled = config.protocol?.debugRenderEnabled ?? false;
      this.debugRenderer = this.createDebugRenderer(protocolHost, protocolPort, debugRenderEnabled);
    }
    await this.client.connect();

    await waitForInitialRenderReady(this);

    logger.info('Navigating to Napit tab...');
    await navigateToNapitTab(this);

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
      this.debugRenderer = null;
    }
    this.initialized = false;
    this.state.resetAll();
    this.window.clear();
    logger.info('Protocol controller closed');
  }

  resetDropdownState(): void {
    this.state.resetDropdown();
    logger.info('Dropdown state reset to top');
  }

  getPendingOperationCount(): number {
    return this.pendingOperations;
  }

  async navigateToTab(tabName: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await doNavigateToTabCmd(this, tabName);
    });
  }

  // ---------------------------------------------------------------------------
  // Light switch selection
  // ---------------------------------------------------------------------------

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string): Promise<{ postSelectionCommands: PaintCommand[] }> {
    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doSelectLightSwitchOnce(lightId, index);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isHeaderMismatch = lastError instanceof DropdownHeaderMismatchError;
        const message = lastError.message ?? '';
        const isRecoverableError =
          message.includes('Scroll failed after') ||
          message.includes('Scroll reopen failed') ||
          message.includes('Dropdown failed to open') ||
          message.includes('Dropdown failed to close') ||
          message.includes('Dropdown not ready for item click') ||
          message.includes('Dropdown row out of view after scroll');

        logger.warn({ err: lastError, lightId, attempt, maxAttempts }, 'Selection attempt failed');

        if (attempt < maxAttempts && (isHeaderMismatch || isRecoverableError)) {
          this.state.resetDropdown();
          // Reconnect on all recoverable errors and header mismatches.
          // Header mismatches often indicate CoDeSys click-mapping desync
          // from scrolling — a fresh session resets internal state.
          await this.doReconnect(`selection-failure:${lightId}:${attempt}`);
        }
      }
    }

    throw lastError!;
  }

  private async doSelectLightSwitchOnce(
    lightId: string,
    index: number,
  ): Promise<{ postSelectionCommands: PaintCommand[] }> {
    logger.info(`Selecting light switch: ${lightId} (index: ${index})`);

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;

    // Drain pending PLC frames from the previous operation and let the PLC
    // settle before starting a new selection. Without this, ensureDropdownClosed
    // sees empty/minimal transition frames, returns immediately, and the
    // subsequent openDropdown click arrives while the PLC is still processing.
    this.window.clear();
    await this.pollPaintCommands(`drain:${lightId}`);
    await this.delay(300);

    // Step 1: Ensure dropdown is closed
    await ensureDropdownClosed(this, `select-start:${lightId}`);

    // Step 2: Open dropdown
    const opened = await openDropdown(this, lightId);

    // Step 3: Scroll to target
    await scrollToTarget(this, lightId, index);

    // Snapshot: after scroll settled, before click
    await this.captureDebugSnapshot(`${lightId}-after-scroll`);

    // Let PLC scroll position fully stabilize before clicking
    await this.delay(500);

    // Clear window after scroll — pre-click wait needs fresh position data
    this.window.clear();

    // Step 4: Wait for view ready before click
    const readyResult = await waitForDropdownReady(this, {
      reason: `pre-click:${lightId}`,
      timeoutMs: 2000,
      readyForClickIndex: index,
      requireFreshLabels: true,
    });
    let readyView = readyResult.view;

    if (readyResult.closedDetected) {
      logger.warn({ lightId, index }, 'Dropdown closed before item click; reopening');
      const { view: reopenView } = await reopenDropdownFromClosed(this, `pre-click-reopen:${lightId}`);
      let resolvedAfterReopen = reopenView;
      if (!isViewReadyForClick(resolvedAfterReopen, index)) {
        const settled = await waitForDropdownReady(this, {
          reason: `pre-click-reopen:${lightId}`,
          timeoutMs: 2000,
          readyForClickIndex: index,
          requireFreshLabels: true,
        });
        resolvedAfterReopen = settled.view;
      }
      readyView = resolvedAfterReopen;
    }

    if (!readyView) {
      throw new Error(`Dropdown not ready for item click: light=${lightId}, index=${index}`);
    }
    this.state.applyDropdownView(readyView);

    // Step 5: Resolve click coordinates
    const positionInView = index - this.state.dropdownFirstVisible;
    if (positionInView < 0 || positionInView >= dropdownConfig.visibleItems) {
      throw new Error(`Dropdown row out of view after scroll: light=${lightId}, position=${positionInView}`);
    }
    let rowClickX = dropdownConfig.itemX;
    let itemY: number;
    let clickSource: string;

    const targetLabel = readyView.labels.find(l => l.index === index) ?? null;
    if (targetLabel) {
      rowClickX = Math.round((targetLabel.left + targetLabel.right) / 2);
      itemY = Math.round((targetLabel.top + targetLabel.bottom) / 2);
      clickSource = 'view-label-center';
    } else {
      itemY = dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight) + Math.round(dropdownConfig.itemHeight / 2);
      clickSource = 'computed-row';
    }
    rowClickX = Math.max(120, Math.min(510, rowClickX));

    const touchValidatedTarget = resolveTouchValidatedDropdownClickY(
      this.window.getCommands(),
      positionInView,
      rowClickX,
      itemY,
    );
    itemY = touchValidatedTarget.y;
    if (touchValidatedTarget.usedTouchRectangles) {
      clickSource = `${clickSource}+${touchValidatedTarget.source}`;
    }

    logger.info({
      lightId, index, positionInView,
      clickX: rowClickX, clickY: itemY, clickSource,
      readyViewFirstVisible: readyView.firstVisible,
      readyViewLabels: readyView.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top, bottom: l.bottom })),
      targetLabelText: targetLabel?.text,
      targetLabelTop: targetLabel?.top,
      targetLabelBottom: targetLabel?.bottom,
    }, 'Selecting dropdown item');

    // Snapshot: before click with target marker
    await this.captureDebugSnapshot(`${lightId}-before-click`, [
      { x: rowClickX, y: itemY, type: 'click' },
    ]);

    // Step 5.5: Move mouse to list area before item click.
    // After arrow scrolling, the mouse is on the scrollbar widget. The PLC's
    // dropdown list sub-widget may need a mouseMove within its area to sync
    // its click mapping with the scrollbar's scroll position. In a browser,
    // the mouse naturally passes through the list before clicking an item.
    await this.client.mouseMove(rowClickX, dropdownConfig.firstItemY);
    await this.delay(200);

    // Step 6: Selection gesture
    const selectionResult = await selectDropdownItemAndCollect(this, lightId, index, rowClickX, itemY);

    // Snapshot: after click (shows header result)
    await this.captureDebugSnapshot(`${lightId}-after-click`);

    // Step 7: Verify header
    verifyDropdownHeader(selectionResult.commands, lightId, index);

    // Track the widget's scroll position — it persists globally and determines
    // where the scrollbar thumb is on next dropdown open.
    this.state.widgetScrollPosition = this.state.dropdownFirstVisible;

    logger.info(`Light switch ${lightId} selected`);
    return { postSelectionCommands: selectionResult.commands };
  }

  // ---------------------------------------------------------------------------
  // Toggle & status
  // ---------------------------------------------------------------------------

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

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
        lightId, functionNumber,
        x: targetButton.x, y: targetButton.y, buttonSource,
      }, 'Dispatching toggle button click');

      const clickCommands = await this.client.pressAndCollect(targetButton.x, targetButton.y);

      const postRenderPolls = Math.max(1, config.protocol?.togglePostRenderPolls ?? 2);
      const postRenderPollDelayMs = Math.max(0, config.protocol?.togglePostRenderPollDelayMs ?? 0);
      const settleResult = await this.client.waitForRenderSettled({
        reason: `toggle-post:${lightId}`,
        maxPolls: postRenderPolls,
        pollIntervalMs: postRenderPollDelayMs,
      });
      const totalPostCommands = settleResult.commands.length;

      logger.info({
        lightId, functionNumber,
        clickCommandCount: clickCommands.length,
        postRenderPolls, totalPostCommands,
        settleBy: settleResult.settledBy,
        settlePolls: settleResult.polls,
        settleDurationMs: settleResult.durationMs,
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
      const statusSettle = await this.client.waitForRenderSettled({
        reason: `status:${lightId}`,
        maxPolls: Math.max(1, config.protocol?.statusMaxAttempts ?? 3),
        pollIntervalMs: Math.max(0, config.protocol?.statusPollDelayMs ?? 0),
      });
      const statusCommands = statusSettle.commands;
      logger.debug({
        lightId,
        settleBy: statusSettle.settledBy,
        settlePolls: statusSettle.polls,
        settleDurationMs: statusSettle.durationMs,
        settleCommandCount: statusCommands.length,
      }, 'Status render settle');
      const statusRelevantCommands = [...postSelectionCommands, ...statusCommands];

      const indicatorImages = resolveIndicatorImages(statusRelevantCommands);

      const key1 = firstPressLightId ?? `${lightId}:1`;
      const key2 = secondPressLightId ?? `${lightId}:2`;

      let isOn1 = resolveLampStatus(indicatorImages.indicator1);
      if (isOn1 === null) {
        const cached = this.state.lastStatusByLight.get(key1);
        if (cached !== undefined) {
          isOn1 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 1 (light: ${key1}), using cached=${cached}`);
        } else {
          isOn1 = false;
          logger.warn(`No lamp image found for ${lightId} indicator 1 (light: ${key1}), defaulting to OFF`);
        }
      }
      this.state.lastStatusByLight.set(key1, isOn1);
      logger.info(`Status indicator 1 for ${lightId} (light: ${key1}): images=${JSON.stringify(formatImageSummary(indicatorImages.indicator1))}, isOn=${isOn1}`);

      let resolved2 = resolveLampStatus(indicatorImages.indicator2);
      if (resolved2 === null) {
        const cached = this.state.lastStatusByLight.get(key2);
        if (cached !== undefined) {
          resolved2 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 2 (light: ${key2}), using cached=${cached}`);
        } else {
          resolved2 = false;
        }
      }
      this.state.lastStatusByLight.set(key2, resolved2);
      logger.info(`Status indicator 2 for ${lightId} (light: ${key2}): images=${JSON.stringify(formatImageSummary(indicatorImages.indicator2))}, isOn=${resolved2}`);

      let resolved3 = resolveLampStatus(indicatorImages.indicator3);
      if (resolved3 === null) {
        const cached = this.state.lastStatusByLight.get(`${lightId}:3`);
        if (cached !== undefined) {
          resolved3 = cached;
        } else {
          resolved3 = false;
        }
      }
      this.state.lastStatusByLight.set(`${lightId}:3`, resolved3);

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

  // ---------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------

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
        if (commands.length > 0) return rendered;
      }
      return latest ?? Buffer.alloc(0);
    } catch (error) {
      logger.warn({ error }, 'Failed to generate protocol debug screenshot');
      return latest ?? Buffer.alloc(0);
    }
  }

  async getRenderedUiImage(markers?: Array<{ x: number; y: number; type: 'down' | 'up' | 'click'; label?: string }>): Promise<Buffer | null> {
    if (!this.debugRenderer) return null;
    return this.debugRenderer.renderPreview([], markers);
  }

  async captureDebugSnapshot(label: string, markers?: Array<{ x: number; y: number; type: 'down' | 'up' | 'click'; label?: string }>): Promise<void> {
    if (!this.debugRenderer) return;
    this.snapshotSequence++;
    const seq = String(this.snapshotSequence).padStart(2, '0');
    const png = await this.debugRenderer.renderPreview([], markers);
    this.collectedSnapshots.push({ label: `${seq}-${label}`, png: Buffer.from(png) });
  }

  collectAndClearSnapshots(): DebugSnapshot[] {
    const result = this.collectedSnapshots;
    this.collectedSnapshots = [];
    return result;
  }

  async isConnected(): Promise<boolean> {
    return this.client.isConnected();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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

  private async doReconnect(reason: string): Promise<void> {
    logger.warn({ reason }, 'Reconnecting to PLC...');
    try {
      await this.client.disconnect();
    } catch (error) {
      logger.warn({ error }, 'Error during disconnect before reconnect');
    }

    this.state.resetAll();
    this.state.lastReconnectAt = Date.now();

    await this.client.connect();
    await waitForInitialRenderReady(this);
    await navigateToNapitTab(this);

    logger.info({ reason }, 'Reconnected successfully');
  }
}
