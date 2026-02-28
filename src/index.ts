import { app, setController } from './api';
import { IWebVisuController } from './controller-interface';
import { config } from './config';
import { initDatabase, closeDatabase } from './database';
import { startPolling, stopPolling, setPollingController } from './polling-service';
import pino from 'pino';

const logger = pino({
  name: 'wago-webvisu-adapter',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

const controllerType = process.env.CONTROLLER || 'protocol';

async function createController(): Promise<IWebVisuController> {
  if (controllerType === 'playwright') {
    logger.info('Using Playwright browser controller');
    const { webVisuController } = await import('./webvisu-controller');
    return webVisuController;
  } else {
    logger.info('Using direct protocol controller');
    const { ProtocolController } = await import('./protocol-controller');
    return new ProtocolController();
  }
}

async function main() {
  logger.info(`Starting WAGO WebVisu Adapter (controller: ${controllerType})...`);

  const controller = await createController();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopPolling();
    await controller.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Initialize database
    logger.info('Initializing database...');
    initDatabase();

    // Wire up controller to API and polling service
    setController(controller);
    setPollingController(controller);

    // Initialize the controller
    logger.info('Initializing controller...');
    await controller.initialize();

    // Start the HTTP API server
    app.listen(config.server.port, () => {
      logger.info(`HTTP API server listening on port ${config.server.port}`);
      logger.info('');
      logger.info('HTTP API endpoints:');
      logger.info(`  GET  http://localhost:${config.server.port}/health`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/lights`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/lights/:id`);
      logger.info(`  POST http://localhost:${config.server.port}/api/lights/:id/toggle`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/polling/status`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/debug/screenshot`);
      logger.info('');

      // Start background polling service after server is ready
      startPolling();
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start adapter');
    stopPolling();
    await controller.close();
    closeDatabase();
    process.exit(1);
  }
}

main();
