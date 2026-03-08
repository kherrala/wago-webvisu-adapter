import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { isDropdownOpen, isDropdownDefinitivelyClosed } from '../model/dropdown-detection';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
import pino from 'pino';

const logger = pino({ name: 'ensure-dropdown-closed' });

export async function ensureDropdownClosed(
  ctx: CommandContext,
  reason: string,
): Promise<void> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  // Clear window for fresh close detection
  ctx.window.clear();

  const deadline = Date.now() + 4500;
  let poll = 0;
  let notOpenStreak = 0;
  while (Date.now() < deadline) {
    poll++;
    const probeCmds = await ctx.pollPaintCommands(`dropdown-close-probe:${reason}:${poll}`);

    // Check fresh poll for definitive close
    if (isDropdownDefinitivelyClosed(probeCmds)) return;

    // Check accumulated commands — handles progressive rendering
    const accumulated = ctx.window.getCommands();
    if (isDropdownDefinitivelyClosed(accumulated) && !isDropdownOpen(accumulated)) return;

    // Track consecutive polls that don't show open signals
    if (!isDropdownOpen(probeCmds)) {
      notOpenStreak++;
      // Two consecutive "not open" fresh polls → assume closed
      if (notOpenStreak >= 2) return;
    } else {
      notOpenStreak = 0;
    }

    // Only click to close if fresh poll actually shows dropdown open
    if (isDropdownOpen(probeCmds)) {
      logger.info({ reason, poll }, 'Dropdown appears open; clicking arrow to close');
      ctx.window.clear();
      const clickCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
      ctx.window.append(clickCmds);
      if (isDropdownDefinitivelyClosed(clickCmds)) return;

      const postClickDeadline = Date.now() + 900;
      while (Date.now() < postClickDeadline) {
        const waitCmds = await ctx.pollPaintCommands(`dropdown-close-wait:${reason}:${poll}`);
        if (isDropdownDefinitivelyClosed(waitCmds)) return;
        // Check accumulated since click
        const postClickAccum = ctx.window.getCommands();
        if (isDropdownDefinitivelyClosed(postClickAccum) && !isDropdownOpen(postClickAccum)) return;
        const remainingPostClick = postClickDeadline - Date.now();
        if (remainingPostClick > 0) await ctx.delay(Math.min(120, remainingPostClick));
      }
      notOpenStreak = 0;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(120, remaining));
  }

  throw new Error(`Dropdown failed to close: ${reason}`);
}

export async function reopenDropdownFromClosed(
  ctx: CommandContext,
  reason: string,
): Promise<{
  view: DropdownView | null;
}> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  try {
    await ensureDropdownClosed(ctx, `reopen:${reason}`);
  } catch (error) {
    logger.warn({ error, reason }, 'Dropdown close could not be confirmed before reopen; continuing');
  }

  // Clear window for fresh reopen detection
  ctx.window.clear();

  const clickCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
  ctx.window.append(clickCmds);

  let openDetected = isDropdownOpen(ctx.window.getCommands());
  if (!openDetected) {
    const deadline = Date.now() + 4000;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      await ctx.pollPaintCommands(`reopen-wait:${reason}:${poll}`);
      if (isDropdownOpen(ctx.window.getCommands())) {
        openDetected = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  if (!openDetected) {
    ctx.window.clear();
    const retryCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
    ctx.window.append(retryCmds);
    openDetected = isDropdownOpen(ctx.window.getCommands());
    if (!openDetected) {
      const retryDeadline = Date.now() + 2200;
      let retryPoll = 0;
      while (Date.now() < retryDeadline) {
        retryPoll++;
        await ctx.pollPaintCommands(`reopen-retry-wait:${reason}:${retryPoll}`);
        if (isDropdownOpen(ctx.window.getCommands())) {
          openDetected = true;
          break;
        }
        const remaining = retryDeadline - Date.now();
        if (remaining > 0) await ctx.delay(Math.min(150, remaining));
      }
    }
  }

  const settled = await waitForDropdownReady(ctx, {
    reason: `reopen-settle:${reason}`,
    timeoutMs: openDetected ? 2200 : 1200,
    requireFreshLabels: true,
  });
  const view = settled.view ?? resolveDropdownView(ctx.window.getCommands());
  if (view) {
    ctx.state.applyDropdownView(view);
    logger.info({ reason, firstVisible: view.firstVisible }, 'Dropdown reopened and synced');
  } else {
    logger.warn({ reason, openDetected }, 'Dropdown reopen produced no view');
  }

  return { view };
}
