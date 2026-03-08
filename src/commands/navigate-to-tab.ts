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

function isNapitSchedulerView(commands: PaintCommand[]): boolean {
  return classifyFrame(commands).napitSchedulerView >= THRESHOLD_NAPIT_SCHEDULER_VIEW;
}

function hasNapitControlView(ctx: CommandContext, latestCommands?: PaintCommand[]): boolean {
  if (latestCommands !== undefined) {
    return latestCommands.length > 0 && isNapitTabLoaded(latestCommands);
  }
  return isNapitTabLoaded(ctx.window.getCommands());
}

function hasNapitSchedulerSubview(ctx: CommandContext, latestCommands?: PaintCommand[]): boolean {
  if (latestCommands !== undefined) {
    return latestCommands.length > 0 && isNapitSchedulerView(latestCommands);
  }
  return isNapitSchedulerView(ctx.window.getCommands());
}

async function recoverNapitControlFromScheduler(
  ctx: CommandContext,
  reason: string,
): Promise<boolean> {
  const esc = uiCoordinates.lightSwitches.keypadEscButton;
  logger.warn({ reason, x: esc.x, y: esc.y }, 'Napit scheduler view detected; clicking ESC recovery point');

  const clickCommands = await ctx.client.pressAndCollect(esc.x, esc.y);
  ctx.window.append(clickCommands);
  if (hasNapitControlView(ctx, clickCommands)) return true;

  const deadline = Date.now() + 6000;
  let poll = 0;
  while (Date.now() < deadline) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`napit-recover:${reason}:${poll}`);
    if (hasNapitControlView(ctx, cmds)) return true;
    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(160, remaining));
  }
  return false;
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

  logger.info(`Clicking Napit tab at (${coords.x}, ${coords.y})`);

  const clickCommands = await ctx.client.pressAndCollect(coords.x, coords.y);
  ctx.window.append(clickCommands);

  if (hasNapitControlView(ctx, clickCommands)) {
    logger.info({ commandCount: clickCommands.length }, 'Napit tab loaded after click');
    return;
  }

  let recoveries = 0;
  const maxRecoveries = 2;
  if (hasNapitSchedulerSubview(ctx, clickCommands) && recoveries < maxRecoveries) {
    recoveries++;
    if (await recoverNapitControlFromScheduler(ctx, 'after-click')) {
      logger.info({ recoveries }, 'Napit control view recovered after scheduler detection');
      return;
    }
  }

  const deadline = Date.now() + timeoutMs;
  let poll = 0;
  while (Date.now() < deadline) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`napit-verify:${poll}`);
    if (hasNapitControlView(ctx, cmds)) {
      logger.info({ poll }, 'Napit tab loaded after polling');
      return;
    }
    if (hasNapitSchedulerSubview(ctx, cmds) && recoveries < maxRecoveries) {
      recoveries++;
      if (await recoverNapitControlFromScheduler(ctx, `poll-${poll}`)) {
        logger.info({ poll, recoveries }, 'Napit control view recovered after scheduler detection');
        return;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(200, remaining));
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
