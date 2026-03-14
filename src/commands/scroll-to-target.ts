import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { resolveDropdownView } from '../model/dropdown-labels';
import { arrowScrollOneByOne } from '../model/scroll-settle';
import { classifyFrame, THRESHOLD_DROPDOWN_CLOSED, THRESHOLD_DROPDOWN_OPEN } from '../protocol/frame-classifier';
import { reopenDropdownFromClosed } from './ensure-dropdown-closed';
import pino from 'pino';

const logger = pino({ name: 'scroll-to-target' });

/**
 * Drag the scrollbar thumb to a target position.
 *
 * The drag sets only the WIDGET (click-mapping) state, not the visual.
 * After the drag, visual stays unchanged while widget moves to approximately
 * targetFirstVisible (±1 due to pixel rounding).
 *
 * Important: the PLC only processes the FIRST mouseMove after mouseDown.
 * Subsequent mouseMoves within the same drag are ignored. So we send
 * exactly one mouseMove to the target position.
 *
 * The mouseDown MUST be at the current thumb position (based on visual state),
 * not always at topY. If the thumb is at a different position (e.g., after
 * prior scrolling), clicking at topY won't grab the thumb and the drag fails.
 */
async function dragToPosition(
  ctx: CommandContext,
  targetFirstVisible: number,
  reason: string,
): Promise<void> {
  const scrollX = uiCoordinates.lightSwitches.scrollbar.x;
  const fromY = Math.round(ctx.state.getDropdownScrollY(ctx.state.dropdownFirstVisible));
  const targetY = Math.round(ctx.state.getDropdownScrollY(targetFirstVisible));

  if (fromY === targetY) return;

  logger.info({
    fromY, toY: targetY, targetFirstVisible, reason,
    currentFirstVisible: ctx.state.dropdownFirstVisible,
  }, 'Drag scroll to target');

  await ctx.client.mouseDownAndCollect(scrollX, fromY);
  await ctx.delay(200);
  await ctx.client.mouseMoveAndCollect(scrollX, targetY);
  await ctx.delay(300);
  await ctx.client.mouseUpAndCollect(scrollX, targetY);
  await ctx.delay(500);

  // Don't poll with viewport events — they show the old visual position
  // (drag doesn't change visual). The actual widget position is revealed
  // by the arrow-down sync below.
  ctx.state.widgetScrollPosition = targetFirstVisible;
}

/**
 * Scroll the dropdown to make `index` visible.
 *
 * Two-phase approach based on CoDeSys PLC dropdown dual-state architecture:
 *
 * Phase 1 — Drag to set widget position:
 *   The drag only changes the widget (click-mapping) state, not the visual.
 *   The drag also "activates" the scrollbar widget — without a prior drag,
 *   arrow clicks only advance the visual, not the widget.
 *
 * Phase 2 — Combined arrow-down + arrow-up to sync and re-align:
 *   Arrow-down syncs visual to widget, arrow-up re-aligns widget with
 *   visual (fixes +1 offset). Both clicks sent rapidly (500ms apart),
 *   then a single poll window waits for the visual to settle (~12-15s).
 *   Continuous polling keeps the PLC's widget synchronized.
 *
 * Phase 3 — Arrow-UP clicks for fine adjustment:
 *   Arrow-UP from synced state decreases both visual and widget equally
 *   (no offset). Arrow-DOWN has a +1 widget offset, so we NEVER use
 *   arrow-down for fine adjustment.
 */
export async function scrollToTarget(
  ctx: CommandContext,
  lightId: string,
  index: number,
): Promise<void> {
  const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
  const maxFirstVisible = ctx.state.getDropdownMaxFirstVisible();
  const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;

  const needsScroll = !ctx.state.isDropdownIndexVisible(index);
  const widgetDesynced = ctx.state.widgetScrollPosition !== ctx.state.dropdownFirstVisible;

  if (!needsScroll && !widgetDesynced) return;

  // Phase 1: Drag to set widget position.
  // Use centered target (item at row 2) but ensure minimum of 2 positions
  // of movement so the PLC registers the drag.
  const MINIMUM_DRAG = 2;
  const centerRow = Math.floor(visibleItems / 2);
  const centered = Math.max(0, Math.min(index - centerRow, maxFirstVisible));
  const dragTarget = Math.max(MINIMUM_DRAG, Math.min(centered, maxFirstVisible));

  logger.info({
    lightId, index, needsScroll, widgetDesynced, dragTarget,
    widgetScrollPosition: ctx.state.widgetScrollPosition,
    dropdownFirstVisible: ctx.state.dropdownFirstVisible,
  }, 'Scroll to target: starting drag + sync');

  await dragToPosition(ctx, dragTarget, lightId);

  // Combined Phase 2 + 2.5: Send arrow-down (sync visual to widget) and
  // arrow-up (re-align widget) clicks rapidly, then poll once for the visual
  // to settle. This overlaps PLC processing of both clicks — instead of
  // sequential polling (Phase 2 ~7s + Phase 2.5 ~15s = ~22s), a single
  // poll window handles both (~12-15s).
  const downBtn = scrollbarConfig.arrowDown;
  const upBtn = scrollbarConfig.arrowUp;
  const startFv = ctx.state.dropdownFirstVisible;

  ctx.window.clear();
  const downCmds = await ctx.client.pressAndCollect(downBtn.x, downBtn.y);
  ctx.window.append(downCmds);
  await ctx.delay(500);
  const upCmds = await ctx.client.pressAndCollect(upBtn.x, upBtn.y);
  ctx.window.append(upCmds);

  const syncStart = Date.now();
  const syncDeadline = syncStart + 18000;
  const minSyncMs = 500; // Small floor to avoid accepting very early transients
  let lastSyncFv: number | null = null;
  let syncStable = 0;
  let syncMoved = false;
  let syncView: ReturnType<typeof resolveDropdownView> = null;
  let closedStreak = 0;
  let syncClosed = false;

  while (Date.now() < syncDeadline) {
    const cmds = await ctx.pollPaintCommands(`combined-sync:${lightId}`);

    const classification = classifyFrame(cmds);
    const definitelyClosed =
      classification.dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED &&
      classification.dropdownOpen < THRESHOLD_DROPDOWN_OPEN &&
      classification.dropdownItems.length === 0;
    closedStreak = definitelyClosed ? closedStreak + 1 : 0;
    if (closedStreak >= 2) { syncClosed = true; break; }

    const freshView = resolveDropdownView(cmds);
    const accView = resolveDropdownView(ctx.window.getCommands());
    const view = freshView ?? accView;

    if (view) {
      syncView = view;
      if (view.firstVisible !== startFv) syncMoved = true;

      if (view.firstVisible === lastSyncFv) {
        syncStable++;
        const elapsed = Date.now() - syncStart;
        if (syncMoved && syncStable >= 3 && elapsed >= minSyncMs) break;
      } else {
        syncStable = 1;
        lastSyncFv = view.firstVisible;
      }
    }

    const remaining = syncDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  if (syncClosed) {
    logger.warn({ lightId }, 'Dropdown closed during combined sync');
    const { view } = await reopenDropdownFromClosed(ctx, `sync-reopen:${lightId}`);
    if (view) ctx.state.applyDropdownView(view);
    return;
  }

  if (syncView) {
    ctx.state.applyDropdownView(syncView);
    ctx.state.widgetScrollPosition = syncView.firstVisible;
    logger.info({
      lightId, firstVisible: syncView.firstVisible, dragTarget,
      elapsed: Date.now() - syncStart,
    }, 'Visual settled after combined sync');
  }

  if (ctx.state.isDropdownIndexVisible(index)) return;

  // Phase 3: Arrow-UP clicks to fine-adjust from overshoot to target.
  const maxArrowAttempts = 10;
  for (let attempt = 0; attempt < maxArrowAttempts && !ctx.state.isDropdownIndexVisible(index); attempt++) {
    const targetFv = Math.max(0, Math.min(index - (visibleItems - 1), maxFirstVisible));
    const delta = targetFv - ctx.state.dropdownFirstVisible;
    if (delta >= 0) break; // Only scroll up (negative delta)

    const upBtn = scrollbarConfig.arrowUp;

    logger.info({
      lightId, index, attempt, delta,
      currentFirstVisible: ctx.state.dropdownFirstVisible,
      targetFirstVisible: targetFv,
    }, 'Arrow-UP fine adjustment');

    const upResult = await arrowScrollOneByOne(ctx, {
      arrowX: upBtn.x,
      arrowY: upBtn.y,
      clickCount: Math.min(Math.abs(delta), 10),
      direction: 'up',
      startFirstVisible: ctx.state.dropdownFirstVisible,
      scrollAttempt: attempt + 1,
      targetFirstVisible: targetFv,
    });

    if (upResult.closedDetected) {
      logger.warn({ attempt, lightId }, 'Dropdown closed during arrow-up');
      const { view } = await reopenDropdownFromClosed(ctx, `arrow-up-reopen:${lightId}:${attempt}`);
      if (view) ctx.state.applyDropdownView(view);
      break;
    }

    if (upResult.view) {
      ctx.state.applyDropdownView(upResult.view);
      ctx.state.widgetScrollPosition = upResult.view.firstVisible;
      logger.info({ attempt, firstVisible: upResult.view.firstVisible }, 'Arrow-up adjusted');
    }
  }

  if (!ctx.state.isDropdownIndexVisible(index)) {
    throw new Error(`Scroll failed: light=${lightId}, index=${index}, fv=${ctx.state.dropdownFirstVisible}`);
  }
}
