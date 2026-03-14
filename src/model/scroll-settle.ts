import { CommandContext } from './command-context';
import { DropdownView, resolveDropdownView } from './dropdown-labels';
import { classifyFrame, THRESHOLD_DROPDOWN_CLOSED, THRESHOLD_DROPDOWN_OPEN } from '../protocol/frame-classifier';
import pino from 'pino';

const logger = pino({ name: 'scroll-settle' });

export interface ScrollSettleResult {
  view: DropdownView | null;
  closedDetected: boolean;
}

/**
 * Wait for the dropdown scroll position to stabilize after a drag.
 *
 * Polls until two consecutive polls agree on the same firstVisible,
 * confirming the PLC has finished processing the scroll.
 */
export async function waitForScrollSettle(
  ctx: CommandContext,
  options: {
    reason: string;
    timeoutMs: number;
    preSettleDelayMs?: number;
    expectedToMove?: boolean;
  },
): Promise<ScrollSettleResult> {
  const { reason, timeoutMs, preSettleDelayMs = 300, expectedToMove = false } = options;

  await ctx.delay(preSettleDelayMs);
  ctx.window.clear();

  let lastFirstVisible: number | null = null;
  let stableCount = 0;
  let closedStreak = 0;
  let bestView: DropdownView | null = null;
  let everMoved = false;

  // If we expect movement, require more polls to confirm no-movement stability
  const requiredStable = 3;
  const requiredStableNoMovement = expectedToMove ? 6 : requiredStable;

  const deadline = Date.now() + timeoutMs;
  let poll = 0;

  while (Date.now() < deadline) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`scroll-settle:${reason}:${poll}`);

    const classification = classifyFrame(cmds);
    const definitelyClosed =
      classification.dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED &&
      classification.dropdownOpen < THRESHOLD_DROPDOWN_OPEN &&
      classification.dropdownItems.length === 0;
    closedStreak = definitelyClosed ? closedStreak + 1 : 0;
    if (closedStreak >= 2) {
      return { view: bestView, closedDetected: true };
    }

    const freshView = resolveDropdownView(cmds);
    const accumulatedView = resolveDropdownView(ctx.window.getCommands());
    const currentView = freshView ?? accumulatedView;

    if (currentView) {
      bestView = currentView;

      if (currentView.firstVisible === lastFirstVisible) {
        stableCount++;
        const threshold = everMoved ? requiredStable : requiredStableNoMovement;
        if (stableCount >= threshold) {
          logger.info({
            reason, poll, firstVisible: currentView.firstVisible,
            labelCount: currentView.labels.length, everMoved,
          }, 'Scroll position stable');
          return { view: currentView, closedDetected: false };
        }
      } else {
        if (lastFirstVisible !== null) everMoved = true;
        logger.debug({
          reason, poll,
          previous: lastFirstVisible,
          current: currentView.firstVisible,
        }, 'Scroll position still changing');
        stableCount = 1;
        lastFirstVisible = currentView.firstVisible;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  if (bestView) {
    logger.warn({ reason, firstVisible: bestView.firstVisible, poll }, 'Scroll settle timed out; using best view');
  } else {
    logger.warn({ reason, poll }, 'Scroll settle timed out with no view');
  }

  return { view: bestView, closedDetected: false };
}

/**
 * Click arrow buttons one at a time, waiting for each click to register.
 *
 * Each arrow click advances the dropdown by exactly 1 position. This function
 * sends one click, then polls until the position advances by 1 from the
 * previous position, before sending the next click. This ensures every click
 * is fully processed before the next one.
 *
 * Returns the final stable view, or null if the scroll stalled or closed.
 */
export async function arrowScrollOneByOne(
  ctx: CommandContext,
  options: {
    arrowX: number;
    arrowY: number;
    clickCount: number;
    direction: 'down' | 'up';
    startFirstVisible: number;
    scrollAttempt: number;
    targetFirstVisible?: number;
    interClickDelayMs?: number;
  },
): Promise<ScrollSettleResult> {
  const { arrowX, arrowY, clickCount, direction, startFirstVisible, scrollAttempt, targetFirstVisible, interClickDelayMs = 100 } = options;

  let currentFirstVisible = startFirstVisible;
  let latestView: DropdownView | null = null;

  for (let i = 0; i < clickCount; i++) {
    // No retries — duplicate clicks cause PLC click-mapping desync (PLC
    // processes both but only updates visual once). Use a longer timeout
    // instead to wait for slow PLC visual updates.
    const maxClickAttempts = 1;

    let advanced = false;
    for (let attempt = 0; attempt < maxClickAttempts && !advanced; attempt++) {
      ctx.window.clear();

      const clickCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
      ctx.window.append(clickCmds);

      // PLC arrow click visual updates take 7–10s under load; 10s timeout
      // causes phantom stalls where the click IS processed but the render
      // arrives just after the deadline, creating click-mapping desync.
      const perClickDeadline = Date.now() + 20000;

      while (Date.now() < perClickDeadline) {
        const cmds = await ctx.pollPaintCommands(`arrow-click:${scrollAttempt}:${i}:${attempt}`);

        const freshView = resolveDropdownView(cmds);
        const accumulatedView = resolveDropdownView(ctx.window.getCommands());
        const view = freshView ?? accumulatedView;

        if (view) {
          latestView = view;
          const movedCorrectDirection = direction === 'down'
            ? view.firstVisible > currentFirstVisible
            : view.firstVisible < currentFirstVisible;
          if (movedCorrectDirection) {
            logger.info({
              scrollAttempt, click: i, attempt,
              from: currentFirstVisible, to: view.firstVisible,
            }, 'Arrow click registered');
            currentFirstVisible = view.firstVisible;
            advanced = true;
            break;
          }
        }

        const remaining = perClickDeadline - Date.now();
        if (remaining > 0) await ctx.delay(Math.min(200, remaining));
      }

      if (!advanced && attempt < maxClickAttempts - 1) {
        logger.info({
          scrollAttempt, click: i, attempt, currentFirstVisible,
        }, 'Arrow click ignored by PLC — retrying');
        await ctx.delay(500);
      }
    }

    if (!advanced) {
      logger.warn({
        scrollAttempt, click: i, currentFirstVisible,
      }, 'Arrow click did not advance position');
      break;
    }

    // Stop early if we've reached or passed the target
    if (targetFirstVisible !== undefined) {
      const reached = direction === 'down'
        ? currentFirstVisible >= targetFirstVisible
        : currentFirstVisible <= targetFirstVisible;
      if (reached) {
        logger.info({
          scrollAttempt, click: i, currentFirstVisible, targetFirstVisible,
        }, 'Target reached — stopping arrow clicks');
        break;
      }
    }

    // Delay before next click to let PLC finish processing
    if (i < clickCount - 1) await ctx.delay(interClickDelayMs);
  }

  return { view: latestView, closedDetected: false };
}

/**
 * Send all arrow clicks rapidly without waiting for visual confirmation
 * between each click, then wait for the visual to stabilize.
 *
 * Much faster than one-by-one for large deltas: sending N clicks takes
 * ~N*100ms, then a single settle wait of ~10-15s. Compared to one-by-one
 * which takes N * 7-10s (7-10s per click for PLC render).
 *
 * The trade-off: if some clicks are lost, we end up short of the target.
 * The caller should retry with the remaining delta.
 */
export async function batchArrowScroll(
  ctx: CommandContext,
  options: {
    arrowX: number;
    arrowY: number;
    clickCount: number;
    direction: 'down' | 'up';
    startFirstVisible: number;
    targetFirstVisible: number;
    scrollAttempt: number;
  },
): Promise<ScrollSettleResult> {
  const { arrowX, arrowY, clickCount, direction, startFirstVisible, targetFirstVisible, scrollAttempt } = options;

  // Phase 1: Send all clicks with moderate pacing.
  // Too fast (80ms) causes PLC visual/click-mapping desync.
  // Too slow (7s one-by-one) is impractical for large deltas.
  // 500ms gives the PLC time to process each click internally
  // (the actual render takes longer but happens in the background).
  const interClickMs = 500;
  logger.info({
    scrollAttempt, clickCount, direction, startFirstVisible, targetFirstVisible,
    interClickMs,
  }, 'Batch sending arrow clicks');

  for (let i = 0; i < clickCount; i++) {
    await ctx.client.pressAndCollect(arrowX, arrowY);
    if (i < clickCount - 1) await ctx.delay(interClickMs);
  }

  // Phase 2: Wait for visual to stabilize at the final position.
  // The PLC processes each click sequentially (~7s each for rendering).
  // We must wait for the position to CHANGE from startFirstVisible before
  // counting stability — otherwise we falsely declare "stable" at the old
  // position while the PLC is still processing.
  ctx.window.clear();
  const deadline = Date.now() + 60000;
  let stableCount = 0;
  let lastFirstVisible: number | null = null;
  let bestView: DropdownView | null = null;
  let closedStreak = 0;
  let poll = 0;
  let everMoved = false;

  // Require more stable polls before the position has moved (to avoid
  // declaring stable at the starting position while PLC is still processing).
  const requiredStableBeforeMove = 8;
  const requiredStableAfterMove = 3;

  while (Date.now() < deadline) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`batch-arrow-settle:${scrollAttempt}:${poll}`);

    const classification = classifyFrame(cmds);
    const definitelyClosed =
      classification.dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED &&
      classification.dropdownOpen < THRESHOLD_DROPDOWN_OPEN &&
      classification.dropdownItems.length === 0;
    closedStreak = definitelyClosed ? closedStreak + 1 : 0;
    if (closedStreak >= 2) {
      return { view: bestView, closedDetected: true };
    }

    const freshView = resolveDropdownView(cmds);
    const accumulatedView = resolveDropdownView(ctx.window.getCommands());
    const currentView = freshView ?? accumulatedView;

    if (currentView) {
      bestView = currentView;

      if (currentView.firstVisible !== startFirstVisible) {
        everMoved = true;
      }

      if (currentView.firstVisible === lastFirstVisible) {
        stableCount++;
        const threshold = everMoved ? requiredStableAfterMove : requiredStableBeforeMove;
        if (stableCount >= threshold) {
          logger.info({
            scrollAttempt, poll, firstVisible: currentView.firstVisible,
            targetFirstVisible, clickCount, everMoved,
          }, 'Batch arrow scroll stable');
          return { view: currentView, closedDetected: false };
        }
      } else {
        stableCount = 1;
        lastFirstVisible = currentView.firstVisible;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  if (bestView) {
    logger.warn({
      scrollAttempt, firstVisible: bestView.firstVisible,
      targetFirstVisible, poll, everMoved,
    }, 'Batch arrow settle timed out; using best view');
  } else {
    logger.warn({ scrollAttempt, poll }, 'Batch arrow settle timed out with no view');
  }

  return { view: bestView, closedDetected: false };
}
