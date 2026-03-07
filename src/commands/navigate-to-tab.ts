import { config, uiCoordinates } from '../config';
import { PaintCommand, extractDrawImages, extractTextLabels } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { PaintCollector } from '../model/paint-collector';
import { isLampStatusImageId } from '../model/lamp-ids';
import { normalizeVisuText } from '../model/text-utils';
import pino from 'pino';

const logger = pino({ name: 'navigate-to-tab' });

const NAPIT_REQUIRED_LABELS = [
  'ohjaus',
  'tallenna asetukset',
  'lue asetukset',
  '1. painallus',
  '2. painallus',
];

function isNapitTabLoaded(commands: PaintCommand[]): boolean {
  const lampCount = extractDrawImages(commands)
    .filter(img => isLampStatusImageId(img.imageId))
    .length;
  if (lampCount < 3) return false;

  const labels = extractTextLabels(commands);
  const normalizedTexts = new Set(labels.map(l => normalizeVisuText(l.text)));
  return NAPIT_REQUIRED_LABELS.every(req => normalizedTexts.has(normalizeVisuText(req)));
}

const MIN_INITIAL_RENDER_TIMEOUT_MS = 3500;
const DEFAULT_INITIAL_RENDER_TIMEOUT_MS = 7000;
const MIN_INITIAL_RENDER_POLL_INTERVAL_MS = 50;
const DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS = 200;

export async function waitForInitialRenderReady(
  ctx: CommandContext,
  collector: PaintCollector,
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
  const accumulated: PaintCommand[] = [];
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt++;
    const commands = await ctx.pollPaintCommands(`initial-render:${attempt}`);
    accumulated.push(...commands);
    collector.add(commands);
    const images = extractDrawImages(accumulated);
    const labels = extractTextLabels(accumulated);
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
  collector: PaintCollector,
): Promise<void> {
  const coords = uiCoordinates.tabs.napit;
  const timeoutMs = config.protocol?.initialRenderTimeoutMs ?? DEFAULT_INITIAL_RENDER_TIMEOUT_MS;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info({ attempt }, `Clicking Napit tab at (${coords.x}, ${coords.y})`);
    const accumulated: PaintCommand[] = [];

    const clickCommands = await ctx.client.pressAndCollect(coords.x, coords.y);
    accumulated.push(...clickCommands);
    collector.add(clickCommands);

    if (isNapitTabLoaded(accumulated)) {
      logger.info({ attempt, commandCount: accumulated.length }, 'Napit tab loaded after click');
      return;
    }

    const deadline = Date.now() + timeoutMs;
    let poll = 0;
    while (Date.now() < deadline) {
      poll++;
      const cmds = await ctx.pollPaintCommands(`napit-verify:${attempt}:${poll}`);
      accumulated.push(...cmds);
      collector.add(cmds);
      if (isNapitTabLoaded(accumulated)) {
        logger.info({ attempt, poll, commandCount: accumulated.length }, 'Napit tab loaded after polling');
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(200, remaining));
    }

    logger.warn({ attempt, commandCount: accumulated.length }, 'Napit tab not verified within timeout');
  }

  throw new Error(`Napit tab navigation failed after ${maxAttempts} attempts`);
}

export async function navigateToTab(
  ctx: CommandContext,
  collector: PaintCollector,
  tabName: string,
): Promise<void> {
  const coords = (uiCoordinates.tabs as Record<string, { x: number; y: number }>)[tabName];
  if (!coords) throw new Error(`Unknown tab: ${tabName}`);

  if (tabName === 'napit') {
    await navigateToNapitTab(ctx, collector);
    return;
  }

  logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
  const clickCmds = await ctx.client.clickAndCollect(coords.x, coords.y);
  collector.add(clickCmds);
  const pollCmds = await ctx.pollPaintCommands(`navigate:${tabName}`);
  collector.add(pollCmds);
}
