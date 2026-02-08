// Drop-in replacement controller using CoDeSys binary protocol instead of Playwright

import { config, uiCoordinates, lightSwitches, lightSwitchNames, lightSwitchById, lightSwitchList } from './config';
import { IWebVisuController, LightStatus } from './controller-interface';
import { WebVisuProtocolClient } from './protocol/client';
import { buildMouseDown, buildMouseUp, buildHeartbeat } from './protocol/messages';
import {
  parsePaintCommands,
  extractStatusColors,
  extractStatusImages,
  extractDrawImages,
  extractTextLabels,
  determineStatus,
  determineStatusFromImages,
  ImageDrawCommand,
} from './protocol/paint-commands';
import pino from 'pino';

const logger = pino({ name: 'protocol-controller' });

export class ProtocolController implements IWebVisuController {
  private client: WebVisuProtocolClient;
  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private statusByImageId = new Map<string, boolean>();
  private lastImageByIndicator = new Map<string, string>();
  private lastStatusByIndicator = new Map<string, boolean>();
  private napitTabVerifiedAt = 0;
  private napitTabKnownActive = false;

  // Dropdown scroll tracking — same logic as WebVisuController
  private dropdownFirstVisible: number = 0;
  private dropdownStateUnknown: boolean = false;

  constructor() {
    this.client = new WebVisuProtocolClient({
      host: config.protocol?.host || '192.168.1.10',
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
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Initializing protocol controller...');

    try {
      await this.client.connect();
    } catch (e) {
      logger.error('Error occurred: ' +  e);
      throw e;
    }

    // Match Playwright baseline: wait for initial visualization render.
    await this.delay(config.webvisu.canvasRenderDelay);

    // Send a heartbeat to get initial paint data
    await this.client.heartbeat();

    // Navigate to the Napit tab
    logger.info('Navigating to Napit tab...');
    await this.doNavigateToTab('napit');

    this.initialized = true;
    logger.info('Protocol controller initialized successfully');
  }

  async close(): Promise<void> {
    await this.client.disconnect();
    this.initialized = false;
    this.dropdownFirstVisible = 0;
    this.dropdownStateUnknown = false;
    this.napitTabVerifiedAt = 0;
    this.napitTabKnownActive = false;
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
      await this.ensureNapitTabActive(!this.napitTabKnownActive, 'navigateToTab');
      return;
    }
    logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
    await this.client.click(coords.x, coords.y);
    await this.delay(config.webvisu.delays.tabClick);
    // Send heartbeat to get updated paint
    await this.client.heartbeat();
    this.napitTabVerifiedAt = 0;
    this.napitTabKnownActive = false;
  }

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string): Promise<void> {
    await this.ensureNapitTabActive(false, `select:${lightId}`);

    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    logger.info(`Selecting light switch: ${lightId} (index: ${index})`);

    // Click the dropdown arrow to open it
    await this.client.click(
      uiCoordinates.lightSwitches.dropdownArrow.x,
      uiCoordinates.lightSwitches.dropdownArrow.y
    );
    await this.delay(config.webvisu.delays.dropdownOpen);

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const totalItems = 57;
    const { visibleItems } = dropdownConfig;

    const { topY, bottomY } = scrollbarConfig.thumbRange;
    const scrollRange = bottomY - topY;
    const maxFirstVisible = totalItems - visibleItems;

    const getTargetScrollY = (firstVisible: number): number => {
      if (firstVisible <= 0) return topY;
      if (firstVisible >= maxFirstVisible) return bottomY;
      return topY + (scrollRange * firstVisible / maxFirstVisible);
    };

    // If dropdown state is unknown, scroll to top first
    if (this.dropdownStateUnknown) {
      logger.info('Dropdown state unknown - scrolling to top');
      await this.doDrag(
        scrollbarConfig.x, scrollbarConfig.thumbRange.bottomY,
        scrollbarConfig.x, scrollbarConfig.thumbRange.topY
      );
      this.dropdownFirstVisible = 0;
      this.dropdownStateUnknown = false;
    }

    // Check if item is currently visible
    const isVisible = index >= this.dropdownFirstVisible &&
                      index < this.dropdownFirstVisible + visibleItems;

    let itemY: number;

    if (isVisible) {
      const positionInView = index - this.dropdownFirstVisible;
      itemY = dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight);
      logger.info(`Item ${index} already visible at position ${positionInView}, clicking at Y=${itemY}`);
    } else {
      // Need to scroll
      let targetFirstVisible: number;

      if (index > this.dropdownFirstVisible) {
        targetFirstVisible = index;
      } else {
        targetFirstVisible = Math.max(0, index - (visibleItems - 1));
      }
      targetFirstVisible = Math.min(targetFirstVisible, maxFirstVisible);

      // Calculate scroll positions
      const currentScrollY = getTargetScrollY(this.dropdownFirstVisible);
      const targetScrollY = getTargetScrollY(targetFirstVisible);

      logger.info(`Scrolling: firstVisible ${this.dropdownFirstVisible} → ${targetFirstVisible}, scrollY ${currentScrollY.toFixed(1)} → ${targetScrollY.toFixed(1)}`);

      await this.doDrag(
        scrollbarConfig.x, currentScrollY,
        scrollbarConfig.x, targetScrollY
      );

      this.dropdownFirstVisible = targetFirstVisible;

      const positionInView = index - targetFirstVisible;
      itemY = dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight);
      logger.info(`After scroll, item ${index} at position ${positionInView}, clicking at Y=${itemY}`);
    }

    // Click the item
    await this.client.click(dropdownConfig.itemX, itemY);
    await this.delay(config.webvisu.delays.dropdownSelect);
    // Pull pending paint updates after selection (browser client has a continuous poll loop).
    await this.client.heartbeat();

    logger.info(`Light switch ${lightId} selected`);
  }

  /**
   * Simulate a drag operation via protocol mouse events.
   * Drag from (fromX, fromY) to (toX, toY).
   */
  private async doDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    logger.debug(`Dragging from (${fromX}, ${fromY}) to (${toX}, ${toY})`);

    // Match browser semantics: move to source before pressing.
    await this.client.mouseMove(fromX, fromY);

    // Mouse down at start position
    await this.client.mouseDown(fromX, fromY);
    await this.delay(config.webvisu.delays.dropdownScrollStart);

    // Send intermediate move events while dragging.
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(fromX + (toX - fromX) * t);
      const y = Math.round(fromY + (toY - fromY) * t);
      await this.client.mouseMove(x, y);
      await this.delay(Math.max(10, Math.floor(config.webvisu.delays.dropdownScrollDrag / steps)));
    }

    // Mouse up at target position (simulates drag)
    await this.client.mouseUp(toX, toY);
    await this.delay(config.webvisu.delays.dropdownScrollStop);
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();

      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

      const ohjausButton = uiCoordinates.lightSwitches.ohjausButton;
      await this.client.click(ohjausButton.x, ohjausButton.y);
      await this.delay(config.webvisu.delays.toggleButton);
      // Pull post-toggle paint updates.
      await this.client.heartbeat();

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

      // Select the light
      await this.doSelectLightSwitch(lightId);
      await this.delay(config.webvisu.delays.statusRead);

      // Send heartbeat and collect paint data to read status
      const heartbeatBuf = buildHeartbeat(this.client.getClientId(), this.client.getSessionId());
      let { allCommands } = await this.client.sendEventAndCollect(heartbeatBuf);

      // Extract status from paint commands
      const statusCoords1 = uiCoordinates.lightSwitches.statusIndicator;
      let colors1 = extractStatusColors(allCommands, {
        x: statusCoords1.x,
        y: statusCoords1.y,
        tolerance: 15,
      });
      let images1 = extractStatusImages(allCommands, {
        x: statusCoords1.x,
        y: statusCoords1.y,
        tolerance: 15,
      });
      if (colors1.length === 0 && images1.length === 0) {
        // If first poll has no indicator draw commands yet, wait and poll once more.
        await this.delay(Math.max(100, config.webvisu.delays.statusRead));
        const retry = await this.client.sendEventAndCollect(heartbeatBuf);
        allCommands = retry.allCommands;
        colors1 = extractStatusColors(allCommands, {
          x: statusCoords1.x,
          y: statusCoords1.y,
          tolerance: 15,
        });
        images1 = extractStatusImages(allCommands, {
          x: statusCoords1.x,
          y: statusCoords1.y,
          tolerance: 15,
        });
        logger.info(`Status poll retry for ${lightId} indicator 1: images=${images1.length}, colors=${colors1.length}`);
      }
      const isOn1 = this.resolveImageBackedStatus(lightId, 1, images1) ?? determineStatusFromImages(images1) ?? determineStatus(colors1);

      if (isOn1 === null) {
        logger.warn(`No status colors/images found for ${lightId} indicator 1, defaulting to OFF`);
      }

      logger.info(
        `Status indicator 1 for ${lightId}: images=${JSON.stringify(images1.slice(-2).map(i => ({ id: i.imageId, tint: i.tintColor, flags: i.flags })))}, colors=${JSON.stringify(colors1.slice(-3))}, isOn=${isOn1}`
      );

      let isOn2: boolean | undefined;
      if (hasDualFunction) {
        const statusCoords2 = uiCoordinates.lightSwitches.statusIndicator2;
        const colors2 = extractStatusColors(allCommands, {
          x: statusCoords2.x,
          y: statusCoords2.y,
          tolerance: 15,
        });
        const images2 = extractStatusImages(allCommands, {
          x: statusCoords2.x,
          y: statusCoords2.y,
          tolerance: 15,
        });
        isOn2 = this.resolveImageBackedStatus(lightId, 2, images2) ?? determineStatusFromImages(images2) ?? determineStatus(colors2) ?? false;
        logger.info(
          `Status indicator 2 for ${lightId}: images=${JSON.stringify(images2.slice(-2).map(i => ({ id: i.imageId, tint: i.tintColor, flags: i.flags })))}, colors=${JSON.stringify(colors2.slice(-3))}, isOn=${isOn2}`
        );
      }

      return {
        id: lightId,
        name: switchName,
        isOn: isOn1 ?? false,
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
    // Not available via protocol - return empty buffer
    logger.warn('takeScreenshot() not available in protocol mode');
    return Buffer.alloc(0);
  }

  async isConnected(): Promise<boolean> {
    return this.client.isConnected();
  }

  // --- Private helpers ---

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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isLampStatusImageId(imageId: string): boolean {
    const normalized = imageId
      .toLowerCase()
      .replace(/\x00+$/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    return normalized.includes('element-lamp-lamp1-yellow-on') ||
      normalized.includes('element-lamp-lamp1-yellow-off');
  }

  private normalizeVisuText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\x00+$/g, '')
      .trim();
  }

  private async ensureNapitTabActive(forceClick: boolean, reason: string): Promise<void> {
    if (!forceClick && this.napitTabKnownActive) {
      return;
    }

    const now = Date.now();
    const verifyTtlMs = 5000;
    if (!forceClick && now - this.napitTabVerifiedAt < verifyTtlMs) {
      return;
    }

    const coords = uiCoordinates.tabs.napit;
    const staticClickPoints = [
      { x: coords.x, y: coords.y },
      { x: coords.x, y: coords.y + 10 },
      { x: coords.x, y: coords.y + 20 },
      { x: coords.x - 20, y: coords.y + 10 },
      { x: coords.x + 20, y: coords.y + 10 },
    ];
    const dynamicClickPoints = new Map<string, { x: number; y: number; source: string }>();
    const maxAttempts = staticClickPoints.length + 6;
    let sawAnyImages = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const shouldClick = forceClick || attempt > 1;
      if (shouldClick) {
        const dynamic = Array.from(dynamicClickPoints.values())[attempt - staticClickPoints.length - 1];
        const point = dynamic ?? staticClickPoints[Math.min(attempt - 1, staticClickPoints.length - 1)];
        logger.info({ reason, attempt, x: point.x, y: point.y, source: dynamic ? point.source : 'static' }, 'Ensuring Napit tab is active');
        await this.client.click(point.x, point.y);
        await this.delay(config.webvisu.delays.tabClick);
      }

      const heartbeatBuf = buildHeartbeat(this.client.getClientId(), this.client.getSessionId());
      const { allCommands } = await this.client.sendEventAndCollect(heartbeatBuf);
      const images = extractDrawImages(allCommands);
      if (images.length > 0) {
        sawAnyImages = true;
      }
      const lampImages = images.filter((image) => this.isLampStatusImageId(image.imageId));
      const labels = extractTextLabels(allCommands);
      const topLabels = labels
        .filter((label) => label.top <= 50 && label.bottom <= 70)
        .map((label) => ({ text: label.text, left: label.left, top: label.top, right: label.right, bottom: label.bottom }));
      const napitLabel = labels.find((label) => this.normalizeVisuText(label.text).includes('napit'));

      if (napitLabel) {
        const centerX = Math.round((napitLabel.left + napitLabel.right) / 2);
        const centerY = Math.round((napitLabel.top + napitLabel.bottom) / 2);
        const key = `${centerX}:${centerY}`;
        if (!dynamicClickPoints.has(key)) {
          dynamicClickPoints.set(key, { x: centerX, y: centerY, source: `label:${napitLabel.text}` });
        }
      }

      logger.info({
        reason,
        attempt,
        imageCount: images.length,
        imageIds: images.map((image) => image.imageId),
        lampImageCount: lampImages.length,
        lampImages: lampImages.map((image) => image.imageId),
        topLabels,
        dynamicClickPoints: Array.from(dynamicClickPoints.values()),
      }, 'Napit tab probe');

      if (lampImages.length > 0) {
        this.napitTabKnownActive = true;
        this.napitTabVerifiedAt = Date.now();
        return;
      }

      await this.delay(Math.max(100, config.webvisu.delays.statusRead));
    }
    if (this.napitTabKnownActive && !sawAnyImages) {
      logger.warn({ reason }, 'Napit tab probe returned no paint updates; keeping previously verified active state');
      this.napitTabVerifiedAt = Date.now();
      return;
    }

    logger.warn({ reason }, 'Failed to verify Napit tab by lamp symbols; continuing with best effort');
    this.napitTabKnownActive = false;
  }

  private resolveImageBackedStatus(
    lightId: string,
    indicator: 1 | 2,
    images: ImageDrawCommand[]
  ): boolean | null {
    if (images.length === 0) return null;

    const last = images[images.length - 1];
    const imageKey = last.imageId.trim().toLowerCase();
    if (!imageKey) return null;

    const direct = determineStatusFromImages(images);
    if (direct !== null) {
      this.statusByImageId.set(imageKey, direct);
      this.rememberIndicatorObservation(lightId, indicator, imageKey, direct);
      return direct;
    }

    const known = this.statusByImageId.get(imageKey);
    if (known !== undefined) {
      this.rememberIndicatorObservation(lightId, indicator, imageKey, known);
      return known;
    }

    const indicatorKey = `${lightId}:${indicator}`;
    const previousImage = this.lastImageByIndicator.get(indicatorKey);
    const previousStatus = this.lastStatusByIndicator.get(indicatorKey);
    if (previousImage && previousStatus !== undefined && previousImage !== imageKey) {
      const inferred = !previousStatus;
      this.statusByImageId.set(imageKey, inferred);
      this.rememberIndicatorObservation(lightId, indicator, imageKey, inferred);
      logger.info({ lightId, indicator, previousImage, imageKey, inferred }, 'Inferred status mapping from image transition');
      return inferred;
    }

    this.rememberIndicatorObservation(lightId, indicator, imageKey, null);
    return null;
  }

  private rememberIndicatorObservation(
    lightId: string,
    indicator: 1 | 2,
    imageKey: string,
    status: boolean | null
  ): void {
    const indicatorKey = `${lightId}:${indicator}`;
    this.lastImageByIndicator.set(indicatorKey, imageKey);
    if (status !== null) {
      this.lastStatusByIndicator.set(indicatorKey, status);
    }
  }
}
