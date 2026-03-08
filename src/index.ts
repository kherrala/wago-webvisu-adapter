import 'dotenv/config';
import { app, setController } from './api';
import { config } from './config';
import { initDatabase, closeDatabase } from './database';
import { startPolling, stopPolling, setPollingController } from './polling-service';
import { ProtocolController } from './protocol-controller';
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

  const controller = new ProtocolController();

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
      logger.info(`  GET  http://localhost:${config.server.port}/api/debug/rendered-ui`);
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
