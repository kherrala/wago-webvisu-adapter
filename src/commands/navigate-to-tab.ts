import { config, uiCoordinates } from '../config';
import { PaintCommand, extractDrawImages, extractTextLabels } from '../protocol/paint-commands';
import {
  classifyFrame,
  THRESHOLD_NAPIT_LOADED,
  THRESHOLD_NAPIT_SCHEDULER_VIEW,
} from '../protocol/frame-classifier';
import { CommandContext } from '../model/command-context';
import pino from 'pino';

const logger = pino({ name: 'navigate-to-tab' });

function isNapitTabLoaded(commands: PaintCommand[]): boolean {
  return classifyFrame(commands).napitTabLoaded >= THRESHOLD_NAPIT_LOADED;
}

function hasNapitControlView(ctx: CommandContext, latestCommands?: PaintCommand[]): boolean {
  if (latestCommands !== undefined) {
    return latestCommands.length > 0 && isNapitTabLoaded(latestCommands);
  }
  return isNapitTabLoaded(ctx.window.getCommands());
}

const MIN_INITIAL_RENDER_TIMEOUT_MS = 3500;
const DEFAULT_INITIAL_RENDER_TIMEOUT_MS = 7000;
const MIN_INITIAL_RENDER_POLL_INTERVAL_MS = 50;
const DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS = 200;

export async function waitForInitialRenderReady(
  ctx: CommandContext,
): Promise<void> {
  const timeoutMs = Math.max(
    MIN_INITIAL_RENDER_TIMEOUT_MS,
    config.protocol?.initialRenderTimeoutMs ?? DEFAULT_INITIAL_RENDER_TIMEOUT_MS,
  );
  const pollIntervalMs = Math.max(
    MIN_INITIAL_RENDER_POLL_INTERVAL_MS,
    config.protocol?.initialRenderPollIntervalMs ?? DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt++;
    await ctx.pollPaintCommands(`initial-render:${attempt}`);
    const images = extractDrawImages(ctx.window.getCommands());
    const labels = extractTextLabels(ctx.window.getCommands());
    const topLabels = labels.filter((label) => label.top <= 55 && label.bottom <= 75);
    logger.info({
      reason: 'initialize',
      attempt,
      imageCount: images.length,
      topLabelCount: topLabels.length,
    }, 'Initial render probe');

    if (images.length > 0 || topLabels.length > 0) {
      logger.info({ attempts: attempt, elapsedMs: Date.now() - startedAt }, 'Initial render ready');
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await ctx.delay(Math.min(pollIntervalMs, remainingMs));
  }

  logger.warn({
    attempts: attempt,
    elapsedMs: Date.now() - startedAt,
    timeoutMs,
  }, 'Initial render did not become ready; continuing');
}

export async function navigateToNapitTab(
  ctx: CommandContext,
): Promise<void> {
  const coords = uiCoordinates.tabs.napit;
  const timeoutMs = Math.max(
    15000,
    config.protocol?.initialRenderTimeoutMs ?? DEFAULT_INITIAL_RENDER_TIMEOUT_MS,
  );

  // Clear window to avoid stale commands from initial render
  ctx.window.clear();

  const maxAttempts = 6;
  // Alternate between different tabs to reset Napit subview more reliably
  const resetTabs = [
    uiCoordinates.tabs.autokatos,
    (uiCoordinates.tabs as Record<string, { x: number; y: number }>)['lisatoiminnot'] ?? uiCoordinates.tabs.autokatos,
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    logger.info({ attempt }, `Clicking Napit tab at (${coords.x}, ${coords.y})`);

    const clickCommands = await ctx.client.pressAndCollect(coords.x, coords.y);
    ctx.window.clear();
    ctx.window.append(clickCommands);

    if (hasNapitControlView(ctx, clickCommands)) {
      logger.info({ commandCount: clickCommands.length, attempt }, 'Napit tab loaded after click');
      return;
    }

    const pollDeadlineMs = attempt < 2 ? timeoutMs : 5000; // Shorter deadline for later retries
    const deadline = Date.now() + pollDeadlineMs;
    let poll = 0;
    let schedulerDetected = false;
    while (Date.now() < deadline) {
      poll++;
      const cmds = await ctx.pollPaintCommands(`napit-verify:${poll}`);

      // Check latest fresh commands for control panel
      if (hasNapitControlView(ctx, cmds)) {
        logger.info({ poll, attempt }, 'Napit tab loaded after polling');
        return;
      }

      // Also check accumulated post-click commands for control panel
      if (isNapitTabLoaded(ctx.window.getCommands())) {
        logger.info({ poll, attempt }, 'Napit tab loaded from accumulated commands');
        return;
      }

      // Check accumulated post-click commands for scheduler subview
      // Only check after enough polls to let the view stabilize
      if (poll >= 3) {
        const classification = classifyFrame(ctx.window.getCommands());
        if (classification.napitSchedulerView >= THRESHOLD_NAPIT_SCHEDULER_VIEW) {
          logger.warn({ poll, attempt, napitSchedulerView: classification.napitSchedulerView },
            'Napit scheduler subview detected — navigating away to reset');
          schedulerDetected = true;
          break;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(200, remaining));
    }

    if (schedulerDetected && attempt < maxAttempts - 1) {
      // Navigate to a different tab to deselect Napit, then retry
      const resetTab = resetTabs[attempt % resetTabs.length];
      logger.info({ attempt, resetTabX: resetTab.x }, 'Navigating away to reset Napit subview');
      await ctx.client.pressAndCollect(resetTab.x, resetTab.y);
      ctx.window.clear();
      // Longer settle time for odd attempts to vary timing
      const settleMs = attempt % 2 === 0 ? 1000 : 2000;
      await ctx.delay(settleMs);
      for (let i = 0; i < 5; i++) {
        await ctx.pollPaintCommands(`reset-tab-settle:${i}`);
        await ctx.delay(200);
      }
      ctx.window.clear();
      continue;
    }
  }

  throw new Error('Napit tab navigation failed');
}

export async function navigateToTab(
  ctx: CommandContext,
  tabName: string,
): Promise<void> {
  const coords = (uiCoordinates.tabs as Record<string, { x: number; y: number }>)[tabName];
  if (!coords) throw new Error(`Unknown tab: ${tabName}`);

  if (tabName === 'napit') {
    await navigateToNapitTab(ctx);
    return;
  }

  logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
  const clickCmds = await ctx.client.clickAndCollect(coords.x, coords.y);
  ctx.window.append(clickCmds);
  await ctx.pollPaintCommands(`navigate:${tabName}`);
}
