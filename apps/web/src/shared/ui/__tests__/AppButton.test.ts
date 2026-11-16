import { cleanup, render, screen } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import AppButton from '../AppButton.vue';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** A form with a text field and one AppButton submit, to check `busy` against real form submission. */
const SubmitForm = defineComponent({
  props: { busy: { type: Boolean, default: false } },
  emits: { submit: () => true },
  setup(props, { emit }) {
    return () =>
      h(
        'form',
        {
          onSubmit: (event: Event) => {
            event.preventDefault();
            emit('submit');
          },
        },
        [
          h('input', { 'aria-label': 'Name' }),
          h(AppButton, { type: 'submit', busy: props.busy }, { default: () => 'send' }),
        ],
      );
  },
});

describe('AppButton', () => {
  it('passes clicks on and is neither disabled nor aria-disabled by default', async () => {
    const onClick = vi.fn();
    render(AppButton, { props: { onClick }, slots: { default: 'load more' } });

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'load more' });
    await userEvent.click(button);

    expect(onClick).toHaveBeenCalledOnce();
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('while busy is aria-disabled, keeps focus and swallows clicks (WCAG 2.4.3)', async () => {
    const onClick = vi.fn();
    const view = render(AppButton, { props: { onClick }, slots: { default: 'load more' } });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'load more' });

    await userEvent.click(button);
    await view.rerender({ onClick, busy: true });

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    await userEvent.click(button);
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not submit its form while busy', async () => {
    const view = render(SubmitForm);
    const button = screen.getByRole('button', { name: 'send' });

    await userEvent.click(button);
    expect(view.emitted('submit')).toHaveLength(1);

    await view.rerender({ busy: true });
    await userEvent.click(button);
    expect(view.emitted('submit')).toHaveLength(1);
  });
});
