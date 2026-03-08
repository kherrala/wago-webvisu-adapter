import { uiCoordinates } from '../config';
import { CommandContext } from '../model/command-context';
import { resolveDropdownView } from '../model/dropdown-labels';
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
  const ARROW_THRESHOLD = 3;

  if (ctx.state.isDropdownIndexVisible(index)) {
    logger.info({ lightId, index, firstVisible: ctx.state.dropdownFirstVisible }, 'Target already visible, no scroll needed');
    return;
  }

  const delta = targetFirstVisible - ctx.state.dropdownFirstVisible;
  const absDelta = Math.abs(delta);

  // Arrow path for small deltas
  if (absDelta <= ARROW_THRESHOLD && delta !== 0) {
    const scrollDirection: 'down' | 'up' = delta > 0 ? 'down' : 'up';
    const arrowBtn = scrollDirection === 'down'
      ? scrollbarConfig.arrowDown
      : scrollbarConfig.arrowUp;

    logger.info({
      lightId, index, delta, absDelta,
      direction: scrollDirection,
      arrowX: arrowBtn.x, arrowY: arrowBtn.y,
    }, 'Arrow-click scroll');

    const settled = await arrowScrollOneByOne(ctx, {
      arrowX: arrowBtn.x,
      arrowY: arrowBtn.y,
      clickCount: absDelta,
      direction: scrollDirection,
      startFirstVisible: ctx.state.dropdownFirstVisible,
      scrollAttempt: 0,
    });
    let view = settled.view;

    if (!view && settled.closedDetected) {
      logger.warn({ lightId, delta }, 'Dropdown closed during arrow scroll; reopening');
      const { view: reopenView } = await reopenDropdownFromClosed(ctx, `arrow-scroll-reopen`);
      view = reopenView;
    }

    if (view) {
      ctx.state.applyDropdownView(view);
      logger.info({ firstVisible: view.firstVisible }, 'Arrow-scroll view synced');
    }

    if (ctx.state.isDropdownIndexVisible(index)) {
      return;
    }
    logger.warn({ lightId, index, firstVisible: ctx.state.dropdownFirstVisible }, 'Arrow scroll insufficient; falling back to drag');
  }

  // Drag path
  const currentHandleY = Math.round(ctx.state.dropdownHandleCenterY);
  const rawTargetY = ctx.state.getDropdownScrollY(targetFirstVisible);
  const thumbTopY = scrollbarConfig.thumbRange.topY;
  const thumbBottomY = scrollbarConfig.thumbRange.bottomY;

  const scrollingDown = targetFirstVisible > ctx.state.dropdownFirstVisible;
  const targetHandleY = scrollingDown ? Math.ceil(rawTargetY) : Math.floor(rawTargetY);
  const effectiveTargetHandleY = Math.max(thumbTopY, Math.min(thumbBottomY, targetHandleY));

  logger.info({
    lightId, index,
    currentFirstVisible: ctx.state.dropdownFirstVisible, targetFirstVisible,
    delta, currentHandleY, targetHandleY, effectiveTargetHandleY,
  }, 'Dragging scrollbar thumb');

  // Step 1: Grab the handle — wait for handle redraw to confirm grab
  const grabCmds = await ctx.client.mouseDownAndCollect(scrollbarX, currentHandleY);
  ctx.window.append(grabCmds);

  if (grabCmds.length === 0) {
    // Poll until PLC redraws the handle (confirms grab)
    logger.info({ lightId }, 'No handle redraw on grab — polling for readiness');
    const grabDeadline = Date.now() + 3000;
    let grabbed = false;
    while (Date.now() < grabDeadline) {
      const cmds = await ctx.pollPaintCommands(`handle-grab:${lightId}`);
      ctx.window.append(cmds);
      if (cmds.length > 0) {
        grabbed = true;
        logger.info({ lightId, cmdCount: cmds.length }, 'Handle redraw detected — grab confirmed');
        break;
      }
      await ctx.delay(100);
    }
    if (!grabbed) {
      await ctx.client.mouseUp(scrollbarX, currentHandleY);
      throw new Error(`Scrollbar handle did not redraw after mouseDown: light=${lightId}`);
    }
  } else {
    logger.info({ lightId, grabCmdCount: grabCmds.length }, 'Handle grabbed (immediate redraw)');
  }

  // Wait for PLC to fully process the grab before sending mouseMove
  // After a slow dropdown open, the PLC may need time to initialize the scrollbar
  await ctx.delay(300);

  // Verify position stability — poll until consecutive empty/stable responses
  // to ensure the PLC has finished processing the grab
  let stablePolls = 0;
  const stabilityDeadline = Date.now() + 2000;
  while (stablePolls < 2 && Date.now() < stabilityDeadline) {
    const cmds = await ctx.pollPaintCommands(`pre-drag-stable:${lightId}`);
    ctx.window.append(cmds);
    stablePolls = cmds.length === 0 ? stablePolls + 1 : 0;
    if (stablePolls < 2) await ctx.delay(100);
  }

  // Step 2: Drag to target position
  const dragDistance = Math.abs(effectiveTargetHandleY - currentHandleY);
  const dragSteps = dragDistance > 30 ? 3 : 1;
  for (let step = 1; step <= dragSteps; step++) {
    const t = step / dragSteps;
    const stepY = Math.round(currentHandleY + (effectiveTargetHandleY - currentHandleY) * t);
    const moveCmds = await ctx.client.mouseMoveAndCollect(scrollbarX, stepY);
    ctx.window.append(moveCmds);
    if (step < dragSteps) await ctx.delay(100);
  }

  // Step 3: Wait for handle to redraw at/near target position before releasing
  // Poll until the view shows the dropdown has scrolled close to the target.
  // The target index must be visible in the view — not just any position change.
  const dragDeadline = Date.now() + 5000;
  let dragView: ReturnType<typeof resolveDropdownView> = null;
  let poll = 0;
  let lastSeenFirstVisible = ctx.state.dropdownFirstVisible;

  while (Date.now() < dragDeadline) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`drag-settle:${lightId}:${poll}`);
    ctx.window.append(cmds);

    const freshView = resolveDropdownView(cmds);
    const accumulatedView = resolveDropdownView(ctx.window.getCommands());
    const currentView = freshView ?? accumulatedView;

    if (currentView) {
      if (currentView.firstVisible !== lastSeenFirstVisible) {
        logger.debug({
          lightId, poll,
          fromFirstVisible: lastSeenFirstVisible,
          toFirstVisible: currentView.firstVisible,
          targetFirstVisible,
        }, 'Handle position changing during drag');
        lastSeenFirstVisible = currentView.firstVisible;
      }

      // Check if the target index is now visible
      const visibleItems = 5;
      const targetVisible = index >= currentView.firstVisible &&
        index < currentView.firstVisible + visibleItems;

      if (targetVisible) {
        dragView = currentView;
        logger.info({
          lightId, poll,
          firstVisible: currentView.firstVisible,
          targetFirstVisible, index,
        }, 'Target visible during drag — ready for release');
        break;
      }
    }

    await ctx.delay(100);
  }

  // Step 4: Release the handle
  const upCmds = await ctx.client.mouseUpAndCollect(scrollbarX, effectiveTargetHandleY);
  ctx.window.append(upCmds);

  // Step 5: Final settle — wait for position to stabilize after release
  const settleDeadline = Date.now() + 3000;
  let stableCount = 0;
  let lastFirstVisible: number | null = dragView?.firstVisible ?? null;
  let finalView = dragView;
  let settlePoll = 0;

  while (Date.now() < settleDeadline) {
    settlePoll++;
    const cmds = await ctx.pollPaintCommands(`post-release:${lightId}:${settlePoll}`);
    ctx.window.append(cmds);

    const freshView = resolveDropdownView(cmds);
    const accumulatedView = resolveDropdownView(ctx.window.getCommands());
    const currentView = freshView ?? accumulatedView;

    if (currentView) {
      finalView = currentView;
      if (currentView.firstVisible === lastFirstVisible) {
        stableCount++;
        if (stableCount >= 3) {
          logger.info({ lightId, settlePoll, firstVisible: currentView.firstVisible }, 'Post-release position stable');
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
    throw new Error(`Drag produced no stable view: light=${lightId}, index=${index}`);
  }
  ctx.state.applyDropdownView(finalView);

  if (!ctx.state.isDropdownIndexVisible(index)) {
    throw new Error(`Drag did not reach target: light=${lightId}, index=${index}, firstVisible=${ctx.state.dropdownFirstVisible}, target=${targetFirstVisible}`);
  }

  logger.info({ firstVisible: ctx.state.dropdownFirstVisible, index }, 'Target visible after scroll');
}
