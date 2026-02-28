// Simplified protocol controller for CoDeSys WebVisu.
// Strategy:
// - Execute one forced render (viewport event) after each UI step.
// - Use only explicit lamp image IDs for status detection.

import {
  config,
  uiCoordinates,
  lightSwitches,
  lightSwitchNames,
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
  parsePaintCommands,
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
  private static readonly MIN_DROPDOWN_OPEN_TIMEOUT_MS = 1000;
  private static readonly DEFAULT_DROPDOWN_OPEN_TIMEOUT_MS = 4000;
  private static readonly MIN_DROPDOWN_OPEN_POLL_INTERVAL_MS = 50;
  private static readonly DEFAULT_DROPDOWN_OPEN_POLL_INTERVAL_MS = 180;
  private static readonly MIN_SELECTION_VERIFY_TIMEOUT_MS = 200;
  private static readonly DEFAULT_SELECTION_VERIFY_TIMEOUT_MS = 2500;
  private static readonly MIN_SELECTION_VERIFY_POLL_INTERVAL_MS = 50;
  private static readonly DEFAULT_SELECTION_VERIFY_POLL_INTERVAL_MS = 120;
  private static readonly MIN_DROPDOWN_SCROLL_TIMEOUT_MS = 800;
  private static readonly DEFAULT_DROPDOWN_SCROLL_TIMEOUT_MS = 2400;
  private static readonly MIN_DROPDOWN_SCROLL_POLL_INTERVAL_MS = 50;
  private static readonly DEFAULT_DROPDOWN_SCROLL_POLL_INTERVAL_MS = 120;
  private static readonly DEFAULT_MAX_LIGHT_SELECTION_ATTEMPTS = 3;

  private client: WebVisuProtocolClient;
  private debugRenderer: ProtocolDebugRenderer | null = null;
  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;

  private napitTabKnownActive = false;
  private napitTabVerifiedAt = 0;
  private napitTabClickHint: { x: number; y: number; source: string } | null = null;
  private napitEnsureBackoffUntil = 0;

  // Dropdown scroll tracking.
  private dropdownFirstVisible = 0;
  private dropdownStateUnknown = false;
  private dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;
  private dropdownLastSnapshotLabels: Array<{ text: string; index: number; top: number; bottom: number; row: number }> = [];

  // Cache status by light/indicator for cases where PLC does not redraw unchanged icon.
  private lastStatusByIndicator = new Map<string, boolean>();

  constructor() {
    const protocolHost = config.protocol?.host || '192.168.1.10';
    const protocolPort = config.protocol?.port || 443;
    if (config.protocol?.debugRenderEnabled) {
      try {
        this.debugRenderer = new ProtocolDebugRenderer({
          outputDir: config.protocol?.debugRenderDir || './data/protocol-render-debug',
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
        logger.warn({ error }, 'Failed to initialize protocol debug renderer; continuing without rendered screenshots');
        this.debugRenderer = null;
      }
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
      sessionTraceDir: config.protocol?.sessionTraceDir || './data/protocol-trace',
      logRawFrameData: config.protocol?.logRawFrameData || false,
      postDataInHeader: config.protocol?.postDataInHeader || 'auto',
      deviceUsername: config.protocol?.deviceUsername || '',
      devicePassword: config.protocol?.devicePassword || '',
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
    const initialCommands = await this.waitForInitialRenderReady();
    this.captureNapitHint(initialCommands);

    logger.info('Navigating to Napit tab...');
    await this.ensureNapitTabActive(true, 'initialize');

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
    this.napitTabKnownActive = false;
    this.napitTabVerifiedAt = 0;
    this.napitTabClickHint = null;
    this.napitEnsureBackoffUntil = 0;
    this.dropdownFirstVisible = 0;
    this.dropdownStateUnknown = false;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;
    this.dropdownLastSnapshotLabels = [];
    this.lastStatusByIndicator.clear();
    logger.info('Protocol controller closed');
  }

  resetDropdownState(): void {
    this.dropdownStateUnknown = true;
    logger.info('Dropdown state marked as unknown - will scroll to top on next selection');
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
      await this.ensureNapitTabActive(false, 'navigateToTab');
      return;
    }

    logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
    const clickPaint = await this.client.click(coords.x, coords.y);
    const clickCommands = this.parseCommandsFromPaintResponse(clickPaint);
    const forcedCommands = await this.forceRenderOnce(`navigate:${tabName}`);
    this.captureNapitHint([...clickCommands, ...forcedCommands]);
    this.napitTabKnownActive = false;
  }

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string, selectionAttempt: number = 1): Promise<PaintCommand[]> {
    await this.ensureNapitTabActive(false, `select:${lightId}`);

    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }
    const maxSelectionAttempts = Math.max(
      1,
      config.protocol?.maxSelectionAttempts ?? ProtocolController.DEFAULT_MAX_LIGHT_SELECTION_ATTEMPTS,
    );
    const retrySelection = async (reason: string): Promise<PaintCommand[]> => {
      this.dropdownStateUnknown = true;
      this.napitTabKnownActive = false;
      if (selectionAttempt < maxSelectionAttempts) {
        logger.warn({ lightId, index, reason, selectionAttempt, maxSelectionAttempts }, 'Retrying light selection');
        return this.doSelectLightSwitch(lightId, selectionAttempt + 1);
      }
      throw new Error(`${reason}: light=${lightId}, index=${index}`);
    };

    logger.info(`Selecting light switch: ${lightId} (index: ${index}, attempt: ${selectionAttempt})`);

    const preOpenDelayMs = Math.max(0, config.protocol?.dropdownPreOpenDelayMs ?? 200);
    if (preOpenDelayMs > 0) await this.delay(preOpenDelayMs);
    const preClickCommands = await this.forceRenderOnce(`pre-dropdown-open:${lightId}`);
    if (this.detectKeypadDialog(preClickCommands)) {
      await this.dismissKeypadDialog();
      return retrySelection('Keypad dialog detected before dropdown open');
    }

    await this.client.click(
      uiCoordinates.lightSwitches.dropdownArrow.x,
      uiCoordinates.lightSwitches.dropdownArrow.y
    );
    const dropdownOpen = await this.waitForDropdownOpen(lightId);
    const dropdownOpenCommands = [...dropdownOpen.commands];
    if (!dropdownOpen.detected) {
      return retrySelection('Dropdown open render not detected');
    }
    this.syncDropdownStateFromCommands(dropdownOpenCommands, `dropdown-open:${lightId}`);

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const selectionSettleDelayMs = Math.max(0, config.protocol?.selectionSettleDelayMs ?? 220);
    const totalItems = lightSwitchList.length;
    const visibleItems = dropdownConfig.visibleItems;
    const maxFirstVisible = Math.max(0, totalItems - visibleItems);
    const stepCommands: PaintCommand[] = [...dropdownOpenCommands];
    let usedScrollbarDrag = false;

    if (this.dropdownStateUnknown) {
      logger.info('Dropdown state unknown - scrolling to top');
      await this.doDrag(
        scrollbarConfig.x, scrollbarConfig.thumbRange.bottomY,
        scrollbarConfig.x, scrollbarConfig.thumbRange.topY
      );
      usedScrollbarDrag = true;
      let synced = false;
      for (let probe = 1; probe <= 3; probe++) {
        const probeCommands = await this.forceRenderOnce(`dropdown-reset-probe:${lightId}:${probe}`);
        stepCommands.push(...probeCommands);
        synced = this.syncDropdownStateFromCommands(probeCommands, `dropdown-reset-probe:${lightId}:${probe}`) || synced;
        if (synced && this.dropdownFirstVisible <= 0) {
          break;
        }
        if (probe < 3) {
          await this.delay(100);
        }
      }
    }

    const scrollResult = await this.ensureDropdownIndexVisible(lightId, index, maxFirstVisible);
    stepCommands.push(...scrollResult.commands);
    if (scrollResult.usedDrag) {
      usedScrollbarDrag = true;
    }
    if (!scrollResult.visible) {
      return retrySelection('Dropdown scroll did not expose target item');
    }

    const positionInView = index - this.dropdownFirstVisible;
    const dynamicClickPoint = this.resolveDropdownItemClickPointFromSnapshot(index, positionInView);
    if (!dynamicClickPoint && (positionInView < 0 || positionInView >= visibleItems)) {
      return retrySelection(`Dropdown row out of view after scroll (position=${positionInView})`);
    }

    const itemClickYOffset = config.protocol?.dropdownItemClickYOffset ?? 2;
    let itemY: number;
    if (dynamicClickPoint) {
      const snapshotLabel = this.dropdownLastSnapshotLabels
        .find(l => l.index === index && l.row === dynamicClickPoint.row);
      const maxY = snapshotLabel ? snapshotLabel.bottom - 2 : Infinity;
      itemY = Math.min(dynamicClickPoint.y + itemClickYOffset, maxY);
    } else {
      const rowBottomY = dropdownConfig.firstItemY + ((positionInView + 1) * dropdownConfig.itemHeight) - 2;
      itemY = Math.min(
        dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight) + itemClickYOffset,
        rowBottomY,
      );
    }
    logger.info({
      lightId,
      index,
      positionInView,
      clickY: itemY,
      clickSource: dynamicClickPoint ? 'dynamic-label-center' : 'computed-row',
      dynamicRow: dynamicClickPoint?.row ?? null,
    }, 'Selecting dropdown item');

    const selectPaint = await this.client.click(dropdownConfig.itemX, itemY);
    const selectCommands = this.parseCommandsFromPaintResponse(selectPaint);
    const selectionCommands = await this.forceRenderOnce(`dropdown-select:${lightId}`);
    if (usedScrollbarDrag || selectionSettleDelayMs > 0) {
      await this.delay(selectionSettleDelayMs);
      const settledCommands = await this.forceRenderOnce(`dropdown-select-settle:${lightId}`);
      selectionCommands.push(...settledCommands);
    }

    const verificationSeed = [
      ...selectCommands,
      ...selectionCommands,
    ];

    const expectedLabel = this.getExpectedLightLabel(lightId, index);
    const verification = await this.verifyDropdownSelection(lightId, index, verificationSeed);
    const combinedCommands = [
      ...stepCommands,
      ...verification.commands,
    ];
    if (!verification.ok) {
      const hasVerificationText = !!verification.headerText || !!verification.firstPressText;
      if (hasVerificationText) {
        logger.warn({
          lightId,
          index,
          expectedLabel,
          actualLabel: verification.headerText,
          actualFirstPress: verification.firstPressText,
          verifyAttempts: verification.attempts,
          verifyElapsedMs: verification.elapsedMs,
        }, 'Dropdown selection verification failed');
        return retrySelection(`Dropdown selection verification failed (actual="${verification.headerText ?? verification.firstPressText ?? 'unknown'}")`);
      }
      logger.warn({
        lightId,
        index,
        expectedLabel,
        verifyAttempts: verification.attempts,
        verifyElapsedMs: verification.elapsedMs,
      }, 'Dropdown verification returned no readable labels; proceeding with best effort');
    } else if (verification.attempts > 0) {
      logger.info({
        lightId,
        expectedLabel,
        actualLabel: verification.headerText,
        actualFirstPress: verification.firstPressText,
        verifyAttempts: verification.attempts,
        verifyElapsedMs: verification.elapsedMs,
      }, 'Dropdown header verified');
    }

    logger.info(`Light switch ${lightId} selected`);
    return combinedCommands;
  }

  private async doDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    logger.debug(`Dragging from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
    const scrollSettleDelayMs = Math.max(0, config.protocol?.scrollSettleDelayMs ?? 800);
    const dragStartHoldMs = Math.max(0, config.protocol?.dragStartHoldMs ?? 60);
    const dragStepDelayMs = Math.max(0, config.protocol?.dragStepDelayMs ?? 45);
    const dragEndHoldMs = Math.max(0, config.protocol?.dragEndHoldMs ?? 50);

    await this.client.mouseMove(fromX, fromY);
    await this.client.mouseDown(fromX, fromY);
    if (dragStartHoldMs > 0) {
      await this.delay(dragStartHoldMs);
    }

    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(fromX + (toX - fromX) * t);
      const y = Math.round(fromY + (toY - fromY) * t);
      await this.client.mouseMove(x, y);
      if (dragStepDelayMs > 0) {
        await this.delay(dragStepDelayMs);
      }
    }

    if (dragEndHoldMs > 0) {
      await this.delay(dragEndHoldMs);
    }
    await this.client.mouseUp(toX, toY);
    if (scrollSettleDelayMs > 0) {
      await this.delay(scrollSettleDelayMs);
    }
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

      const togglePreClickDelayMs = Math.max(0, config.protocol?.togglePreClickDelayMs ?? 250);
      const togglePressHoldMs = Math.max(0, config.protocol?.togglePressHoldMs ?? 140);
      const togglePostClickDelayMs = Math.max(0, config.protocol?.togglePostClickDelayMs ?? 500);
      const togglePostRenderPolls = Math.max(1, config.protocol?.togglePostRenderPolls ?? 2);
      const togglePostRenderPollDelayMs = Math.max(0, config.protocol?.togglePostRenderPollDelayMs ?? 200);

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

      if (togglePreClickDelayMs > 0) {
        await this.delay(togglePreClickDelayMs);
      }
      await this.forceRenderOnce(`toggle-pre:${lightId}`);

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

      let totalPostCommands = 0;
      for (let poll = 1; poll <= togglePostRenderPolls; poll++) {
        const waitMs = poll === 1 ? togglePostClickDelayMs : togglePostRenderPollDelayMs;
        if (waitMs > 0) {
          await this.delay(waitMs);
        }
        const postCommands = await this.forceRenderOnce(`toggle-post:${lightId}:${poll}`);
        totalPostCommands += postCommands.length;
      }

      logger.info({
        lightId,
        functionNumber,
        postRenderPolls: togglePostRenderPolls,
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
      const hasDualFunction = !!(switchInfo as any)?.secondPress;
      const switchName = lightSwitchNames[index] || lightId;

      const selectionCommands = await this.doSelectLightSwitch(lightId);
      const allCommands = await this.collectStatusCommands(lightId, selectionCommands);

      const indicatorImages = this.resolveIndicatorImages(allCommands);

      let isOn1 = this.resolveLampStatus(indicatorImages.indicator1);
      if (isOn1 === null) {
        const cached = this.lastStatusByIndicator.get(`${lightId}:1`);
        if (cached !== undefined) {
          isOn1 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 1, using cached=${cached}`);
        } else {
          isOn1 = false;
          logger.warn(`No lamp image found for ${lightId} indicator 1, defaulting to OFF`);
        }
      }
      this.lastStatusByIndicator.set(`${lightId}:1`, isOn1);
      logger.info(`Status indicator 1 for ${lightId}: images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator1))}, isOn=${isOn1}`);

      let resolved2 = this.resolveLampStatus(indicatorImages.indicator2);
      if (resolved2 === null) {
        const cached = this.lastStatusByIndicator.get(`${lightId}:2`);
        if (cached !== undefined) {
          resolved2 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 2, using cached=${cached}`);
        } else {
          resolved2 = false;
        }
      }
      this.lastStatusByIndicator.set(`${lightId}:2`, resolved2);
      logger.info(`Status indicator 2 for ${lightId}: images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator2))}, isOn=${resolved2}`);

      let resolved3 = this.resolveLampStatus(indicatorImages.indicator3);
      if (resolved3 === null) {
        const cached = this.lastStatusByIndicator.get(`${lightId}:3`);
        if (cached !== undefined) {
          resolved3 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 3, using cached=${cached}`);
        } else {
          resolved3 = false;
        }
      }
      this.lastStatusByIndicator.set(`${lightId}:3`, resolved3);
      logger.info(`Status indicator 3 for ${lightId}: images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator3))}, isOn=${resolved3}`);

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

        if (attempt < maxAttempts) {
          await this.delay(120);
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
    const latest = this.debugRenderer.getLatestPng();
    return latest ?? null;
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

  private captureNapitHint(commands: PaintCommand[]): void {
    const labels = extractTextLabels(commands);
    const napitLabel = labels.find((label) => this.normalizeVisuText(label.text).includes('napit'));
    if (!napitLabel) return;

    const centerX = Math.round((napitLabel.left + napitLabel.right) / 2);
    const centerY = Math.round((napitLabel.top + napitLabel.bottom) / 2);
    this.napitTabClickHint = { x: centerX, y: centerY, source: `label:${napitLabel.text}` };
  }

  private parseCommandsFromPaintResponse(
    paintResponse: { commands: Uint8Array } | null | undefined,
  ): PaintCommand[] {
    if (!paintResponse || !paintResponse.commands || paintResponse.commands.length === 0) {
      return [];
    }
    try {
      return parsePaintCommands(paintResponse.commands);
    } catch (error) {
      logger.debug({ error }, 'Failed to parse paint commands from event response');
      return [];
    }
  }

  private isNapitContentLabel(text: string): boolean {
    const normalized = this.normalizeVisuText(text);
    return normalized.includes('valitse valaisin')
      || normalized.includes('1. painallus')
      || normalized.includes('ohjaus');
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

  private async ensureDropdownIndexVisible(
    lightId: string,
    index: number,
    maxFirstVisible: number,
  ): Promise<{ visible: boolean; commands: PaintCommand[]; usedDrag: boolean }> {
    const commands: PaintCommand[] = [];
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const dragXCandidates = [
      scrollbarConfig.x,
      scrollbarConfig.x + 2,
      scrollbarConfig.x - 2,
      scrollbarConfig.x - 4,
      scrollbarConfig.x - 6,
      scrollbarConfig.x - 8,
    ];
    const timeoutMs = Math.max(
      ProtocolController.MIN_DROPDOWN_SCROLL_TIMEOUT_MS,
      config.protocol?.dropdownScrollTimeoutMs ?? ProtocolController.DEFAULT_DROPDOWN_SCROLL_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(
      ProtocolController.MIN_DROPDOWN_SCROLL_POLL_INTERVAL_MS,
      config.protocol?.dropdownScrollPollIntervalMs ?? ProtocolController.DEFAULT_DROPDOWN_SCROLL_POLL_INTERVAL_MS,
    );

    if (this.isDropdownIndexVisible(index)) {
      return { visible: true, commands, usedDrag: false };
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let usedDrag = false;
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt++;
      const dragX = dragXCandidates[(attempt - 1) % dragXCandidates.length];
      const baseTargetFirstVisible = this.getTargetFirstVisible(index, maxFirstVisible);
      let targetFirstVisible = baseTargetFirstVisible;
      const direction = index >= this.dropdownFirstVisible ? 1 : -1;

      const currentScrollY = this.dropdownHandleCenterY || this.getDropdownScrollY(this.dropdownFirstVisible, maxFirstVisible);
      if (Math.abs(currentScrollY - this.getDropdownScrollY(targetFirstVisible, maxFirstVisible)) < 0.5 && !this.isDropdownIndexVisible(index)) {
        // When state and target collapse to the same Y while item is still not visible,
        // nudge one row to force movement and refresh scrollbar tracking.
        targetFirstVisible = Math.max(0, Math.min(maxFirstVisible, targetFirstVisible + direction));
      }
      const targetScrollY = this.getDropdownScrollY(targetFirstVisible, maxFirstVisible);

      logger.info(
        `Scrolling: firstVisible ${this.dropdownFirstVisible} -> ${targetFirstVisible}, baseTarget=${baseTargetFirstVisible}, dragX=${dragX}, scrollY ${currentScrollY.toFixed(1)} -> ${targetScrollY.toFixed(1)}`,
      );
      await this.doDrag(dragX, currentScrollY, dragX, targetScrollY);
      usedDrag = true;

      for (let probe = 1; probe <= 3; probe++) {
        const probeCommands = await this.forceRenderOnce(`dropdown-scroll-probe:${lightId}:${attempt}:${probe}`);
        commands.push(...probeCommands);
        this.syncDropdownStateFromCommands(probeCommands, `dropdown-scroll-probe:${lightId}:${attempt}:${probe}`);

        if (this.isDropdownIndexVisible(index)) {
          return { visible: true, commands, usedDrag };
        }

        if (probe < 3) {
          await this.delay(80);
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.delay(Math.min(pollIntervalMs, remainingMs));
    }

    logger.warn({
      lightId,
      index,
      firstVisible: this.dropdownFirstVisible,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
    }, 'Dropdown index did not become visible');

    return { visible: this.isDropdownIndexVisible(index), commands, usedDrag };
  }

  private getExpectedLightLabel(lightId: string, index: number): string {
    return lightSwitchNames[index] || lightId;
  }

  private resolveDropdownItemClickPointFromSnapshot(
    targetIndex: number,
    expectedRow: number,
  ): { x: number; y: number; row: number } | null {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const snapshotMatches = this.dropdownLastSnapshotLabels
      .filter((label) => label.index === targetIndex)
      .sort((a, b) => Math.abs(a.row - expectedRow) - Math.abs(b.row - expectedRow));
    const best = snapshotMatches[0] ?? null;

    if (!best) {
      return null;
    }

    return {
      x: dropdown.itemX,
      y: Math.round((best.top + best.bottom) / 2),
      row: best.row,
    };
  }

  private extractDropdownHeaderText(commands: PaintCommand[]): string | null {
    const dropdown = uiCoordinates.lightSwitches.dropdown;
    const dropdownList = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const labels = extractTextLabels(commands);
    const minLeft = Math.max(0, dropdown.x - 180);
    const maxRight = arrowX - 12;
    const minTop = Math.max(0, dropdown.y - 20);
    const maxBottom = dropdownList.firstItemY - 2;

    const candidates = labels
      .filter((label) => label.left >= minLeft && label.right <= maxRight)
      .filter((label) => label.top >= minTop && label.bottom <= maxBottom)
      .map((label) => ({
        text: label.text.replace(/\x00+$/g, '').trim(),
        width: Math.max(0, label.right - label.left),
        top: label.top,
        left: label.left,
      }))
      .filter((label) => label.text.length > 0)
      .sort((a, b) => b.width - a.width || a.top - b.top || a.left - b.left);

    return candidates[0]?.text ?? null;
  }

  private extractFirstPressLabelText(commands: PaintCommand[]): string | null {
    const dropdown = uiCoordinates.lightSwitches.dropdown;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const ohjausButton = uiCoordinates.lightSwitches.ohjausButton;
    const labels = extractTextLabels(commands);

    const minLeft = Math.max(0, dropdown.x - 180);
    const maxRight = arrowX - 12;
    const minTop = Math.max(0, ohjausButton.y - 26);
    const maxBottom = ohjausButton.y + 14;

    const candidates = labels
      .filter((label) => label.left >= minLeft && label.right <= maxRight)
      .filter((label) => label.top >= minTop && label.bottom <= maxBottom)
      .map((label) => ({
        text: label.text.replace(/\x00+$/g, '').trim(),
        width: Math.max(0, label.right - label.left),
        top: label.top,
        left: label.left,
      }))
      .filter((label) => label.text.length > 0)
      .filter((label) => this.normalizeVisuText(label.text) !== 'ohjaus')
      .sort((a, b) => b.width - a.width || a.top - b.top || a.left - b.left);

    return candidates[0]?.text ?? null;
  }

  private doesDropdownHeaderMatchExpected(headerText: string | null, expectedText: string): boolean {
    if (!headerText) return false;
    const actual = this.normalizeVisuText(headerText);
    const expected = this.normalizeVisuText(expectedText);
    if (!actual || !expected) return false;
    if (actual === expected) return true;
    return actual.includes(expected) || expected.includes(actual);
  }

  private async verifyDropdownSelection(
    lightId: string,
    index: number,
    seedCommands: PaintCommand[],
  ): Promise<{
    ok: boolean;
    headerText: string | null;
    firstPressText: string | null;
    commands: PaintCommand[];
    attempts: number;
    elapsedMs: number;
  }> {
    const timeoutMs = Math.max(
      ProtocolController.MIN_SELECTION_VERIFY_TIMEOUT_MS,
      config.protocol?.selectionVerifyTimeoutMs ?? ProtocolController.DEFAULT_SELECTION_VERIFY_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(
      ProtocolController.MIN_SELECTION_VERIFY_POLL_INTERVAL_MS,
      config.protocol?.selectionVerifyPollIntervalMs ?? ProtocolController.DEFAULT_SELECTION_VERIFY_POLL_INTERVAL_MS,
    );
    const expectedLabel = this.getExpectedLightLabel(lightId, index);
    const expectedFirstPress = lightSwitchById[lightId]?.firstPress ?? null;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const commands: PaintCommand[] = [...seedCommands];
    let attempts = 0;
    let headerText = this.extractDropdownHeaderText(seedCommands);
    let firstPressText = this.extractFirstPressLabelText(seedCommands);
    const isMatch = () => {
      if (this.doesDropdownHeaderMatchExpected(headerText, expectedLabel)) {
        return true;
      }
      if (!expectedFirstPress) {
        return false;
      }
      return this.doesDropdownHeaderMatchExpected(firstPressText, expectedFirstPress);
    };

    while (!isMatch() && Date.now() <= deadline) {
      attempts++;
      const forced = await this.forceRenderOnce(`dropdown-verify:${lightId}:${attempts}`);
      commands.push(...forced);
      const freshHeader = this.extractDropdownHeaderText(forced);
      if (freshHeader) {
        headerText = freshHeader;
      }
      const freshFirstPress = this.extractFirstPressLabelText(forced);
      if (freshFirstPress) {
        firstPressText = freshFirstPress;
      }
      if (isMatch()) {
        break;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.delay(Math.min(pollIntervalMs, remainingMs));
    }

    return {
      ok: isMatch(),
      headerText,
      firstPressText,
      commands,
      attempts,
      elapsedMs: Date.now() - startedAt,
    };
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
      if (this.normalizeVisuText(light.name) === normalized) {
        return light.index;
      }
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
    const wasUnknown = this.dropdownStateUnknown;
    this.dropdownFirstVisible = snapshot.firstVisible;
    this.dropdownStateUnknown = false;
    this.dropdownHandleCenterY = snapshot.handleCenterY;
    this.dropdownLastSnapshotLabels = snapshot.labels;

    if (wasUnknown || previousFirstVisible !== snapshot.firstVisible) {
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

  private async waitForDropdownOpen(lightId: string): Promise<{
    commands: PaintCommand[];
    detected: boolean;
    attempts: number;
    elapsedMs: number;
  }> {
    const timeoutMs = Math.max(
      ProtocolController.MIN_DROPDOWN_OPEN_TIMEOUT_MS,
      config.protocol?.dropdownOpenTimeoutMs ?? ProtocolController.DEFAULT_DROPDOWN_OPEN_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(
      ProtocolController.MIN_DROPDOWN_OPEN_POLL_INTERVAL_MS,
      config.protocol?.dropdownOpenPollIntervalMs ?? ProtocolController.DEFAULT_DROPDOWN_OPEN_POLL_INTERVAL_MS,
    );

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const collected: PaintCommand[] = [];
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt++;
      const commands = await this.forceRenderOnce(`dropdown-open:${lightId}:${attempt}`);
      collected.push(...commands);
      if (this.detectKeypadDialog(commands)) {
        const elapsedMs = Date.now() - startedAt;
        logger.warn({ lightId, attempts: attempt, elapsedMs }, 'Keypad dialog detected while waiting for dropdown');
        return { commands: collected, detected: false, attempts: attempt, elapsedMs };
      }
      const detected = this.syncDropdownStateFromCommands(commands, `dropdown-open:${lightId}:attempt:${attempt}`);
      if (detected) {
        const elapsedMs = Date.now() - startedAt;
        logger.info({ lightId, attempts: attempt, elapsedMs }, 'Dropdown open render ready');
        return { commands: collected, detected: true, attempts: attempt, elapsedMs };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.delay(Math.min(pollIntervalMs, remainingMs));
    }

    const elapsedMs = Date.now() - startedAt;
    logger.warn({
      lightId,
      attempts: attempt,
      elapsedMs,
      timeoutMs,
    }, 'Dropdown open render not detected; continuing with cached dropdown state');

    return { commands: collected, detected: false, attempts: attempt, elapsedMs };
  }

  private async collectStatusCommands(lightId: string, seedCommands: PaintCommand[]): Promise<PaintCommand[]> {
    const allCommands = [...seedCommands];
    const maxAttempts = Math.max(1, config.protocol?.statusMaxAttempts ?? 6);
    const pollDelayMs = Math.max(0, config.protocol?.statusPollDelayMs ?? 200);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const indicators = this.resolveIndicatorImages(allCommands);
      const ready =
        indicators.indicator1.length > 0 &&
        indicators.indicator2.length > 0 &&
        indicators.indicator3.length > 0;
      if (ready) {
        return allCommands;
      }

      const moreCommands = await this.forceRenderOnce(`status:${lightId}:${attempt}`);
      allCommands.push(...moreCommands);
      if (attempt < maxAttempts && pollDelayMs > 0) {
        await this.delay(pollDelayMs);
      }
    }

    return allCommands;
  }

  private collectLampImages(commands: PaintCommand[]): ImageDrawCommand[] {
    return extractDrawImages(commands)
      .filter((image) => this.isLampStatusImageId(image.imageId))
      .slice(-12);
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
    const remaining = indexed.filter((entry) => !used.has(entry.index));
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

  private detectKeypadDialog(commands: PaintCommand[]): boolean {
    const labels = extractTextLabels(commands);
    const texts = new Set(labels.map(l => l.text.replace(/\x00+$/g, '').trim()));
    let digitCount = 0;
    for (let d = 0; d <= 9; d++) {
      if (texts.has(String(d))) digitCount++;
    }
    return digitCount >= 8 && texts.has('ESC');
  }

  private async dismissKeypadDialog(): Promise<void> {
    const escButton = uiCoordinates.lightSwitches.keypadEscButton;
    logger.warn({ x: escButton.x, y: escButton.y }, 'Keypad dialog detected — clicking ESC to dismiss');
    await this.client.click(escButton.x, escButton.y);
    await this.delay(200);
    await this.forceRenderOnce('keypad-dismiss-settle');
    this.dropdownStateUnknown = true;
    this.napitTabKnownActive = false;
  }

  private async forceRenderOnce(reason: string): Promise<PaintCommand[]> {
    const request = buildViewportEvent(
      this.client.getClientId(),
      config.browser.viewport.width,
      config.browser.viewport.height,
      1.0,
      this.client.getSessionId()
    );

    const { allCommands } = await this.client.sendEventAndCollect(request);
    this.captureNapitHint(allCommands);

    logger.debug({ reason, commandCount: allCommands.length }, 'Forced render');
    return allCommands;
  }

  private async ensureNapitTabActive(forceClick: boolean, reason: string): Promise<void> {
    if (!forceClick && this.napitTabKnownActive) {
      return;
    }
    if (!forceClick && Date.now() < this.napitEnsureBackoffUntil) {
      return;
    }

    const coords = uiCoordinates.tabs.napit;
    const staticClickPoints = [
      { x: coords.x, y: coords.y, source: 'static' },
      { x: coords.x, y: coords.y + 10, source: 'static' },
      { x: coords.x, y: coords.y + 20, source: 'static' },
      { x: coords.x - 20, y: coords.y + 10, source: 'static' },
      { x: coords.x + 20, y: coords.y + 10, source: 'static' },
    ];

    const clickPoints: Array<{ x: number; y: number; source: string }> = [];
    const addClickPoint = (point: { x: number; y: number; source: string }) => {
      if (clickPoints.some((candidate) => candidate.x === point.x && candidate.y === point.y)) {
        return;
      }
      clickPoints.push(point);
    };
    if (this.napitTabClickHint) {
      addClickPoint(this.napitTabClickHint);
    }
    for (const point of staticClickPoints) {
      addClickPoint(point);
    }

    const maxAttempts = Math.max(8, clickPoints.length + 3);
    let sawAnyData = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let clickCommands: PaintCommand[] = [];
      const shouldClick = forceClick || attempt > 1;
      if (shouldClick) {
        const point = clickPoints[Math.min(attempt - 1, clickPoints.length - 1)] ?? staticClickPoints[0];
        logger.info({ reason, attempt, x: point.x, y: point.y, source: point.source }, 'Ensuring Napit tab is active');
        const clickPaint = await this.client.click(point.x, point.y);
        clickCommands = this.parseCommandsFromPaintResponse(clickPaint);
      }

      const commands: PaintCommand[] = [...clickCommands];
      for (let probe = 1; probe <= 3; probe++) {
        const forcedCommands = await this.forceRenderOnce(`napit-probe:${reason}:${attempt}:${probe}`);
        commands.push(...forcedCommands);

        const images = extractDrawImages(commands);
        const lampImages = images.filter((img) => this.isLampStatusImageId(img.imageId));
        const labels = extractTextLabels(commands);
        if (commands.length > 0 || labels.length > 0 || images.length > 0) {
          sawAnyData = true;
        }
        const napitContentLabels = labels.filter((label) => this.isNapitContentLabel(label.text));
        const topLabels = labels
          .filter((label) => label.top <= 55 && label.bottom <= 75)
          .map((label) => ({ text: label.text, left: label.left, top: label.top, right: label.right, bottom: label.bottom }));

        logger.info({
          reason,
          attempt,
          probe,
          imageCount: images.length,
          imageIds: images.map((img) => img.imageId),
          lampImageCount: lampImages.length,
          lampImages: lampImages.map((img) => img.imageId),
          napitContentLabelCount: napitContentLabels.length,
          topLabels,
          napitHint: this.napitTabClickHint,
        }, 'Napit tab probe');

        if (lampImages.length > 0 || napitContentLabels.length > 0) {
          this.napitTabKnownActive = true;
          this.napitTabVerifiedAt = Date.now();
          this.napitEnsureBackoffUntil = 0;
          return;
        }

        if (probe < 3) {
          await this.delay(120);
        }
      }
    }

    if (!sawAnyData && this.napitTabKnownActive) {
      logger.warn({ reason }, 'Napit probes returned only empty frames; keeping previously verified active state');
      this.napitEnsureBackoffUntil = Date.now() + 2000;
      return;
    }

    logger.warn({ reason }, 'Failed to verify Napit tab by lamp/images labels; continuing with best effort');
    this.napitTabKnownActive = false;
    this.napitTabVerifiedAt = 0;
    this.napitEnsureBackoffUntil = Date.now() + 2000;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
