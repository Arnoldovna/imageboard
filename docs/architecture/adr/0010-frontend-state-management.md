# ADR 0010: Frontend state: Pinia for shared state, composables for scoped state, validated responses

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-04 to F-08, F-16, F-17, F-24, F-28, F-33, F-37, F-56; B-46 to B-55, B-57

## Context

The legacy client duplicates fetch logic, leaks `hashchange` listeners, reloads the whole list after a delete
(losing "MORE" pages and scroll position), fetches the detail twice and has no loading/error/empty states. PLAN.md
fixes Vue 3 + Pinia + Vue Router.

## Decision

- **Pinia only for state that outlives a component or is shared**: `useSessionStore` (CSRF token in memory,
  `uploadMaxBytes`, `ensure()` de-duplicating concurrent calls), `useGalleryStore` (list, cursor, statuses,
  `prepend`, `remove`), `useAnnouncerStore` (live region messages, routed to the top-most open dialog, see below).
- **Composables for scoped state**: `useImageDetail(idRef)`, `useComments(imageIdRef)`, `useUploadForm()`. Each
  exposes a discriminated status (`'loading' | 'ready' | 'notFound' | 'error'` etc.) so templates never read fields
  of missing data (B-49).
- **One HTTP client** (`shared/api/http.ts`, native `fetch`): CSRF header, problem parsing to `ApiError`, Zod
  validation of every success body with the shared schema, `AbortSignal` support, one retry after
  `403 csrf-invalid`. Each feature has a thin `*.api.ts` with typed functions (`listImages`, `getImage`, …).
- **Tolerant reader**: response DTO schemas in `packages/shared` are `z.object` (unknown keys are stripped), not
  `z.strictObject`; request schemas stay strict on the server. `ProblemDetails.code` is parsed as
  `ProblemCode.or(z.string())`. A body that is not `application/problem+json` on a non-2xx status becomes
  `ApiError { code: 'unexpected-response', status }` with a generic message ("The service is not available right
  now. Try again in a moment." for 502/503/504, the upload size message for 413). Network failures stay
  `ApiError { code: 'network' }`. Adding a field or a problem code to the API therefore never breaks a deployed SPA.
- **Live announcements reach the user while a dialog is open**: `showModal()` makes everything outside the dialog
  inert, which removes App.vue's live region from the accessibility tree. `ModalDialog` therefore renders its own
  visually hidden `aria-live="polite"` region and registers it with `useAnnouncerStore` on open (a stack); the store
  writes each message to the region of the top-most open dialog and falls back to App.vue's region when no dialog is
  open. Messages are cleared and set on the next tick so repeated identical messages are announced again.
- **Cross-feature effects go through `HomePage.vue`**: `UploadPanel` emits `uploaded(image)` → `gallery.prepend`;
  `ImageDetailDialog` emits `deleted(id)` (through `<RouterView v-slot>`) → `gallery.remove(id)`; `GallerySection`
  emits `request-upload` on its empty-state button → `uploadPanel.open()` (exposed method); after the dialog
  unmounts → `gallerySection.focusTile(id)`. Features stay independent; the gallery store is the only feature API
  that `app/` calls.
- **Busy controls keep focus** (phase 3 review, FEATURES §14 R-10): a button whose request is running ("loading…",
  "posting…", "Uploading…", "deleting…") is `AppButton` with `busy`: `aria-disabled="true"` and its clicks are
  swallowed (a busy submit does not submit). Assistive technology still reports it as disabled, but unlike native
  `disabled` it keeps keyboard focus (WCAG 2.4.3). Native `disabled` is only for an action that is unavailable.
  Forms stay editable while their request runs; reset-on-success empties the values that were sent and keeps
  anything entered meanwhile, so no input is lost without notice.
- No optimistic insert on upload (we need the server DTO with `url` and dimensions); delete removes the item **after**
  the `204`, so a failed delete leaves the item and shows an error (F-37).
- Responses are validated at runtime: a missing or mistyped field becomes a visible error state instead of a broken
  render; additive changes pass.

## Alternatives

- **Everything in Pinia**: detail and comments would need manual reset per id, which is exactly the class of bug
  in B-47/B-48.
- **TanStack Query (vue-query)**: excellent caching, but adds a dependency and concepts for four endpoints; the
  composables are ~60 lines each.
- **Event bus between features**: hidden coupling; explicit wiring in HomePage is easier to read and test.

## Consequences

- Unit tests for stores and composables run with happy-dom and a mocked `fetch` (via `vi.stubGlobal`), asserting
  abort on id change, single fetch per open, dedupe, keep-values-on-error, reset-on-success (including the file
  input: the component re-keys the `<input type=file>`).
- The session store must be ready before the first mutation; GET requests do not wait for it. If `GET /api/session`
  fails (for example 429 from the identity limiter), browsing still works and the mutation shows the error.
- `e2e/a11y.spec.ts` asserts that "Comment added." and "Comment deleted." appear in a live region that is a
  descendant of the open `<dialog>` (axe cannot detect a muted region).
