/**
 * Capture binary paint frames from a live PLC session for classifier test fixtures.
 *
 * Connects to the PLC, navigates through key UI states, and saves compressed
 * binary paint command data. Output: data/classifier-fixtures.json
 *
 * Usage:
 *   npx tsx src/capture-classifier-fixtures.ts
 *
 * Requires PLC connectivity (PROTOCOL_HOST env var, default 192.168.1.10).
 */

import fs from 'fs';
import path from 'path';
import { deflateSync } from 'zlib';
import { ProtocolController } from './protocol-controller';
import { PaintCommand } from './protocol/paint-commands';
import { uiCoordinates } from './config';
import { buildViewportEvent } from './events';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'classifier-fixtures.json');

interface CapturedFrame {
  label: string;
  stage: string;
  commandCount: number;
  byteLength: number;
  compressedBase64: string;
}

// Serialize PaintCommand[] back to the raw binary format parsePaintCommands reads.
function serializeCommands(commands: PaintCommand[]): Uint8Array {
  let totalLen = 0;
  for (const cmd of commands) totalLen += 8 + cmd.data.length;
  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);
  let offset = 0;
  for (const cmd of commands) {
    dv.setUint32(offset, 8 + cmd.data.length, true);
    dv.setUint32(offset + 4, cmd.id, true);
    buf.set(cmd.data, offset + 8);
    offset += 8 + cmd.data.length;
  }
  return buf;
}

function compressAndStore(label: string, stage: string, commands: PaintCommand[]): CapturedFrame {
  const raw = serializeCommands(commands);
  const compressed = deflateSync(Buffer.from(raw));
  return {
    label,
    stage,
    commandCount: commands.length,
    byteLength: raw.length,
    compressedBase64: compressed.toString('base64'),
  };
}

async function main() {
  const frames: CapturedFrame[] = [];
  const controller = new ProtocolController();

  try {
    // ── Stage 1: Connect and capture initial render ──────────────────────────
    console.log('Connecting to PLC...');
    await controller.client.connect();
    console.log('Connected. Capturing initial render frames...');

    // Poll until first non-empty frame (initial page load)
    const maxInitPolls = 40;
    let gotInitial = false;
    for (let i = 0; i < maxInitPolls; i++) {
      const cmds = await controller.pollPaintCommands(`capture-init:${i}`);
      if (cmds.length > 0) {
        frames.push(compressAndStore('initial-page-load', 'connect', cmds));
        console.log(`  initial-page-load: ${cmds.length} commands`);
        gotInitial = true;
        break;
      }
      // Capture an empty frame too
      if (i === 2 && !gotInitial) {
        frames.push(compressAndStore('empty-frame', 'connect', cmds));
        console.log(`  empty-frame: ${cmds.length} commands`);
      }
      await controller.delay(200);
    }
    if (!gotInitial) throw new Error('Never received initial page load frame');

    // Capture a few follow-up polls (may be empty or minimal)
    for (let i = 0; i < 5; i++) {
      await controller.delay(100);
      const cmds = await controller.pollPaintCommands(`capture-post-init:${i}`);
      if (cmds.length === 0) {
        if (!frames.some(f => f.label === 'empty-frame')) {
          frames.push(compressAndStore('empty-frame', 'post-init', cmds));
          console.log(`  empty-frame: 0 commands`);
        }
      } else if (cmds.length <= 8) {
        frames.push(compressAndStore('minimal-update', 'post-init', cmds));
        console.log(`  minimal-update: ${cmds.length} commands`);
      }
    }

    // ── Stage 2: Navigate to Napit tab ──────────────────────────────────────
    console.log('Navigating to Napit tab...');
    const napitCoords = uiCoordinates.tabs.napit;
    const napitCmds = await controller.client.pressAndCollect(napitCoords.x, napitCoords.y);
    if (napitCmds.length > 0) {
      frames.push(compressAndStore('napit-tab-click', 'navigate', napitCmds));
      console.log(`  napit-tab-click: ${napitCmds.length} commands`);
    }

    // Poll until napit tab is fully loaded
    const accumulated: PaintCommand[] = [...napitCmds];
    for (let i = 0; i < 20; i++) {
      await controller.delay(200);
      const cmds = await controller.pollPaintCommands(`capture-napit-settle:${i}`);
      accumulated.push(...cmds);
      if (cmds.length > 0) {
        frames.push(compressAndStore(`napit-settle-${i}`, 'navigate', cmds));
        console.log(`  napit-settle-${i}: ${cmds.length} commands`);
      }
      // Check if we have lamp icons (napit loaded)
      const { extractDrawImages } = await import('./protocol/paint-commands');
      const { isLampStatusImageId } = await import('./model/lamp-ids');
      const lampCount = extractDrawImages(accumulated)
        .filter(img => isLampStatusImageId(img.imageId))
        .length;
      if (lampCount >= 3) {
        console.log(`  Napit tab loaded (${lampCount} lamps found)`);
        break;
      }
    }

    // Save the full accumulated napit render
    if (accumulated.length > 0) {
      frames.push(compressAndStore('napit-tab-loaded-accumulated', 'navigate', accumulated));
      console.log(`  napit-tab-loaded-accumulated: ${accumulated.length} commands`);
    }

    // ── Stage 3: Napit tab steady state (closed dropdown) ───────────────────
    console.log('Capturing Napit steady state...');
    await controller.delay(500);
    for (let i = 0; i < 5; i++) {
      const cmds = await controller.pollPaintCommands(`capture-napit-steady:${i}`);
      if (cmds.length > 0 && cmds.length <= 8) {
        frames.push(compressAndStore('napit-minimal-update', 'napit-steady', cmds));
        console.log(`  napit-minimal-update: ${cmds.length} commands`);
        break;
      }
      await controller.delay(150);
    }

    // ── Stage 4: Open dropdown ──────────────────────────────────────────────
    console.log('Opening dropdown...');
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;
    const dropdownClickCmds = await controller.client.pressAndCollect(arrowX, arrowY);
    if (dropdownClickCmds.length > 0) {
      frames.push(compressAndStore('dropdown-arrow-click', 'dropdown-open', dropdownClickCmds));
      console.log(`  dropdown-arrow-click: ${dropdownClickCmds.length} commands`);
    }

    // Poll until dropdown is open (look for dropdown labels)
    const dropdownAccum: PaintCommand[] = [...dropdownClickCmds];
    for (let i = 0; i < 15; i++) {
      await controller.delay(200);
      const cmds = await controller.pollPaintCommands(`capture-dropdown-open:${i}`);
      dropdownAccum.push(...cmds);
      if (cmds.length > 0) {
        frames.push(compressAndStore(`dropdown-open-poll-${i}`, 'dropdown-open', cmds));
        console.log(`  dropdown-open-poll-${i}: ${cmds.length} commands`);
      }
      const { extractDropdownLabels } = await import('./model/dropdown-labels');
      const labels = extractDropdownLabels(dropdownAccum);
      if (labels.length >= 3) {
        console.log(`  Dropdown open confirmed (${labels.length} labels)`);
        break;
      }
    }

    // Save accumulated dropdown open state
    if (dropdownAccum.length > 0) {
      frames.push(compressAndStore('dropdown-open-accumulated', 'dropdown-open', dropdownAccum));
      console.log(`  dropdown-open-accumulated: ${dropdownAccum.length} commands`);
    }

    // ── Stage 5: Scroll dropdown (arrow down 3 times) ───────────────────────
    console.log('Scrolling dropdown...');
    const arrowDown = uiCoordinates.lightSwitches.scrollbar.arrowDown;
    for (let i = 0; i < 3; i++) {
      const scrollCmds = await controller.client.pressAndCollect(arrowDown.x, arrowDown.y);
      if (scrollCmds.length > 0) {
        frames.push(compressAndStore(`scroll-down-${i}`, 'scroll', scrollCmds));
        console.log(`  scroll-down-${i}: ${scrollCmds.length} commands`);
      }
      await controller.delay(150);
    }

    // ── Stage 6: Select dropdown item ───────────────────────────────────────
    console.log('Selecting dropdown item...');
    const { dropdownList } = uiCoordinates.lightSwitches;
    const itemClickY = dropdownList.firstItemY + Math.floor(dropdownList.itemHeight / 2);
    const itemClickX = dropdownList.itemX;
    const selectCmds = await controller.client.pressAndCollect(itemClickX, itemClickY);
    if (selectCmds.length > 0) {
      frames.push(compressAndStore('item-select-click', 'select', selectCmds));
      console.log(`  item-select-click: ${selectCmds.length} commands`);
    }

    // Poll for post-selection render (header change + lamp icons)
    for (let i = 0; i < 5; i++) {
      await controller.delay(200);
      const cmds = await controller.pollPaintCommands(`capture-post-select:${i}`);
      if (cmds.length > 0) {
        frames.push(compressAndStore(`post-select-${i}`, 'select', cmds));
        console.log(`  post-select-${i}: ${cmds.length} commands`);
      }
    }

    // ── Done ────────────────────────────────────────────────────────────────
    console.log(`\nCaptured ${frames.length} frames total.`);

    // Ensure empty frame exists
    if (!frames.some(f => f.label === 'empty-frame')) {
      frames.push(compressAndStore('empty-frame', 'synthetic', []));
      console.log('  (added synthetic empty frame)');
    }

    // Save fixture file
    const output = {
      capturedAt: new Date().toISOString(),
      plcHost: process.env.PROTOCOL_HOST || '192.168.1.10',
      frameCount: frames.length,
      frames,
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\nFixtures saved to ${OUTPUT_PATH}`);

    // Print summary
    const totalRaw = frames.reduce((s, f) => s + f.byteLength, 0);
    const totalCompressed = frames.reduce((s, f) => s + Math.ceil(f.compressedBase64.length * 3 / 4), 0);
    console.log(`Total: ${totalRaw} bytes raw, ~${totalCompressed} bytes compressed`);

  } finally {
    await controller.client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
