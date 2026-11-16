import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createHealthRouter, createReadiness, type HealthRouterOptions, type ReadinessCheck } from '../health.js';

function appWith(options: HealthRouterOptions) {
  const app = express();
  app.use('/api/health', createHealthRouter(options));
  return app;
}

const ready: ReadinessCheck = () => Promise.resolve(true);
const notReady: ReadinessCheck = () => Promise.resolve(false);

describe('health router', () => {
  it('F-47: GET /api/health/live answers 200 without running readiness checks', async () => {
    const check = vi.fn(ready);
    const response = await request(appWith({ checks: { database: check }, isShuttingDown: () => false })).get(
      '/api/health/live',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();
  });

  it('F-47: GET /api/health answers 200 when every check passes', async () => {
    const response = await request(
      appWith({ checks: { database: ready, redis: ready, storage: ready }, isShuttingDown: () => false }),
    ).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['returns false', notReady],
    ['rejects', () => Promise.reject(new Error('connection refused'))],
    [
      'throws synchronously',
      () => {
        throw new Error('boom');
      },
    ],
  ])('B-87: answers 503 without naming the dependency when a check %s', async (_case, failing: ReadinessCheck) => {
    const response = await request(
      appWith({ checks: { database: ready, storage: failing }, isShuttingDown: () => false }),
    ).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });

  it('B-87: a hanging check fails after the timeout', async () => {
    const hanging: ReadinessCheck = () => new Promise<boolean>(() => undefined);
    const response = await request(
      appWith({ checks: { redis: hanging }, isShuttingDown: () => false, timeoutMs: 20 }),
    ).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });

  it('B-87: answers 503 shutting-down while shutting down, bypassing the cache', async () => {
    let shuttingDown = false;
    const check = vi.fn(ready);
    const app = appWith({ checks: { database: check }, isShuttingDown: () => shuttingDown });

    expect((await request(app).get('/api/health')).status).toBe(200);
    shuttingDown = true;
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'shutting-down' });
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('createReadiness', () => {
  it('reuses the result for the cache window and re-checks afterwards', async () => {
    let clock = 1_000;
    const check = vi.fn(ready);
    const isReady = createReadiness({ database: check }, { cacheMs: 3000, now: () => clock });

    await expect(isReady()).resolves.toBe(true);
    clock += 2999;
    await expect(isReady()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);

    clock += 1;
    await expect(isReady()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('caches a failing result too, so a broken dependency is not hammered', async () => {
    const check = vi.fn(notReady);
    const isReady = createReadiness({ storage: check }, { now: () => 0 });

    await expect(isReady()).resolves.toBe(false);
    await expect(isReady()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight run between concurrent callers', async () => {
    let release: (value: boolean) => void = () => undefined;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const isReady = createReadiness({ database: check });

    const calls = [isReady(), isReady(), isReady()];
    await vi.waitFor(() => {
      expect(check).toHaveBeenCalled();
    });
    release(true);

    await expect(Promise.all(calls)).resolves.toEqual([true, true, true]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
