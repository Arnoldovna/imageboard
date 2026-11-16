import type { CommentDto, CommentPage } from '@app/shared';
import { cleanup, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_REGION, useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import CommentsSection from '../components/CommentsSection.vue';

function comment(id: number, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id,
    imageId: 6,
    authorName: 'Sanne',
    body: 'A long way past the last car park. Worth the walk.',
    createdAt: '2026-10-06T15:52:00.000Z',
    canDelete: false,
    ...overrides,
  };
}

const marit = comment(41, { authorName: 'Marit', body: 'The light on that grass is doing a lot of work.' });
const own = comment(40, {
  authorName: 'Kofi',
  body: 'Which beach is this?\nAsking for next year.',
  createdAt: '2026-10-06T16:40:00.000Z',
  canDelete: true,
});
const henrik = comment(37, { authorName: 'Henrik', body: 'The light up there in autumn is something else.' });

type FetchArgs = [input: string, init: RequestInit];
type Handler = (url: string, init: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function page(items: readonly CommentDto[], nextCursor: string | null = null): Response {
  const body: CommentPage = { items: [...items], nextCursor };
  return json(body);
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: `tag:test:${code}`, title: code, status, detail, code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const session = (): Response => json({ csrfToken: 'csrf-token-1', uploadMaxBytes: 5 * 1024 * 1024 });

/** A handler whose response the test sends later with the returned function. */
function deferred(): { handler: Handler; answer: (response: Response) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const handler: Handler = () =>
    new Promise<Response>((done) => {
      resolve = done;
    });
  return {
    handler,
    answer: (response) => {
      resolve(response);
    },
  };
}

function stubFetch(...answers: (Response | Handler)[]) {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  for (const answer of answers) {
    fetchMock.mockImplementationOnce((url, init) =>
      typeof answer === 'function' ? answer(url, init) : Promise.resolve(answer),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function setup() {
  const user = userEvent.setup();
  render(CommentsSection, { props: { imageId: 6 }, global: { plugins: [pinia] } });
  return { user };
}

describe('CommentsSection', () => {
  it('shows an h3, a loading text, then the comments as an ordered list of articles (F-26, F-54)', async () => {
    stubFetch(page([marit, own]));
    setup();

    expect(screen.getByRole('heading', { level: 3, name: 'Comments' })).toBeTruthy();
    expect(screen.getByText('Loading comments…')).toBeTruthy();

    const list = await screen.findByRole('list');
    expect(list.tagName).toBe('OL');
    const articles = within(list).getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]?.textContent).toContain('Marit');
    expect(articles[1]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-06T16:40:00.000Z');
    expect(screen.getByRole('region', { name: 'Comments' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'show older comments' })).toBeNull();
  });

  it('shows the empty text (F-30)', async () => {
    stubFetch(page([]));
    setup();

    expect(await screen.findByText('No comments yet. Start the conversation.')).toBeTruthy();
  });

  it('shows an error with try again (F-30)', async () => {
    stubFetch(problem(500, 'internal-error', 'An unexpected error occurred.'), page([marit]));
    const { user } = setup();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('An unexpected error occurred.');
    await user.click(screen.getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('list')).toBeTruthy();
  });

  it('moves focus to the heading while "try again" reloads and onto the new "try again" when it fails again', async () => {
    const reload = deferred();
    stubFetch(problem(500, 'internal-error', 'An unexpected error occurred.'), reload.handler);
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: 'try again' }));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Comments' }));
    });

    reload.answer(problem(503, 'service-unavailable', 'The service is unavailable. Try again in a moment.'));
    const retry = await screen.findByRole('button', { name: 'try again' });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(retry);
    });
  });

  it('keeps focus on the busy "show older comments" while the page loads and while older ones remain', async () => {
    const older = deferred();
    stubFetch(page([marit, own], 'cursor-2'), older.handler);
    const { user } = setup();

    const button = await screen.findByRole('button', { name: 'show older comments' });
    await user.click(button);

    expect(button.textContent.trim()).toBe('loading…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);

    older.answer(page([henrik], 'cursor-3'));
    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(3);
    });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('1 older comment loaded.');
  });

  it('shows "show older comments" only with a cursor and focuses the first older comment (F-31)', async () => {
    stubFetch(page([marit, own], 'cursor-2'), page([henrik]));
    const { user } = setup();

    const button = await screen.findByRole('button', { name: 'show older comments' });
    await user.click(button);

    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(3);
    });
    expect(screen.queryByRole('button', { name: 'show older comments' })).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute('data-comment-id')).toBe('37');
    });
    expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('1 older comment loaded.');
  });

  it('keeps the comments when an older page fails and puts focus on "try again"', async () => {
    stubFetch(
      page([marit, own], 'cursor-2'),
      problem(500, 'internal-error', 'An unexpected error occurred.'),
      page([henrik]),
    );
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: 'show older comments' }));

    const retry = await screen.findByRole('button', { name: 'try again' });
    expect(screen.getByRole('alert').textContent).toBe('An unexpected error occurred.');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(retry);
    });

    await user.click(retry);
    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(3);
    });
  });

  it('offers "delete comment" only on own comments, described by author and time (F-32, B-74)', async () => {
    stubFetch(page([marit, own]));
    setup();

    const buttons = await screen.findAllByRole('button', { name: 'delete comment' });
    expect(buttons).toHaveLength(1);
    const ids = buttons[0]?.getAttribute('aria-describedby')?.split(' ') ?? [];
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts[0]).toBe('Kofi');
    expect(texts[1]).toMatch(/^6 Oct 2026, \d\d:40$/);
  });

  it('confirms, deletes, announces and moves focus to the heading', async () => {
    stubFetch(page([marit, own]), session(), new Response(null, { status: 204 }));
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: 'delete comment' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this comment?' });
    await user.click(within(dialog).getByRole('button', { name: 'delete' }));

    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Comments' }));
    await vi.waitFor(() => {
      expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('Comment deleted.');
    });
  });

  it("tracks each delete on its own: a cancelled one never blocks or speaks into another comment's confirmation", async () => {
    const other = comment(39, { authorName: 'Bea', body: 'Bring a coat.', canDelete: true });
    const firstDelete = deferred();
    const fetchMock = stubFetch(page([own, other]), session(), firstDelete.handler);
    const { user } = setup();

    const [deleteOwn, deleteOther] = await screen.findAllByRole('button', { name: 'delete comment' });
    if (deleteOwn === undefined || deleteOther === undefined) throw new Error('expected two delete buttons');
    await user.click(deleteOwn);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'cancel' }));

    // The second confirmation is not busy and would send its own request.
    await user.click(deleteOther);
    const dialog = screen.getByRole('dialog', { name: 'Delete this comment?' });
    const confirm = within(dialog).getByRole('button', { name: 'delete' });
    expect(confirm.hasAttribute('aria-disabled')).toBe(false);

    // The first delete finishes while the second confirmation is open: nothing is said inside that dialog.
    firstDelete.answer(new Response(null, { status: 204 }));
    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
    expect(dialog.querySelector('[aria-live]')?.textContent).toBe('');
    expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('');

    // Once it closes, the deletion is announced in the region that is live again.
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));
    await vi.waitFor(() => {
      expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('Comment deleted.');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog and the comment when deleting fails', async () => {
    stubFetch(page([own]), session(), problem(403, 'not-owner', 'You can only delete comments you wrote.'));
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: 'delete comment' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this comment?' });
    await user.click(within(dialog).getByRole('button', { name: 'delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe('You can only delete comments you wrote.');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts a posted comment on top and announces it (F-28)', async () => {
    const created = comment(42, { authorName: 'Bea', body: 'I can almost hear the wind.', canDelete: true });
    stubFetch(page([marit]), session(), json(created, 201));
    const { user } = setup();

    await screen.findByRole('list');
    await user.type(screen.getByLabelText('Name (shown publicly)'), 'Bea');
    await user.type(screen.getByLabelText('Comment'), 'I can almost hear the wind.');
    await user.click(screen.getByRole('button', { name: 'post comment' }));

    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
    });
    expect(screen.getAllByRole('article')[0]?.textContent).toContain('I can almost hear the wind.');
    await vi.waitFor(() => {
      expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('Comment added.');
    });
  });
});
