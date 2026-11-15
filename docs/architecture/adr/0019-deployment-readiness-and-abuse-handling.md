# ADR 0019: Deployment readiness and abuse handling

- Status: proposed (added after the architecture critique, round 1; checklist item 8 added in the consistency-pass
  review, ADR 0020)
- Date: 15 Nov 2026
- Covers: PLAN "CD" (`vars.DEPLOY_ENABLED`), F-42, F-46; B-05, B-08, B-10

## Context

The repository ships a deploy job that stays disabled until hosting exists. Several things that are harmless on
`127.0.0.1` become wrong or risky the day `DEPLOY_ENABLED` is set: a CDN in front of the bucket would drop the
security headers that only the API media route sets (a B-05 regression); nginx overwrote `X-Forwarded-Proto` with its
own `$scheme`, which is `http` behind a TLS-terminating load balancer, so express-session would silently never set
the `Secure` cookie; the app is a public, anonymous image host with no takedown path; and logs contain client IPs,
which a deployment run from Germany has to justify in a privacy notice.

## Decision

Built now (cheap, and tested like everything else):

- **nginx forwards the original scheme**:
  `map $http_x_forwarded_proto $fwd_proto { default $http_x_forwarded_proto; '' $scheme; }` and
  `proxy_set_header X-Forwarded-Proto $fwd_proto;`. `TRUST_PROXY` = the real number of hops (documented in
  `.env.example`). `security-headers.int.test.ts` asserts the `Secure` cookie when `X-Forwarded-Proto: https`
  arrives through the configured hops.
- **nginx config is a template** (`apps/web/templates/default.conf.template`, rendered by the image's envsubst
  entrypoint): `API_MAX_BODY_SIZE` (default `6m`) and `CSP_IMG_SRC_EXTRA` (default empty; a CDN origin later) are
  the only variables. Defaults are set with `ENV` in the web Dockerfile, together with
  `NGINX_ENVSUBST_FILTER=^(API_MAX_BODY_SIZE|CSP_IMG_SRC_EXTRA)$` so the entrypoint never touches nginx's own
  `$variables` in the template.
- **Takedown path**: `pnpm --filter @app/api admin:remove-image <id>` (`src/scripts/admin-remove-image.ts`) loads env,
  builds the modules like the composition root and calls `imagesModule.adminRemove(id)` (ADR 0017), which deletes the
  row (comments cascade) and discards original and preview. It logs `{ imageId, objectKey }` at `warn` and refuses to
  run without `--yes`. Tested in `test/admin-remove-image.int.test.ts`.
- **Global daily upload cap** (`RATE_LIMIT_UPLOADS_GLOBAL_DAY` = 200, ADR 0013) bounds storage cost even against
  many IPs.
- **IP minimisation in logs**: the pino-http request serializer logs `remoteAddress` truncated to /24 (IPv4) or /48
  (IPv6) and never logs `x-forwarded-for`. Rate limiting still uses the full address in Redis keys with TTLs ≤ 24 h.
  `logger.test.ts` asserts the truncation.

Checklist that must be done **before** `DEPLOY_ENABLED` is set (kept in OVERVIEW §16 and in the deploy job's
description; none of it blocks the Definition of Done for the private repository):

1. CDN, if any, sits in front of the **public app origin** (so `/api/media/*` responses keep `nosniff`,
   `Content-Disposition`, `CSP sandbox` and CORP), or applies an equivalent response-headers policy; the bucket stays
   private. `MEDIA_PUBLIC_BASE_URL` and `CSP_IMG_SRC_EXTRA` are set together. Delete must invalidate both media paths.
2. Production Redis per ADR 0002 (AOF, `noeviction` for sessions, optional separate limiter instance), memory alert.
3. `TRUST_PROXY` set to the measured hop count; verify `Secure` + `__Host-imageboard.sid` in a browser.
4. Load balancer health probe targets the api container's `/api/health`, not the public origin.
5. Imprint (Impressum) and privacy page (log contents, retention, session cookie, no tracking) linked from the
   footer; content written and confirmed by Marina.
6. A contact address for takedown requests in the privacy page; the admin script above is the procedure.
7. Billing alarm on the S3 account and a bucket lifecycle rule for incomplete multipart uploads (defensive).
8. The repository is public: `images` and `deploy` in `release.yml` only run then (CI cost rule, ADR 0020).
   Deploying from a private repository needs a superseding ADR.

## Alternatives

- **CDN directly on the bucket (origin access control)**: cheapest delivery, but needs a response-headers policy that
  reproduces every media header, and a private bucket behind OAC is AWS-specific. Allowed by item 1 if the headers
  policy is in place; not the default.
- **Moderation UI**: out of scope (FEATURES §13); a script is enough for a portfolio deployment.
- **No IP logging at all**: rate limiting does not need logs, but truncated addresses still help to spot abuse
  patterns. Truncation is the middle ground.

## Consequences

- ADR 0004's "a CDN needs only one env var" is corrected: it needs the two env vars above plus item 1.
- The admin script reuses the service code path, so the cascade and object cleanup stay tested.
- Legal pages are content work for Marina, tracked as a deploy blocker, not as code.
