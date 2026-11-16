import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ClosableServer, createGracefulShutdown, type GracefulShutdownOptions } from '../graceful-shutdown.js';

/** A server whose close() completes when the test says so (in-flight requests still running). */
function fakeServer() {
  let finishClose: () => void = () => undefined;
  const server = {
    close: vi.fn<ClosableServer['close']>((callback) => {
      finishClose = () => {
        callback();
      };
    }),
  };
  return {
    server,
    finishClose: () => {
      finishClose();
    },
  };
}

function setup(overrides: Partial<GracefulShutdownOptions> = {}) {
  const { server, finishClose } = fakeServer();
  const dispose = vi.fn(() => Promise.resolve());
  const exit = vi.fn<(code: number) => void>();
  const logger = pino({ level: 'silent' });
  const fatal = vi.spyOn(logger, 'fatal');
  const shutdown = createGracefulShutdown({
    server,
    logger,
    dispose,
    exit,
    drainDelayMs: 5_000,
    forceExitAfterMs: 10_000,
    ...overrides,
  });
  return { shutdown, server, finishClose, dispose, exit, fatal };
}

describe('createGracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('B-87: on a signal, fails readiness at once and keeps serving for the drain delay before closing', async () => {
    const { shutdown, server, finishClose, dispose, exit } = setup();

    const done = shutdown.onSignal('SIGTERM');
    expect(shutdown.isShuttingDown()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    finishClose();
    await done;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('closes immediately without a drain delay', async () => {
    const { shutdown, server, finishClose, exit } = setup({ drainDelayMs: 0 });

    const done = shutdown.onSignal('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.close).toHaveBeenCalledTimes(1);

    finishClose();
    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('ignores a second signal', async () => {
    const { shutdown, server, finishClose, exit } = setup();

    const first = shutdown.onSignal('SIGTERM');
    await shutdown.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    finishClose();
    await first;

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('B-18 / ADR 0009: a fatal error logs fatal, skips the drain delay and exits 1', async () => {
    const { shutdown, server, finishClose, dispose, exit, fatal } = setup();
    const error = new Error('boom');

    const done = shutdown.onFatal('unhandled rejection', error);
    expect(fatal).toHaveBeenCalledWith({ err: error }, 'unhandled rejection');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.close).toHaveBeenCalledTimes(1);

    finishClose();
    await done;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('a fatal error during a signal shutdown cuts the drain delay short and turns the exit code into 1', async () => {
    const { shutdown, server, finishClose, exit } = setup();

    const done = shutdown.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown.onFatal('uncaught exception', new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.close).toHaveBeenCalledTimes(1);

    finishClose();
    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 when dispose fails', async () => {
    const { shutdown, finishClose, exit } = setup({
      drainDelayMs: 0,
      dispose: () => Promise.reject(new Error('pool end failed')),
    });

    const done = shutdown.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    finishClose();
    await done;

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 when connections do not close within the limit after the drain delay', async () => {
    const { shutdown, exit } = setup();

    void shutdown.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000 + 9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
