import { classifyFrame, THRESHOLD_DROPDOWN_CLOSED, THRESHOLD_DROPDOWN_OPEN } from '../protocol/frame-classifier';
import { CommandContext } from './command-context';
import { DropdownView, resolveDropdownView, isViewReadyForClick, isViewInRange } from './dropdown-labels';

export interface WaitForDropdownOptions {
  reason: string;
  timeoutMs: number;
  /** View's firstVisible must be in this range */
  expectedRange?: { min: number; max: number };
  /** View must be ready for clicking this index (≥3 labels + target visible) */
  readyForClickIndex?: number;
  /** Latest poll must contain fresh dropdown labels */
  requireFreshLabels?: boolean;
}

export async function waitForDropdownReady(
  ctx: CommandContext,
  options: WaitForDropdownOptions,
): Promise<{ view: DropdownView | null; closedDetected: boolean }> {
  const { reason, timeoutMs, expectedRange, readyForClickIndex, requireFreshLabels } = options;

  const isReady = (v: DropdownView | null, hasFreshLabels: boolean): boolean => {
    if (!v) return false;
    if (expectedRange && !isViewInRange(v, expectedRange)) return false;
    if (readyForClickIndex !== undefined && !isViewReadyForClick(v, readyForClickIndex)) return false;
    if (requireFreshLabels && !hasFreshLabels) return false;
    return true;
  };

  let view = resolveDropdownView(ctx.window.getCommands());
  if (expectedRange && !isViewInRange(view, expectedRange)) view = null;
  if (requireFreshLabels) view = null;

  if (isReady(view, false) && !requireFreshLabels) {
    return { view, closedDetected: false };
  }

  if (timeoutMs <= 0) {
    return { view: isReady(view, false) ? view : null, closedDetected: false };
  }

  let closedDetected = false;
  let closedStreak = 0;

  const deadline = Date.now() + timeoutMs;
  let poll = 0;

  while (Date.now() < deadline && !closedDetected) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`dropdown-ready:${reason}:${poll}`);

    const classification = classifyFrame(cmds);
    const definitelyClosed =
      classification.dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED &&
      classification.dropdownOpen < THRESHOLD_DROPDOWN_OPEN &&
      classification.dropdownItems.length === 0;
    closedStreak = definitelyClosed ? closedStreak + 1 : 0;
    closedDetected = closedStreak >= 2;
    const freshCandidate = resolveDropdownView(cmds);
    const freshLabels = classification.dropdownItems.length > 0;
    const accumulatedView = resolveDropdownView(ctx.window.getCommands());
    const candidate = freshCandidate ?? accumulatedView;

    if (isReady(candidate, freshLabels)) {
      view = candidate;
      break;
    }

    if (candidate && (!expectedRange || isViewInRange(candidate, expectedRange))) {
      if (!requireFreshLabels || freshLabels) {
        view = candidate;
      }
    }

    if (closedDetected) break;

    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  return { view, closedDetected };
}
