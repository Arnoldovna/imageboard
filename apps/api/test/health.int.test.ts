import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestApp, type TestApp } from './test-app.js';

describe('health against real Postgres and Redis', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-47: GET /api/health reports ready when the database and Redis answer', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-47: GET /api/health/live reports the process as alive', async () => {
    const response = await request(testApp.app).get('/api/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-41: unknown /api routes answer 404 problem+json', async () => {
    const response = await request(testApp.app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 404, instance: '/api/does-not-exist' });
    expect(response.body).not.toHaveProperty('stack');
  });
});

describe('health with an unreachable database', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    const url = new URL(inject('databaseUrl'));
    url.pathname = '/database_that_does_not_exist';
    testApp = await createTestApp({ databaseUrl: url.toString() });
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
    const response = await request(testApp.app).get('/api/health/live');

    expect(response.status).toBe(200);
  });
});
