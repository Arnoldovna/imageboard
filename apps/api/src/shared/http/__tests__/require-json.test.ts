import { requestMessages } from '@app/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { problemApp } from '../../../../test/http.js';
import { requireJson } from '../require-json.js';

function app() {
  return problemApp((server) => {
    server.use(express.json({ limit: '16kb', strict: true }));
    server.post('/api/json', requireJson, (_req, res) => {
      res.status(204).end();
    });
  });
}

describe('requireJson', () => {
  it('passes application/json (with a charset parameter)', async () => {
    const response = await request(app())
      .post('/api/json')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send('{"a":1}');

    expect(response.status).toBe(204);
  });

  it.each([
    ['text/plain', 'hello'],
    ['application/x-www-form-urlencoded', 'a=1'],
    ['multipart/form-data; boundary=x', '--x--'],
  ])('F-49: answers 415 unsupported-content-type for %s', async (contentType, payload) => {
    const response = await request(app()).post('/api/json').set('Content-Type', contentType).send(payload);

    expect(response.status).toBe(415);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ code: 'unsupported-content-type', detail: requestMessages.jsonRequired });
  });

  it('F-49: answers 415 for a request without a body or content type', async () => {
    const response = await request(app()).post('/api/json');

    expect(response.status).toBe(415);
  });
});
