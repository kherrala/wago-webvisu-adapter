import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { DropdownView, resolveDropdownView } from '../model/dropdown-labels';
import { arrowScrollOneByOne } from '../model/scroll-settle';
import { reopenDropdownFromClosed } from './ensure-dropdown-closed';
import pino from 'pino';

const logger = pino({ name: 'scroll-to-target' });

export async function scrollToTarget(
  ctx: CommandContext,
  lightId: string,
  index: number,
  preferredTargetRow?: number,
): Promise<void> {
  const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
  const scrollbarX = scrollbarConfig.x;
  const targetFirstVisible = ctx.state.getTargetFirstVisible(index, preferredTargetRow);
  const ARROW_THRESHOLD = 5;
  const maxScrollAttempts = 8;

  for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts && !ctx.state.isDropdownIndexVisible(index); scrollAttempt++) {
    let delta = targetFirstVisible - ctx.state.dropdownFirstVisible;
    let absDelta = Math.abs(delta);
    const scrollStartFirstVisible = ctx.state.dropdownFirstVisible;

    // Arrow path: used for all backward scrolling (CoDeSys backward drags
    // permanently desync PLC click mapping) and for small forward deltas.
    if ((delta < 0 || absDelta <= ARROW_THRESHOLD) && delta !== 0) {
      const scrollDirection: 'down' | 'up' = delta > 0 ? 'down' : 'up';
      const arrowBtn = scrollDirection === 'down'
        ? scrollbarConfig.arrowDown
        : scrollbarConfig.arrowUp;

      logger.info({
        lightId, index, scrollAttempt, delta, absDelta,
        direction: scrollDirection,
        arrowX: arrowBtn.x, arrowY: arrowBtn.y,
      }, 'Arrow-click scroll');

      const settled = await arrowScrollOneByOne(ctx, {
        arrowX: arrowBtn.x,
        arrowY: arrowBtn.y,
        clickCount: absDelta,
        direction: scrollDirection,
        startFirstVisible: ctx.state.dropdownFirstVisible,
        scrollAttempt,
        targetFirstVisible,
      });
      let view = settled.view;

      if (!view && settled.closedDetected) {
        logger.warn({ scrollAttempt, lightId, delta }, 'Dropdown closed during arrow scroll; reopening');
        const { view: reopenView } = await reopenDropdownFromClosed(ctx, `arrow-scroll-reopen:${scrollAttempt}`);
        view = reopenView;
      }

      if (view) {
        ctx.state.applyDropdownView(view);
        const arrowProgressed = view.firstVisible !== scrollStartFirstVisible;
        logger.info({ scrollAttempt, firstVisible: view.firstVisible, arrowProgressed }, 'Arrow-scroll view synced');
        if (arrowProgressed) continue;
      }
      logger.warn({ scrollAttempt, lightId, index }, 'Arrow scroll insufficient; falling back to drag');
    }

    // Drag path (forward only — backward scrolling uses arrows above)
    const currentHandleY = Math.round(ctx.state.dropdownHandleCenterY);
    const targetHandleY = Math.round(ctx.state.getDropdownScrollY(targetFirstVisible));
    const thumbTopY = scrollbarConfig.thumbRange.topY;
    const thumbBottomY = scrollbarConfig.thumbRange.bottomY;
    const effectiveTargetHandleY = Math.max(thumbTopY, Math.min(thumbBottomY, targetHandleY));

    logger.info({
      lightId, index, scrollAttempt,
      currentFirstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible,
      delta, currentHandleY, effectiveTargetHandleY,
    }, 'Dragging scrollbar thumb');

    ctx.window.clear();

    // Snapshot: before drag with mouseDown marker
    await ctx.captureDebugSnapshot(`scroll-drag-start:${scrollAttempt}`, [
      { x: scrollbarX, y: currentHandleY, type: 'down', label: `drag-from:${currentHandleY}` },
      { x: scrollbarX, y: effectiveTargetHandleY, type: 'up', label: `drag-to:${effectiveTargetHandleY}` },
    ]);

    // Grab handle
    await ctx.client.mouseDown(scrollbarX, currentHandleY);
    await ctx.delay(60);

    // Move to target in steps
    const dragDistance = Math.abs(effectiveTargetHandleY - currentHandleY);
    const dragSteps = Math.max(2, Math.min(12, Math.ceil(dragDistance / 12)));
    let lastDragY = currentHandleY;
    for (let step = 1; step <= dragSteps; step++) {
      const t = step / dragSteps;
      const moveY = Math.round(currentHandleY + ((effectiveTargetHandleY - currentHandleY) * t));
      if (moveY === lastDragY) continue;
      const moveCmds = await ctx.client.mouseMoveAndCollect(scrollbarX, moveY);
      ctx.window.append(moveCmds);
      lastDragY = moveY;
      if (step < dragSteps) await ctx.delay(45);
    }

    // Hold briefly then release
    await ctx.delay(50);
    const upCmds = await ctx.client.mouseUpAndCollect(scrollbarX, effectiveTargetHandleY);
    ctx.window.append(upCmds);
    await ctx.pollPaintCommands(`drag-settle:${scrollAttempt}`);

    // Wait for position to stabilize
    const settleDeadline = Date.now() + 3000;
    let stableCount = 0;
    let lastFirstVisible: number | null = null;
    let finalView: DropdownView | null = null;
    let settlePoll = 0;

    while (Date.now() < settleDeadline) {
      settlePoll++;
      const cmds = await ctx.pollPaintCommands(`post-release:${scrollAttempt}:${settlePoll}`);
      ctx.window.append(cmds);

      const freshView = resolveDropdownView(cmds);
      const accumulatedView = resolveDropdownView(ctx.window.getCommands());
      const currentView = freshView ?? accumulatedView;

      if (currentView) {
        finalView = currentView;
        if (currentView.firstVisible === lastFirstVisible) {
          stableCount++;
          if (stableCount >= 3) {
            logger.info({ scrollAttempt, settlePoll, firstVisible: currentView.firstVisible }, 'Post-release stable');
            break;
          }
        } else {
          stableCount = 1;
          lastFirstVisible = currentView.firstVisible;
        }
      }

      await ctx.delay(100);
    }

    if (!finalView) {
      logger.warn({ lightId, index, scrollAttempt }, 'Drag produced no stable view; closing/reopening to reset PLC scroll state');
      const { view: reopenView } = await reopenDropdownFromClosed(ctx, `drag-no-view-reset:${scrollAttempt}`);
      if (reopenView) {
        ctx.state.applyDropdownView(reopenView);
      } else {
        throw new Error(`Scroll reopen failed after drag: light=${lightId}, scrollAttempt=${scrollAttempt}`);
      }
      continue;
    }
    ctx.state.applyDropdownView(finalView);

    // Snapshot: after drag settled
    await ctx.captureDebugSnapshot(`scroll-drag-settled:${scrollAttempt}:fv=${finalView.firstVisible}`);

    if (ctx.state.isDropdownIndexVisible(index)) {
      logger.info({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, index }, 'Target visible after scroll');
    } else if (finalView.firstVisible === scrollStartFirstVisible) {
      // Drag had no visual effect but CoDeSys may have accumulated internal
      // scroll motion. Close/reopen to reset PLC internal state and prevent
      // cumulative offset on next retry.
      logger.warn({ scrollAttempt, firstVisible: finalView.firstVisible, targetFirstVisible, index },
        'Drag had no visual effect — closing/reopening to reset PLC scroll state');
      const { view: reopenView } = await reopenDropdownFromClosed(ctx, `drag-stale-reset:${scrollAttempt}`);
      if (reopenView) {
        ctx.state.applyDropdownView(reopenView);
      } else {
        throw new Error(`Scroll reopen failed after stale drag: light=${lightId}, scrollAttempt=${scrollAttempt}`);
      }
    } else {
      logger.warn({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible, index }, 'Target not visible after drag — will retry');
    }
  }

  if (!ctx.state.isDropdownIndexVisible(index)) {
    throw new Error(`Scroll failed after ${maxScrollAttempts} attempts: light=${lightId}, index=${index}, firstVisible=${ctx.state.dropdownFirstVisible}, target=${targetFirstVisible}`);
  }
}
