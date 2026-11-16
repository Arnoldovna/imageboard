import { fieldMessages, requestMessages, uploadTooLarge } from '@app/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { problemApp, problemOf } from '../../../../test/http.js';
import { createMultipartParser } from '../multipart.js';

const MAX_FILE_BYTES = 1024;

function app() {
  return problemApp(
    (server) => {
      server.post('/api/images', createMultipartParser({ maxFileBytes: MAX_FILE_BYTES }), (req, res) => {
        // Never the client filename or MIME type: only the bytes and their length go further (ADR 0017).
        res.json({ fields: req.body as unknown, file: req.file ? { size: req.file.size } : null });
      });
    },
    { uploadMaxBytes: MAX_FILE_BYTES },
  );
}

describe('createMultipartParser', () => {
  it('parses one file and the three text fields into memory', async () => {
    const response = await request(app())
      .post('/api/images')
      .field('authorName', 'Kofi')
      .field('title', 'Commute')
      .field('description', 'Line one\r\nline two')
      .attach('file', Buffer.alloc(100, 1), { filename: '../../etc/passwd.png', contentType: 'image/png' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fields: { authorName: 'Kofi', title: 'Commute', description: 'Line one\r\nline two' },
      file: { size: 100 },
    });
  });

  it('passes a request without a file on (file presence is checked with the fields, B-24)', async () => {
    const response = await request(app()).post('/api/images').field('title', 'No file');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ fields: { title: 'No file' }, file: null });
  });

  it('F-49: answers 415 unsupported-content-type for a non-multipart body', async () => {
    const response = await request(app()).post('/api/images').send({ title: 'json' });

    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({
      code: 'unsupported-content-type',
      detail: requestMessages.multipartRequired,
    });
  });

  it('F-20 / B-11: answers 413 for a file above the limit, as problem+json', async () => {
    const response = await request(app())
      .post('/api/images')
      .attach('file', Buffer.alloc(MAX_FILE_BYTES + 1, 1), { filename: 'big.jpg' });

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ code: 'payload-too-large', detail: uploadTooLarge(MAX_FILE_BYTES) });
  });

  it('accepts a file of exactly the limit', async () => {
    const response = await request(app())
      .post('/api/images')
      .attach('file', Buffer.alloc(MAX_FILE_BYTES, 1), { filename: 'exact.jpg' });

    expect(response.status).toBe(200);
  });

  it('F-21: a second file is 400 malformed-request', async () => {
    const response = await request(app())
      .post('/api/images')
      .attach('file', Buffer.alloc(10, 1), { filename: 'a.png' })
      .attach('file', Buffer.alloc(10, 1), { filename: 'b.png' });

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('malformed-request');
  });

  it('F-21: a file under another field name is 400 malformed-request', async () => {
    const response = await request(app())
      .post('/api/images')
      .attach('avatar', Buffer.alloc(10, 1), { filename: 'a.png' });

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('malformed-request');
  });

  it('F-21: more than three text fields is 400 malformed-request', async () => {
    const response = await request(app())
      .post('/api/images')
      .field('authorName', 'a')
      .field('title', 'b')
      .field('description', 'c')
      .field('extra', 'd');

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('malformed-request');
  });

  it('F-18: a text field over 16 KiB is 400 validation-failed on that field', async () => {
    const response = await request(app())
      .post('/api/images')
      .field('description', 'x'.repeat(16 * 1024 + 1));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'validation-failed',
      errors: [{ field: 'description', location: 'body', message: fieldMessages.description.tooLong }],
    });
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'a long part named %s gets the generic message, never an inherited object member',
    async (name) => {
      const response = await request(app())
        .post('/api/images')
        .field(name, 'x'.repeat(16 * 1024 + 1));

      expect(response.status).toBe(400);
      expect(problemOf(response)).toMatchObject({
        code: 'validation-failed',
        errors: [{ field: name, location: 'body', message: requestMessages.fieldTooLong }],
      });
    },
  );

  it('a truncated multipart body is 400 malformed-request, never a 500 or a hanging request', async () => {
    const response = await request(app())
      .post('/api/images')
      .set('Content-Type', 'multipart/form-data; boundary=xyz')
      .send('--xyz\r\nContent-Disposition: form-data; name="title"\r\n\r\nunfinished');

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('malformed-request');
  });
});
