import { cleanup, render, screen } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import ConfirmDialog from '../ConfirmDialog.vue';

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function renderConfirm(props: Record<string, unknown> = {}) {
  return render(ConfirmDialog, {
    props: {
      title: 'Delete this image?',
      message: 'This cannot be undone.',
      confirmLabel: 'delete',
      ...props,
    },
    global: { plugins: [pinia] },
  });
}

describe('ConfirmDialog', () => {
  it('asks the question as the dialog name and states the consequence (F-37)', () => {
    renderConfirm();

    expect(screen.getByRole('dialog', { name: 'Delete this image?' })).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
  });

  it('puts the first focus on "cancel" (autofocus inside the modal dialog)', () => {
    renderConfirm();

    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('autofocus')).toBe(true);
    expect(screen.getByRole('button', { name: 'delete' }).hasAttribute('autofocus')).toBe(false);
  });

  it('emits confirm and cancel from the buttons', async () => {
    const view = renderConfirm();

    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(view.emitted('confirm')).toHaveLength(1);
    expect(view.emitted('cancel')).toHaveLength(1);
  });

  it('treats Esc as cancel', () => {
    const view = renderConfirm();

    document.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(view.emitted('cancel')).toHaveLength(1);
    expect(view.emitted('confirm')).toBeUndefined();
  });

  it('disables the confirm button while busy and shows the busy label', async () => {
    const view = renderConfirm({ busy: true, busyLabel: 'deleting…' });

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'deleting…' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'cancel' }).hasAttribute('aria-disabled')).toBe(false);

    await userEvent.click(confirm);
    expect(view.emitted('confirm')).toBeUndefined();
  });

  it('keeps focus on the confirm button while busy and after a failure (WCAG 2.4.3)', async () => {
    const view = renderConfirm();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'delete' });

    await userEvent.click(confirm);
    expect(document.activeElement).toBe(confirm);
    await view.rerender({ busy: true, busyLabel: 'deleting…' });
    expect(confirm.disabled).toBe(false);
    expect(document.activeElement).toBe(confirm);

    await view.rerender({ busy: false, error: 'Too many requests. Wait a moment and try again.' });
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows a failure as an alert and stays open for another try', () => {
    renderConfirm({ error: 'You can only delete images you uploaded.' });

    expect(screen.getByRole('alert').textContent).toBe('You can only delete images you uploaded.');
    expect(screen.queryByRole('button', { name: 'try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'delete' })).toBeTruthy();
  });
});
