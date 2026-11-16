import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeStorage } from './fakes.js';
import { createTestApp, type TestApp } from './test-app.js';
import { currentDatabaseUrl, databaseUrl } from './test-db.js';

describe('health against real Postgres and Redis', () => {
  let testApp: TestApp;
  let storageChecks = 0;

  beforeAll(async () => {
    const storage = createFakeStorage();
    testApp = await createTestApp({
      storage: {
        ...storage,
        isReady: () => {
          storageChecks += 1;
          return storage.isReady();
        },
      },
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-47: GET /api/health reports ready when the database, Redis and storage answer', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-47: concurrent and repeated calls within 3 s run the checks once (ADR 0013)', async () => {
    const before = storageChecks;
    const responses = await Promise.all([1, 2, 3].map(() => request(testApp.app).get('/api/health')));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(storageChecks - before).toBeLessThanOrEqual(1);
  });

  it('F-47: GET /api/health/live reports the process as alive', async () => {
    const response = await request(testApp.app).get('/api/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('is not behind the session: no cookie is ever set', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('F-41: unknown /api routes answer 404 problem+json', async () => {
    const response = await request(testApp.app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 404, code: 'not-found', instance: '/api/does-not-exist' });
    expect(response.body).not.toHaveProperty('stack');
  });
});

describe('health with an unreachable database', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ databaseUrl: databaseUrl(currentDatabaseUrl(), 'database_that_does_not_exist') });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('B-87: GET /api/health answers 503 without naming the failing dependency', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });

  it('B-87: liveness stays 200 while readiness fails', async () => {
    expect((await request(testApp.app).get('/api/health/live')).status).toBe(200);
  });
});

describe('health with unreachable object storage', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ storage: { ...createFakeStorage(), isReady: () => Promise.resolve(false) } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-47 / B-87: answers 503 unavailable', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });
});
