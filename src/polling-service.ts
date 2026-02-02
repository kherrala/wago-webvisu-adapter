import { config, lightSwitchList, lightSwitchById } from './config';
import { webVisuController } from './webvisu-controller';
import { upsertLightStatus, setMetadata, getMetadata } from './database';
import pino from 'pino';

const logger = pino({ name: 'polling-service' });

// Light switches to poll: only those with firstPress defined
const pollableIds = lightSwitchList
  .filter(light => light.firstPress)
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
    totalPollable: pollableIds.length,
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
  logger.info(`Starting polling loop with ${pollableIds.length} pollable lights`);
  logger.info(`Cycle delay: ${config.polling.cycleDelayMs}ms`);

  // Restore last polling position if available
  const savedIndex = getMetadata('lastPollIndex');
  if (savedIndex !== null) {
    currentIndex = parseInt(savedIndex, 10) || 0;
    if (currentIndex >= pollableIds.length) {
      currentIndex = 0;
    }
    logger.info(`Resuming polling from index ${currentIndex}`);
  }

  while (!shouldStop) {
    // Wait if there are pending operations
    const pendingOps = webVisuController.getPendingOperationCount();
    if (pendingOps > 0) {
      logger.debug(`Waiting for ${pendingOps} pending operations to complete`);
      await delay(500);
      continue;
    }

    const lightId = pollableIds[currentIndex];
    const switchInfo = lightSwitchById[lightId];

    try {
      logger.debug(`Polling light ${lightId} (${currentIndex + 1}/${pollableIds.length})`);

      const status = await webVisuController.getLightStatus(lightId);

      // Store in database
      upsertLightStatus({
        id: status.id,
        name: status.name,
        isOn: status.isOn,
        isOn2: status.isOn2,
        firstPress: switchInfo?.firstPress ?? null,
        secondPress: (switchInfo as any)?.secondPress ?? null,
      });

      lastPollTime = new Date();
      pollCount++;

      logger.debug(`Polled ${lightId}: isOn=${status.isOn}${status.isOn2 !== undefined ? `, isOn2=${status.isOn2}` : ''}`);
    } catch (error) {
      logger.error({ error, lightId }, `Error polling light ${lightId}`);
    }

    // Move to next light
    currentIndex++;
    setMetadata('lastPollIndex', String(currentIndex));

    // Check if we completed a cycle
    if (currentIndex >= pollableIds.length) {
      currentIndex = 0;
      cycleCount++;
      setMetadata('lastPollIndex', '0');
      logger.info(`Completed polling cycle ${cycleCount}, waiting ${config.polling.cycleDelayMs}ms before next cycle`);

      // Wait for cycle delay
      await delay(config.polling.cycleDelayMs);
    }
    // No delay between individual polls - proceed immediately to next light
  }

  logger.info('Polling loop stopped');
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

  // Run polling loop in background (don't await)
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
