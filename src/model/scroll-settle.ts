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
  },
): Promise<ScrollSettleResult> {
  const { arrowX, arrowY, clickCount, direction, startFirstVisible, scrollAttempt } = options;

  let currentFirstVisible = startFirstVisible;
  let latestView: DropdownView | null = null;

  for (let i = 0; i < clickCount; i++) {
    ctx.window.clear();

    const clickCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
    ctx.window.append(clickCmds);

    const perClickDeadline = Date.now() + 800;
    let advanced = false;
    let closedStreak = 0;

    while (Date.now() < perClickDeadline) {
      const cmds = await ctx.pollPaintCommands(`arrow-click:${scrollAttempt}:${i}`);

      const classification = classifyFrame(cmds);
      const definitelyClosed =
        classification.dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED &&
        classification.dropdownOpen < THRESHOLD_DROPDOWN_OPEN &&
        classification.dropdownItems.length === 0;
      closedStreak = definitelyClosed ? closedStreak + 1 : 0;
      if (closedStreak >= 2) {
        return { view: latestView, closedDetected: true };
      }

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
            scrollAttempt, click: i,
            from: currentFirstVisible, to: view.firstVisible,
          }, 'Arrow click registered');
          currentFirstVisible = view.firstVisible;
          advanced = true;
          break;
        }
      }

      const remaining = perClickDeadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(80, remaining));
    }

    if (!advanced) {
      logger.warn({
        scrollAttempt, click: i, currentFirstVisible,
      }, 'Arrow click did not advance position');
      break;
    }

    // Brief delay before next click to let PLC finish processing
    if (i < clickCount - 1) await ctx.delay(100);
  }

  return { view: latestView, closedDetected: false };
}
