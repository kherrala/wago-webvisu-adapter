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
  let openDetected = isDropdownOpen(ctx.window.getCommands());

  // If pressAndCollect returned a large response (full page repaint) but no
  // dropdown labels, the click likely toggled a stale-open dropdown closed.
  // The PLC sometimes retains an internal "dropdown open" state after a rapid
  // select cycle, even though the visual render shows it closed. Our first
  // arrow click then closes it instead of opening it. A second click opens
  // it properly.
  if (!openDetected && clickCommands.length > 50) {
    logger.info({ commandCount: clickCommands.length }, 'Large response without dropdown — retrying (likely toggled stale dropdown closed)');
    await ctx.delay(500);
    ctx.window.clear();
    await ctx.pollPaintCommands(`dropdown-open-retry-drain:${lightId}`);
    ctx.window.clear();
    const retryCommands = await ctx.client.pressAndCollect(arrowX, arrowY);
    ctx.window.append(retryCommands);
    openDetected = isDropdownOpen(ctx.window.getCommands());
    logger.info({ retryCommandCount: retryCommands.length, openDetected }, 'Retry click result');
  }

  if (!openDetected) {
    const deadline = Date.now() + dropdownOpenTimeoutMs;
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
