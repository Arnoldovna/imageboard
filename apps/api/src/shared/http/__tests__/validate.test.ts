import { CreateCommentBody, fieldMessages, IdParam, pageQuery, requestMessages } from '@app/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { problemApp, problemOf } from '../../../../test/http.js';
import { validate } from '../validate.js';

const Params = z.strictObject({ imageId: IdParam });
const Query = pageQuery(20, 50);

function app() {
  return problemApp((server) => {
    server.set('query parser', 'simple');
    server.use(express.json());
    server.post(
      '/api/images/:imageId/comments',
      validate({ params: Params, query: Query, body: CreateCommentBody }, ({ params, query, body }, _req, res) => {
        res.json({ params, query, body });
      }),
    );
  });
}

describe('validate()', () => {
  it('hands parsed, normalised values to the handler', async () => {
    const response = await request(app())
      .post('/api/images/7/comments?limit=999')
      .send({ authorName: ' Kofi ', body: 'Where does it go?\r\n' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      params: { imageId: 7 },
      query: { limit: 50 },
      body: { authorName: 'Kofi', body: 'Where does it go?' },
    });
  });

  it('F-18 / B-13: collects issues from params, query and body into one 400 with { field, location, message }', async () => {
    const response = await request(app())
      .post('/api/images/abc/comments?limit=x')
      .send({ authorName: '', body: 'b'.repeat(1001) });

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('validation-failed');
    expect(problemOf(response).errors).toEqual([
      { field: 'imageId', location: 'params', message: requestMessages.invalidId },
      { field: 'limit', location: 'query', message: requestMessages.invalidLimit },
      { field: 'authorName', location: 'body', message: fieldMessages.authorName.required },
      { field: 'body', location: 'body', message: fieldMessages.commentBody.tooLong },
    ]);
  });

  it('F-49: reports every unknown body key as its own field', async () => {
    const response = await request(app())
      .post('/api/images/1/comments')
      .send({ authorName: 'Kofi', body: 'Hi', ownerId: 'x', canDelete: true });

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([
      { field: 'ownerId', location: 'body', message: requestMessages.unknownField },
      { field: 'canDelete', location: 'body', message: requestMessages.unknownField },
    ]);
  });

  it('reports a body that is not an object on the part itself', async () => {
    const response = await request(app()).post('/api/images/1/comments').send(['not', 'an', 'object']);

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([expect.objectContaining({ field: 'body', location: 'body' })]);
  });

  it('F-44: rejects an id above 2^31 - 1 before any handler runs', async () => {
    const response = await request(app()).post('/api/images/2147483648/comments').send({ authorName: 'a', body: 'b' });

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([
      { field: 'imageId', location: 'params', message: requestMessages.invalidId },
    ]);
  });
});
