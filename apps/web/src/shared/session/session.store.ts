import { LIMITS, SessionDto } from '@app/shared';
import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

import { send } from '../api/transport';

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The anonymous session (ADR 0002, OVERVIEW §8.1): the CSRF token lives in memory only (never in storage), plus the
 * effective upload limit for the client-side size check. `GET /api/session` creates the identity on first call.
 *
 * GET requests never wait for this store. Mutations call `ensure()` through the HTTP client; if the session cannot
 * be created (for example 429 from the identity limiter), browsing continues and only the mutation reports the error.
 */
export const useSessionStore = defineStore('session', () => {
  const csrfToken = shallowRef<string | null>(null);
  /** Until the session answers, the documented default keeps the client check meaningful. */
  const uploadMaxBytes = shallowRef<number>(LIMITS.uploadMaxBytesDefault);
  const status = shallowRef<SessionStatus>('idle');

  let inFlight: Promise<string> | null = null;

  async function load(): Promise<string> {
    status.value = 'loading';
    try {
      const session = await send('GET', '/api/session', { schema: SessionDto });
      csrfToken.value = session.csrfToken;
      uploadMaxBytes.value = session.uploadMaxBytes;
      status.value = 'ready';
      return session.csrfToken;
    } catch (error) {
      status.value = 'error';
      throw error;
    } finally {
      inFlight = null;
    }
  }

  /** Resolves with the CSRF token. Concurrent callers share one request; a failed attempt is retried next time. */
  function ensure(): Promise<string> {
    if (csrfToken.value !== null) return Promise.resolve(csrfToken.value);
    inFlight ??= load();
    return inFlight;
  }

  /** Drops the token and fetches a new one (after `403 csrf-invalid`, e.g. an expired session). */
  function refresh(): Promise<string> {
    if (inFlight === null) csrfToken.value = null;
    return ensure();
  }

  /** Starts the session at app start without making anyone wait for it; errors surface on the first mutation. */
  function prefetch(): void {
    ensure().catch(() => undefined);
  }

  return { csrfToken, uploadMaxBytes, status, ensure, refresh, prefetch };
});
