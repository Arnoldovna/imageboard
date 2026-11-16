import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../errors/app-error.js';
import { actorOf, markSessionActive, requireOwnerSession, type SessionLifetimes } from '../actor.js';

const lifetimes: SessionLifetimes = { provisionalMs: 24 * 3_600_000, fullMs: 180 * 86_400_000 };

/** The parts of a request the helpers touch: the session data and its cookie. */
function fakeRequest(session: { ownerId?: string; active?: boolean }, withLifetimes = true) {
  const cookie = { maxAge: lifetimes.provisionalMs };
  const req = {
    session: Object.assign(session, { cookie }),
    ...(withLifetimes ? { sessionLifetimes: lifetimes } : {}),
  };
  return { req: req as unknown as Request, cookie, session };
}

describe('actorOf', () => {
  it('returns the session owner', () => {
    expect(actorOf(fakeRequest({ ownerId: 'owner-1' }).req)).toEqual({ ownerId: 'owner-1' });
  });

  it('returns a null owner for a visitor without an identity', () => {
    expect(actorOf(fakeRequest({}).req)).toEqual({ ownerId: null });
  });
});

describe('requireOwnerSession', () => {
  it('B-02: passes a session with an identity', () => {
    const next = vi.fn();
    requireOwnerSession(fakeRequest({ ownerId: 'owner-1' }).req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('B-02: rejects a mutation without an identity as 403 session-required', () => {
    const next = vi.fn();
    requireOwnerSession(fakeRequest({}).req, {} as never, next);

    const error: unknown = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, code: 'session-required' });
  });
});

describe('markSessionActive', () => {
  it('F-34: promotes the provisional session to the full lifetime', () => {
    const { req, cookie, session } = fakeRequest({ ownerId: 'owner-1' });

    markSessionActive(req);

    expect(session.active).toBe(true);
    expect(cookie.maxAge).toBe(lifetimes.fullMs);
  });

  it('fails loudly when the session middleware did not run', () => {
    expect(() => {
      markSessionActive(fakeRequest({ ownerId: 'owner-1' }, false).req);
    }).toThrow(/session middleware/);
  });
});
