# ADR 0011: Image detail as a nested route rendered in a native `<dialog>`

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-11, F-12, F-13, F-15, F-16, F-37, F-53; B-47, B-48, B-49, B-59, B-69

## Context

The legacy modal uses `#id` hash routing (stray `#`, unvalidated input into the API), is not an accessible dialog
(no role, no focus handling, no Esc, close control is an image in a div) and the background stays scrollable.

## Decision

- Route `/images/:id(\\d+)` is a **child** of `/` so the gallery stays mounted (scroll position and loaded pages
  survive). Non-digit ids fall through to the 404 page; digit ids out of range get a 400 from the API and the
  dialog shows "Image not found".
- `ImageDetailDialog` wraps the shared `ModalDialog` (native `<dialog>`): `showModal()` on mount gives focus
  containment and an inert background; `aria-labelledby` points to the `h2` title; the first focus goes to the
  Close button, a real `<button type="button">` whose visible text is the maw word "close" (accessible name
  "close"; FEATURES F-15's "Close" matches case-insensitively, as Playwright's role locator does).
- Closing (Close button, Esc via the `cancel` event with `preventDefault`, backdrop click is **not** a close action
  to avoid accidental loss of a typed comment): if `router.options.history.state.back` is `/` → `router.back()`,
  else `router.replace({ name: 'home' })`. Browser Back closes it naturally. No `#` ever appears (history mode).
- Focus return: HomePage records the tile id; after unmount it calls `gallerySection.focusTile(id)`; when the tile
  is not loaded (deep link), focus goes to the "Gallery" `h2` (`tabindex="-1"`).
- Background scroll lock in CSS: `:root:has(dialog[open]) { overflow: hidden; }` with `scrollbar-gutter: stable`
  on `:root` (no layout jump, no JS). `:root` instead of `html` because the copied stylelint config
  (`selector-max-type: 1`) rejects `html:has(dialog[open])` (two type selectors); `:root:has(dialog[open])` was
  checked against stylelint 18.0.0 + stylelint-config-standard 41 + the skill config and passes, so no
  `stylelint-disable` is needed.
- Each `ModalDialog` contains its own polite live region; while the dialog is open, announcements go there
  (ADR 0010), because the App-level region is inert behind a modal dialog.
- Delete confirmation is a second `ModalDialog` opened from inside the first (top layer stacking), with
  `autofocus` on "Cancel" (F-37).
- `useImageDetail` watches the route param with `immediate: true`, aborts the previous request, and fetches once
  per id. The document title is set when data is ready.

## Alternatives

- **Separate full page for `/images/:id`**: loses gallery context, contradicts F-11/F-12.
- **Custom focus-trap library + `div role="dialog"`**: more code and more ways to get it wrong; native `<dialog>`
  is supported in all target browsers.
- **Close on backdrop click**: common, but easy to trigger accidentally on touch devices while a comment is typed.

## Consequences

- E2E covers: deep link, reload, Back, Esc, focus in/out, Tab containment, `aria-modal` semantics (native dialog
  exposes modal semantics; axe validates), title per route, no `#`, announcements inside the dialog's live region.
  The WebKit smoke project repeats open/Esc/focus return, because dialog focus behaviour differs between engines.
- Vitest component tests stub `HTMLDialogElement.prototype.showModal` (happy-dom support is partial).
