# ADR 0016: No real-time updates

- Status: proposed
- Date: 15 Nov 2026
- Covers: F-62

## Context

The legacy app has no WebSocket, SSE or polling. FEATURES F-62 states that the rebuild does not need any and that
this must not count as missing. Live updates are listed as out of scope (§13).

## Decision

No socket.io, SSE or polling. New images and comments from other visitors appear after the next fetch (page load,
"load more", reopening the dialog). The visitor's own uploads and comments appear immediately because the client
inserts the server's `201` DTO into its state.

## Alternatives

- **SSE stream of new images**: small, but needs sticky connections through nginx, Redis pub/sub for more than one
  instance, and UX for "3 new images" banners. Not requested.
- **Polling every N seconds**: wasteful and fights the rate limits.

## Consequences

- No socket events exist; API.md lists HTTP endpoints only.
- If live updates are wanted later, SSE on `/api/events` with Redis pub/sub is the preferred path (social-network
  already uses socket.io; Imageboard would not need bidirectional messages).
