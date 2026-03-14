import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { isDropdownOpen, isDropdownDefinitivelyClosed } from '../model/dropdown-detection';
import { classifyFrame } from '../protocol/frame-classifier';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
import pino from 'pino';

const logger = pino({ name: 'ensure-dropdown-closed' });

/**
 * Close the dropdown if it's open. Clicks the dropdown arrow at most ONCE
 * to avoid toggle storms — clicking multiple times rapidly toggles the
 * dropdown open/close/open/close, corrupting the PLC's internal state.
 *
 * After clicking, waits up to 3s for close confirmation. If the dropdown
 * appears already closed (no open signals for 2 consecutive polls), returns
 * immediately without clicking.
 */
export async function ensureDropdownClosed(
  ctx: CommandContext,
  reason: string,
): Promise<void> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  // Clear window for fresh close detection
  ctx.window.clear();

  // Phase 1: Check if already closed (up to 1.5s)
  // Require at least one frame with real content before accepting "not open"
  // as evidence of closed. Empty/minimal frames during PLC transitions can
  // cause false negatives — the PLC may still have the dropdown open internally
  // but hasn't rendered the dropdown labels yet.
  const probeDeadline = Date.now() + 1500;
  let notOpenStreak = 0;
  let poll = 0;
  let openSeen = false;
  let contentfulFrameSeen = false;
  while (Date.now() < probeDeadline) {
    poll++;
    const probeCmds = await ctx.pollPaintCommands(`dropdown-close-probe:${reason}:${poll}`);

    if (isDropdownDefinitivelyClosed(probeCmds)) return;

    const accumulated = ctx.window.getCommands();
    if (isDropdownDefinitivelyClosed(accumulated) && !isDropdownOpen(accumulated)) return;

    // Track whether we've seen a frame with real content (not empty/minimal)
    const classification = classifyFrame(probeCmds);
    if (classification.textLabelCount > 0 || classification.imageCount > 0) {
      contentfulFrameSeen = true;
    }

    if (!isDropdownOpen(probeCmds)) {
      notOpenStreak++;
      // Only accept "not open" as closed if we've seen actual content
      if (notOpenStreak >= 2 && contentfulFrameSeen) return;
    } else {
      notOpenStreak = 0;
      openSeen = true;
      break; // Confirmed open — proceed to click
    }

    const remaining = probeDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(120, remaining));
  }

  if (!openSeen) return; // No open signal seen — assume closed

  // Phase 2: Single click to close
  logger.info({ reason, poll }, 'Dropdown appears open; clicking arrow to close');
  ctx.window.clear();
  const clickCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
  ctx.window.append(clickCmds);
  if (isDropdownDefinitivelyClosed(clickCmds)) return;

  // Phase 3: Wait for close confirmation (up to 3s)
  // Do NOT click again — a second click would reopen the dropdown.
  const closeDeadline = Date.now() + 3000;
  notOpenStreak = 0;
  while (Date.now() < closeDeadline) {
    poll++;
    const waitCmds = await ctx.pollPaintCommands(`dropdown-close-wait:${reason}:${poll}`);
    if (isDropdownDefinitivelyClosed(waitCmds)) return;

    const postClickAccum = ctx.window.getCommands();
    if (isDropdownDefinitivelyClosed(postClickAccum) && !isDropdownOpen(postClickAccum)) return;

    if (!isDropdownOpen(waitCmds)) {
      notOpenStreak++;
      if (notOpenStreak >= 2) return;
    } else {
      notOpenStreak = 0;
    }

    const remaining = closeDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  throw new Error(`Dropdown failed to close: ${reason}`);
}

/**
 * Close and reopen the dropdown to sync visual and click mapping after a drag.
 * Uses a fixed delay instead of polling for close confirmation — the PLC
 * often takes >3s to render definitive close signals after a scrollbar drag,
 * making detection-based close unreliable.
 */
export async function closeAndReopenForDragSync(
  ctx: CommandContext,
  reason: string,
): Promise<{
  view: DropdownView | null;
}> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  // Close: single click + fixed delay. No detection polling to avoid
  // false "still open" → second click → toggle storm.
  ctx.window.clear();
  await ctx.client.pressAndCollect(arrowX, arrowY);
  await ctx.delay(1500);
  // Drain any pending paint commands from the close transition
  await ctx.pollPaintCommands(`drag-sync-close-drain:${reason}`);

  // Open: single click + wait for labels
  ctx.window.clear();
  const openCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
  ctx.window.append(openCmds);

  let openDetected = isDropdownOpen(ctx.window.getCommands());
  if (!openDetected) {
    const deadline = Date.now() + 5000;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      await ctx.pollPaintCommands(`drag-sync-open-wait:${reason}:${poll}`);
      if (isDropdownOpen(ctx.window.getCommands())) {
        openDetected = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  if (!openDetected) {
    logger.warn({ reason }, 'Drag sync reopen did not detect open — clicking again');
    ctx.window.clear();
    const retryCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
    ctx.window.append(retryCmds);
    const retryDeadline = Date.now() + 3000;
    let retryPoll = 0;
    while (Date.now() < retryDeadline) {
      retryPoll++;
      await ctx.pollPaintCommands(`drag-sync-open-retry:${reason}:${retryPoll}`);
      if (isDropdownOpen(ctx.window.getCommands())) {
        openDetected = true;
        break;
      }
      const remaining = retryDeadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  const settled = await waitForDropdownReady(ctx, {
    reason: `drag-sync-settle:${reason}`,
    timeoutMs: openDetected ? 2200 : 1200,
    requireFreshLabels: true,
  });
  const view = settled.view ?? resolveDropdownView(ctx.window.getCommands());
  if (view) {
    ctx.state.applyDropdownView(view);
    logger.info({ reason, firstVisible: view.firstVisible }, 'Drag sync: dropdown reopened and synced');
  } else {
    logger.warn({ reason, openDetected }, 'Drag sync: reopen produced no view');
  }

  return { view };
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
    // One retry click — the first click may have reopened a closed dropdown
    // that then closed again, or the PLC was slow to render.
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
