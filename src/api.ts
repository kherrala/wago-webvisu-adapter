import express, { Request, Response, NextFunction } from 'express';
import { webVisuController } from './webvisu-controller';
import { lightSwitches, lightSwitchNames, lightSwitchList, lightSwitchById } from './config';
import pino from 'pino';

const logger = pino({ name: 'api' });

export const app = express();
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path }, 'Request received');
  next();
});

// Health check
app.get('/health', async (req: Request, res: Response) => {
  const connected = await webVisuController.isConnected();
  res.json({
    status: connected ? 'healthy' : 'degraded',
    webvisuConnected: connected,
  });
});

// List all available light switches
app.get('/api/lights', async (req: Request, res: Response) => {
  try {
    const lights = lightSwitchList
      .filter(light => light.firstPress) // Only include switches with actual functions
      .map(light => ({
        id: light.id,
        name: light.name,
        index: light.index,
        firstPress: light.firstPress,
        secondPress: (light as any).secondPress || null,
        hasDualFunction: !!(light as any).secondPress,
        href: `/api/lights/${light.id}`,
      }));

    res.json({
      count: lights.length,
      lights,
      _links: {
        self: '/api/lights',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Error listing lights');
    res.status(500).json({ error: 'Failed to list lights' });
  }
});

// Get status of a specific light
app.get('/api/lights/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(id in lightSwitches)) {
    res.status(404).json({
      error: 'Light not found',
      validIds: Object.keys(lightSwitches).filter(k => lightSwitchById[k]?.firstPress),
    });
    return;
  }

  const switchInfo = lightSwitchById[id];
  const hasDualFunction = !!(switchInfo as any)?.secondPress;

  try {
    const status = await webVisuController.getLightStatus(id);
    res.json({
      id: status.id,
      name: status.name,
      isOn: status.isOn,
      ...(status.isOn2 !== undefined ? { isOn2: status.isOn2 } : {}),
      firstPress: switchInfo?.firstPress || null,
      secondPress: (switchInfo as any)?.secondPress || null,
      hasDualFunction,
      _links: {
        self: `/api/lights/${id}`,
        toggle: `/api/lights/${id}/toggle`,
        ...(hasDualFunction ? { toggleSecond: `/api/lights/${id}/toggle?function=2` } : {}),
      },
    });
  } catch (error) {
    logger.error({ error, lightId: id }, 'Error getting light status');
    res.status(500).json({ error: 'Failed to get light status' });
  }
});

// Toggle a light switch
// Use ?function=2 to toggle the second function of dual-function switches
app.post('/api/lights/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params;
  const functionParam = req.query.function as string | undefined;
  const functionNumber = functionParam === '2' ? 2 : 1;

  if (!(id in lightSwitches)) {
    res.status(404).json({
      error: 'Light not found',
      validIds: Object.keys(lightSwitches),
    });
    return;
  }

  const switchInfo = lightSwitchById[id];
  const hasDualFunction = !!(switchInfo as any)?.secondPress;

  // Validate function=2 is only used for dual-function switches
  if (functionNumber === 2 && !hasDualFunction) {
    res.status(400).json({
      error: 'This switch does not have a second function',
      id,
      name: switchInfo?.name || id,
      firstPress: switchInfo?.firstPress || null,
    });
    return;
  }

  try {
    await webVisuController.toggleLight(id, functionNumber as 1 | 2);

    const functionInfo = functionNumber === 2
      ? (switchInfo as any)?.secondPress
      : switchInfo?.firstPress;

    // Don't fetch status after toggle - it causes extra UI interactions
    // User can call GET /api/lights/:id separately if needed
    res.json({
      message: `Light toggled successfully (function ${functionNumber})`,
      id,
      name: lightSwitchNames[lightSwitches[id]] || id,
      function: functionNumber,
      controls: functionInfo || null,
      _links: {
        self: `/api/lights/${id}`,
        toggle: `/api/lights/${id}/toggle`,
        ...(hasDualFunction ? { toggleSecond: `/api/lights/${id}/toggle?function=2` } : {}),
        status: `/api/lights/${id}`,
      },
    });
  } catch (error) {
    logger.error({ error, lightId: id, function: functionNumber }, 'Error toggling light');
    res.status(500).json({ error: 'Failed to toggle light' });
  }
});

// Get all lights with their current status
app.get('/api/lights/status/all', async (req: Request, res: Response) => {
  try {
    const lights = await webVisuController.getAllLights();
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

// Debug endpoint: take a screenshot
app.get('/api/debug/screenshot', async (req: Request, res: Response) => {
  try {
    const screenshot = await webVisuController.takeScreenshot();
    res.set('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (error) {
    logger.error({ error }, 'Error taking screenshot');
    res.status(500).json({ error: 'Failed to take screenshot' });
  }
});

// Debug endpoint: get canvas info
app.get('/api/debug/canvas', async (req: Request, res: Response) => {
  try {
    const canvasInfo = await webVisuController.getCanvasInfo();
    res.json({
      canvas: canvasInfo,
      viewport: { width: 1280, height: 768 },
      message: 'Use these values to calibrate coordinates. Tab coordinates are page-absolute, canvas element coordinates are relative to canvas position.',
    });
  } catch (error) {
    logger.error({ error }, 'Error getting canvas info');
    res.status(500).json({ error: 'Failed to get canvas info' });
  }
});

// Debug endpoint: check status indicator position and color
app.get('/api/debug/status-indicator', async (req: Request, res: Response) => {
  try {
    const debug = await webVisuController.debugStatusIndicator();
    res.json({
      position: debug.position,
      color: debug.color,
      isOn: debug.color.g > 140 && debug.color.r > 140,
      message: 'Screenshot saved. Check position and color values. Yellow ON has R>140, G>140. Brown OFF has G<100.',
    });
  } catch (error) {
    logger.error({ error }, 'Error debugging status indicator');
    res.status(500).json({ error: 'Failed to debug status indicator' });
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
    await webVisuController.navigateToTab(tab as any);
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
