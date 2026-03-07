import { config, uiCoordinates } from '../config';
import { PaintCommand, extractTextLabels } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { PaintCollector } from '../model/paint-collector';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { didPressLeaveDropdownOpen, syncDropdownStateFromCommands } from '../model/dropdown-detection';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
import { ensureDropdownClosed } from './ensure-dropdown-closed';
import pino from 'pino';

const logger = pino({ name: 'open-dropdown' });

export async function openDropdown(
  ctx: CommandContext,
  collector: PaintCollector,
  lightId: string,
): Promise<{ view: DropdownView | null }> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;
  const dropdownOpenTimeoutMs = config.protocol?.dropdownOpenTimeoutMs ?? 6000;
  const maxOpenAttempts = 3;
  let dropdownOpened = false;
  let attemptCommands: PaintCommand[] = [];

  for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
    attemptCommands = [];
    const { downCommands, upCommands } = await ctx.client.pressAndCollectDetailed(arrowX, arrowY);
    const clickCommands = [...downCommands, ...upCommands];
    attemptCommands.push(...clickCommands);
    collector.add(clickCommands);
    logger.info({
      openAttempt,
      commandCount: clickCommands.length,
      labelCount: extractTextLabels(clickCommands).length,
    }, 'Dropdown open: pressAndCollect response');

    const settledCommands: PaintCommand[] = [...upCommands];
    if (didPressLeaveDropdownOpen(downCommands, settledCommands)) {
      dropdownOpened = true;
      attemptCommands = [...downCommands, ...settledCommands];
      break;
    }

    const deadline = Date.now() + dropdownOpenTimeoutMs;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      const cmds = await ctx.pollPaintCommands(`dropdown-open-verify:${openAttempt}:${poll}:${lightId}`);
      settledCommands.push(...cmds);
      attemptCommands.push(...cmds);
      collector.add(cmds);
      if (didPressLeaveDropdownOpen(downCommands, settledCommands)) {
        dropdownOpened = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(200, remaining));
    }

    if (dropdownOpened) break;

    if (openAttempt < maxOpenAttempts) {
      logger.warn({ lightId, openAttempt }, 'Dropdown not verified as open after final-state checks; resetting and retrying');
      const closeCollector = new PaintCollector();
      await ensureDropdownClosed(ctx, closeCollector, `open-retry:${lightId}:${openAttempt}`);
      collector.add(closeCollector.getAll());
    }
  }

  if (!dropdownOpened) {
    throw new Error(`Dropdown failed to open after ${maxOpenAttempts} attempts for light=${lightId}`);
  }

  const openSettle = await waitForDropdownReady(ctx, {
    seedCommands: attemptCommands,
    reason: `open-settle:${lightId}`,
    timeoutMs: 1600,
  });
  if (openSettle.commands.length > 0) {
    attemptCommands.push(...openSettle.commands);
    collector.add(openSettle.commands);
  }
  if (openSettle.closedDetected && !openSettle.view) {
    throw new Error(`Dropdown closed during open settle for light=${lightId}`);
  }

  syncDropdownStateFromCommands(attemptCommands, ctx.state, 'on-open');
  const view = resolveDropdownView(attemptCommands);

  logger.info({
    hasView: !!view,
    firstVisible: view?.firstVisible,
    labelCount: view?.labels.length,
    labels: view?.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top })),
  }, 'Initial dropdown view');

  return { view };
}
