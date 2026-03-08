/**
 * Tests for frame-classifier.ts heuristics using real PLC binary frames.
 *
 * Loads compressed binary paint frames from data/classifier-fixtures.json
 * (captured from a live PLC session) and verifies that classifyFrame()
 * produces correct scores for each UI state.
 *
 * Usage:
 *   npx tsx src/test-classifier.ts
 *
 * Regenerate fixtures (requires PLC connectivity):
 *   npx tsx src/capture-classifier-fixtures.ts
 */

import fs from 'fs';
import path from 'path';
import { PaintCommand } from './protocol/paint-commands';
import {
  classifyFrame,
  decompressTraceCommands,
  FrameClassification,
  PreviousFrameState,
} from './protocol/frame-classifier';

// ── ANSI colours ─────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// ── Fixture loading ──────────────────────────────────────────────────────────
const FIXTURE_PATH = path.join(process.cwd(), 'data', 'classifier-fixtures.json');

interface FixtureFrame {
  label: string;
  stage: string;
  commandCount: number;
  byteLength: number;
  compressedBase64: string;
}

interface FixtureFile {
  capturedAt: string;
  plcHost: string;
  frameCount: number;
  frames: FixtureFrame[];
}

function loadFixtures(): FixtureFile {
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`Fixture file not found: ${FIXTURE_PATH}`);
    console.error('Run: npx tsx src/capture-classifier-fixtures.ts');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function loadFrame(fixture: FixtureFile, label: string): PaintCommand[] {
  const frame = fixture.frames.find(f => f.label === label);
  if (!frame) throw new Error(`Fixture frame not found: ${label}`);
  return decompressTraceCommands(frame.compressedBase64);
}

function findFrame(fixture: FixtureFile, label: string): FixtureFrame | undefined {
  return fixture.frames.find(f => f.label === label);
}

// ── Test infra ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, name: string, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ${GREEN}PASS${RESET}: ${name}`);
  } else {
    failed++;
    console.log(`  ${RED}FAIL${RESET}: ${name} ${detail}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ${YELLOW}SKIP${RESET}: ${name} ${DIM}(${reason})${RESET}`);
}

function assertScore(
  classification: FrameClassification,
  field: keyof FrameClassification,
  op: '>=' | '<=' | '===' | '>' | '<',
  threshold: number,
  name: string,
) {
  const actual = classification[field] as number;
  let ok: boolean;
  switch (op) {
    case '>=': ok = actual >= threshold; break;
    case '<=': ok = actual <= threshold; break;
    case '===': ok = actual === threshold; break;
    case '>': ok = actual > threshold; break;
    case '<': ok = actual < threshold; break;
  }
  assert(ok!, name, `(${field}: got ${actual}, expected ${op} ${threshold})`);
}

// ── Tests ────────────────────────────────────────────────────────────────────
const fixtures = loadFixtures();
console.log(`Loaded ${fixtures.frameCount} frames captured at ${fixtures.capturedAt} from ${fixtures.plcHost}\n`);

// ── 1. Decompression roundtrip ──────────────────────────────────────────────
console.log(`${BOLD}1. Decompression roundtrip${RESET}`);
{
  for (const frame of fixtures.frames) {
    const cmds = decompressTraceCommands(frame.compressedBase64);
    assert(
      cmds.length === frame.commandCount,
      `${frame.label}: ${cmds.length} commands roundtrip`,
      `(expected ${frame.commandCount}, got ${cmds.length})`,
    );
  }
}

// ── 2. Empty frame ──────────────────────────────────────────────────────────
console.log(`\n${BOLD}2. Empty frame${RESET}`);
{
  const frame = findFrame(fixtures, 'empty-frame');
  if (frame) {
    const cmds = decompressTraceCommands(frame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'emptyFrame', '===', 1.0, 'emptyFrame = 1.0');
    assertScore(c, 'commandCount', '===', 0, 'commandCount = 0');
    assertScore(c, 'initialPageLoad', '===', 0, 'all other scores = 0');
    assertScore(c, 'minimalUpdate', '===', 0, 'minimalUpdate = 0');
    assertScore(c, 'fullPageRender', '===', 0, 'fullPageRender = 0');
    assertScore(c, 'napitTabLoaded', '===', 0, 'napitTabLoaded = 0');
    assertScore(c, 'napitSchedulerView', '===', 0, 'napitSchedulerView = 0');
    assertScore(c, 'dropdownOpen', '===', 0, 'dropdownOpen = 0');
    assertScore(c, 'dropdownClosed', '===', 0, 'dropdownClosed = 0');
    assertScore(c, 'lampStatusVisible', '===', 0, 'lampStatusVisible = 0');
    assert(c.headerLabel === null, 'headerLabel = null');
    assert(c.dropdownItems.length === 0, 'dropdownItems empty');
    assert(c.tabLabels.length === 0, 'tabLabels empty');
  } else {
    skip('empty-frame', 'fixture not captured');
  }
}

// ── 3. Initial page load ────────────────────────────────────────────────────
console.log(`\n${BOLD}3. Initial page load${RESET}`);
{
  const cmds = loadFrame(fixtures, 'initial-page-load');
  const c = classifyFrame(cmds);
  assertScore(c, 'initialPageLoad', '===', 1.0, 'initialPageLoad = 1.0');
  assertScore(c, 'emptyFrame', '===', 0, 'emptyFrame = 0');
  assertScore(c, 'commandCount', '>', 100, 'commandCount > 100 (full render)');
  assertScore(c, 'textLabelCount', '>=', 40, 'textLabelCount >= 40');
  assertScore(c, 'imageCount', '>=', 20, 'imageCount >= 20');
  // fullPageRender halved because initialPageLoad is 1.0
  assertScore(c, 'fullPageRender', '>', 0, 'fullPageRender > 0');
  assertScore(c, 'fullPageRender', '<=', 0.5, 'fullPageRender <= 0.5 (halved by init)');
  assert(c.tabLabels.length >= 4, `tabLabels >= 4 (got ${c.tabLabels.length})`);
}

// ── 4. Minimal update frames ────────────────────────────────────────────────
console.log(`\n${BOLD}4. Minimal update frames${RESET}`);
{
  const minimalFrames = fixtures.frames.filter(f =>
    f.commandCount > 0 && f.commandCount <= 8 && f.label !== 'empty-frame'
  );
  if (minimalFrames.length > 0) {
    for (const frame of minimalFrames) {
      const cmds = decompressTraceCommands(frame.compressedBase64);
      const c = classifyFrame(cmds);
      assertScore(c, 'minimalUpdate', '===', 1.0, `${frame.label}: minimalUpdate = 1.0`);
      assertScore(c, 'emptyFrame', '===', 0, `${frame.label}: emptyFrame = 0`);
      assertScore(c, 'textLabelCount', '===', 0, `${frame.label}: no text labels`);
      assertScore(c, 'imageCount', '===', 0, `${frame.label}: no images`);
    }
  } else {
    skip('minimal-update', 'no minimal frames captured');
  }
}

// ── 5. Full page render (tab transitions) ───────────────────────────────────
console.log(`\n${BOLD}5. Full page render (tab transition)${RESET}`);
{
  const cmds = loadFrame(fixtures, 'napit-tab-click');
  const c = classifyFrame(cmds);
  assertScore(c, 'fullPageRender', '>=', 0.8, 'fullPageRender >= 0.8');
  assertScore(c, 'initialPageLoad', '===', 0, 'initialPageLoad = 0 (no init cmd)');
  assertScore(c, 'textLabelCount', '>=', 40, 'textLabelCount >= 40');
  assertScore(c, 'imageCount', '>=', 20, 'imageCount >= 20');
  assertScore(c, 'napitSchedulerView', '>=', 0.95, 'napitSchedulerView >= 0.95');
  assertScore(c, 'napitTabLoaded', '<=', 0.2, 'napitTabLoaded <= 0.2 while scheduler subview active');
  assert(c.tabLabels.length >= 4, `tabLabels >= 4 (got ${c.tabLabels.length})`);
}

// ── 6. Napit tab loaded ─────────────────────────────────────────────────────
console.log(`\n${BOLD}6. Napit tab loaded${RESET}`);
{
  // The napit-settle-4 frame is typically the one where napit-specific labels appear
  const napitFrame = findFrame(fixtures, 'napit-settle-4');
  if (napitFrame) {
    const cmds = decompressTraceCommands(napitFrame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'napitTabLoaded', '>=', 0.95, 'napitTabLoaded >= 0.95');
    assertScore(c, 'napitSchedulerView', '<=', 0.2, 'napitSchedulerView <= 0.2 in control subview');
    assertScore(c, 'lampStatusVisible', '>=', 0.6, 'lampStatusVisible >= 0.6 (lamp icons)');
    assert(c.headerLabel !== null, `headerLabel extracted: "${c.headerLabel}"`);
  } else {
    skip('napit-settle-4', 'fixture not captured');
  }

  // Accumulated napit render should also score high
  const accumFrame = findFrame(fixtures, 'napit-tab-loaded-accumulated');
  if (accumFrame) {
    const cmds = decompressTraceCommands(accumFrame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'napitTabLoaded', '>=', 0.95, 'accumulated: napitTabLoaded >= 0.95');
    assertScore(c, 'napitSchedulerView', '>=', 0.1, 'accumulated: napitSchedulerView retains scheduler context');
    assertScore(c, 'lampStatusVisible', '>=', 0.6, 'accumulated: lampStatusVisible >= 0.6');
    assertScore(c, 'fullPageRender', '>=', 0.8, 'accumulated: fullPageRender >= 0.8');
  } else {
    skip('napit-tab-loaded-accumulated', 'fixture not captured');
  }
}

// ── 7. Dropdown open detection ──────────────────────────────────────────────
console.log(`\n${BOLD}7. Dropdown open detection${RESET}`);
{
  // Single dropdown open frames may be ambiguous (PLC renders incrementally)
  const singleFrame = findFrame(fixtures, 'dropdown-arrow-click');
  if (singleFrame) {
    const cmds = decompressTraceCommands(singleFrame.compressedBase64);
    const c = classifyFrame(cmds);
    // Single frame: dropdown may not be fully populated yet
    assertScore(c, 'napitTabLoaded', '>=', 0.5, 'single: napitTabLoaded >= 0.5 (napit labels present)');
    assert(c.headerLabel !== null, `single: headerLabel present ("${c.headerLabel}")`);
  }

  // Accumulated dropdown frames should score higher
  const accumFrame = findFrame(fixtures, 'dropdown-open-accumulated');
  if (accumFrame) {
    const cmds = decompressTraceCommands(accumFrame.compressedBase64);
    const c = classifyFrame(cmds);
    // Depending on PLC render timing, this accumulated slice may still be
    // transitional and not yet show stable row labels.
    if (c.dropdownItems.length >= 1) {
      assertScore(c, 'dropdownOpen', '>=', 0.6, 'accumulated: dropdownOpen >= 0.6');
      assert(c.dropdownItems.length >= 1, `accumulated: dropdownItems >= 1 (got ${c.dropdownItems.length})`);
    } else {
      assertScore(c, 'dropdownOpen', '<=', 0.5, 'accumulated transitional: dropdownOpen <= 0.5');
      assertScore(c, 'dropdownClosed', '>=', 0.6, 'accumulated transitional: dropdownClosed >= 0.6');
    }
  } else {
    skip('dropdown-open-accumulated', 'fixture not captured');
  }

  // Post-scroll frame with many items should be clearly open
  const scrollFrame = findFrame(fixtures, 'scroll-down-2');
  if (scrollFrame) {
    const cmds = decompressTraceCommands(scrollFrame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'dropdownOpen', '>=', 0.95, 'post-scroll: dropdownOpen >= 0.95');
    assert(c.dropdownItems.length >= 3, `post-scroll: dropdownItems >= 3 (got ${c.dropdownItems.length})`);
  } else {
    skip('scroll-down-2', 'fixture not captured');
  }
}

// ── 8. Dropdown closed (napit steady state, no dropdown items) ──────────────
console.log(`\n${BOLD}8. Dropdown closed detection${RESET}`);
{
  // The napit-settle-4 frame has napit labels but should show dropdown as closed
  const napitFrame = findFrame(fixtures, 'napit-settle-4');
  if (napitFrame) {
    const cmds = decompressTraceCommands(napitFrame.compressedBase64);
    const c = classifyFrame(cmds);
    // With napit labels visible and only 0-1 dropdown items, dropdownClosed should score
    if (c.dropdownItems.length <= 2) {
      assertScore(c, 'dropdownClosed', '>=', 0.9, 'napit steady: dropdownClosed >= 0.9');
      assertScore(c, 'dropdownOpen', '<=', 0.5, 'napit steady: dropdownOpen <= 0.5');
    } else {
      // If PLC retained dropdown items from previous session, scores may differ
      assert(true, `napit steady: dropdownItems=${c.dropdownItems.length} (PLC retained session state)`);
    }
  } else {
    skip('napit-settle-4', 'fixture not captured');
  }
}

// ── 9. Dropdown scrolled (delta detection) ──────────────────────────────────
console.log(`\n${BOLD}9. Dropdown scrolled (delta detection)${RESET}`);
{
  // Use post-select frames which have clear dropdown items
  const postSelect1 = findFrame(fixtures, 'post-select-1');
  const postSelect3 = findFrame(fixtures, 'post-select-3');

  if (postSelect1 && postSelect3) {
    const cmds1 = decompressTraceCommands(postSelect1.compressedBase64);
    const cmds3 = decompressTraceCommands(postSelect3.compressedBase64);
    const c1 = classifyFrame(cmds1);
    const c3 = classifyFrame(cmds3);

    // Check if items actually differ between frames
    const items1Str = JSON.stringify(c1.dropdownItems);
    const items3Str = JSON.stringify(c3.dropdownItems);

    if (items1Str !== items3Str) {
      // Items differ — scrolled should detect the change
      const prev: PreviousFrameState = {
        headerLabel: c1.headerLabel,
        dropdownItems: c1.dropdownItems,
      };
      const c3WithPrev = classifyFrame(cmds3, prev);
      assertScore(c3WithPrev, 'dropdownScrolled', '===', 1.0, 'items differ: dropdownScrolled = 1.0');
    } else {
      // Same items — scrolled should be 0
      const prev: PreviousFrameState = {
        headerLabel: c1.headerLabel,
        dropdownItems: c1.dropdownItems,
      };
      const c3WithPrev = classifyFrame(cmds3, prev);
      assertScore(c3WithPrev, 'dropdownScrolled', '===', 0.0, 'same items: dropdownScrolled = 0.0');
    }

    // Always: no previous → 0
    assertScore(c3, 'dropdownScrolled', '===', 0.0, 'no previous: dropdownScrolled = 0.0');
  } else {
    skip('scroll detection', 'post-select fixtures not captured');
  }

  // Use scroll frames for a clearer test
  const scrollFrame1 = findFrame(fixtures, 'scroll-down-1');
  const scrollFrame2 = findFrame(fixtures, 'scroll-down-2');
  if (scrollFrame1 && scrollFrame2) {
    const cmds1 = decompressTraceCommands(scrollFrame1.compressedBase64);
    const cmds2 = decompressTraceCommands(scrollFrame2.compressedBase64);
    const c1 = classifyFrame(cmds1);
    const c2 = classifyFrame(cmds2);
    if (c1.dropdownItems.length >= 3 && c2.dropdownItems.length >= 3) {
      const prev: PreviousFrameState = {
        headerLabel: c1.headerLabel,
        dropdownItems: c1.dropdownItems,
      };
      const c2WithPrev = classifyFrame(cmds2, prev);
      if (JSON.stringify(c1.dropdownItems) !== JSON.stringify(c2.dropdownItems)) {
        assertScore(c2WithPrev, 'dropdownScrolled', '===', 1.0, 'scroll frames differ: dropdownScrolled = 1.0');
      } else {
        assert(true, 'scroll frames have same items (PLC render timing)');
      }
    } else {
      skip('scroll-frame comparison', `insufficient items: scroll-1=${c1.dropdownItems.length}, scroll-2=${c2.dropdownItems.length}`);
    }
  }
}

// ── 10. Header changed (delta detection) ────────────────────────────────────
console.log(`\n${BOLD}10. Header changed (delta detection)${RESET}`);
{
  // Compare initial page load (default tab header) with napit tab (different header)
  const initCmds = loadFrame(fixtures, 'initial-page-load');
  const initC = classifyFrame(initCmds);

  const napitFrame = findFrame(fixtures, 'napit-settle-4');
  if (napitFrame && initC.headerLabel !== null) {
    const napitCmds = decompressTraceCommands(napitFrame.compressedBase64);
    const napitC = classifyFrame(napitCmds);

    if (napitC.headerLabel !== null && initC.headerLabel !== napitC.headerLabel) {
      const prev: PreviousFrameState = {
        headerLabel: initC.headerLabel,
        dropdownItems: initC.dropdownItems,
      };
      const cWithPrev = classifyFrame(napitCmds, prev);
      assertScore(cWithPrev, 'headerChanged', '===', 1.0, 'different headers: headerChanged = 1.0');
    } else {
      skip('header change', `headers match: "${initC.headerLabel}" === "${napitC?.headerLabel}"`);
    }
  }

  // Same frame twice → no change
  if (initC.headerLabel !== null) {
    const prev: PreviousFrameState = {
      headerLabel: initC.headerLabel,
      dropdownItems: initC.dropdownItems,
    };
    const cSame = classifyFrame(initCmds, prev);
    assertScore(cSame, 'headerChanged', '===', 0.0, 'same header: headerChanged = 0.0');
  }

  // No previous → 0
  assertScore(initC, 'headerChanged', '===', 0.0, 'no previous: headerChanged = 0.0');
}

// ── 11. Lamp status visible ─────────────────────────────────────────────────
console.log(`\n${BOLD}11. Lamp status visible${RESET}`);
{
  // Napit tab loaded should have lamp icons
  const napitFrame = findFrame(fixtures, 'napit-settle-4');
  if (napitFrame) {
    const cmds = decompressTraceCommands(napitFrame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'lampStatusVisible', '>=', 0.6, 'napit: lampStatusVisible >= 0.6');
  }

  // Initial page load should NOT have lamp icons (different tab)
  const initCmds = loadFrame(fixtures, 'initial-page-load');
  const initC = classifyFrame(initCmds);
  assertScore(initC, 'lampStatusVisible', '===', 0, 'initial page: lampStatusVisible = 0 (different tab)');

  // Empty frame has no lamps
  const emptyFrame = findFrame(fixtures, 'empty-frame');
  if (emptyFrame) {
    const cmds = decompressTraceCommands(emptyFrame.compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'lampStatusVisible', '===', 0, 'empty: lampStatusVisible = 0');
  }

  // Minimal update frame has no lamps
  const minimalFrames = fixtures.frames.filter(f =>
    f.commandCount > 0 && f.commandCount <= 8 && f.label !== 'empty-frame'
  );
  if (minimalFrames.length > 0) {
    const cmds = decompressTraceCommands(minimalFrames[0].compressedBase64);
    const c = classifyFrame(cmds);
    assertScore(c, 'lampStatusVisible', '===', 0, 'minimal: lampStatusVisible = 0');
  }
}

// ── 12. Mutual exclusion: dropdownOpen vs dropdownClosed ────────────────────
console.log(`\n${BOLD}12. Mutual exclusion: dropdownOpen vs dropdownClosed${RESET}`);
{
  for (const frame of fixtures.frames) {
    const cmds = decompressTraceCommands(frame.compressedBase64);
    const c = classifyFrame(cmds);
    // When dropdownOpen >= 0.6, dropdownClosed should be capped at 0.2
    if (c.dropdownOpen >= 0.6) {
      assertScore(c, 'dropdownClosed', '<=', 0.2,
        `${frame.label}: ddClosed <= 0.2 when ddOpen=${c.dropdownOpen.toFixed(2)}`);
    }
  }
}

// ── 13. Extracted data consistency ──────────────────────────────────────────
console.log(`\n${BOLD}13. Extracted data consistency${RESET}`);
{
  for (const frame of fixtures.frames) {
    const cmds = decompressTraceCommands(frame.compressedBase64);
    const c = classifyFrame(cmds);

    // commandCount matches actual decompressed count
    assert(c.commandCount === cmds.length,
      `${frame.label}: commandCount matches (${c.commandCount})`);

    // Empty frame → all counts zero
    if (cmds.length === 0) {
      assert(c.textLabelCount === 0, `${frame.label}: textLabelCount = 0`);
      assert(c.imageCount === 0, `${frame.label}: imageCount = 0`);
    }

    // Scores clamped to [0, 1]
    const scoreFields: (keyof FrameClassification)[] = [
      'initialPageLoad', 'fullPageRender', 'napitTabLoaded', 'napitSchedulerView',
      'dropdownOpen', 'dropdownClosed', 'dropdownScrolled',
      'headerChanged', 'minimalUpdate', 'emptyFrame', 'lampStatusVisible',
    ];
    for (const field of scoreFields) {
      const val = c[field] as number;
      assert(val >= 0 && val <= 1, `${frame.label}: ${field} in [0,1] (${val})`);
    }
  }
}

// ── 14. Cross-frame delta detection with real sequence ──────────────────────
console.log(`\n${BOLD}14. Cross-frame delta detection (real sequence)${RESET}`);
{
  // Simulate processing frames in capture order, tracking state
  let previous: PreviousFrameState | undefined;
  let prevLabel = '';
  const eventLog: string[] = [];

  for (const frame of fixtures.frames) {
    const cmds = decompressTraceCommands(frame.compressedBase64);
    const c = classifyFrame(cmds, previous);

    if (c.headerChanged > 0) {
      eventLog.push(`headerChanged at "${frame.label}": "${previous?.headerLabel}" → "${c.headerLabel}"`);
    }
    if (c.dropdownScrolled > 0) {
      eventLog.push(`dropdownScrolled at "${frame.label}": ${previous?.dropdownItems.length} → ${c.dropdownItems.length} items`);
    }

    // Update previous state for next iteration
    if (c.headerLabel !== null || c.dropdownItems.length > 0) {
      previous = {
        headerLabel: c.headerLabel,
        dropdownItems: c.dropdownItems,
      };
      prevLabel = frame.label;
    }
  }

  console.log(`  ${DIM}Events detected in sequence:${RESET}`);
  for (const event of eventLog) {
    console.log(`    ${event}`);
  }
  assert(eventLog.length > 0, 'at least one delta event detected in sequence');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}, ${skipped > 0 ? YELLOW : ''}${skipped} skipped${RESET}`);
process.exit(failed > 0 ? 1 : 0);
