# ADR 0007: Keyset pagination with opaque, validated cursors

- Status: proposed
- Date: 15 Nov 2026
- Covers: F-02, F-04, F-05, F-27, F-31, F-44; B-41, B-45, B-46

## Context

Legacy "MORE" loads `id < lastId` with a hard-coded 9 and decides "has more" by checking whether the last id is 1,
which breaks with zero images, with ≤ 9 images and after deleting image 1 (B-46). Comments are unordered and
unpaginated (B-41, B-45).

## Decision

- Order everywhere: `created_at DESC, id DESC` (id breaks ties).
- Query: `WHERE (created_at, id) < ($t::timestamptz, $id)` row comparison, `LIMIT limit + 1`. The extra row only
  signals that another page exists; `nextCursor = encode(last returned item)` or `null`.
- Cursor = base64url of JSON `{ t: ISO-8601 with ms, id }`, ≤ 200 chars, decoded with Zod; any failure →
  `400 invalid-cursor`, never a 500.
- `created_at` has millisecond precision (`timestamptz(3)`), so the cursor's JS `Date` equals the stored value
  exactly. With microsecond timestamps a truncated cursor could skip rows whose time falls between the truncated
  and the real value.
- `limit`: shared `pageQuery(default, 50)`: empty → default (12 images, 20 comments, from env), non-integer → 400,
  out of range → clamped to 1..50.
- Gallery store deduplicates by id on append (defensive; keyset already prevents duplicates).

## Alternatives

- **Offset pagination**: duplicates/skips when items are added or removed between requests. Rejected (F-04).
- **`id`-only keyset**: identity ids are monotonic per insert, but seeds insert historic `created_at` values, so
  `id` order ≠ time order. Rejected.
- **Signed cursors (HMAC)**: tampering with a cursor only changes which public page you see; validation suffices.

## Consequences

- Composite indexes are required (DATA-MODEL §2).
- "Load more" is shown only when `nextCursor !== null`, which fixes all three B-46 cases; tests cover 0, 12, 13 items
  and deletion of the oldest item.
- Clients cannot jump to page N; not needed.
