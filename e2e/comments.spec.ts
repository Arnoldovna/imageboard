import { type APIRequestContext, type APIResponse, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import {
  type CommentInfo,
  createCommentViaApi,
  createImageViaApi,
  deleteImageViaApi,
  E2E_AUTHOR,
  expectProblem,
  getSessionViaApi,
  type ImageInfo,
  uniqueTitle,
} from './support/api.ts';
import { dialogLiveRegion, openDetail as openDetailDialog, SERVICE_UNAVAILABLE } from './support/screens.ts';
import { createGate, fulfillServiceUnavailable } from './support/stubs.ts';

/**
 * Comments in the detail dialog (FEATURES §7: F-26 to F-33; B-26, B-41, B-45, B-55).
 *
 * Data rules (ADR 0015, BUILD-ORDER phase 5): every test creates its own image and comments through the public API,
 * with unique titles and bodies. Images and "foreign" comments come from the `request` fixture (its own cookie jar,
 * so its own anonymous session); comments that should belong to the page are created with `page.request` before the
 * first `page.goto()`. Counts are only asserted on the test's own image, never on shared lists.
 * Loading, error and in-flight states are produced with `page.route`, never with timeouts.
 */

/** Fictional names only (no real personal data). */
const FOREIGN_AUTHOR = 'Foreign Visitor';
const NAME_LABEL = 'Name (shown publicly)';
const COMMENT_LABEL = 'Comment';
/** `formatDateTime` output, e.g. "15 Nov 2026, 14:03" (F-14). */
const READABLE_DATE_TIME = /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d{2}:\d{2}$/;

/** Matches a list entry whose text starts with this comment body (the body is the first line of a comment). */
function startsWith(body: string): RegExp {
  return new RegExp(`^${RegExp.escape(body)}`);
}

interface DetailScreen {
  dialog: Locator;
  comments: Locator;
  entries: Locator;
  nameField: Locator;
  commentField: Locator;
  submit: Locator;
  /** The detail dialog's own polite live region (F-56): a direct child of the `<dialog>`. */
  liveRegion: Locator;
}

/** Opens `/images/:id` directly and waits until the dialog shows the image and its comment list has settled. */
async function openDetail(page: Page, image: ImageInfo): Promise<DetailScreen> {
  const dialog = await openDetailDialog(page, image);
  const comments = dialog.getByRole('region', { name: 'Comments' });
  await expect(comments).toBeVisible();
  return detailScreen(dialog, comments);
}

function detailScreen(dialog: Locator, comments: Locator): DetailScreen {
  return {
    dialog,
    comments,
    entries: comments.getByRole('listitem'),
    nameField: comments.getByRole('textbox', { name: NAME_LABEL }),
    commentField: comments.getByRole('textbox', { name: COMMENT_LABEL, exact: true }),
    // The label changes to "posting…" while the request runs (F-33).
    submit: comments.getByRole('button', { name: /^(post comment|posting…)$/ }),
    liveRegion: dialogLiveRegion(dialog),
  };
}

function entryFor(screen: DetailScreen, body: string): Locator {
  return screen.entries.filter({ hasText: body });
}

async function expectBodiesInOrder(screen: DetailScreen, bodies: readonly string[]): Promise<void> {
  await expect(screen.entries).toHaveText(bodies.map(startsWith));
}

function commentsPath(imageId: number): string {
  return `/api/images/${String(imageId)}/comments`;
}

/** Matches the comments endpoint of one image, with or without a query (`?cursor=` for older pages). */
function isCommentsUrl(imageId: number): (url: URL) => boolean {
  const path = commentsPath(imageId);
  return (url) => url.pathname === path;
}

/** Counts the comment POSTs the page actually sends for one image (double-submit guard, F-33). */
function countCommentPosts(page: Page, imageId: number): { readonly count: number } {
  const matches = isCommentsUrl(imageId);
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (request.method() === 'POST' && matches(new URL(request.url()))) counter.count += 1;
  });
  return counter;
}

async function postCommentRaw(
  request: APIRequestContext,
  imageId: number,
  data: unknown,
  { withCsrf = true }: { withCsrf?: boolean } = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = withCsrf
    ? { 'x-csrf-token': (await getSessionViaApi(request)).csrfToken }
    : {};
  return request.post(commentsPath(imageId), { headers, data });
}

/** Expected `formatDateTime` text in a fixed UTC offset without daylight saving time. */
function formatInFixedOffset(iso: string, offsetMinutes: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shifted = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(shifted.getUTCDate())} ${months[shifted.getUTCMonth()] ?? '?'} ${String(shifted.getUTCFullYear())}, ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

type MarkedWindow = Window & { e2eNoReloadMarker?: string };

test.describe('comment list and posting', () => {
  // Asia/Kolkata is UTC+05:30 all year, so the expected local time is exact and proves the time-zone conversion.
  const KOLKATA_OFFSET_MINUTES = 330;
  test.use({ timezoneId: 'Asia/Kolkata' });

  test('F-26, F-27, F-28, B-41: comments show body, author and date newest first; a new one goes on top without a reload and keeps its place after reopening', async ({
    page,
    request,
  }) => {
    const image = await createImageViaApi(request, { title: uniqueTitle('Comment list') });
    // Markup in a comment is text, never HTML (Vue interpolation; no v-html anywhere).
    const oldest = await createCommentViaApi(request, image.id, {
      authorName: FOREIGN_AUTHOR,
      body: uniqueTitle('Markup stays text <b>not bold</b> & <i>not italic</i>'),
    });
    const middle = await createCommentViaApi(request, image.id, {
      authorName: 'Second Visitor',
      body: uniqueTitle('Second comment'),
    });
    const newest = await createCommentViaApi(request, image.id, {
      authorName: 'Third Visitor',
      body: uniqueTitle('Third comment'),
    });
    const seeded: CommentInfo[] = [newest, middle, oldest];

    const screen = await openDetail(page, image);

    await test.step('F-26: each comment shows body, author name and a readable local date', async () => {
      await expectBodiesInOrder(
        screen,
        seeded.map((comment) => comment.body),
      );
      for (const comment of seeded) {
        const entry = entryFor(screen, comment.body);
        await expect(entry.getByRole('article')).toBeVisible();
        await expect(entry).toContainText(comment.authorName);
        const time = entry.locator('time');
        await expect(time).toHaveAttribute('datetime', comment.createdAt);
        await expect(time).toHaveText(READABLE_DATE_TIME);
        await expect(time).toHaveText(formatInFixedOffset(comment.createdAt, KOLKATA_OFFSET_MINUTES));
        // Written by another session: no delete control (F-32).
        await expect(entry.getByRole('button', { name: 'delete comment' })).toHaveCount(0);
      }
      const markup = entryFor(screen, oldest.body);
      await expect(markup).toContainText('<b>not bold</b> & <i>not italic</i>');
      await expect(markup.locator('b, i')).toHaveCount(0);
      // Three comments fit on one page: no "show older comments" (F-31).
      await expect(screen.comments.getByRole('button', { name: 'show older comments' })).toHaveCount(0);
    });

    const posted = uniqueTitle('Fresh comment from the form');
    await test.step('F-28: a posted comment appears on top immediately, without a reload', async () => {
      const marker = uniqueTitle('no reload');
      await page.evaluate((value) => {
        (window as MarkedWindow).e2eNoReloadMarker = value;
      }, marker);

      await screen.nameField.fill('Form Visitor');
      await screen.commentField.fill(posted);
      await screen.submit.click();

      await expectBodiesInOrder(screen, [posted, newest.body, middle.body, oldest.body]);
      await expect(screen.liveRegion).toHaveText('Comment added.');
      const own = entryFor(screen, posted);
      await expect(own).toContainText('Form Visitor');
      await expect(own.locator('time')).toHaveText(READABLE_DATE_TIME);
      // The 201 body says canDelete: the author's session sees the delete control right away (F-32).
      await expect(own.getByRole('button', { name: 'delete comment' })).toBeVisible();
      expect(await page.evaluate(() => (window as MarkedWindow).e2eNoReloadMarker)).toBe(marker);
    });

    await test.step('F-27, B-41: after closing and reopening, the order is the same (newest first)', async () => {
      await screen.dialog.getByRole('button', { name: 'close' }).click();
      await expect(screen.dialog).toBeHidden();
      await expect(page).toHaveURL(/\/$/);

      const reopened = await openDetail(page, image);
      await expectBodiesInOrder(reopened, [posted, newest.body, middle.body, oldest.body]);
      await expect(entryFor(reopened, posted).getByRole('button', { name: 'delete comment' })).toBeVisible();
    });

    await expectNoA11yViolationsInBothColorSchemes(page);
  });
});

test('F-29, F-33, B-55: invalid input is shown inline at the field, from the client check and from a real API 400', async ({
  page,
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Comment validation') });
  const posts = countCommentPosts(page, image.id);
  const screen = await openDetail(page, image);
  await expect(screen.comments.getByText('No comments yet. Start the conversation.')).toBeVisible();

  await test.step('labelled fields, Name before Comment, both marked required', async () => {
    const textboxes = screen.comments.locator('form').getByRole('textbox');
    await expect(textboxes).toHaveCount(2);
    await expect(textboxes.nth(0)).toHaveAccessibleName(NAME_LABEL);
    await expect(textboxes.nth(1)).toHaveAccessibleName(COMMENT_LABEL);
    await expect(screen.nameField).toHaveAttribute('aria-required', 'true');
    await expect(screen.commentField).toHaveAttribute('aria-required', 'true');
  });

  await test.step('empty submit: both errors inline, linked to the fields, focus on the first one, nothing sent', async () => {
    await screen.submit.click();

    await expect(screen.nameField).toHaveAttribute('aria-invalid', 'true');
    await expect(screen.nameField).toHaveAccessibleDescription('Enter a name.');
    await expect(screen.commentField).toHaveAttribute('aria-invalid', 'true');
    await expect(screen.commentField).toHaveAccessibleDescription('Write a comment.');
    await expect(screen.nameField).toBeFocused();
    expect(posts.count).toBe(0);
  });

  const body = uniqueTitle('A valid comment body');
  await test.step('values are trimmed: a blank name is still empty, the valid comment keeps its value', async () => {
    await screen.nameField.fill('   ');
    await screen.commentField.fill(body);
    await screen.submit.click();

    await expect(screen.nameField).toHaveAccessibleDescription('Enter a name.');
    await expect(screen.commentField).not.toHaveAttribute('aria-invalid');
    await expect(screen.commentField).toHaveValue(body);
    await expect(screen.nameField).toBeFocused();
    expect(posts.count).toBe(0);
  });

  await test.step('a 400 from the real API is mapped to the field it names, and the values are kept', async () => {
    // The client check uses the same schema, so a valid form never earns a 400. The request is sent with a name the
    // input's maxlength would not allow, to show that the API's field errors reach the form.
    await page.route(isCommentsUrl(image.id), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.continue({ postData: JSON.stringify({ authorName: 'n'.repeat(61), body }) });
    });
    await screen.nameField.fill('Valid Visitor');
    await screen.submit.click();

    await expect(screen.nameField).toHaveAttribute('aria-invalid', 'true');
    await expect(screen.nameField).toHaveAccessibleDescription('Name must be 60 characters or fewer.');
    await expect(screen.nameField).toBeFocused();
    await expect(screen.nameField).toHaveValue('Valid Visitor');
    await expect(screen.commentField).toHaveValue(body);
    await expect(screen.submit).toHaveText('post comment');
    expect(posts.count).toBe(1);
    await expect(screen.comments.getByText('No comments yet. Start the conversation.')).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
  });

  await test.step('after fixing the input the same form posts the comment', async () => {
    await screen.submit.click();
    await expect(entryFor(screen, body)).toContainText('Valid Visitor');
    await expect(screen.nameField).not.toHaveAttribute('aria-invalid');
    await expect(screen.nameField).toHaveValue('');
    await expect(screen.commentField).toHaveValue('');
  });

  await expectNoA11yViolations(page);
});

test('F-29, B-26: the comments API validates trimmed values with problem+json and answers 404 for a missing image', async ({
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Comment API validation') });

  await test.step('blank values: 400 with one field error per field', async () => {
    const problem = await expectProblem(
      await postCommentRaw(request, image.id, { authorName: '  \t ', body: ' \n \n ' }),
      400,
      'validation-failed',
    );
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        { field: 'authorName', location: 'body', message: 'Enter a name.' },
        { field: 'body', location: 'body', message: 'Write a comment.' },
      ]),
    );
  });

  await test.step('one code point over the limits: 400 with the length messages', async () => {
    const problem = await expectProblem(
      await postCommentRaw(request, image.id, { authorName: 'n'.repeat(61), body: 'b'.repeat(1001) }),
      400,
      'validation-failed',
    );
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        { field: 'authorName', location: 'body', message: 'Name must be 60 characters or fewer.' },
        { field: 'body', location: 'body', message: 'Comment must be 1,000 characters or fewer.' },
      ]),
    );
  });

  await test.step('exactly at the limits, with surrounding whitespace: 201 with the trimmed values', async () => {
    const authorName = 'n'.repeat(60);
    const body = 'b'.repeat(1000);
    const created = await createCommentViaApi(request, image.id, {
      authorName: `  ${authorName} `,
      body: `\n${body}  `,
    });
    expect(created).toMatchObject({ imageId: image.id, authorName, body, canDelete: true });
  });

  await test.step('a mutation without the CSRF token is refused', async () => {
    await expectProblem(
      await postCommentRaw(request, image.id, { authorName: E2E_AUTHOR, body: 'No token' }, { withCsrf: false }),
      403,
      'csrf-invalid',
    );
  });

  await test.step('B-26: commenting on (or listing comments of) a deleted image gives 404, not a hang', async () => {
    const gone = await createImageViaApi(request, { title: uniqueTitle('Comment target that is deleted') });
    await deleteImageViaApi(request, gone.id);

    await expectProblem(
      await postCommentRaw(request, gone.id, { authorName: E2E_AUTHOR, body: 'Too late' }),
      404,
      'not-found',
    );
    await expectProblem(await request.get(commentsPath(gone.id)), 404, 'not-found');
  });
});

test('F-30: comments show a loading state, an error with "try again", and the empty state', async ({
  page,
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Comment states') });

  // First load fails at the network level.
  await page.route(isCommentsUrl(image.id), (route) =>
    route.request().method() === 'GET' ? route.abort('failed') : route.fallback(),
  );
  const screen = await openDetail(page, image);

  const retry = screen.comments.getByRole('button', { name: 'try again' });
  await test.step('a failed load shows an inline error with "try again"; the form stays usable', async () => {
    await expect(screen.comments.getByRole('alert')).toHaveText(SERVICE_UNAVAILABLE);
    await expect(retry).toBeVisible();
    await expect(screen.nameField).toBeEditable();
    await expect(screen.comments.getByText('No comments yet. Start the conversation.')).toHaveCount(0);
  });

  const gate = createGate();
  await page.unrouteAll({ behavior: 'wait' });
  await page.route(isCommentsUrl(image.id), async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate.opened;
    return route.continue();
  });

  await test.step('"try again" shows the loading state while the request runs', async () => {
    await retry.click();
    const loading = screen.comments.getByText('Loading comments…');
    await expect(loading).toBeVisible();
    await expect(screen.comments.locator('[aria-busy="true"]')).toContainText('Loading comments…');
    await expect(screen.comments.getByRole('alert')).toHaveCount(0);
    // The pressed button is gone; focus continues on the section heading, not on the page.
    await expect(screen.comments.getByRole('heading', { name: 'Comments', level: 3 })).toBeFocused();
  });

  await test.step('with no comments the empty state appears', async () => {
    gate.open();
    await expect(screen.comments.getByText('No comments yet. Start the conversation.')).toBeVisible();
    await expect(screen.comments.getByText('Loading comments…')).toHaveCount(0);
    await expect(screen.comments.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(screen.entries).toHaveCount(0);
  });

  await expectNoA11yViolationsInBothColorSchemes(page);
});

test('F-31, B-45: 20 comments per page; "show older comments" loads the rest and disappears when none are left', async ({
  page,
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Many comments') });
  const prefix = uniqueTitle('Paged comment');
  const bodies: string[] = [];
  for (let index = 1; index <= 21; index += 1) {
    const body = `${prefix} ${String(index).padStart(2, '0')}`;
    // Sequential on purpose: the creation order is the expected (reversed) display order.
    await createCommentViaApi(request, image.id, { authorName: FOREIGN_AUTHOR, body });
    bodies.push(body);
  }
  const newestFirst = bodies.toReversed();

  const screen = await openDetail(page, image);
  const showOlder = screen.comments.getByRole('button', { name: 'show older comments' });

  await test.step('the first page holds the 20 newest comments, and an older page is offered', async () => {
    await expectBodiesInOrder(screen, newestFirst.slice(0, 20));
    await expect(showOlder).toBeVisible();
  });

  await test.step('loading the older page appends the oldest comment and removes the button', async () => {
    await showOlder.click();
    await expectBodiesInOrder(screen, newestFirst);
    await expect(showOlder).toHaveCount(0);
    await expect(screen.liveRegion).toHaveText('1 older comment loaded.');
    // The button that had focus is gone: focus continues at the first comment that was added.
    await expect(entryFor(screen, bodies[0]!).getByRole('article')).toBeFocused();
  });

  await expectNoA11yViolations(page);
});

test('F-32: only the session that wrote a comment can delete it; deleting asks first and removes it for good', async ({
  page,
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Comment ownership') });
  const foreign = await createCommentViaApi(request, image.id, {
    authorName: FOREIGN_AUTHOR,
    body: uniqueTitle('Written by another session'),
  });
  // Created with the page's cookie jar before the first navigation, so the comment belongs to the page's session.
  const own = await createCommentViaApi(page.request, image.id, { body: uniqueTitle('Written by this session') });
  expect(own.canDelete).toBe(true);

  await test.step('API: another session gets 403 not-owner, and a delete without CSRF token is refused', async () => {
    const { csrfToken } = await getSessionViaApi(request);
    await expectProblem(
      await request.delete(`/api/comments/${String(own.id)}`, { headers: { 'x-csrf-token': csrfToken } }),
      403,
      'not-owner',
    );
    await expectProblem(await page.request.delete(`/api/comments/${String(own.id)}`), 403, 'csrf-invalid');
  });

  const screen = await openDetail(page, image);
  await expectBodiesInOrder(screen, [own.body, foreign.body]);
  const ownEntry = entryFor(screen, own.body);
  const deleteOwn = ownEntry.getByRole('button', { name: 'delete comment' });

  await test.step('the delete control is shown only on the own comment and names whose comment it deletes', async () => {
    await expect(entryFor(screen, foreign.body).getByRole('button', { name: 'delete comment' })).toHaveCount(0);
    await expect(deleteOwn).toBeVisible();
    await expect(deleteOwn).toHaveAccessibleDescription(new RegExp(`^${RegExp.escape(E2E_AUTHOR)} `));
  });

  const confirm = page.getByRole('dialog', { name: 'Delete this comment?' });
  await test.step('cancelling the confirmation keeps the comment', async () => {
    await deleteOwn.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('This cannot be undone.');
    await expect(confirm.getByRole('button', { name: 'cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(ownEntry).toBeVisible();
  });

  await test.step('confirming deletes it (204) and focus moves to the comments heading', async () => {
    await deleteOwn.click();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname === `/api/comments/${String(own.id)}`,
    );
    await confirm.getByRole('button', { name: 'delete' }).click();
    expect((await deleted).status()).toBe(204);

    await expect(confirm).toBeHidden();
    await expectBodiesInOrder(screen, [foreign.body]);
    await expect(screen.comments.getByRole('heading', { name: 'Comments', level: 3 })).toBeFocused();
    await expect(screen.liveRegion).toHaveText('Comment deleted.');
  });

  await test.step('after a reload the comment is still gone and the foreign one is untouched', async () => {
    const reopened = await openDetail(page, image);
    await expectBodiesInOrder(reopened, [foreign.body]);
  });

  await expectNoA11yViolations(page);
});

test('F-33, B-55: the form submits with Enter, ignores presses while sending, keeps values on error and resets on success', async ({
  page,
  request,
}) => {
  const image = await createImageViaApi(request, { title: uniqueTitle('Comment form') });
  const screen = await openDetail(page, image);
  const body = uniqueTitle('Posted once');

  await test.step('a failed post keeps every value and shows the error in the form', async () => {
    // nginx-style failure without a problem body (unexpected-response).
    await page.route(isCommentsUrl(image.id), (route) =>
      route.request().method() === 'POST' ? fulfillServiceUnavailable(route) : route.fallback(),
    );
    await screen.nameField.fill('Patient Visitor');
    await screen.commentField.fill(body);
    await screen.submit.click();

    await expect(screen.comments.locator('form').getByRole('alert')).toHaveText(SERVICE_UNAVAILABLE);
    await expect(screen.nameField).toHaveValue('Patient Visitor');
    await expect(screen.commentField).toHaveValue(body);
    await expect(screen.submit).toHaveText('post comment');
    await expect(screen.entries).toHaveCount(0);
    await page.unrouteAll({ behavior: 'wait' });
  });

  const gate = createGate();
  await page.route(isCommentsUrl(image.id), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate.opened;
    return route.continue();
  });
  const posts = countCommentPosts(page, image.id);
  const typedMeanwhile = uniqueTitle('Typed while the first one was sending');

  await test.step('Enter in the name field submits; while sending the button is busy and keeps ignoring presses', async () => {
    await screen.nameField.press('Enter');

    await expect(screen.submit).toHaveText('posting…');
    await expect(screen.submit).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.nameField).toBeFocused();
    await expect(screen.comments.locator('form').getByRole('alert')).toHaveCount(0);

    // A second Enter and a press on the busy button: both must be swallowed. `force` because Playwright itself
    // refuses to click an aria-disabled button; a person can still press it.
    await screen.nameField.press('Enter');
    await screen.submit.click({ force: true });
    // R-10: text typed while the request runs is not lost by the reset.
    await screen.commentField.fill(typedMeanwhile);
    expect(posts.count).toBe(1);
  });

  await test.step('on success the comment appears once, the sent values reset and the new text stays', async () => {
    gate.open();
    await expect(entryFor(screen, body)).toHaveCount(1);
    await expect(entryFor(screen, body)).toContainText('Patient Visitor');
    await expect(screen.submit).toHaveText('post comment');
    await expect(screen.submit).not.toHaveAttribute('aria-disabled');
    await expect(screen.nameField).toHaveValue('');
    await expect(screen.commentField).toHaveValue(typedMeanwhile);
    await expect(screen.comments.locator('form').getByRole('alert')).toHaveCount(0);
    await expect(screen.entries).toHaveCount(1);
    expect(posts.count).toBe(1);
  });

  await test.step('the server stored exactly one comment', async () => {
    await page.unrouteAll({ behavior: 'wait' });
    const reopened = await openDetail(page, image);
    await expectBodiesInOrder(reopened, [body]);
  });

  await expectNoA11yViolations(page);
});
