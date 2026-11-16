import { randomUUID } from 'node:crypto';

/** The part of an express-session the service reads and writes. */
export interface IdentitySession {
  ownerId?: string | undefined;
}

export interface SessionServiceDeps {
  /** UUID v4 generator; injectable for tests. */
  newOwnerId?: () => string;
}

export interface Identity {
  ownerId: string;
  /** True when this call created the identity (the identity limiter has counted it). */
  created: boolean;
}

/**
 * The anonymous identity rules (ADR 0002): a session gets exactly one `ownerId`, created on the first
 * `GET /api/session` and never replaced. Names are display text only; ownership is never derived from them (B-12).
 */
export function createSessionService({ newOwnerId = randomUUID }: SessionServiceDeps = {}) {
  return {
    hasIdentity(session: IdentitySession): boolean {
      return session.ownerId !== undefined;
    },

    /** Returns the existing identity, or stores a new one in the session (which makes the session persistent). */
    ensureIdentity(session: IdentitySession): Identity {
      if (session.ownerId !== undefined) return { ownerId: session.ownerId, created: false };
      const ownerId = newOwnerId();
      session.ownerId = ownerId;
      return { ownerId, created: true };
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
