# ADR 0002: Anonymous session ownership instead of user accounts

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-25, F-32, F-34, F-35, F-38; B-02, B-12, B-56

## Context

Anyone can delete anything in the legacy app (B-02), and free-text usernames look like identities (B-12). FEATURES
§8 puts accounts out of scope (module cut: images, comments, upload) but requires that only the uploader or
commenter can delete. PLAN.md requires sessions in httpOnly cookies and a Redis store.

The first draft gave every visitor (and every JS-rendering crawler, which keeps no cookies) a 180-day Redis session
on page load, "bounded by the global rate limit". That bound is about 86,000 new sessions per IP per day, and with
`ipv6Subnet: 56` one IPv6 /48 yields 256 separate limiter keys. Sessions and limiter counters shared one Redis, so
filling it would either evict sessions (owners silently lose their delete right) or make writes fail (every limited
request becomes a 500).

## Decision

- `GET /api/session` creates an anonymous identity when `req.session.ownerId` is absent:
  `req.session.ownerId = crypto.randomUUID()` (UUID v4). Images and comments store it in `owner_id uuid NOT NULL`.
- **Identity creation is rate-limited**: limiter `identities` (`RATE_LIMIT_IDENTITIES` = 20 per hour per IP, ADR 0013) runs inside the session handler **only when a new `ownerId` is about to be created**; existing sessions are
  never counted. On 429 the SPA still renders and browses (GETs need no session); mutations show the rate-limit
  message.
- **Provisional sessions are short-lived**: a new identity gets `req.session.cookie.maxAge =
SESSION_PROVISIONAL_HOURS` (default 24 h). After the first successful upload or comment the controller calls
  `markSessionActive(req)` (`shared/session/actor.ts`), which sets `req.session.active = true` and
  `cookie.maxAge = SESSION_MAX_AGE_DAYS` (default 180 days). `rolling: true` renews whichever lifetime the session has
  on every response; connect-redis derives the key TTL from `cookie.maxAge`. Crawlers and one-off visitors therefore
  leave keys that expire after a day. (FEATURES F-34 is revised accordingly.)
- express-session 1.19 + connect-redis 10 (`imageboard:sess:` prefix), `saveUninitialized: false`,
  `resave: false`, `rolling: true`, cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` + `__Host-imageboard.sid` name in
  production (`imageboard.sid` on local http; app-scoped because cookies ignore ports). The cookie holds only the signed session id.
- `actorOf(req)` returns `{ ownerId: string | null }`. `requireOwnerSession` (403 `session-required`) guards
  mutations. Services compare `row.ownerId === actor.ownerId`; `canDelete` is part of every DTO; `owner_id` never
  appears in a response.
- No session regeneration is needed (there is no privilege change); the CSRF token is bound to the session id
  (ADR 0003).
- UI copy: "Name (shown publicly)"; names are display text, never identity.
- Seed rows use an owner UUID no session can hold (`5eed0000-0000-4000-8000-000000000001`).

### Production Redis

| Instance                                                   | Holds                           | Settings                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` (sessions)                                     | ownership-relevant session keys | AOF (`appendonly yes`, `appendfsync everysec`), `maxmemory` sized with headroom, `maxmemory-policy noeviction` (never silently evict an owner) |
| `RATE_LIMIT_REDIS_URL` (optional, defaults to `REDIS_URL`) | limiter counters only           | no persistence, `maxmemory-policy volatile-ttl` (all keys have TTLs; evicting a counter only resets a budget)                                  |

Separate _instances_ rather than separate logical databases, because `maxmemory` and the eviction policy are per
instance. Local compose keeps one Redis without persistence (restarting it resets ownership, acceptable in
development). Memory alerts on the sessions instance are part of the deployment checklist (ADR 0019).

## Alternatives

- **Accounts (email + password)**: out of scope per FEATURES; adds argon2, registration, reset flows.
- **Per-item delete tokens** (returned once, stored in `localStorage`): survives cookie-less clients but puts a
  bearer secret into JS-readable storage and needs one secret per item. Rejected.
- **Signed cookie holding the owner id without a server store**: no revocation and PLAN requires Redis sessions.
- **Create the identity lazily before the first mutation**: avoids most keys, but the CSRF token is bound to the
  session id, and with `saveUninitialized: false` an empty session is not stored, so its id changes on every request.
  The SPA would need a second "upgrade" round trip right before the first POST and a retry path for the token. The
  provisional TTL achieves the same bound with less moving parts. Rejected.

## Consequences

- Clearing cookies, another browser, 180 days of inactivity after posting, or 24 h of inactivity without ever
  posting lose the ability to delete own content. This is stated in the README; it is the accepted trade-off of
  account-less posting.
- Upper bound of session keys: 20 identities × 24 per day per limiter key, each expiring after a day. A /48 IPv6
  attacker (256 keys) can hold roughly 120,000 provisional keys of a few hundred bytes each (tens of MB), which the
  sized `maxmemory` absorbs; the noeviction policy makes overload visible as errors instead of silent loss.
- `markSessionActive` is called by the images and comments controllers after a `201` (frozen in ADR 0017);
  `session.int.test.ts` asserts the cookie `Max-Age` before (24 h) and after a comment (180 days).
- Without accounts there is still no moderation; the admin removal script in ADR 0019 is the takedown path.
