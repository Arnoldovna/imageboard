import { fieldMessages, PROBLEM_CODES, ProblemDetails, requestMessages, uploadTooLarge } from '@app/shared';
import { doubleCsrf } from 'csrf-csrf';
import type { RequestHandler } from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  InvalidCursorError,
  NotFoundError,
  NotOwnerError,
  ValidationError,
} from '../../errors/app-error.js';
import { problemApp } from '../../../../test/http.js';
import { notFoundHandler, PROBLEM_TYPE_PREFIX } from '../problem.js';

const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** A route that fails with `error`, behind the real request logger and the real error handler. */
function appFailingWith(error: unknown) {
  const fail: RequestHandler = () => {
    throw error;
  };
  return problemApp(
    (app) => {
      app.get('/api/fail', fail);
      app.use(notFoundHandler);
    },
    { uploadMaxBytes: UPLOAD_MAX_BYTES },
  );
}

async function problemFor(error: unknown) {
  const response = await request(appFailingWith(error)).get('/api/fail');
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = ProblemDetails.parse(response.body);
  // The API only ever sends codes from the shared enum (ADR 0009).
  expect(PROBLEM_CODES).toContain(body.code);
  expect(body.type).toBe(`${PROBLEM_TYPE_PREFIX}${body.code}`);
  expect(body.status).toBe(response.status);
  return { response, body };
}

/** The shape `http-errors` gives body-parser errors (status, expose, type). */
function bodyParserError(status: number, type: string): Error {
  return Object.assign(new Error(type), { status, statusCode: status, expose: true, type });
}

/** pg's DatabaseError shape, wrapped the way Drizzle wraps driver errors. */
function drizzleWrapped(code: string, constraint?: string): Error {
  const driverError = Object.assign(new Error(`violates check constraint "${String(constraint)}"`), {
    severity: 'ERROR',
    code,
    constraint,
  });
  return new Error('Failed query: insert into "comments" ... params: secret-value', { cause: driverError });
}

describe('problem details (RFC 9457)', () => {
  it('F-41: renders an AppError with type, title, status, detail, instance, code and requestId', async () => {
    const { body } = await problemFor(new NotOwnerError('You can only delete images you uploaded.'));

    expect(body).toMatchObject({
      title: 'Forbidden',
      status: 403,
      detail: 'You can only delete images you uploaded.',
      instance: '/api/fail',
      code: 'not-owner',
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('F-18: validation problems carry errors[] with field, location and message', async () => {
    const issues = [{ field: 'title', location: 'body', message: fieldMessages.title.required }] as const;
    const { body } = await problemFor(new ValidationError(issues));

    expect(body.status).toBe(400);
    expect(body.code).toBe('validation-failed');
    expect(body.errors).toEqual(issues);
  });

  it('extension members never overwrite standard members', async () => {
    const error = new ForbiddenError('session-required');
    Object.assign(error, { extensions: { status: 200, type: 'evil', code: 'nope', detail: 'x' } });
    const { body } = await problemFor(error);

    expect(body).toMatchObject({ status: 403, code: 'session-required' });
  });

  it('F-41 / B-17: an unknown error becomes a generic 500 without stack, SQL or driver text', async () => {
    const { response, body } = await problemFor(drizzleWrapped('23505', 'images_object_key_key'));

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ code: 'internal-error', detail: 'An unexpected error occurred.' });
    expect(JSON.stringify(body)).not.toMatch(/stack|insert into|secret-value|constraint/i);
  });

  it('B-11: multer LIMIT_FILE_SIZE becomes 413 with the size message', async () => {
    const { response, body } = await problemFor(new multer.MulterError('LIMIT_FILE_SIZE', 'file'));

    expect(response.status).toBe(413);
    expect(body).toMatchObject({ code: 'payload-too-large', detail: uploadTooLarge(UPLOAD_MAX_BYTES) });
  });

  it('B-11: multer LIMIT_FIELD_VALUE becomes 400 validation-failed on that field', async () => {
    // Field-specific wording is attached by the multipart parser (multipart.test.ts); this is the generic fallback.
    const { response, body } = await problemFor(new multer.MulterError('LIMIT_FIELD_VALUE', 'description'));

    expect(response.status).toBe(400);
    expect(body.errors).toEqual([{ field: 'description', location: 'body', message: requestMessages.fieldTooLong }]);
  });

  it.each(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT'] as const)(
    'B-11: multer %s becomes 400 malformed-request',
    async (code) => {
      const { response, body } = await problemFor(new multer.MulterError(code, 'file'));

      expect(response.status).toBe(400);
      expect(body.code).toBe('malformed-request');
    },
  );

  it('B-03: a rejected CSRF token becomes 403 csrf-invalid', async () => {
    const { invalidCsrfTokenError } = doubleCsrf({
      getSecret: () => 'unit-csrf-secret-at-least-32-characters',
      getSessionIdentifier: () => 'session-id',
    });
    const { response, body } = await problemFor(invalidCsrfTokenError);

    expect(response.status).toBe(403);
    expect(body.code).toBe('csrf-invalid');
  });

  it.each([
    [bodyParserError(413, 'entity.too.large'), 413, 'payload-too-large'],
    [bodyParserError(400, 'entity.parse.failed'), 400, 'malformed-request'],
    [bodyParserError(415, 'charset.unsupported'), 415, 'unsupported-content-type'],
    [bodyParserError(400, 'request.aborted'), 400, 'malformed-request'],
  ])('F-49: body-parser error %# maps to %i %s', async (error, status, code) => {
    const { response, body } = await problemFor(error);

    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
  });

  it.each([[bodyParserError(403, 'entity.verify.failed')], [bodyParserError(405, 'method.not.allowed')]])(
    'ADR 0009: an http-error %# without a matching code is a 500, never a client code with another status',
    async (error) => {
      const { response, body } = await problemFor(error);

      expect(response.status).toBe(500);
      expect(body.code).toBe('internal-error');
    },
  );

  it('F-44: a path parameter with broken percent-encoding is 400 malformed-request, not a 500', async () => {
    const app = problemApp(
      (server) => {
        server.get('/api/images/:id', (_req, res) => {
          res.status(204).end();
        });
      },
      { uploadMaxBytes: UPLOAD_MAX_BYTES },
    );

    const response = await request(app).get('/api/images/%E0%A4%A');

    expect(response.status).toBe(400);
    expect(ProblemDetails.parse(response.body)).toMatchObject({
      code: 'malformed-request',
      detail: requestMessages.malformed,
    });
  });

  it('ADR 0006: a text CHECK violation becomes 400 on the matching field, without driver text', async () => {
    const { response, body } = await problemFor(drizzleWrapped('23514', 'comments_body_valid'));

    expect(response.status).toBe(400);
    expect(body.errors).toEqual([{ field: 'body', location: 'body', message: fieldMessages.commentBody.invalid }]);
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('a CHECK violation on a server-computed column stays a 500 (it is a bug, not bad input)', async () => {
    const { response } = await problemFor(drizzleWrapped('23514', 'images_dimensions_positive'));

    expect(response.status).toBe(500);
  });

  it('ADR 0007: an invalid cursor is 400 invalid-cursor', async () => {
    const { body } = await problemFor(new InvalidCursorError());

    expect(body).toMatchObject({ status: 400, code: 'invalid-cursor', detail: requestMessages.invalidCursor });
  });

  it('F-41: unknown routes are 404 problem+json', async () => {
    const response = await request(appFailingWith(new NotFoundError('Image'))).post('/api/nothing-here');
    const body = ProblemDetails.parse(response.body);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ code: 'not-found', instance: '/api/nothing-here' });
  });
});
