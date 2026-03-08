import { config, uiCoordinates } from '../config';
import { PaintCommand } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { PaintCollector } from '../model/paint-collector';
import { DropdownView, resolveDropdownView, isViewInRange } from '../model/dropdown-labels';
import { CommandWindow, waitForDropdownReady } from '../model/wait-for-dropdown';
import { reopenDropdownFromClosed } from './ensure-dropdown-closed';
import pino from 'pino';

const logger = pino({ name: 'scroll-to-target' });

export async function scrollToTarget(
  ctx: CommandContext,
  collector: PaintCollector,
  lightId: string,
  index: number,
  initialView: DropdownView | null,
  initialViewCommands: PaintCommand[],
  preferredTargetRow?: number,
): Promise<{
  latestView: DropdownView | null;
  latestViewCommands: PaintCommand[];
}> {
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;
  const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
  const scrollbarX = scrollbarConfig.x;
  const targetFirstVisible = ctx.state.getTargetFirstVisible(index, preferredTargetRow);
  const ARROW_THRESHOLD = 5;
  const dragStartHoldMs = config.protocol?.dragStartHoldMs ?? 60;
  const dragStepDelayMs = Math.max(0, config.protocol?.dragStepDelayMs ?? 45);
  const dragEndHoldMs = Math.max(0, config.protocol?.dragEndHoldMs ?? 50);
  const maxScrollAttempts = 8;

  let latestView = initialView;
  let latestViewCommands = [...initialViewCommands];

  for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts && !ctx.state.isDropdownIndexVisible(index); scrollAttempt++) {
    const delta = targetFirstVisible - ctx.state.dropdownFirstVisible;
    const absDelta = Math.abs(delta);
    const scrollStartFirstVisible = ctx.state.dropdownFirstVisible;

    const canUseArrowPath = absDelta <= ARROW_THRESHOLD && delta !== 0;
    if (canUseArrowPath) {
      const scrollDirection: 'down' | 'up' = delta > 0 ? 'down' : 'up';
      const arrowBtn = scrollDirection === 'down'
        ? scrollbarConfig.arrowDown
        : scrollbarConfig.arrowUp;
      const arrowWindow = new CommandWindow(240);

      logger.info({
        lightId, index, scrollAttempt, delta, absDelta,
        direction: scrollDirection,
        arrowX: arrowBtn.x, arrowY: arrowBtn.y,
      }, 'Arrow-click scroll');

      for (let i = 0; i < absDelta; i++) {
        const clickCmds = await ctx.client.pressAndCollect(arrowBtn.x, arrowBtn.y);
        arrowWindow.append(clickCmds);
        collector.add(clickCmds);
        const settleCmds = await ctx.pollPaintCommands(`arrow-step:${scrollAttempt}:${i}`);
        arrowWindow.append(settleCmds);
        collector.add(settleCmds);
        if (i < absDelta - 1) await ctx.delay(120);
      }

      await ctx.delay(120);
      const arrowPollCmds = await ctx.pollPaintCommands(`arrow-scroll:${scrollAttempt}`);
      arrowWindow.append(arrowPollCmds);
      collector.add(arrowPollCmds);

      const expectedRange = {
        min: Math.min(scrollStartFirstVisible, scrollStartFirstVisible + delta),
        max: Math.max(scrollStartFirstVisible, scrollStartFirstVisible + delta),
      };

      let view = resolveDropdownView(arrowWindow.getCommands());
      if (!isViewInRange(view, expectedRange)) view = null;
      let viewSourceCommands = arrowWindow.getCommands();

      if (!view) {
        const settled = await waitForDropdownReady(ctx, {
          seedCommands: arrowWindow.getCommands(),
          reason: `arrow-scroll:${scrollAttempt}`,
          timeoutMs: 2000,
          expectedRange,
        });
        collector.add(settled.commands);
        arrowWindow.append(settled.commands);
        view = settled.view;
        let closedDetected = settled.closedDetected;
        viewSourceCommands = arrowWindow.getCommands();

        if (!view && closedDetected) {
          logger.warn({ scrollAttempt, lightId, delta }, 'Dropdown closed during arrow scroll (Ohjaus detected); reopening');
          const reopenCollector = new PaintCollector();
          const { view: reopenView } = await reopenDropdownFromClosed(ctx, reopenCollector, `arrow-scroll-reopen:${scrollAttempt}`);
          collector.add(reopenCollector.getAll());
          view = reopenView;
          if (!isViewInRange(view, expectedRange)) view = null;
          viewSourceCommands = reopenCollector.getAll();
          if (!view) {
            const reopenSettled = await waitForDropdownReady(ctx, {
              seedCommands: reopenCollector.getAll(),
              reason: `arrow-scroll-reopen:${scrollAttempt}`,
              timeoutMs: 2000,
              expectedRange,
            });
            collector.add(reopenSettled.commands);
            view = reopenSettled.view;
            viewSourceCommands = [...reopenCollector.getAll(), ...reopenSettled.commands];
          }
        }
      }

      let arrowProgressed = false;
      if (view) {
        ctx.state.applyDropdownView(view);
        latestView = view;
        latestViewCommands = viewSourceCommands;
        arrowProgressed = view.firstVisible !== scrollStartFirstVisible;
        logger.info({ scrollAttempt, firstVisible: view.firstVisible }, 'Arrow-scroll view synced');
      }
      if (view && arrowProgressed) {
        await ctx.delay(120);
        const closeCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
        collector.add(closeCmds);
        await ctx.delay(220);

        const resyncCollector = new PaintCollector();
        const { view: reopenView } = await reopenDropdownFromClosed(ctx, resyncCollector, `arrow-resync:${scrollAttempt}`);
        collector.add(resyncCollector.getAll());
        let syncedView = reopenView;
        let syncedSourceCommands = resyncCollector.getAll();
        if (!syncedView) {
          const settled = await waitForDropdownReady(ctx, {
            seedCommands: resyncCollector.getAll(),
            reason: `arrow-resync:${scrollAttempt}`,
            timeoutMs: 2200,
          });
          collector.add(settled.commands);
          syncedView = settled.view;
          syncedSourceCommands = [...resyncCollector.getAll(), ...settled.commands];
        }

        if (!syncedView) {
          throw new Error(`Arrow resync produced no stable view: light=${lightId}, index=${index}, target=${targetFirstVisible}, scrollAttempt=${scrollAttempt}`);
        }

        ctx.state.applyDropdownView(syncedView);
        latestView = syncedView;
        latestViewCommands = syncedSourceCommands;
        continue;
      }
      if (view && !arrowProgressed) {
        logger.warn({ scrollAttempt, lightId, index, firstVisible: view.firstVisible }, 'Arrow scroll produced no progress; falling back to drag');
      } else {
        logger.warn({ scrollAttempt, lightId, index, targetFirstVisible }, 'Arrow scroll did not produce stable view; falling back to drag');
      }
    }

    // Drag path
    const currentHandleY = Math.round(ctx.state.dropdownHandleCenterY);
    const targetHandleY = Math.round(ctx.state.getDropdownScrollY(targetFirstVisible));

    logger.info({
      lightId, index, scrollAttempt,
      currentFirstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible,
      delta, currentHandleY, targetHandleY,
    }, 'Dragging scrollbar thumb');

    await ctx.client.mouseDown(scrollbarX, currentHandleY);
    await ctx.delay(dragStartHoldMs);

    const dragDistance = Math.abs(targetHandleY - currentHandleY);
    const dragSteps = Math.max(2, Math.min(12, Math.ceil(dragDistance / 12)));
    let lastDragY = currentHandleY;
    for (let step = 1; step <= dragSteps; step++) {
      const interpolation = step / dragSteps;
      const moveY = Math.round(currentHandleY + ((targetHandleY - currentHandleY) * interpolation));
      if (moveY === lastDragY) continue;
      const moveCmds = await ctx.client.mouseMoveAndCollect(scrollbarX, moveY);
      collector.add(moveCmds);
      lastDragY = moveY;
      if (dragStepDelayMs > 0 && step < dragSteps) await ctx.delay(dragStepDelayMs);
    }

    await ctx.delay(dragEndHoldMs);

    const dragUpCmds = await ctx.client.mouseUpAndCollect(scrollbarX, targetHandleY);
    collector.add(dragUpCmds);
    const dragSettleCmds = await ctx.pollPaintCommands(`drag-settle:${scrollAttempt}`);
    collector.add(dragSettleCmds);

    await ctx.delay(200);

    const closeCmds = await ctx.client.pressAndCollect(arrowX, arrowY);
    collector.add(closeCmds);
    await ctx.delay(300);

    const dragReopenCollector = new PaintCollector();
    const { view: reopenView } = await reopenDropdownFromClosed(ctx, dragReopenCollector, `drag-reopen:${scrollAttempt}`);
    collector.add(dragReopenCollector.getAll());
    let viewAfterReopen = reopenView;
    let viewSourceCommands = dragReopenCollector.getAll();
    if (!viewAfterReopen) {
      const settled = await waitForDropdownReady(ctx, {
        seedCommands: dragReopenCollector.getAll(),
        reason: `drag-reopen:${scrollAttempt}`,
        timeoutMs: 2500,
      });
      collector.add(settled.commands);
      viewAfterReopen = settled.view;
      viewSourceCommands = [...dragReopenCollector.getAll(), ...settled.commands];
    }

    if (!viewAfterReopen) {
      const recoveryCollector = new PaintCollector();
      const { view: recoveryView } = await reopenDropdownFromClosed(
        ctx,
        recoveryCollector,
        `drag-reopen-recovery:${scrollAttempt}`,
      );
      collector.add(recoveryCollector.getAll());
      let recoveredView = recoveryView;
      let recoverySourceCommands = recoveryCollector.getAll();
      if (!recoveredView) {
        const recoverySettled = await waitForDropdownReady(ctx, {
          seedCommands: recoveryCollector.getAll(),
          reason: `drag-reopen-recovery:${scrollAttempt}`,
          timeoutMs: 2500,
        });
        collector.add(recoverySettled.commands);
        recoveredView = recoverySettled.view;
        recoverySourceCommands = [...recoveryCollector.getAll(), ...recoverySettled.commands];
      }

      if (!recoveredView) {
        logger.warn({
          lightId,
          index,
          scrollAttempt,
          targetFirstVisible,
        }, 'Drag reopen produced no stable view; continuing to next scroll attempt');
        continue;
      }

      viewAfterReopen = recoveredView;
      viewSourceCommands = recoverySourceCommands;
    }
    ctx.state.applyDropdownView(viewAfterReopen);
    latestView = viewAfterReopen;
    latestViewCommands = viewSourceCommands;

    if (ctx.state.isDropdownIndexVisible(index)) {
      logger.info({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, index }, 'Target visible after scroll');
    } else {
      logger.warn({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible, index }, 'Target not visible after reopen — will re-drag');
    }
  }

  if (!ctx.state.isDropdownIndexVisible(index)) {
    throw new Error(`Scroll failed after ${maxScrollAttempts} drag attempts: light=${lightId}, index=${index}, firstVisible=${ctx.state.dropdownFirstVisible}, target=${targetFirstVisible}`);
  }

  return { latestView, latestViewCommands };
}
