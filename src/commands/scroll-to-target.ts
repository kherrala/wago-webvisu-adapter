import { config, uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { DropdownView, isViewInRange } from '../model/dropdown-labels';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
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
  const dragStartHoldMs = config.protocol?.dragStartHoldMs ?? 60;
  const dragStepDelayMs = Math.max(0, config.protocol?.dragStepDelayMs ?? 45);
  const dragEndHoldMs = Math.max(0, config.protocol?.dragEndHoldMs ?? 50);
  const maxScrollAttempts = 8;

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

      logger.info({
        lightId, index, scrollAttempt, delta, absDelta,
        direction: scrollDirection,
        arrowX: arrowBtn.x, arrowY: arrowBtn.y,
      }, 'Arrow-click scroll');

      // Clear window for fresh arrow scroll detection
      ctx.window.clear();

      for (let i = 0; i < absDelta; i++) {
        const clickCmds = await ctx.client.pressAndCollect(arrowBtn.x, arrowBtn.y);
        ctx.window.append(clickCmds);
        await ctx.pollPaintCommands(`arrow-step:${scrollAttempt}:${i}`);
      }

      await ctx.pollPaintCommands(`arrow-scroll:${scrollAttempt}`);

      const expectedRange = {
        min: Math.min(scrollStartFirstVisible, scrollStartFirstVisible + delta),
        max: Math.max(scrollStartFirstVisible, scrollStartFirstVisible + delta),
      };

      const settled = await waitForDropdownReady(ctx, {
        reason: `arrow-scroll:${scrollAttempt}`,
        timeoutMs: 2000,
        expectedRange,
        requireFreshLabels: true,
      });
      let view = settled.view;

      if (!view && settled.closedDetected) {
        logger.warn({ scrollAttempt, lightId, delta }, 'Dropdown closed during arrow scroll; reopening');
        ctx.window.clear();
        const { view: reopenView } = await reopenDropdownFromClosed(ctx, `arrow-scroll-reopen:${scrollAttempt}`);
        view = reopenView;
        if (!isViewInRange(view, expectedRange)) view = null;
        if (!view) {
          const reopenSettled = await waitForDropdownReady(ctx, {
            reason: `arrow-scroll-reopen:${scrollAttempt}`,
            timeoutMs: 2000,
            expectedRange,
            requireFreshLabels: true,
          });
          view = reopenSettled.view;
        }
      }

      let arrowProgressed = false;
      if (view) {
        ctx.state.applyDropdownView(view);
        arrowProgressed = view.firstVisible !== scrollStartFirstVisible;
        logger.info({ scrollAttempt, firstVisible: view.firstVisible }, 'Arrow-scroll view synced');
      }
      if (view && arrowProgressed) {
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
    const thumbTopY = scrollbarConfig.thumbRange.topY;
    const thumbBottomY = scrollbarConfig.thumbRange.bottomY;
    const minDragDistance = 18;
    let effectiveTargetHandleY = targetHandleY;
    const rawDragDistance = Math.abs(targetHandleY - currentHandleY);
    if (rawDragDistance > 0 && rawDragDistance < minDragDistance) {
      const direction = targetHandleY > currentHandleY ? 1 : -1;
      effectiveTargetHandleY = Math.max(
        thumbTopY,
        Math.min(thumbBottomY, currentHandleY + (direction * minDragDistance))
      );
    }

    logger.info({
      lightId, index, scrollAttempt,
      currentFirstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible,
      delta, currentHandleY, targetHandleY, effectiveTargetHandleY,
    }, 'Dragging scrollbar thumb');

    // Clear window for fresh drag detection
    ctx.window.clear();

    await ctx.client.mouseDown(scrollbarX, currentHandleY);
    await ctx.delay(dragStartHoldMs);

    const dragDistance = Math.abs(effectiveTargetHandleY - currentHandleY);
    const dragSteps = Math.max(2, Math.min(12, Math.ceil(dragDistance / 12)));
    let lastDragY = currentHandleY;
    for (let step = 1; step <= dragSteps; step++) {
      const interpolation = step / dragSteps;
      const moveY = Math.round(currentHandleY + ((effectiveTargetHandleY - currentHandleY) * interpolation));
      if (moveY === lastDragY) continue;
      const moveCmds = await ctx.client.mouseMoveAndCollect(scrollbarX, moveY);
      ctx.window.append(moveCmds);
      lastDragY = moveY;
      if (dragStepDelayMs > 0 && step < dragSteps) await ctx.delay(dragStepDelayMs);
    }

    await ctx.delay(dragEndHoldMs);

    const dragUpCmds = await ctx.client.mouseUpAndCollect(scrollbarX, effectiveTargetHandleY);
    ctx.window.append(dragUpCmds);
    await ctx.pollPaintCommands(`drag-settle:${scrollAttempt}`);

    const dragSettled = await waitForDropdownReady(ctx, {
      reason: `drag-settle:${scrollAttempt}`,
      timeoutMs: 2500,
      requireFreshLabels: true,
    });
    let viewAfterDrag = dragSettled.view;

    if (!viewAfterDrag && dragSettled.closedDetected) {
      logger.warn({ lightId, index, scrollAttempt }, 'Dropdown closed during drag settle; reopening');
      ctx.window.clear();
      const { view: reopenView } = await reopenDropdownFromClosed(ctx, `drag-reopen:${scrollAttempt}`);
      viewAfterDrag = reopenView;
      if (!viewAfterDrag) {
        const reopenSettled = await waitForDropdownReady(ctx, {
          reason: `drag-reopen:${scrollAttempt}`,
          timeoutMs: 2500,
          requireFreshLabels: true,
        });
        viewAfterDrag = reopenSettled.view;
      }
    }

    if (!viewAfterDrag) {
      logger.warn({
        lightId, index, scrollAttempt, targetFirstVisible,
      }, 'Drag settle produced no stable view; continuing to next scroll attempt');
      continue;
    }
    ctx.state.applyDropdownView(viewAfterDrag);

    if (ctx.state.isDropdownIndexVisible(index)) {
      logger.info({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, index }, 'Target visible after scroll');
    } else {
      logger.warn({ scrollAttempt, firstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible, index }, 'Target not visible after drag — will re-drag');
    }
  }

  if (!ctx.state.isDropdownIndexVisible(index)) {
    throw new Error(`Scroll failed after ${maxScrollAttempts} drag attempts: light=${lightId}, index=${index}, firstVisible=${ctx.state.dropdownFirstVisible}, target=${targetFirstVisible}`);
  }
}
