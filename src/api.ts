import express, { Request, Response, NextFunction } from 'express';
import { IWebVisuController } from './controller-interface';
import {
  lightList,
  lightById,
  lightPrimaryController,
  lightAllControllers,
  lightSwitchById,
  lightSwitches,
  lightSwitchNames,
} from './config';
import { getAllCachedStatuses, upsertLightStatus } from './database';
import { getPollingStatus } from './polling-service';
import pino from 'pino';

const logger = pino({ name: 'api' });

let controller: IWebVisuController;

export function setController(ctrl: IWebVisuController): void {
  controller = ctrl;
}

export const app = express();
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path }, 'Request received');
  next();
});

// Health check
app.get('/health', async (req: Request, res: Response) => {
  const connected = await controller.isConnected();
  res.json({
    status: connected ? 'healthy' : 'degraded',
    webvisuConnected: connected,
  });
});

// List all physical lights with cached status
app.get('/api/lights', async (req: Request, res: Response) => {
  try {
    const cachedStatuses = new Map(
      getAllCachedStatuses().map(s => [s.id, s])
    );

    const lights = lightList
      .filter(light => lightPrimaryController[light.id]) // only lights with a controlling switch
      .map(light => {
        const cached = cachedStatuses.get(light.id);
        const controllers = lightAllControllers[light.id] ?? [];
        const hasDualFunction = controllers.some(c => c.functionNumber === 2);
        return {
          id: light.id,
          name: light.name,
          hasDualFunction,
          controllers: controllers.map(c => ({
            switchId: c.switchId,
            switchName: lightSwitchNames[lightSwitches[c.switchId]] ?? c.switchId,
            functionNumber: c.functionNumber,
          })),
          isOn: cached?.isOn ?? null,
          isOn2: cached?.isOn2 ?? null,
          polledAt: cached?.polledAt ?? null,
          href: `/api/lights/${light.id}`,
        };
      });

    res.json({
      count: lights.length,
      lights,
      _links: {
        self: '/api/lights',
        polling: '/api/polling/status',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Error listing lights');
    res.status(500).json({ error: 'Failed to list lights' });
  }
});

// Get live status of a physical light by light ID
app.get('/api/lights/:lightId', async (req: Request, res: Response) => {
  const { lightId } = req.params;

  const light = lightById[lightId];
  if (!light) {
    res.status(404).json({
      error: 'Light not found',
      validIds: lightList.filter(l => lightPrimaryController[l.id]).map(l => l.id),
    });
    return;
  }

  const primary = lightPrimaryController[lightId];
  if (!primary) {
    res.status(404).json({ error: 'No controlling switch found for this light', lightId });
    return;
  }

  try {
    const switchStatus = await controller.getLightStatus(primary.switchId);
    // Extract the correct indicator based on which function controls this light
    const isOn = primary.functionNumber === 2 ? switchStatus.isOn2 ?? false : switchStatus.isOn;

    // Store in database keyed by light ID
    upsertLightStatus({
      id: lightId,
      name: light.name,
      isOn,
      isOn2: undefined,
      firstPress: light.name,
      secondPress: null,
    });

    const controllers = lightAllControllers[lightId] ?? [];
    const hasDualFunction = controllers.some(c => c.functionNumber === 2);

    res.json({
      id: lightId,
      name: light.name,
      isOn,
      hasDualFunction,
      controllers: controllers.map(c => ({
        switchId: c.switchId,
        switchName: lightSwitchNames[lightSwitches[c.switchId]] ?? c.switchId,
        functionNumber: c.functionNumber,
      })),
      _links: {
        self: `/api/lights/${lightId}`,
        toggle: `/api/lights/${lightId}/toggle`,
      },
    });
  } catch (error) {
    logger.error({ error, lightId }, 'Error getting light status');
    res.status(500).json({ error: 'Failed to get light status' });
  }
});

// Toggle a physical light by light ID
app.post('/api/lights/:lightId/toggle', async (req: Request, res: Response) => {
  const { lightId } = req.params;

  const light = lightById[lightId];
  if (!light) {
    res.status(404).json({
      error: 'Light not found',
      validIds: lightList.filter(l => lightPrimaryController[l.id]).map(l => l.id),
    });
    return;
  }

  const primary = lightPrimaryController[lightId];
  if (!primary) {
    res.status(404).json({ error: 'No controlling switch found for this light', lightId });
    return;
  }

  try {
    await controller.toggleLight(primary.switchId, primary.functionNumber);

    res.json({
      message: 'Light toggled successfully',
      id: lightId,
      name: light.name,
      via: {
        switchId: primary.switchId,
        switchName: lightSwitchNames[lightSwitches[primary.switchId]] ?? primary.switchId,
        functionNumber: primary.functionNumber,
      },
      _links: {
        self: `/api/lights/${lightId}`,
        toggle: `/api/lights/${lightId}/toggle`,
        status: `/api/lights/${lightId}`,
      },
    });
  } catch (error) {
    logger.error({ error, lightId }, 'Error toggling light');
    res.status(500).json({ error: 'Failed to toggle light' });
  }
});

// Get polling service status
app.get('/api/polling/status', async (req: Request, res: Response) => {
  try {
    const status = getPollingStatus();
    res.json({
      ...status,
      _links: {
        self: '/api/polling/status',
        lights: '/api/lights',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Error getting polling status');
    res.status(500).json({ error: 'Failed to get polling status' });
  }
});

// Get all lights with their current status (live query)
app.get('/api/lights/status/all', async (req: Request, res: Response) => {
  try {
    const lights = await controller.getAllLights();
    res.json({
      lights,
      _links: {
        self: '/api/lights/status/all',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Error getting all light statuses');
    res.status(500).json({ error: 'Failed to get light statuses' });
  }
});

// Debug endpoint: get rendered UI image (protocol renderer output)
app.get('/api/debug/rendered-ui', async (req: Request, res: Response) => {
  try {
    if (!controller.getRenderedUiImage) {
      res.status(501).json({ error: 'Rendered UI cache is not available for this controller mode' });
      return;
    }
    const screenshot = await controller.getRenderedUiImage();
    if (!screenshot || screenshot.length === 0) {
      res.status(503).json({ error: 'Rendered UI image is not available yet' });
      return;
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.set('X-Rendered-Source', 'memory-cache');
    res.send(screenshot);
  } catch (error) {
    logger.error({ error }, 'Error getting rendered UI image');
    res.status(500).json({ error: 'Failed to get rendered UI image' });
  }
});

// Navigate to a specific tab (for debugging)
app.post('/api/debug/navigate/:tab', async (req: Request, res: Response) => {
  const { tab } = req.params;
  const validTabs = ['autokatos', 'ulkopistorasia', 'lisatoiminnot', 'napit', 'lammitys', 'hvac'];

  if (!validTabs.includes(tab)) {
    res.status(400).json({
      error: 'Invalid tab',
      validTabs,
    });
    return;
  }

  try {
    await controller.navigateToTab(tab as any);
    res.json({ message: `Navigated to ${tab}` });
  } catch (error) {
    logger.error({ error, tab }, 'Error navigating to tab');
    res.status(500).json({ error: 'Failed to navigate to tab' });
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ error: err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});
