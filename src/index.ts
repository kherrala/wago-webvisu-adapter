import { app } from './api';
import { webVisuController } from './webvisu-controller';
import { config } from './config';
import pino from 'pino';

const logger = pino({
  name: 'wago-webvisu-adapter',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

async function main() {
  logger.info('Starting WAGO WebVisu Adapter...');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await webVisuController.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Initialize the WebVisu controller (launches browser)
    logger.info('Initializing WebVisu controller...');
    await webVisuController.initialize();

    // Navigate to the light switches tab by default
    logger.info('Navigating to light switches tab...');
    await webVisuController.navigateToTab('napit');

    // Start the HTTP API server
    app.listen(config.server.port, () => {
      logger.info(`HTTP API server listening on port ${config.server.port}`);
      logger.info('');
      logger.info('HTTP API endpoints:');
      logger.info(`  GET  http://localhost:${config.server.port}/health`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/lights`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/lights/:id`);
      logger.info(`  POST http://localhost:${config.server.port}/api/lights/:id/toggle`);
      logger.info(`  GET  http://localhost:${config.server.port}/api/debug/screenshot`);
      logger.info('');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start adapter');
    await webVisuController.close();
    process.exit(1);
  }
}

main();
