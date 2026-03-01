import { config, lightList, lightById, lightPrimaryController, lightSwitches } from './config';
import { IWebVisuController } from './controller-interface';
import { upsertLightStatus, setMetadata, getMetadata } from './database';
import pino from 'pino';

let controller: IWebVisuController;

const logger = pino({ name: 'polling-service' });

// Poll only lights that have a primary controller, sorted by their switch's dropdown index
// so polling visits the PLC dropdown in order (minimising scrolling).
const pollableLightIds = lightList
  .filter(light => lightPrimaryController[light.id])
  .sort((a, b) => {
    const aIdx = lightSwitches[lightPrimaryController[a.id].switchId] ?? 999;
    const bIdx = lightSwitches[lightPrimaryController[b.id].switchId] ?? 999;
    return aIdx - bIdx;
  })
  .map(light => light.id);

let isRunning = false;
let shouldStop = false;
let currentIndex = 0;
let lastPollTime: Date | null = null;
let pollCount = 0;
let cycleCount = 0;

export function getPollingStatus(): {
  isRunning: boolean;
  enabled: boolean;
  currentIndex: number;
  totalPollable: number;
  lastPollTime: string | null;
  pollCount: number;
  cycleCount: number;
  cycleDelayMs: number;
} {
  return {
    isRunning,
    enabled: config.polling.enabled,
    currentIndex,
    totalPollable: pollableLightIds.length,
    lastPollTime: lastPollTime?.toISOString() ?? null,
    pollCount,
    cycleCount,
    cycleDelayMs: config.polling.cycleDelayMs,
  };
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollLoop(): Promise<void> {
  logger.info(`Starting polling loop with ${pollableLightIds.length} pollable lights`);
  logger.info(`Cycle delay: ${config.polling.cycleDelayMs}ms`);

  // Restore last polling position if available
  const savedIndex = getMetadata('lastPollIndex');
  if (savedIndex !== null) {
    currentIndex = parseInt(savedIndex, 10) || 0;
    if (currentIndex >= pollableLightIds.length) {
      currentIndex = 0;
    }
    logger.info(`Resuming polling from index ${currentIndex}`);
  }

  while (!shouldStop) {
    // Wait if there are pending operations
    const pendingOps = controller.getPendingOperationCount();
    if (pendingOps > 0) {
      logger.debug(`Waiting for ${pendingOps} pending operations to complete`);
      await delay(500);
      continue;
    }

    const lightId = pollableLightIds[currentIndex];
    const light = lightById[lightId];
    const primary = lightPrimaryController[lightId];

    try {
      logger.debug(`Polling light ${lightId} (${currentIndex + 1}/${pollableLightIds.length})`);

      const switchStatus = await controller.getLightStatus(primary.switchId);
      const isOn = primary.functionNumber === 2 ? switchStatus.isOn2 ?? false : switchStatus.isOn;

      upsertLightStatus({
        id: lightId,
        name: light?.name ?? lightId,
        isOn,
        isOn2: undefined,
        firstPress: light?.name ?? null,
        secondPress: null,
      });

      lastPollTime = new Date();
      pollCount++;

      logger.debug(`Polled ${lightId}: isOn=${isOn}`);
    } catch (error) {
      logger.error({ err: error, lightId }, `Error polling light ${lightId}`);
    }

    // Move to next light
    currentIndex++;
    setMetadata('lastPollIndex', String(currentIndex));

    // Check if we completed a cycle
    if (currentIndex >= pollableLightIds.length) {
      currentIndex = 0;
      cycleCount++;
      setMetadata('lastPollIndex', '0');
      logger.info(`Completed polling cycle ${cycleCount}, waiting ${config.polling.cycleDelayMs}ms before next cycle`);

      await delay(config.polling.cycleDelayMs);
    }
    // No delay between individual polls - proceed immediately to next light
  }

  logger.info('Polling loop stopped');
}

export function setPollingController(ctrl: IWebVisuController): void {
  controller = ctrl;
}

export function startPolling(): void {
  if (!config.polling.enabled) {
    logger.info('Polling is disabled via configuration');
    return;
  }

  if (isRunning) {
    logger.info('Polling is already running');
    return;
  }

  isRunning = true;
  shouldStop = false;

  logger.info('Starting background polling service');

  pollLoop().catch(error => {
    logger.error({ error }, 'Polling loop crashed');
    isRunning = false;
  });
}

export function stopPolling(): void {
  if (!isRunning) {
    logger.info('Polling is not running');
    return;
  }

  logger.info('Stopping background polling service');
  shouldStop = true;
  isRunning = false;
}
