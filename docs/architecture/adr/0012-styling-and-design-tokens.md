# ADR 0012: Styling with maw tokens and Tailwind 4 `@apply` only

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-09, F-10, F-50 to F-61; B-58, B-64 to B-84

## Context

Legacy CSS uses IDs, deep selector chains, duplicated buttons, hard-coded greys with failing contrast, `outline: 0`,
`display: none` on the file input and a JS scroll handler for the sticky bar. PLAN.md and the skills
`maw-design-system` (priority) and `modular-css-tailwind4` define the visual language and the CSS rules.

## Decision

- `src/styles/tokens.css` = `maw-design-system/templates/tokens.css` verbatim, with `--color-accent:
var(--color-sky)` (#B8D3F3). It uses `--container-gallery-4: 72rem` ("gallery goes to 4 columns"; added to the
  maw template in the cross-project consistency pass, so the project copy stays verbatim except the accent),
  because FEATURES F-10 asks for up to 4 columns and F-02's page size 12 is chosen to fill 2, 3 and 4 columns. The
  design review in phase 4 must confirm 4 columns at 1280 px; if it fails the rubric, stop using the `@gallery-4` variant and stay at 3.
- `main.css`: `@import "tailwindcss" source(none);` + tokens + base + utilities. Every component has one CSS file
  (`<style scoped src="./X.css">`) starting with `@reference "#styles/main.css";`, rules in `@layer components`,
  BEM classes only, logical properties, motion only in `motion-safe`. Enforced by `scripts/check-no-utilities.mjs`
  and `stylelint.config.mjs` (copied from the skill).
- Fonts: `@fontsource/schibsted-grotesk` 5.3.0 weights 400 and 500 (static files, maw §2), imported in `main.ts`;
  licence copied to `LICENSES/OFL-SchibstedGrotesk.txt` (the `project-scaffold` template ships this package).
- Layout: page shell `max-inline-page`; sticky header with `--header-fade`. **Upload panel = compact sticky bar +
  form in normal flow, on every width** (F-57 revised, B-58): the sticky element is a single row directly below the
  header containing `<h2><button type="button" aria-expanded aria-controls>Upload an image</button></h2>`
  (APG disclosure-in-heading pattern, so heading outline and button stay one element). The form is a sibling in
  normal document flow below the bar and is collapsed by default; expanding it moves focus to the Name field, which
  scrolls it into view. Only one row (about 3.5rem) is ever pinned, plus the header. The first draft made the
  **whole** form sticky on ≥ md, which pinned roughly 350–450 px at 768×1024 and 1440×900 and stacked two sticky
  layers under the header fade; that contradicts maw's quiet editorial layout and the legacy app's slim bar.
- Gallery: `image-grid` container-query grid, 1 → 2 (`@row`) → 3 (`@wide`) → 4 (`@gallery-4`) columns; tiles use
  `aspect-media` (16/10) frames with `object-fit: cover` on `bg-surface`, the preview rendition (ADR 0018), plus
  `width`/`height` attributes from the DTO (CLS < 0.1, F-09). Caption row = maw list row (title left, author and date
  right).
- Tile accessible name (F-03, F-55 revised): the tile is one `<a>` that holds only the preview and the visible title,
  so its name is exactly the title. The tile `<img>` has `alt=""`, because the same link already contains the title
  as text (WCAG technique H2: no duplicated name). Author and date follow the link as text in the same tile and
  describe it through `aria-describedby` (id from Vue's `useId()`); a stretched `::after` on the link keeps the whole
  tile one click target and carries the focus ring, so keyboard focus outlines the same area. The dialog image keeps
  `alt` = title. _Phase 5 change:_ the first build put author and date
  inside the link and named it with `aria-labelledby` → title; axe flagged that as `label-content-name-mismatch`
  (WCAG 2.5.3 Label in Name: visible text inside a control must be part of its name), so the meta moved out of the
  link instead of widening the name to "title author date".
- Eager tiles (F-09, FEATURES §14 R-11): the first four tiles load eagerly on every width, i.e. the first row of the
  widest grid. On one to three columns they are still at the top of the page, where eager loading helps the largest
  contentful paint; deriving the count from the current column count would need layout measurement in script for no
  visible gain.
- Accent use: the upload panel's submit button is the single B+accent button per view; the dialog header rule and
  the current-page underline stay ink. Never text in accent colour; never muted text on the accent.
- Colour scheme follows `prefers-color-scheme` only. **No manual dark-mode toggle.** Reason: it is optional in
  maw §5, and a toggle needs a persisted preference, a blocking script before first paint and a control in the
  header for very little value in a small app. (The first draft claimed the CSP forbids it; that was wrong: an
  external blocking `<script src="/theme.js">` is allowed by `script-src 'self'`. The decision stands for the reason
  above.)
- Focus: global 2px ink `:focus-visible` outline with 4px offset; inputs use a 2px ink underline. File input is
  visually hidden but focusable; its `<label>` shows the focus ring via `:has(:focus-visible)`.
- Copy: lowercase navigation/buttons ("upload image", "load more", "post comment", "delete image",
  "delete comment", "cancel", "close"), sentence case for content, dates `15 Nov 2026, 14:03`. Button names are
  distinct (B-74): the image delete is "delete image" (F-35), each comment delete is "delete comment" with
  `aria-describedby` pointing at that comment's author and time, so screen-reader users can tell them apart. The
  confirmation dialog's buttons stay "delete" / "cancel" (F-37; Playwright role names match case-insensitively unless
  `exact: true`).

## Alternatives

- **Tailwind utilities in markup**: banned by PLAN.
- **Three columns max (maw image-grid default)**: simpler, but under-fills 1280 px pages; kept as the fallback.
- **Dark-mode toggle with an external `theme.js`**: CSP-compatible, but adds a script, storage and a header control
  for an optional feature. Not worth it now.
- **Sticky side column from `lg` up** for the upload form: keeps the form visible on desktop, but splits the
  gallery width at exactly the sizes where 4 columns should fit, and needs a second layout for < lg. Rejected in
  favour of the one-row bar.

## Consequences

- Phase 3 (frontend) writes structural CSS that already passes the checker; phase 4 refines all component CSS
  files and runs the screenshot review against `maw-target-*.png` (390, 768, 1440, dark 1440, hover, focus).
- Any new visual value requires a token in `tokens.css` first.
