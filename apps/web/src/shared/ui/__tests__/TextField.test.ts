import { cleanup, render, screen } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TextField from '../TextField.vue';

function describedTexts(control: HTMLElement): string[] {
  const ids = control.getAttribute('aria-describedby')?.split(' ') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `missing #${id}`);
}

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

describe('TextField', () => {
  it('labels the input with exactly the visible label (B-66)', () => {
    render(TextField, { props: { label: 'Name (shown publicly)' } });

    const input = screen.getByLabelText('Name (shown publicly)');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('text');
  });

  it('updates the model while typing', async () => {
    const onUpdate = vi.fn<(value: string) => void>();
    render(TextField, { props: { label: 'Title', modelValue: '', 'onUpdate:modelValue': onUpdate } });

    await userEvent.type(screen.getByLabelText('Title'), 'Fog');

    expect(onUpdate).toHaveBeenLastCalledWith('Fog');
  });

  it('shows the model value', () => {
    render(TextField, { props: { label: 'Title', modelValue: 'Iris on the axis' } });

    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Iris on the axis');
  });

  it('links hint and error through aria-describedby and marks the field invalid (F-24)', () => {
    render(TextField, {
      props: { label: 'Title', hint: 'Up to 120 characters.', error: 'Enter a title.' },
    });

    const input = screen.getByLabelText('Title');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedTexts(input)).toEqual(['Enter a title.', 'Up to 120 characters.']);
  });

  it('is valid and only described by its hint without an error', () => {
    render(TextField, { props: { label: 'Title', hint: 'Up to 120 characters.', error: null } });

    const input = screen.getByLabelText('Title');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(describedTexts(input)).toEqual(['Up to 120 characters.']);
  });

  it('has no aria-describedby without hint and error', () => {
    render(TextField, { props: { label: 'Title' } });

    expect(screen.getByLabelText('Title').hasAttribute('aria-describedby')).toBe(false);
  });

  it('marks required fields visibly and for assistive technology, without changing the label', () => {
    render(TextField, { props: { label: 'Title', required: true } });

    const input = screen.getByLabelText('Title');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.hasAttribute('required')).toBe(false);
    expect(screen.getByText('required').getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a textarea for multi-line text and passes maxlength and name through', () => {
    render(TextField, {
      props: { label: 'Description (optional)', multiline: true, maxlength: 2000, name: 'description' },
    });

    const textarea = screen.getByLabelText('Description (optional)');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('maxlength')).toBe('2000');
    expect(textarea.getAttribute('name')).toBe('description');
  });

  it('exposes focus() so a form can focus its first invalid field', () => {
    const wrapper = mount(TextField, { props: { label: 'Title' }, attachTo: document.body });

    (wrapper.vm as unknown as { focus: () => void }).focus();

    expect(document.activeElement).toBe(wrapper.find('input').element);
    wrapper.unmount();
  });
});
