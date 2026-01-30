/**
 * Interactive calibration tool
 *
 * Run with: npx ts-node src/calibrate.ts
 *
 * Opens a visible browser and logs click coordinates to help
 * configure the UI mappings in config.ts
 */

import { chromium } from 'playwright';
import { config } from './config';

async function main() {
  console.log('='.repeat(60));
  console.log('WAGO WebVisu Interactive Calibration Tool');
  console.log('='.repeat(60));
  console.log();
  console.log('A browser window will open. Click on UI elements to');
  console.log('see their coordinates logged here. Press Ctrl+C to exit.');
  console.log();

  const browser = await chromium.launch({
    headless: false, // Always visible for calibration
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  try {
    console.log(`Navigating to ${config.webvisu.url}...`);
    await page.goto(config.webvisu.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.webvisu.loadTimeout,
    });

    console.log('Waiting for canvas element...');
    await page.waitForSelector('canvas', { timeout: config.webvisu.loadTimeout });

    console.log('Waiting for canvas to render...');
    await page.waitForTimeout(config.webvisu.canvasRenderDelay);

    // Get canvas bounding box
    const canvas = await page.locator('canvas').first();
    const box = await canvas.boundingBox();

    if (box) {
      console.log();
      console.log(`Canvas found at: x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`);
      console.log();
    }

    console.log('Ready! Click anywhere in the browser window.');
    console.log('Coordinates will be logged below (relative to canvas).');
    console.log('Press Ctrl+C to exit.');
    console.log();
    console.log('-'.repeat(60));

    // Use Playwright's page-level click event listener
    page.on('console', msg => {
      if (msg.text().startsWith('COORD:')) {
        console.log(msg.text().replace('COORD:', 'Click at:'));
      }
    });

    // Inject a more aggressive click handler
    await page.evaluate(() => {
      // Capture clicks on the entire document
      document.addEventListener('click', (event) => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const x = Math.round(event.clientX - rect.left);
          const y = Math.round(event.clientY - rect.top);
          console.log(`COORD: { x: ${x}, y: ${y} } (page: ${event.clientX}, ${event.clientY})`);
        } else {
          console.log(`COORD: page coordinates: { x: ${event.clientX}, y: ${event.clientY} } (no canvas found)`);
        }
      }, true); // Use capture phase to catch all clicks
    });

    // Also listen for mouse clicks via CDP
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('DOM.enable');
    await cdpSession.send('Overlay.enable');

    // Set up mouse position tracking via periodic polling
    setInterval(async () => {
      try {
        const mousePos = await page.evaluate(() => {
          return (window as any).__lastMousePos || null;
        });
        if (mousePos) {
          process.stdout.write(`\rMouse: x=${mousePos.x}, y=${mousePos.y}    `);
        }
      } catch {
        // Ignore errors during shutdown
      }
    }, 100);

    // Track mouse movement
    await page.evaluate(() => {
      document.addEventListener('mousemove', (event) => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          (window as any).__lastMousePos = {
            x: Math.round(event.clientX - rect.left),
            y: Math.round(event.clientY - rect.top)
          };
        }
      }, true);
    });

    // Keep the browser open until interrupted
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        console.log('\n\nClosing browser...');
        resolve();
      });
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
}

main();
