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
  const maxOpenAttempts = 4;

  for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
    let dropdownOpened = false;
    const attemptCommands: PaintCommand[] = [];
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
      attemptCommands.push(...downCommands, ...settledCommands);
      if (attemptCommands.length > 240) {
        attemptCommands.splice(0, attemptCommands.length - 240);
      }
    } else {
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
    }

    if (!dropdownOpened) {
      if (openAttempt < maxOpenAttempts) {
        logger.warn({ lightId, openAttempt }, 'Dropdown open was not confirmed; resetting and retrying');
        const closeCollector = new PaintCollector();
        await ensureDropdownClosed(ctx, closeCollector, `open-retry:${lightId}:${openAttempt}`);
        collector.add(closeCollector.getAll());
      }
      continue;
    }

    const openSettle = await waitForDropdownReady(ctx, {
      seedCommands: attemptCommands,
      reason: `open-settle:${lightId}:${openAttempt}`,
      timeoutMs: 2200,
    });
    if (openSettle.commands.length > 0) {
      attemptCommands.push(...openSettle.commands);
      collector.add(openSettle.commands);
    }

    syncDropdownStateFromCommands(attemptCommands, ctx.state, 'on-open');
    const view = openSettle.view ?? resolveDropdownView(attemptCommands);
    if (view) {
      logger.info({
        hasView: true,
        firstVisible: view.firstVisible,
        labelCount: view.labels.length,
        labels: view.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top })),
      }, 'Initial dropdown view');
      return { view };
    }

    if (openAttempt < maxOpenAttempts) {
      logger.warn({
        lightId,
        openAttempt,
        closedDetected: openSettle.closedDetected,
      }, 'Dropdown open settle produced no stable view; resetting and retrying');
      const closeCollector = new PaintCollector();
      await ensureDropdownClosed(ctx, closeCollector, `open-settle-retry:${lightId}:${openAttempt}`);
      collector.add(closeCollector.getAll());
    }
  }

  throw new Error(`Dropdown failed to open after ${maxOpenAttempts} attempts for light=${lightId}`);
}
