import { ProblemDetails, SessionDto } from '@app/shared';
import express, { type Express } from 'express';
import request from 'supertest';

import { createErrorHandler } from '../src/shared/http/problem.js';
import { createRequestLogger } from '../src/shared/logging/logger.js';
import { silentLogger } from './fakes.js';

/**
 * A bare Express app for middleware unit tests: the real request logger (silent) first, whatever `mount` adds, and
 * the real problem handler last, so every rejection is asserted as the problem+json a client receives.
 */
export function problemApp(mount: (app: Express) => void, { uploadMaxBytes = 1024 } = {}): Express {
  const app = express();
  app.use(createRequestLogger(silentLogger()));
  mount(app);
  app.use(createErrorHandler({ uploadMaxBytes }));
  return app;
}

/**
 * The problem body of an error response, parsed with the shared contract (so tests never touch `any`). Throws when
 * the response is not `application/problem+json`, which every API error must be (F-41).
 */
export function problemOf(response: request.Response): ProblemDetails {
  const contentType = response.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.startsWith('application/problem+json')) {
    throw new Error(`expected application/problem+json, got ${String(contentType)} (${String(response.status)})`);
  }
  return ProblemDetails.parse(response.body);
}

export type Agent = ReturnType<typeof request.agent>;

export interface SessionAgent {
  /** Keeps the session and CSRF cookies between requests. */
  agent: Agent;
  /** Send as `x-csrf-token` on every POST/DELETE. */
  csrfToken: string;
}

/**
 * A Supertest agent with an anonymous identity: `GET /api/session` stores the cookies and returns the CSRF token,
 * exactly like the SPA does on start (ADR 0003). Fails loudly if the session endpoint does not answer 200.
 */
export async function agentWithSession(app: Express): Promise<SessionAgent> {
  const agent = request.agent(app);
  const response = await agent.get('/api/session');
  if (response.status !== 200) {
    throw new Error(`GET /api/session answered ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  const { csrfToken } = SessionDto.parse(response.body);
  return { agent, csrfToken };
}

/** Values of every `Set-Cookie` header of a response (Supertest gives a string, an array or nothing). */
export function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) return header.filter((value): value is string => typeof value === 'string');
  return typeof header === 'string' ? [header] : [];
}

/** The `Set-Cookie` value for one cookie name, if the response sets it. */
export function setCookie(response: { headers: Record<string, unknown> }, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

/** Name of the session cookie (`<APP_SLUG>.sid`). */
export const SESSION_COOKIE = 'imageboard.sid';

/**
 * Lifetime of the session cookie in whole seconds. express-session writes only `Expires` (computed from
 * `cookie.maxAge`), so it is measured against the response's `Date` header (both have one-second resolution).
 */
export function sessionCookieLifetime(response: { headers: Record<string, unknown> }): number {
  const expires = /Expires=([^;]+)/.exec(setCookie(response, SESSION_COOKIE) ?? '')?.[1];
  const date = response.headers['date'];
  if (expires === undefined || typeof date !== 'string') return Number.NaN;
  return Math.round((Date.parse(expires) - Date.parse(date)) / 1000);
}
