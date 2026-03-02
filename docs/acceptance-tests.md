# Acceptance Tests

The acceptance test suite (`src/test-acceptance.ts`) exercises core protocol
operations against a live PLC. Run it locally to diagnose failures before
deploying, or after any change to the protocol stack, config coordinates, or
scroll logic.

## Running

```bash
# Run all tests (PLC must be reachable at PROTOCOL_HOST, default 192.168.1.10)
npm run test:acceptance

# Run only tests whose name contains a substring
npm run test:acceptance -- T05
npm run test:acceptance -- drag
```

Rendered UI PNG snapshots are saved per test step to
`data/acceptance-test-results/`. Inspect these when a test fails to see what
the PLC was showing at the time of the failure.

## Test Cases

| ID | Name | Switch (index) | What it tests |
|----|------|----------------|---------------|
| T01 | connect | — | Protocol handshake: OpenConnection → RegisterClient → StartVisu → Napit tab |
| T02 | row0-no-scroll | kylpyhuone-1 (1) | Click row 0 of dropdown with no scrolling |
| T03 | row4-no-scroll | wc-alakerta-2 (4) | Click bottom-most visible row (row 4) without scrolling |
| T04 | arrow-scroll-small | keittio-1 (7) | Forward arrow-click scroll (delta ≤ 5, `scrollApproach=arrow`) |
| T05 | drag-forward-large | kylpyhuone-yk-2 (24) | Forward drag scroll (large delta, forces drag path) |
| T06 | backward-scroll | kylpyhuone-1 (1) | Backward drag from index 24 back to 1 |
| T07 | plclabel-essi-kattovalo | mh-1-1 (19) | Header verification when `plcLabel` differs from `name` ('Essi Kattovalo') |
| T08 | plclabel-onni-kattovalo | mh2-1 (29) | Header verification for corrected plcLabel ('Onni Kattovalo') |
| T09 | drag-far-end | saareke-4 (44) | Large drag to near end of list (was failing with keypad dialog) |
| T10 | select-last-item | saareke-8 (48) | Item close to the tail of the dropdown |
| T11 | sequential-polling | 12 switches | Full polling simulation: forward, backward, plcLabel, repeat |

## Pass Criteria

Each test calls `getLightStatus(switchId)` which internally:
1. Opens the dropdown (`pressAndCollect`)
2. Scrolls to the target index if not visible
3. Clicks the item (`clickAndCollect`)
4. Verifies the dropdown header matches `lightSwitchPlcLabels[index]`
5. Reads the lamp status images

**A test passes when all five steps succeed** — no exceptions and `isOn` is a
`boolean`. Because `verifyDropdownHeader` throws on a header mismatch, a passing
test guarantees the correct item was selected.

## Common Failure Modes

### T02–T03: Click at row 0/4 selects wrong item
- **Symptom**: header mismatch error, or `Eteinen 1` appears when other items expected
- **Likely cause**: `clickAndCollect` fires mouseDown (no response), then mouseUp
  at the same Y; if the dropdown closes on mouseDown, the mouseUp lands on the
  Ohjaus button at Y=170 or another panel element
- **Diagnostic**: check rendered UI snapshot at failure, look at protocol trace
  in `data/protocol-trace/` for the sequence of events after item click

### T04: Arrow scroll selects wrong item
- **Symptom**: Header mismatch after small scroll
- **Likely cause**: Arrow click count diverged from actual PLC scroll position
- **Check**: `dropdownFirstVisible` tracking vs actual label positions in trace

### T05, T09: Drag scroll opens keypad dialog
- **Symptom**: Numeric keypad overlay visible in rendered UI; subsequent tests fail
  with "wrong header" because all reads return keypad UI labels
- **Likely cause**: Drag mouseUp or post-drag reopen click lands on numeric input
  field at the wrong Y coordinate
- **Resolution**: the test auto-attempts to dismiss the keypad via `keypadEscButton`
  (x=714, y=583) and resets dropdown state before moving to the next test

### T06: Backward scroll overshoots
- **Symptom**: firstVisible stuck > 0 after drag, row click misses
- **Likely cause**: `getDropdownScrollY()` Y formula inaccurate for backward
  (high→low) drag; scrollbar thumb math needs recalibration

### T07–T08: plcLabel header mismatch
- **Symptom**: `verifyDropdownHeader` throws with actual vs expected label
- **Likely cause**: `plcLabel` in config.ts is wrong, or PLC firmware changed the label
- **Fix**: update the `plcLabel` field for the failing switch in `lightSwitchList`

### T11: Failure mid-sequence
- **Symptom**: sequential test fails at a specific switch
- **Approach**: run that switch as an isolated test (e.g. `npm run test:acceptance -- T09`)
  to reproduce, then inspect the trace

## Keypad Detection & Dismissal

When a misclick opens a numeric input dialog, the keypad overlays the panel and
blocks all subsequent operations. The test runner attempts dismissal after each
failed test by clicking `keypadEscButton: { x: 714, y: 583 }`.

If the keypad persists, the controller will reconnect on the next operation
(after `RECONNECT_EMPTY_THRESHOLD` consecutive empty renders).

To add proactive keypad detection to the production controller, check the
rendered UI for buttons in the keypad region (around y=450–600) and auto-click
the ESC button before each operation.

## Protocol Traces

Each run produces a session trace in `data/protocol-trace/` (format:
`protocol-session-YYYYMMDD-HHmmss-NNN.log`). Each line is a JSON object with:

```json
{ "ts": "...", "dir": "→", "type": "MouseDown", "x": 290, "y": 228 }
```

Cross-reference the trace with rendered UI snapshots to understand exactly what
the PLC was showing at each mouse event.

## Adding New Tests

1. Add a new `async function T##_...(): Promise<void>` to `test-acceptance.ts`
2. Add the function to the `ALL_TESTS` array in order
3. Document it in this table
4. Run `npm run build` to check for type errors
