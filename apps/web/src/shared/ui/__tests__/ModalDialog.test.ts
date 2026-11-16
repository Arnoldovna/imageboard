import { cleanup, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { useAnnouncerStore } from '../../a11y/announcer.store';
import ModalDialog from '../ModalDialog.vue';

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function renderDialog(props: Record<string, unknown> = {}) {
  return render(ModalDialog, {
    props: { title: 'Rooftops from the fifth floor', ...props },
    slots: { default: '<p>New flat, no lift.</p>' },
    global: { plugins: [pinia] },
  });
}

function dialogElement(): HTMLDialogElement {
  const dialog = document.querySelector('dialog');
  if (dialog === null) throw new Error('no <dialog> rendered');
  return dialog;
}

describe('ModalDialog', () => {
  it('opens as a native modal dialog on mount, named by its heading (F-15)', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');

    renderDialog();

    expect(showModal).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'Rooftops from the fifth floor' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Rooftops from the fifth floor');
    expect(within(dialog).getByText('New flat, no lift.')).toBeTruthy();
  });

  it('emits close from the "close" button', async () => {
    const view = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(view.emitted('close')).toHaveLength(1);
  });

  it('turns Esc (cancel) into a close request and keeps the dialog open for the owner to decide', () => {
    const view = renderDialog();
    const cancel = new Event('cancel', { cancelable: true });

    dialogElement().dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(dialogElement().open).toBe(true);
    expect(view.emitted('close')).toHaveLength(1);
  });

  it('emits close once when the browser force-closes it (cancel not cancelable)', () => {
    const view = renderDialog();

    dialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
    dialogElement().close();

    expect(view.emitted('close')).toHaveLength(1);
  });

  it('can hide the close button (a confirmation has its own cancel)', () => {
    renderDialog({ showClose: false });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('closes on unmount without emitting and returns focus to the element focused before', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Rooftops from the fifth floor';
    document.body.append(opener);
    opener.focus();
    const view = renderDialog();
    const dialog = dialogElement();
    screen.getByRole('button', { name: 'close' }).focus();

    view.unmount();

    expect(dialog.open).toBe(false);
    expect(view.emitted('close')).toBeUndefined();
    expect(document.activeElement).toBe(opener);
  });

  it('does not move focus back when asked not to (the owner focuses something else)', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = renderDialog({ returnFocus: false });
    screen.getByRole('button', { name: 'close' }).focus();

    view.unmount();

    expect(document.activeElement).not.toBe(opener);
  });

  it('owns a live region inside the dialog that receives announcements while open (F-56)', async () => {
    const view = renderDialog();
    const announcer = useAnnouncerStore();

    await announcer.announce('Comment added.');
    await nextTick();

    const region = within(dialogElement()).getByText('Comment added.');
    expect(region.getAttribute('aria-live')).toBe('polite');

    view.unmount();
    expect(announcer.activeRegion).toBe('app');
  });
});
