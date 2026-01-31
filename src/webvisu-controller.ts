import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { config, uiCoordinates, lightSwitches, lightSwitchNames, lightSwitchById } from './config';
import pino from 'pino';

const logger = pino({ name: 'webvisu-controller' });

export interface LightStatus {
  id: string;
  name: string;
  isOn: boolean;
  isOn2?: boolean; // Second function status for dual-function switches
}

export class WebVisuController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isInitialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();

  // Track the current scrollbar thumb Y position (null = at top/initial position)
  private scrollbarThumbY: number | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Launching browser...');
    this.browser = await chromium.launch({
      headless: config.browser.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: config.browser.viewport,
      ignoreHTTPSErrors: true, // WebVisu often uses self-signed certs
      // HTTP Basic Authentication
    });

    this.page = await this.context.newPage();

    logger.info(`Navigating to ${config.webvisu.url}...`);

    try {
      // Use 'domcontentloaded' instead of 'networkidle' because WebVisu has continuous polling
      await this.page.goto(config.webvisu.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.webvisu.loadTimeout,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to navigate to WebVisu URL. Check network connectivity and credentials.');
      throw error;
    }

    logger.info('Page loaded, waiting for canvas element...');

    // Wait for the canvas to be ready
    // WebVisu uses a canvas element for rendering
    try {
      await this.page.waitForSelector('canvas', { timeout: config.webvisu.loadTimeout });
    } catch (error) {
      // Take a screenshot to help diagnose the issue
      const screenshot = await this.page.screenshot();
      const fs = await import('fs');
      fs.writeFileSync('debug-no-canvas.png', screenshot);
      logger.error('Canvas not found. Screenshot saved to debug-no-canvas.png');
      logger.error('Page content may indicate auth failure or different page structure.');
      throw new Error('Canvas element not found - check debug-no-canvas.png');
    }

    logger.info('Canvas found, waiting for WebVisu to render...');

    // Give the WebVisu app time to fully render (canvas exists but takes time to draw)
    await this.delay(config.webvisu.canvasRenderDelay);

    // Log canvas position for debugging
    const canvas = await this.page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (box) {
      logger.info(`Canvas position: x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`);
    }

    this.isInitialized = true;
    logger.info('WebVisu controller initialized successfully');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isInitialized = false;
      logger.info('Browser closed');
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.page) {
      throw new Error('WebVisu controller not initialized. Call initialize() first.');
    }
  }

  // Serialize operations to prevent race conditions on the canvas
  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  private async clickCanvas(x: number, y: number): Promise<void> {
    this.ensureInitialized();

    // Get the canvas bounding box to calculate absolute page coordinates
    const canvas = await this.page!.locator('canvas').first();
    const box = await canvas.boundingBox();

    if (!box) {
      throw new Error('Could not get canvas bounding box');
    }

    // Calculate absolute page coordinates
    const absX = box.x + x;
    const absY = box.y + y;

    logger.debug(`Clicking canvas at relative (${x}, ${y}), absolute (${absX}, ${absY})`);

    // Use mouse.click for precise clicking without scroll side effects
    await this.page!.mouse.click(absX, absY);
    // Note: caller should add appropriate delay after click
  }

  // Click at absolute page coordinates (for elements outside canvas)
  private async clickPage(x: number, y: number): Promise<void> {
    this.ensureInitialized();
    logger.debug(`Clicking page at absolute (${x}, ${y})`);
    await this.page!.mouse.click(x, y);
    // Note: caller should add appropriate delay after click
  }

  // Drag from one canvas position to another (for scrollbars)
  private async dragCanvas(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    this.ensureInitialized();

    // Get the canvas bounding box to calculate absolute page coordinates
    const canvas = await this.page!.locator('canvas').first();
    const box = await canvas.boundingBox();

    if (!box) {
      throw new Error('Could not get canvas bounding box');
    }

    // Calculate absolute page coordinates
    const absFromX = box.x + fromX;
    const absFromY = box.y + fromY;
    const absToX = box.x + toX;
    const absToY = box.y + toY;

    logger.debug(`Dragging from (${absFromX}, ${absFromY}) to (${absToX}, ${absToY})`);

    // Perform drag: move to start, press, move to end, release
    await this.page!.mouse.move(absFromX, absFromY);
    await this.page!.mouse.down();
    await this.delay(50); // Small delay after pressing
    await this.page!.mouse.move(absToX, absToY, { steps: 10 }); // Smooth movement
    await this.delay(50); // Small delay before releasing
    await this.page!.mouse.up();
    // Note: caller should add appropriate delay after drag
  }

  async navigateToTab(tabName: keyof typeof uiCoordinates.tabs): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      const coords = uiCoordinates.tabs[tabName];
      logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);

      // Tabs might be outside the canvas, try clicking at page coordinates first
      // The tab bar is typically at the top of the page
      await this.clickPage(coords.x, coords.y);
      await this.delay(config.webvisu.delays.tabClick);
    });
  }

  // Get canvas info for debugging coordinate issues
  async getCanvasInfo(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    this.ensureInitialized();
    const canvas = await this.page!.locator('canvas').first();
    return canvas.boundingBox();
  }

  // Internal method - does not queue (for use within other queued operations)
  private async doSelectLightSwitch(lightId: string): Promise<void> {
    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    logger.info(`Selecting light switch: ${lightId} (index: ${index})`);

    // First ensure we're on the Napit (buttons) tab
    await this.clickPage(uiCoordinates.tabs.napit.x, uiCoordinates.tabs.napit.y);
    await this.delay(config.webvisu.delays.tabClick);

    // Click the dropdown arrow to open it
    await this.clickCanvas(
      uiCoordinates.lightSwitches.dropdownArrow.x,
      uiCoordinates.lightSwitches.dropdownArrow.y
    );
    await this.delay(config.webvisu.delays.dropdownOpen);

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const totalItems = 56;

    // Check if item is beyond the initially visible items and needs scrolling
    if (index >= dropdownConfig.visibleItems) {
      // Calculate scroll position: where should the scrollbar thumb be dragged to?
      const scrollRange = scrollbarConfig.track.bottomY - scrollbarConfig.track.topY;

      // Calculate the scroll position proportionally
      // Scroll so that the target item is visible in the dropdown
      const scrollPosition = (index - dropdownConfig.visibleItems + 1) / (totalItems - dropdownConfig.visibleItems);
      const targetScrollY = scrollbarConfig.track.topY + (scrollRange * Math.min(scrollPosition, 1));

      // Start from remembered position, or from thumb start if not set
      const currentThumbY = this.scrollbarThumbY ?? scrollbarConfig.thumbStart.y;

      logger.info(`Dragging scrollbar from (${scrollbarConfig.track.x}, ${currentThumbY}) to (${scrollbarConfig.track.x}, ${targetScrollY}) for item index ${index}`);

      // Drag the scrollbar thumb from current position to target position
      await this.dragCanvas(
        scrollbarConfig.track.x,
        currentThumbY,
        scrollbarConfig.track.x,
        targetScrollY
      );

      // Remember where we left the scrollbar thumb
      this.scrollbarThumbY = targetScrollY;

      await this.delay(config.webvisu.delays.dropdownScroll);

      // Calculate position of item within visible area after scrolling
      // After scrolling, the target item should be near the bottom of visible area
      const visiblePosition = dropdownConfig.visibleItems - 1; // Last visible slot
      const itemY = dropdownConfig.firstItemY + (visiblePosition * dropdownConfig.itemHeight);

      await this.clickCanvas(dropdownConfig.itemX, itemY);
    } else {
      // Item is in the initially visible range, just click it directly
      const itemY = dropdownConfig.firstItemY + (index * dropdownConfig.itemHeight);
      await this.clickCanvas(dropdownConfig.itemX, itemY);
    }

    await this.delay(config.webvisu.delays.dropdownSelect);
    logger.info(`Light switch ${lightId} selected`);
  }

  // Public method - queued for external callers
  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();

      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      // First select the light switch (using internal non-queued method)
      await this.doSelectLightSwitch(lightId);

      // Click the appropriate "Ohjaus" button based on function number
      const ohjausButton = functionNumber === 2
        ? uiCoordinates.lightSwitches.ohjausButton2
        : uiCoordinates.lightSwitches.ohjausButton;

      await this.clickCanvas(ohjausButton.x, ohjausButton.y);
      await this.delay(config.webvisu.delays.toggleButton);

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

      // Select the light first (using internal non-queued method)
      await this.doSelectLightSwitch(lightId);
      await this.delay(config.webvisu.delays.statusRead);

      // Check if this is a dual-function switch
      const switchInfo = lightSwitchById[lightId];
      const hasDualFunction = !!(switchInfo as any)?.secondPress;

      // Read the first status indicator
      const isOn = await this.checkStatusIndicator(1);

      // Read the second status indicator for dual-function switches
      let isOn2: boolean | undefined;
      if (hasDualFunction) {
        isOn2 = await this.checkStatusIndicator(2);
      }

      return {
        id: lightId,
        name: lightSwitchNames[index] || lightId,
        isOn,
        ...(isOn2 !== undefined ? { isOn2 } : {}),
      };
    });
  }

  private async checkStatusIndicator(indicatorNumber: 1 | 2 = 1): Promise<boolean> {
    this.ensureInitialized();

    const coords = indicatorNumber === 2
      ? uiCoordinates.lightSwitches.statusIndicator2
      : uiCoordinates.lightSwitches.statusIndicator;

    // Get the canvas bounding box to calculate absolute coordinates
    const canvas = await this.page!.locator('canvas').first();
    const box = await canvas.boundingBox();

    if (!box) {
      logger.warn('Could not get canvas bounding box');
      return false;
    }

    // Take a screenshot and sample pixels from it (more reliable than canvas context)
    const screenshot = await this.page!.screenshot({ type: 'png' });

    // Calculate absolute page coordinates for the status indicator
    const absX = Math.round(box.x + coords.x);
    const absY = Math.round(box.y + coords.y);

    // Use page.evaluate to decode PNG and read pixel at specific position
    const result = await this.page!.evaluate(async ({ imageData, x, y }) => {
      return new Promise<{ success: boolean; isOn: boolean; r: number; g: number; b: number; error?: string }>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve({ success: false, isOn: false, r: 0, g: 0, b: 0, error: 'Could not create canvas context' });
            return;
          }
          ctx.drawImage(img, 0, 0);
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          const r = pixel[0], g = pixel[1], b = pixel[2];

          // Yellow detection: high green (>140) AND high red (>140) indicates ON
          // Brown OFF has low green (<100)
          const isOn = g > 140 && r > 140;

          resolve({ success: true, isOn, r, g, b });
        };
        img.onerror = () => {
          resolve({ success: false, isOn: false, r: 0, g: 0, b: 0, error: 'Failed to load image' });
        };
        img.src = `data:image/png;base64,${imageData}`;
      });
    }, { imageData: screenshot.toString('base64'), x: absX, y: absY });

    if (result.success) {
      logger.info(`Status indicator at page (${absX}, ${absY}) / canvas (${coords.x}, ${coords.y}): R=${result.r} G=${result.g} B=${result.b} → isOn=${result.isOn}`);
    } else {
      logger.warn(`Failed to read status indicator: ${result.error}`);
    }

    return result.isOn;
  }

  // Debug method to save a screenshot with indicator position marked
  async debugStatusIndicator(): Promise<{ screenshot: Buffer; position: { x: number; y: number }; color: { r: number; g: number; b: number } }> {
    this.ensureInitialized();

    const coords = uiCoordinates.lightSwitches.statusIndicator;
    const canvas = await this.page!.locator('canvas').first();
    const box = await canvas.boundingBox();

    const absX = box ? Math.round(box.x + coords.x) : coords.x;
    const absY = box ? Math.round(box.y + coords.y) : coords.y;

    // Take screenshot
    const screenshot = await this.page!.screenshot({ type: 'png' });

    // Read the pixel color at that position
    const result = await this.page!.evaluate(async ({ imageData, x, y }) => {
      return new Promise<{ r: number; g: number; b: number }>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve({ r: 0, g: 0, b: 0 });
            return;
          }
          ctx.drawImage(img, 0, 0);
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          resolve({ r: pixel[0], g: pixel[1], b: pixel[2] });
        };
        img.onerror = () => resolve({ r: 0, g: 0, b: 0 });
        img.src = `data:image/png;base64,${imageData}`;
      });
    }, { imageData: screenshot.toString('base64'), x: absX, y: absY });

    return {
      screenshot,
      position: { x: absX, y: absY },
      color: result,
    };
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
          isOn: false, // Default to off on error
        });
      }
    }

    return lights;
  }

  async takeScreenshot(): Promise<Buffer> {
    this.ensureInitialized();
    return this.page!.screenshot();
  }

  async isConnected(): Promise<boolean> {
    try {
      if (!this.page) return false;
      await this.page.evaluate(() => document.readyState);
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const webVisuController = new WebVisuController();
