# ADR 0003: CSRF protection with csrf-csrf plus a Fetch Metadata guard

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-39; B-03

## Context

Once ownership lives in a cookie (ADR 0002), cross-site requests become an authorisation bypass (B-03). PLAN.md
prescribes CSRF protection; `express-feature-module` ships csrf-csrf 4 (signed double submit bound to the session
id) and explains why it is equivalent to a synchronizer token here.

## Decision

1. **csrf-csrf 4.1.0** `doubleCsrf({ getSecret: () => CSRF_SECRET, getSessionIdentifier: req => req.session.id,
cookieName: '__Host-imageboard.x-csrf-token' (secure) | 'imageboard.x-csrf-token', cookieOptions: { sameSite:
'lax', path: '/', secure, httpOnly: true }, getCsrfTokenFromRequest: req => req.headers['x-csrf-token'] })`.
   Ignored methods GET/HEAD/OPTIONS. `cookie-parser` runs after express-session.
2. Token delivery: `GET /api/session` returns `{ csrfToken }`. Because that call stores `ownerId`, the session id is
   stable and the token stays valid for the session's lifetime.
3. The SPA keeps the token in memory (Pinia), sends it as `x-csrf-token` on every POST/DELETE, and on
   `403 csrf-invalid` refreshes the session once and retries once.
4. **Fetch Metadata guard** (defence in depth, BUGS B-03 fix): for unsafe methods, if `Sec-Fetch-Site` is present
   it must be `same-origin` or `none`; if it is absent and `Origin` is present, `Origin` must equal `APP_ORIGIN`
   (when set) or the request's own origin (`req.protocol` + `Host`, which relies on `TRUST_PROXY`, and on every
   proxy forwarding the client's `Host` with its port: nginx sends `Host $http_host`, because `$host` drops the port
   and `http://127.0.0.1:8080` would never match); requests with neither (curl, Supertest) pass to the CSRF check.
   Violations → `403 cross-origin-request`. The guard reads headers only and runs before body parsing and the
   session middleware (OVERVIEW §4.1).
5. csrf-csrf's `EBADCSRFTOKEN` is mapped to the stable problem code `csrf-invalid` (not generic `about:blank`) so the
   client can tell it apart from `not-owner`.
6. Cookies `SameSite=Lax`: a third layer.
7. **No CORS middleware.** Dev (Vite proxy) and production (nginx) are same-origin, so no client needs
   cross-origin access. The first draft's `cors` dependency and `CORS_ORIGINS` list served nobody and doubled as an
   allow-list for the guard above, i.e. a second place to misconfigure. Both are removed; browsers block
   cross-origin reads by default.

## Alternatives

- **Keep a CORS allow-list "for later"**: no current client; adding it back is one middleware when a real
  cross-origin client exists. Rejected.
- **csrf-sync (synchronizer token in the session)**: equally valid; PLAN and the skill chose csrf-csrf and bind it
  to the session id. Switching libraries requires a new ADR.
- **SameSite + Origin check only**: modern browsers would be safe, but PLAN requires tokens and older clients exist.
- **Custom header only (`X-Requested-With`)**: relies on CORS preflight behaviour; weaker than a signed token.

## Consequences

- Every integration test for a mutating route includes "missing token → 403" and "foreign origin → 403".
- Supertest flows must first `GET /api/session` with an agent (helper `agentWithSession` in `test/http.ts`).
- Multipart uploads carry the token in the header, so multer never runs before the CSRF check.
