import { config, uiCoordinates } from '../config';
import { extractTextLabels } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { isDropdownOpen, syncDropdownStateFromCommands } from '../model/dropdown-detection';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
import pino from 'pino';

const logger = pino({ name: 'open-dropdown' });

export async function openDropdown(
  ctx: CommandContext,
  lightId: string,
): Promise<{ view: DropdownView | null }> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;
  const dropdownOpenTimeoutMs = config.protocol?.dropdownOpenTimeoutMs ?? 6000;

  // Clear window for fresh open detection
  ctx.window.clear();

  const clickCommands = await ctx.client.pressAndCollect(arrowX, arrowY);
  ctx.window.append(clickCommands);
  logger.info({
    commandCount: clickCommands.length,
    labelCount: extractTextLabels(clickCommands).length,
  }, 'Dropdown open: pressAndCollect response');

  // Check accumulated commands for open detection
  // (PLC renders dropdown labels progressively across multiple frames)
  // Use shorter timeout (3s) for first attempt — if it was a toggle-close,
  // we want to retry quickly rather than wait the full 6s.
  let openDetected = isDropdownOpen(ctx.window.getCommands());
  if (!openDetected) {
    const firstAttemptTimeout = Math.min(3000, dropdownOpenTimeoutMs);
    const deadline = Date.now() + firstAttemptTimeout;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      await ctx.pollPaintCommands(`dropdown-open-verify:${poll}:${lightId}`);
      if (isDropdownOpen(ctx.window.getCommands())) {
        openDetected = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(200, remaining));
    }
  }

  // If the first click didn't open the dropdown, it may have CLOSED it instead
  // (the PLC had the dropdown open internally from the previous operation, but
  // ensureDropdownClosed couldn't detect it). A second click reopens it.
  // Reset widget position — after the close/reopen toggle, the PLC's widget
  // state is unknown and our tracked position is likely stale.
  if (!openDetected) {
    logger.warn({ lightId }, 'First click did not open dropdown — retrying (likely toggled closed)');
    ctx.state.widgetScrollPosition = 0;
    ctx.window.clear();
    const retryCommands = await ctx.client.pressAndCollect(arrowX, arrowY);
    ctx.window.append(retryCommands);
    openDetected = isDropdownOpen(ctx.window.getCommands());
    if (!openDetected) {
      const retryDeadline = Date.now() + dropdownOpenTimeoutMs;
      let retryPoll = 0;
      while (Date.now() < retryDeadline) {
        retryPoll++;
        await ctx.pollPaintCommands(`dropdown-open-retry:${retryPoll}:${lightId}`);
        if (isDropdownOpen(ctx.window.getCommands())) {
          openDetected = true;
          break;
        }
        const remaining = retryDeadline - Date.now();
        if (remaining > 0) await ctx.delay(Math.min(200, remaining));
      }
    }
  }

  if (!openDetected) {
    throw new Error(`Dropdown failed to open for light=${lightId}`);
  }

  const openSettle = await waitForDropdownReady(ctx, {
    reason: `open-settle:${lightId}`,
    timeoutMs: 2200,
    requireFreshLabels: true,
  });

  syncDropdownStateFromCommands(ctx.window.getCommands(), ctx.state, 'on-open');
  const view = openSettle.view ?? resolveDropdownView(ctx.window.getCommands());
  if (!view) {
    throw new Error(`Dropdown opened but no stable view for light=${lightId}`);
  }

  logger.info({
    hasView: true,
    firstVisible: view.firstVisible,
    labelCount: view.labels.length,
    labels: view.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top })),
  }, 'Initial dropdown view');

  // Clear window after stable open — fresh start for next phase
  ctx.window.clear();

  return { view };
}
