import { uiCoordinates } from '../config';
import { PaintCommand } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { PaintCollector } from '../model/paint-collector';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { isDropdownOpen, didPressLeaveDropdownOpen } from '../model/dropdown-detection';
import pino from 'pino';

const logger = pino({ name: 'ensure-dropdown-closed' });

export async function ensureDropdownClosed(
  ctx: CommandContext,
  collector: PaintCollector,
  reason: string,
): Promise<void> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await ctx.pollPaintCommands(`dropdown-close-probe:${reason}:${attempt}`);
    collector.add(probe);
    if (!isDropdownOpen(probe)) return;

    logger.warn({ reason, attempt }, 'Dropdown state not definitively closed; toggling arrow to restore baseline');
    const { upCommands } = await ctx.client.pressAndCollectDetailed(arrowX, arrowY);
    collector.add(upCommands);
    const settle = [...upCommands];
    if (!isDropdownOpen(settle)) return;

    const deadline = Date.now() + 1800;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      const cmds = await ctx.pollPaintCommands(`dropdown-close-wait:${reason}:${attempt}:${poll}`);
      collector.add(cmds);
      settle.push(...cmds);
      if (!isDropdownOpen(cmds) || !isDropdownOpen(settle)) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(120, remaining));
    }
  }

  throw new Error(`Dropdown failed to reach closed state: ${reason}`);
}

export async function reopenDropdownFromClosed(
  ctx: CommandContext,
  collector: PaintCollector,
  reason: string,
): Promise<{
  view: DropdownView | null;
}> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

  const closeCollector = new PaintCollector();
  await ensureDropdownClosed(ctx, closeCollector, `reopen:${reason}`);
  collector.add(closeCollector.getAll());

  const { downCommands, upCommands } = await ctx.client.pressAndCollectDetailed(arrowX, arrowY);
  collector.add(downCommands);
  collector.add(upCommands);
  const settled = [...upCommands];

  if (!didPressLeaveDropdownOpen(downCommands, settled)) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const cmds = await ctx.pollPaintCommands(`reopen-wait:${reason}`);
      settled.push(...cmds);
      collector.add(cmds);
      if (didPressLeaveDropdownOpen(downCommands, settled)) break;
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  const view = resolveDropdownView(collector.getAll());
  if (view) {
    ctx.state.applyDropdownView(view);
    logger.info({ reason, firstVisible: view.firstVisible }, 'Dropdown reopened and synced');
  } else {
    logger.warn({ reason }, 'Dropdown reopen produced no view');
  }

  return { view };
}

export async function forceDropdownResync(
  ctx: CommandContext,
  collector: PaintCollector,
  reason: string,
): Promise<void> {
  try {
    await ensureDropdownClosed(ctx, collector, `resync:${reason}`);
    logger.warn({ reason }, 'Forced dropdown baseline resync after repeated mismatch');
  } catch (error) {
    logger.warn({ error, reason }, 'Dropdown resync attempt failed');
  }
}
