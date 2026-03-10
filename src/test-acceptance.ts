/**
 * Acceptance tests for WAGO WebVisu Adapter protocol operations.
 *
 * These tests verify the core operations (dropdown navigation, scrolling,
 * item selection, header verification, status reading) work correctly
 * against a live PLC. Run locally to diagnose failures before deploying.
 *
 * Usage:
 *   npm run test:acceptance               # run all tests
 *   npm run test:acceptance -- T05        # run only tests whose name contains "T05"
 *
 * Output:
 *   Rendered UI PNG snapshots are saved to data/acceptance-test-results/
 *   per test step (useful for debugging visual state failures).
 *
 * See docs/acceptance-tests.md for test case descriptions.
 */

import path from 'path';
import fs from 'fs';
import { ProtocolController } from './protocol-controller';
import { LightStatus } from './controller-interface';

// ── ANSI colours ─────────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

// ── Infra ─────────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'acceptance-test-results');

let controller: ProtocolController;

interface TestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  duration: number;
  message: string;
}

const results: TestResult[] = [];

// Save rendered UI image to disk (silently ignored if not available)
async function saveRenderedUi(label: string): Promise<void> {
  try {
    const img = await controller.getRenderedUiImage?.();
    if (!img || img.length === 0) return;
    const filename = path.join(OUTPUT_DIR, `${label}.png`);
    fs.writeFileSync(filename, img);
    console.log(`  ${BLUE}[UI → ${path.basename(filename)}]${RESET}`);
  } catch {
    // Renderer not available or not yet initialised — ignore
  }
}

// Save all debug snapshots collected during the test
function saveCollectedSnapshots(testName: string): void {
  try {
    const snapshots = (controller as any).collectAndClearSnapshots?.() ?? [];
    for (const snap of snapshots) {
      const filename = path.join(OUTPUT_DIR, `${testName}-${snap.label}.png`);
      fs.writeFileSync(filename, snap.png);
      console.log(`  ${BLUE}[UI → ${path.basename(filename)}]${RESET}`);
    }
  } catch {
    // ignore
  }
}

// Attempt to dismiss a numeric keypad dialog if one has opened by accident.
// The keypad appears when a misclick lands on a numeric input field and can
// block all subsequent interactions.
async function dismissKeypadIfVisible(): Promise<void> {
  try {
    const img = await controller.getRenderedUiImage?.();
    if (!img || img.length === 0) return;

    // Heuristic: if the rendered image is large enough and the ESC button
    // region (x≈714, y≈583) is present, try clicking it to dismiss.
    // We always attempt the click here; if no keypad is open, it is a
    // harmless no-op at an empty canvas area outside the active panel.
    await (controller as any).client?.clickAndCollect(714, 583);
  } catch {
    // click may fail if client is not connected yet — safe to ignore
  }
}

async function runTest(
  name: string,
  fn: () => Promise<void>,
  skip = false,
): Promise<TestResult> {
  const start = Date.now();
  console.log(`\n${BOLD}${name}${RESET}`);

  if (skip) {
    const r: TestResult = { name, passed: false, skipped: true, duration: 0, message: 'skipped' };
    results.push(r);
    console.log(`  ${YELLOW}○ SKIP${RESET}`);
    return r;
  }

  try {
    await fn();
    const duration = Date.now() - start;
    const r: TestResult = { name, passed: true, skipped: false, duration, message: 'OK' };
    results.push(r);
    console.log(`  ${GREEN}✓ PASS${RESET} ${DIM}(${duration}ms)${RESET}`);
    saveCollectedSnapshots(name);
    await saveRenderedUi(name);
    return r;
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    const r: TestResult = { name, passed: false, skipped: false, duration, message };
    results.push(r);
    console.log(`  ${RED}✗ FAIL${RESET} ${DIM}(${duration}ms)${RESET}`);
    console.log(`  ${RED}  ${message}${RESET}`);
    saveCollectedSnapshots(name);
    await saveRenderedUi(name);
    // Best-effort cleanup: dismiss keypad and reset dropdown state so later
    // tests start from a clean position.
    await dismissKeypadIfVisible();
    try { controller.resetDropdownState(); } catch {}
    return r;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function reconnect(label: string): Promise<void> {
  console.log(`    [${label}] Reconnecting for fresh session...`);
  await controller.close();
  await controller.initialize();
  const ok = await controller.isConnected();
  if (!ok) throw new Error(`Reconnect failed in ${label}`);
}

function assertStatus(switchId: string, status: LightStatus): void {
  if (typeof status.isOn !== 'boolean') {
    throw new Error(
      `getLightStatus('${switchId}') returned isOn=${JSON.stringify(status.isOn)} — expected boolean`,
    );
  }
}

// ── Test cases ─────────────────────────────────────────────────────────────────
/**
 * T01-connect
 * Establish protocol session with the PLC. All other tests depend on this.
 */
async function T01_connect(): Promise<void> {
  await controller.initialize();
  const connected = await controller.isConnected();
  if (!connected) throw new Error('isConnected() returned false after initialize()');
}

/**
 * T02-row0-no-scroll
 * Select kylpyhuone-1 (index 1) — first functional item, always visible at
 * row 0 when the dropdown is at the top. No scroll required.
 *
 * Header verification inside doSelectLightSwitchOnce will fail if the wrong
 * item is returned (indicating a coordinate or click-timing bug).
 */
async function T02_row0_no_scroll(): Promise<void> {
  const status = await controller.getLightStatus('kylpyhuone-1');
  assertStatus('kylpyhuone-1', status);
  console.log(`    kylpyhuone-1 (index 1): isOn=${status.isOn}`);
}

/**
 * T03-row4-no-scroll
 * Select wc-alakerta-2 (index 4) — last row visible when firstVisible=0
 * (rows 0–4 visible). Tests clicking the bottom-most visible row.
 * Reconnects first to guarantee a fresh session at scroll position 0,
 * since T02 may have shifted the dropdown state.
 */
async function T03_row4_no_scroll(): Promise<void> {
  await reconnect('T03');
  const status = await controller.getLightStatus('wc-alakerta-2');
  assertStatus('wc-alakerta-2', status);
  console.log(`    wc-alakerta-2 (index 4): isOn=${status.isOn}`);
}

/**
 * T04-arrow-scroll-small
 * Select keittio-1 (index 7). After T03, firstVisible≈1; delta≈3 → arrow
 * clicks (≤ DRAG_THRESHOLD=5).  Tests the arrow-click scroll path.
 */
async function T04_arrow_scroll_small(): Promise<void> {
  const status = await controller.getLightStatus('keittio-1');
  assertStatus('keittio-1', status);
  console.log(`    keittio-1 (index 7): isOn=${status.isOn}`);
}

/**
 * T05-drag-forward-large
 * Select kylpyhuone-yk-2 (index 24). Delta from ~3 → 20+; forces drag scroll.
 * Tests drag path for a medium-large jump.
 */
async function T05_drag_forward_large(): Promise<void> {
  const status = await controller.getLightStatus('kylpyhuone-yk-2');
  assertStatus('kylpyhuone-yk-2', status);
  console.log(`    kylpyhuone-yk-2 (index 24): isOn=${status.isOn}`);
}

/**
 * T06-backward-scroll
 * Reconnects to guarantee a known starting position, then selects
 * kylpyhuone-yk-2 (index 24) to move the scroll forward, followed by
 * kylpyhuone-1 (index 1) to force a backward scroll (delta < 0).
 */
async function T06_backward_scroll(): Promise<void> {
  await reconnect('T06');
  // Move forward first to establish a high scroll position.
  const fwd = await controller.getLightStatus('kylpyhuone-yk-2');
  assertStatus('kylpyhuone-yk-2', fwd);
  console.log(`    kylpyhuone-yk-2 (index 24, setup): isOn=${fwd.isOn}`);

  const status = await controller.getLightStatus('kylpyhuone-1');
  assertStatus('kylpyhuone-1', status);
  console.log(`    kylpyhuone-1 (index 1, backward from 24): isOn=${status.isOn}`);
}

/**
 * T07-plclabel-header-verify
 * Select mh-1-1 (index 19, plcLabel='Essi Kattovalo').
 * If the header returned by the PLC matches the plcLabel in config, the test
 * passes. A mismatch would throw inside verifyDropdownHeader(), meaning the
 * plcLabel in config.ts is wrong.
 */
async function T07_plclabel_header_verify(): Promise<void> {
  const status = await controller.getLightStatus('mh-1-1');
  assertStatus('mh-1-1', status);
  console.log(`    mh-1-1 (index 19, plcLabel='Essi Kattovalo'): isOn=${status.isOn}`);
}

/**
 * T08-plclabel-onni
 * Select mh2-1 (index 29, plcLabel='Onni Kattovalo').
 * This was a previously misconfigured entry. Verifies the corrected label.
 */
async function T08_plclabel_onni(): Promise<void> {
  const status = await controller.getLightStatus('mh2-1');
  assertStatus('mh2-1', status);
  console.log(`    mh2-1 (index 29, plcLabel='Onni Kattovalo'): isOn=${status.isOn}`);
}

/**
 * T09-drag-far-end
 * Select saareke-4 (index 44) — near the end of the list.
 * Tests a very large forward drag (~40 positions from top).
 * This was the failing case that caused keypad dialogs in the field.
 */
async function T09_drag_far_end(): Promise<void> {
  const status = await controller.getLightStatus('saareke-4');
  assertStatus('saareke-4', status);
  console.log(`    saareke-4 (index 44): isOn=${status.isOn}`);
}

/**
 * T10-select-last-item
 * Select saareke-8 (index 48) — last real functional switch near end.
 * Tests index close to the tail of the list.
 */
async function T10_select_last_item(): Promise<void> {
  const status = await controller.getLightStatus('saareke-8');
  assertStatus('saareke-8', status);
  console.log(`    saareke-8 (index 48): isOn=${status.isOn}`);
}

/**
 * T11-sequential-polling-simulation
 * Cycles through 12 switches in an order that exercises:
 *   - forward scroll (small and large)
 *   - backward scroll
 *   - plcLabel switches
 *   - same switch twice in a row (no scroll needed)
 *
 * Simulates the polling service looping through all lights. All must succeed.
 */
async function T11_sequential_polling(): Promise<void> {
  const sequence: Array<[string, string]> = [
    ['kylpyhuone-1',    'index 1'],
    ['wc-alakerta-2',   'index 4'],
    ['eteinen-1',       'index 13'],
    ['mh-1-1',         'index 19 (plcLabel)'],
    ['kylpyhuone-yk-2', 'index 24'],
    ['mh2-1',          'index 29 (plcLabel)'],
    ['mh3-1',          'index 31 (plcLabel)'],
    ['saareke-1',      'index 41'],
    ['saareke-4',      'index 44'],
    ['saareke-8',      'index 48'],
    ['kylpyhuone-1',   'index 1 (backward return)'],
    ['kylpyhuone-1',   'index 1 (repeat, no scroll)'],
  ];

  for (const [switchId, label] of sequence) {
    const status = await controller.getLightStatus(switchId);
    assertStatus(switchId, status);
    console.log(`    ${switchId.padEnd(22)} [${label}]: isOn=${status.isOn}`);
  }
}

/**
 * T12-cold-start-far-index
 * Reconnect to get a fresh session (dropdown at scroll position 0), then
 * immediately select saareke-4 (index 44) — a large drag from the top.
 *
 * This reproduces the exact production failure scenario: after a deploy the
 * polling service resumes from a high index on a fresh PLC session, requiring
 * a 0→44 drag as the very first dropdown operation. Tests that:
 * - Dropdown open verification works on a fresh session
 * - Large drag + nudge loop works from position 0
 * - Header text is found and verified (not silently skipped)
 */
async function T12_cold_start_far_index(): Promise<void> {
  // Force a reconnect to simulate a cold start (fresh session, dropdown at 0).
  await controller.close();
  await controller.initialize();
  const connected = await controller.isConnected();
  if (!connected) throw new Error('isConnected() returned false after reconnect');

  const status = await controller.getLightStatus('saareke-4');
  assertStatus('saareke-4', status);
  console.log(`    saareke-4 (index 44, cold start): isOn=${status.isOn}`);
}

// ── Test registry ─────────────────────────────────────────────────────────────
const ALL_TESTS: Array<[string, () => Promise<void>]> = [
  ['T01-connect',                    T01_connect],
  ['T02-row0-no-scroll',             T02_row0_no_scroll],
  ['T03-row4-no-scroll',             T03_row4_no_scroll],
  ['T04-arrow-scroll-small',         T04_arrow_scroll_small],
  ['T05-drag-forward-large',         T05_drag_forward_large],
  ['T06-backward-scroll',            T06_backward_scroll],
  ['T07-plclabel-essi-kattovalo',    T07_plclabel_header_verify],
  ['T08-plclabel-onni-kattovalo',    T08_plclabel_onni],
  ['T09-drag-far-end',               T09_drag_far_end],
  ['T10-select-last-item',           T10_select_last_item],
  ['T11-sequential-polling',         T11_sequential_polling],
  ['T12-cold-start-far-index',       T12_cold_start_far_index],
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Accept a filter as the first positional argument: `npm run test:acceptance -- T05`
  const filter = process.argv.slice(2).find(a => !a.startsWith('-'));

  // Create output dir
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`\n${BOLD}WAGO WebVisu Adapter — Acceptance Tests${RESET}`);
  console.log('═'.repeat(55));
  console.log(`PLC host:   ${process.env.PROTOCOL_HOST ?? '192.168.1.10'}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  if (filter) console.log(`Filter:     ${filter}`);
  console.log('═'.repeat(55));

  controller = new ProtocolController();

  let connectPassed = false;
  for (const [name, fn] of ALL_TESTS) {
    const isConnect = name === 'T01-connect';
    // T01-connect always runs (all other tests depend on it).
    const matchesFilter = !filter || name.toLowerCase().includes(filter.toLowerCase());
    const shouldRun = isConnect || matchesFilter;
    const skip = !shouldRun || (!isConnect && !connectPassed);

    const result = await runTest(name, fn, skip);

    if (isConnect && result.passed) connectPassed = true;
  }

  // Teardown
  try {
    await controller.close();
  } catch {
    // Ignore close errors
  }

  // Summary
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`${BOLD}Test Summary${RESET}`);
  console.log('═'.repeat(55));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${YELLOW}○${RESET} ${r.name}`);
      skipped++;
    } else if (r.passed) {
      console.log(`  ${GREEN}✓${RESET} ${r.name.padEnd(38)} ${DIM}${r.duration}ms${RESET}`);
      passed++;
    } else {
      console.log(`  ${RED}✗${RESET} ${r.name.padEnd(38)} ${DIM}${r.duration}ms${RESET}`);
      console.log(`    ${RED}${r.message}${RESET}`);
      failed++;
    }
  }

  console.log(`\n${BOLD}Result: ${passed}/${passed + failed} passed${skipped > 0 ? `, ${skipped} skipped` : ''}${RESET}`);
  if (failed > 0) {
    console.log(`${RED}${BOLD}${failed} test(s) FAILED${RESET}`);
    console.log(`Check rendered UI images in ${OUTPUT_DIR} for visual diagnostics.`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}${BOLD}Fatal error:${RESET}`, err);
  process.exit(1);
});
