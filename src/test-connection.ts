/**
 * Test script to verify connection and calibrate UI coordinates
 *
 * Run with: npm run test:connection
 *
 * This script:
 * 1. Connects to the WebVisu interface
 * 2. Takes screenshots at each step
 * 3. Helps calibrate the coordinate mappings
 */

import { chromium } from 'playwright';
import { config, uiCoordinates } from './config';
import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_DIR = path.join(__dirname, '..', 'calibration-screenshots');

async function main() {
  console.log('='.repeat(60));
  console.log('WAGO WebVisu Connection Test & Calibration Tool');
  console.log('='.repeat(60));
  console.log();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Launching browser (headless: ${config.browser.headless})...`);
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    ignoreHTTPSErrors: true,
    httpCredentials: config.webvisu.username && config.webvisu.password ? {
      username: config.webvisu.username,
      password: config.webvisu.password,
    } : undefined,
  });

  const page = await context.newPage();

  try {
    console.log(`Navigating to ${config.webvisu.url}...`);
    await page.goto(config.webvisu.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.webvisu.loadTimeout,
    });

    console.log('Waiting for canvas...');
    await page.waitForSelector('canvas', { timeout: config.webvisu.loadTimeout });

    console.log('Waiting for canvas to render...');
    await page.waitForTimeout(config.webvisu.canvasRenderDelay);

    // Take initial screenshot
    const initialScreenshot = await page.screenshot();
    fs.writeFileSync(path.join(OUTPUT_DIR, '01-initial.png'), initialScreenshot);
    console.log('Saved: 01-initial.png');

    // Get canvas dimensions
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      return {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
      };
    });
    console.log('Canvas info:', canvasInfo);

    // Click on Napit tab
    console.log(`Clicking on Napit tab at (${uiCoordinates.tabs.napit.x}, ${uiCoordinates.tabs.napit.y})...`);
    const canvas = await page.locator('canvas').first();
    await canvas.click({ position: uiCoordinates.tabs.napit });
    await page.waitForTimeout(1000);

    const napitScreenshot = await page.screenshot();
    fs.writeFileSync(path.join(OUTPUT_DIR, '02-napit-tab.png'), napitScreenshot);
    console.log('Saved: 02-napit-tab.png');

    // Click on dropdown arrow
    console.log(`Clicking dropdown at (${uiCoordinates.lightSwitches.dropdownArrow.x}, ${uiCoordinates.lightSwitches.dropdownArrow.y})...`);
    await canvas.click({ position: uiCoordinates.lightSwitches.dropdownArrow });
    await page.waitForTimeout(500);

    const dropdownScreenshot = await page.screenshot();
    fs.writeFileSync(path.join(OUTPUT_DIR, '03-dropdown-open.png'), dropdownScreenshot);
    console.log('Saved: 03-dropdown-open.png');

    // Click first item in dropdown
    const firstItemY = uiCoordinates.lightSwitches.dropdownList.firstItemY;
    console.log(`Clicking first dropdown item at (${uiCoordinates.lightSwitches.dropdownList.itemX}, ${firstItemY})...`);
    await canvas.click({ position: { x: uiCoordinates.lightSwitches.dropdownList.itemX, y: firstItemY } });
    await page.waitForTimeout(500);

    const selectedScreenshot = await page.screenshot();
    fs.writeFileSync(path.join(OUTPUT_DIR, '04-item-selected.png'), selectedScreenshot);
    console.log('Saved: 04-item-selected.png');

    // Click Ohjaus button
    console.log(`Clicking Ohjaus button at (${uiCoordinates.lightSwitches.ohjausButton.x}, ${uiCoordinates.lightSwitches.ohjausButton.y})...`);
    await canvas.click({ position: uiCoordinates.lightSwitches.ohjausButton });
    await page.waitForTimeout(500);

    const toggledScreenshot = await page.screenshot();
    fs.writeFileSync(path.join(OUTPUT_DIR, '05-after-toggle.png'), toggledScreenshot);
    console.log('Saved: 05-after-toggle.png');

    console.log();
    console.log('='.repeat(60));
    console.log('Test completed!');
    console.log(`Screenshots saved to: ${OUTPUT_DIR}`);
    console.log();
    console.log('Review the screenshots to verify/adjust coordinates in config.ts');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Error during test:', error);

    // Try to take an error screenshot
    try {
      const errorScreenshot = await page.screenshot();
      fs.writeFileSync(path.join(OUTPUT_DIR, 'error.png'), errorScreenshot);
      console.log('Error screenshot saved to: error.png');
    } catch {}
  } finally {
    await browser.close();
  }
}

main();
