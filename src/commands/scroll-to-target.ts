import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { arrowScrollOneByOne } from '../model/scroll-settle';
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
 * Three-phase approach based on CoDeSys PLC dropdown dual-state architecture:
 *
 * Phase 1 — Drag to set widget position:
 *   The drag only changes the widget (click-mapping) state, not the visual.
 *   The drag also "activates" the scrollbar widget — without a prior drag,
 *   arrow clicks only advance the visual, not the widget.
 *
 * Phase 2 — One arrow-down to sync visual to widget:
 *   The first arrow-down from desynced state (visual≠widget) syncs the
 *   visual to the widget position.
 *
 * Phase 2.5 — One arrow-UP to re-align widget with visual:
 *   After drag + arrow-down sync, the PLC's widget may be 1 ahead of
 *   the visual. One arrow-UP from this state re-synchronizes both.
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

  // Phase 2: One arrow-down to sync visual to widget.
  const downBtn = scrollbarConfig.arrowDown;
  const syncResult = await arrowScrollOneByOne(ctx, {
    arrowX: downBtn.x,
    arrowY: downBtn.y,
    clickCount: 1,
    direction: 'down',
    startFirstVisible: ctx.state.dropdownFirstVisible,
    scrollAttempt: 0,
  });
  if (syncResult.view) {
    ctx.state.applyDropdownView(syncResult.view);
    ctx.state.widgetScrollPosition = syncResult.view.firstVisible;
    logger.info({
      lightId, firstVisible: syncResult.view.firstVisible, dragTarget,
    }, 'Visual synced after drag');
  }

  if (syncResult.closedDetected) {
    logger.warn({ lightId }, 'Dropdown closed during sync arrow-down');
    const { view } = await reopenDropdownFromClosed(ctx, `sync-reopen:${lightId}`);
    if (view) ctx.state.applyDropdownView(view);
    return; // Caller will retry the full operation
  }

  // Phase 2.5: Arrow-UP to re-align widget with visual.
  // After drag + arrow-down sync, the PLC's widget (click-mapping) position
  // may be 1 ahead of the visual. One arrow-UP re-aligns the widget to match
  // the visual. The visual may transiently increase (D→D+1) then settle back
  // to D. The polling duration must be long enough for this round-trip.
  // Continuous polling (heartbeats) keeps the PLC's widget synchronized.
  if (ctx.state.dropdownFirstVisible > 0) {
    const upBtn = scrollbarConfig.arrowUp;
    const resyncResult = await arrowScrollOneByOne(ctx, {
      arrowX: upBtn.x,
      arrowY: upBtn.y,
      clickCount: 1,
      direction: 'up',
      startFirstVisible: ctx.state.dropdownFirstVisible,
      scrollAttempt: 0,
      perClickTimeoutMs: 15000,
    });
    if (resyncResult.closedDetected) {
      logger.warn({ lightId }, 'Dropdown closed during resync arrow-up');
      const { view } = await reopenDropdownFromClosed(ctx, `resync-reopen:${lightId}`);
      if (view) ctx.state.applyDropdownView(view);
      return;
    }
    if (resyncResult.view) {
      ctx.state.applyDropdownView(resyncResult.view);
      ctx.state.widgetScrollPosition = resyncResult.view.firstVisible;
      logger.info({
        lightId, firstVisible: resyncResult.view.firstVisible,
      }, 'Post-sync arrow-UP re-alignment');
    }
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
