import { createServer } from 'node:http';

import { createApp } from './app.js';
import { HTTP_TIMEOUTS_MS, SHUTDOWN_FORCE_EXIT_MS } from './config/app.js';
import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { createGracefulShutdown } from './shared/http/graceful-shutdown.js';
import { createLogger } from './shared/logging/logger.js';

const env = loadEnv();
const logger = createLogger(env);
const container = await createContainer(env, logger);

// Timeouts go through the constructor, which validates them (headersTimeout <= requestTimeout, ADR 0013).
const server = createServer({ requestTimeout: HTTP_TIMEOUTS_MS.request, headersTimeout: HTTP_TIMEOUTS_MS.headers });

const shutdown = createGracefulShutdown({
  server,
  logger,
  dispose: () => container.dispose(),
  drainDelayMs: env.SHUTDOWN_DELAY_MS,
  forceExitAfterMs: SHUTDOWN_FORCE_EXIT_MS,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // `once`: a second Ctrl+C falls back to Node's default and ends the process immediately.
  process.once(signal, (received) => void shutdown.onSignal(received));
}
process.on('unhandledRejection', (reason) => void shutdown.onFatal('unhandled rejection', reason));
process.on('uncaughtException', (error) => void shutdown.onFatal('uncaught exception', error));

server.on('request', createApp({ env, logger, ...container, isShuttingDown: shutdown.isShuttingDown }));
server.on('error', (error) => void shutdown.onFatal('server error', error));
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'listening');
});
