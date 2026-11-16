import type { Route } from '@playwright/test';

/**
 * Stand-ins for a `page.route` handler: a "slow server" gate and the failure responses the specs produce without a
 * broken stack (ADR 0015).
 */

/**
 * A promise the test resolves by hand, to hold a routed request in flight for exactly as long as needed: the "slow
 * server" for loading and busy states, without any timer.
 */
export function createGate(): { opened: Promise<undefined>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

/** Answers with the API's `500 internal-error` problem (API.md §2). */
export function fulfillInternalError(route: Route): Promise<void> {
  return route.fulfill({
    status: 500,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      code: 'internal-error',
    }),
  });
}

/** Answers with a 503 that has no problem body, as nginx does while the API is down (client code `unexpected-response`). */
export function fulfillServiceUnavailable(route: Route): Promise<void> {
  return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>503 Service Unavailable</h1>' });
}
