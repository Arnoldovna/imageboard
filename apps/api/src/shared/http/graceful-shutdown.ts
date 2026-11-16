import type { Logger } from 'pino';

/** The part of `http.Server` that shutdown needs. `close()` also closes idle keep-alive connections (Node >= 19). */
export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
}

export interface GracefulShutdownOptions {
  server: ClosableServer;
  logger: Pick<Logger, 'info' | 'error' | 'fatal'>;
  /** Closes pools and clients (`container.dispose`). */
  dispose: () => Promise<void>;
  /** Signals only: time between failing readiness and closing the listener, so a load balancer stops routing first. */
  drainDelayMs: number;
  /** Hard limit for closing connections and disposing once the drain delay is over; then exit 1. */
  forceExitAfterMs: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** True from the first signal or fatal error on; readiness answers 503 from then on. */
  isShuttingDown: () => boolean;
  /** SIGTERM/SIGINT: readiness 503 → drain delay → close listener (in-flight requests finish) → dispose → exit 0. */
  onSignal(signal: NodeJS.Signals): Promise<void>;
  /**
   * Unhandled rejection, uncaught exception or a failed start: log `fatal`, skip (or cut short) the drain delay,
   * shut down and exit 1, also when a signal shutdown is already running (ADR 0009).
   */
  onFatal(message: string, error: unknown): Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createGracefulShutdown({
  server,
  logger,
  dispose,
  drainDelayMs,
  forceExitAfterMs,
  exit = (code) => process.exit(code),
}: GracefulShutdownOptions): GracefulShutdown {
  let shuttingDown = false;
  let failed = false;
  const skipDrain = new AbortController();

  async function shutdown(drainMs: number): Promise<void> {
    shuttingDown = true;
    const force = setTimeout(() => {
      logger.error('forced exit after timeout');
      exit(1);
    }, drainMs + forceExitAfterMs);
    force.unref();

    await delay(drainMs, skipDrain.signal);
    await new Promise<void>((resolve) => {
      // An error here only means the server was not listening (failed start); there is nothing left to close.
      server.close(() => {
        resolve();
      });
    });
    try {
      await dispose();
    } catch (error) {
      failed = true;
      logger.error({ err: error }, 'dispose failed');
    }
    clearTimeout(force);
    logger.info('shutdown complete');
    exit(failed ? 1 : 0);
  }

  return {
    isShuttingDown: () => shuttingDown,
    async onSignal(signal) {
      if (shuttingDown) return;
      logger.info({ signal, drainDelayMs }, 'shutting down');
      await shutdown(drainDelayMs);
    },
    async onFatal(message, error) {
      logger.fatal({ err: error }, message);
      failed = true;
      skipDrain.abort();
      if (shuttingDown) return;
      await shutdown(0);
    },
  };
}
