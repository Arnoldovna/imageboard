import type { CommentDto, CreateCommentBody } from '@app/shared';
import { cleanup, render, screen } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CommentForm from '../components/CommentForm.vue';
import type { CommentSendResult } from '../use-comments';

type Send = (input: CreateCommentBody) => Promise<CommentSendResult>;

const created: CommentDto = {
  id: 42,
  imageId: 6,
  authorName: 'Kofi',
  body: 'Where does it go?',
  createdAt: '2026-11-16T09:12:00.000Z',
  canDelete: true,
};

const NAME = 'Name (shown publicly)';
const COMMENT = 'Comment';

function setup(send: Send = vi.fn<Send>().mockResolvedValue({ ok: true, comment: created })) {
  const user = userEvent.setup();
  render(CommentForm, { props: { send } });
  return {
    user,
    send,
    name: screen.getByLabelText<HTMLInputElement>(NAME),
    body: screen.getByLabelText<HTMLTextAreaElement>(COMMENT),
    submit: () => screen.getByRole<HTMLButtonElement>('button', { name: /post/ }),
  };
}

/** A send that waits until the test answers it. */
function deferredSend() {
  let answer: (result: CommentSendResult) => void = () => undefined;
  const send = vi.fn<Send>(
    () =>
      new Promise<CommentSendResult>((resolve) => {
        answer = resolve;
      }),
  );
  return {
    send,
    answer: (result: CommentSendResult) => {
      answer(result);
    },
  };
}

function describedTexts(control: HTMLElement): string[] {
  const ids = control.getAttribute('aria-describedby')?.split(' ') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `missing #${id}`);
}

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

describe('CommentForm: structure (B-66, F-38)', () => {
  it('is a real form with Name first, then Comment, both labelled, required and length-limited', () => {
    const { name, body } = setup();

    const form = name.closest('form');
    expect(form).not.toBeNull();
    expect(form?.contains(body)).toBe(true);
    // Name comes before Comment in reading and tab order (B-55).
    expect(name.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.getAttribute('maxlength')).toBe('60');
    expect(body.tagName).toBe('TEXTAREA');
    expect(body.getAttribute('maxlength')).toBe('1000');
    expect(name.getAttribute('aria-required')).toBe('true');
    expect(body.getAttribute('aria-required')).toBe('true');
  });

  it('labels its submit button "post comment" (B-74)', () => {
    const { submit } = setup();

    expect(submit().textContent.trim()).toBe('post comment');
    expect(submit().getAttribute('type')).toBe('submit');
  });
});

describe('CommentForm: client check (F-29)', () => {
  it('shows both messages inline, focuses Name and sends nothing when the form is empty', async () => {
    const { user, send, name, body, submit } = setup();

    await user.click(submit());

    expect(send).not.toHaveBeenCalled();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(describedTexts(name)).toEqual(['Enter a name.']);
    expect(describedTexts(body)).toEqual(['Write a comment.']);
    expect(document.activeElement).toBe(name);
  });

  it('treats a name of only spaces as empty and focuses the first invalid field', async () => {
    const { user, send, name, body, submit } = setup();

    await user.type(name, '   ');
    await user.type(body, 'Which beach is this?');
    await user.click(submit());

    expect(send).not.toHaveBeenCalled();
    expect(describedTexts(name)).toEqual(['Enter a name.']);
    expect(body.hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(name);
  });

  it('moves focus to Comment when only the comment is missing', async () => {
    const { user, name, body, submit } = setup();

    await user.type(name, 'Kofi');
    await user.click(submit());

    expect(name.hasAttribute('aria-invalid')).toBe(false);
    expect(describedTexts(body)).toEqual(['Write a comment.']);
    expect(document.activeElement).toBe(body);
  });
});

describe('CommentForm: sending (F-33)', () => {
  it('sends the trimmed values when Enter is pressed in the name field', async () => {
    const { user, send, name, body } = setup();

    await user.type(body, '  Where does it go?  ');
    await user.type(name, ' Kofi {Enter}');

    expect(send).toHaveBeenCalledExactlyOnceWith({ authorName: 'Kofi', body: 'Where does it go?' });
  });

  it('marks the submit button busy and reads "posting…" while sending, so a second click posts nothing', async () => {
    const { send, answer } = deferredSend();
    const { user, name, body, submit } = setup(send);

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());

    expect(submit().getAttribute('aria-disabled')).toBe('true');
    expect(submit().textContent.trim()).toBe('posting…');
    // Busy, not natively disabled: the pressed button keeps keyboard focus (WCAG 2.4.3).
    expect(submit().disabled).toBe(false);
    expect(document.activeElement).toBe(submit());
    await user.click(submit());
    await user.type(name, '{Enter}');
    expect(send).toHaveBeenCalledTimes(1);

    answer({ ok: true, comment: created });
    await vi.waitFor(() => {
      expect(submit().hasAttribute('aria-disabled')).toBe(false);
    });
    expect(submit().textContent.trim()).toBe('post comment');
  });

  it('keeps text typed while the post was running and empties only what was sent', async () => {
    const { send, answer } = deferredSend();
    const { user, name, body, submit } = setup(send);

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());
    await user.clear(body);
    await user.type(body, 'And who took it?');

    answer({ ok: true, comment: created });
    await vi.waitFor(() => {
      expect(name.value).toBe('');
    });
    expect(body.value).toBe('And who took it?');
  });

  it('resets both fields after a successful post', async () => {
    const { user, name, body, submit } = setup();

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());

    await vi.waitFor(() => {
      expect(name.value).toBe('');
    });
    expect(body.value).toBe('');
    expect(name.hasAttribute('aria-invalid')).toBe(false);
  });

  it('keeps the values and shows a server field error inline, focusing that field', async () => {
    const send = vi.fn<Send>().mockResolvedValue({
      ok: false,
      message: 'The request contains invalid data.',
      fieldErrors: { body: 'Comment contains characters that are not allowed.' },
    });
    const { user, name, body, submit } = setup(send);

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());

    await vi.waitFor(() => {
      expect(describedTexts(body)).toEqual(['Comment contains characters that are not allowed.']);
    });
    expect(name.value).toBe('Kofi');
    expect(body.value).toBe('Where does it go?');
    expect(document.activeElement).toBe(body);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the values and shows a request failure as an alert', async () => {
    const send = vi.fn<Send>().mockResolvedValue({
      ok: false,
      message: 'Too many requests. Wait a moment and try again.',
      fieldErrors: {},
    });
    const { user, name, body, submit } = setup(send);

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many requests. Wait a moment and try again.');
    expect(name.value).toBe('Kofi');
    expect(body.value).toBe('Where does it go?');
    expect(submit().hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(submit());
  });

  it('clears an earlier failure message when the next post succeeds', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({ ok: false, message: 'Image was not found.', fieldErrors: {} })
      .mockResolvedValueOnce({ ok: true, comment: created });
    const { user, name, body, submit } = setup(send);

    await user.type(name, 'Kofi');
    await user.type(body, 'Where does it go?');
    await user.click(submit());
    await screen.findByRole('alert');
    await user.click(submit());

    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(body.value).toBe('');
  });
});
