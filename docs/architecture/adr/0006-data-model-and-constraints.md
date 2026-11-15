# ADR 0006: Data model: identity keys, millisecond timestamps, DB checks that mirror Zod

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-D1, F-D2, F-D3, F-43; B-28, B-37 to B-43

## Context

Legacy tables use `SERIAL`, `TIMESTAMP` without time zone, arbitrary `VARCHAR(255)`, a misnamed FK (`user_id` that
points to images), no cascade, no index, destructive `DROP TABLE` scripts and `SELECT *`. FEATURES §2.2 sketches
the target and leaves final names to this ADR.

## Decision

Final schema in [DATA-MODEL.md](../DATA-MODEL.md). Key points:

- Tables `images` and `comments`; names `object_key`, `mime_type`, `width`, `height`, `size_bytes`,
  `author_name`, `title`, `description`, `owner_id`, `created_at`, `image_id`, `body`.
- PKs `integer generated always as identity`. `owner_id uuid NOT NULL` (anonymous identity), never exposed.
- `created_at timestamptz(3) NOT NULL DEFAULT now()` — millisecond precision on purpose (ADR 0007).
- `comments.image_id … REFERENCES images(id) ON DELETE CASCADE`; delete is one statement.
- Indexes: `images (created_at DESC, id DESC)`, `comments (image_id, created_at DESC, id DESC)`.
- CHECK constraints for every rule the API enforces: lengths in code points, no leading/trailing whitespace, no
  forbidden characters, MIME allow-list, key format, key extension matching MIME type, positive dimensions and size.
- **One definition of "forbidden character" and "whitespace"**, as explicit code-point classes exported from
  `packages/shared/src/text.ts` and used verbatim by both Zod (`new RegExp`) and the Drizzle CHECKs (the escape
  syntax `\uXXXX` means the same in JS and in Postgres ARE). No `[[:cntrl:]]` and no `btrim`, because their meaning
  depends on the database locale/libc and differs from JS `trim()`:
  - `WHITESPACE` = JS `String.prototype.trim` set: `\u0009-\u000D \u0020 \u00A0 \u1680 \u2000-\u200A \u2028
    \u2029 \u202F \u205F \u3000 \uFEFF`.
  - `FORBIDDEN_SINGLE_LINE` (`author_name`, `title`): C0 `\u0001-\u001F`, DEL + C1 `\u007F-\u009F`, `\u2028`, `\u2029`,
    bidi embeddings/overrides/isolates `\u202A-\u202E`, `\u2066-\u2069`.
  - `FORBIDDEN_MULTI_LINE` (`description`, `body`): C0 except `\n`, DEL + C1, `\u2028`, `\u2029`. `\r` is forbidden
    in storage because `multiLineText` normalises `\r\n?` → `\n` **before** NFC, trim and counting (browsers send
    CRLF in multipart text fields, JSON keeps LF; both must count the same).
  - U+0000 is rejected by Zod; Postgres `text` cannot store it at all.
- Zod pipeline per text field: `\r\n?` → `\n` (multi-line only) → NFC → JS `trim()` → count code points →
  forbidden-class check. DB CHECK per text field: `char_length(x)` within limits, `x !~ '^[WS]|[WS]$'`, `x !~ '[F]'`.
  A value Zod accepts therefore always satisfies the CHECK, and a direct insert that Zod would reject fails.
- Defence in depth: Postgres `23514` (check violation) is mapped by `shared/errors/db-errors.ts` from the constraint
  name to `400 validation-failed` on the matching field and logged at `warn` (it means Zod and SQL drifted), instead of
  a 500.
- `test/db-constraints.int.test.ts` and `packages/shared/src/__tests__/text.test.ts` run the **same** vector file
  (`@app/shared/testing`, ADR 0015), including both boundaries per limit.
- Repositories select explicit columns; DTO mapping lives in services.
- Migrations only through drizzle-kit generated SQL, committed and reviewed.

## Alternatives

- **UUID primary keys**: hides counts but complicates keyset cursors and URLs; ids are not secret here.
- **`varchar(n)`**: duplicates limits in a type, and byte vs character semantics confuse; `text + CHECK` is the
  Postgres recommendation.
- **Rely on Zod only**: a bug or a script could bypass it; F-D3 requires both.
- **Soft delete (`deleted_at`)**: conflicts with the privacy expectation of deletion (B-07) and complicates every
  query. Rejected.
- **Reject bidi controls in multi-line fields too**: partially rejected. They are a spoofing risk in short labels
  (names, titles shown in lists), so single-line fields reject them; in descriptions and comments they are
  legitimate for mixed-direction text and are rendered as plain text (never `v-html`), so they stay allowed.
- **Tab normalisation** (tab → space): not done; a tab is a control character and is rejected like the others,
  which keeps the rule set small.

## Consequences

- Any limit or character-class change touches `limits.ts`/`text.ts`, the CHECK constraints (new migration) and the
  shared vectors.
- `timestamptz(3)` loses sub-millisecond precision, which nothing needs.
- The FK cascade makes the delete flow simple and atomic; comment deletes are independent.
