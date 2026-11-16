import { describe, expect, it } from 'vitest';

import { createSessionService, type IdentitySession } from '../session.service.js';

describe('session service', () => {
  it('F-34: creates a UUID v4 identity once and stores it in the session', () => {
    const service = createSessionService();
    const session: IdentitySession = {};

    const identity = service.ensureIdentity(session);

    expect(identity.created).toBe(true);
    expect(identity.ownerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(session.ownerId).toBe(identity.ownerId);
  });

  it('B-02: never replaces an existing identity', () => {
    const service = createSessionService({ newOwnerId: () => 'new-id' });
    const session: IdentitySession = { ownerId: 'existing-id' };

    expect(service.ensureIdentity(session)).toEqual({ ownerId: 'existing-id', created: false });
    expect(session.ownerId).toBe('existing-id');
  });

  it('gives every new session its own identity', () => {
    const service = createSessionService();

    expect(service.ensureIdentity({}).ownerId).not.toBe(service.ensureIdentity({}).ownerId);
  });

  it('reports whether a session already has an identity', () => {
    const service = createSessionService();

    expect(service.hasIdentity({})).toBe(false);
    expect(service.hasIdentity({ ownerId: 'x' })).toBe(true);
  });
});
