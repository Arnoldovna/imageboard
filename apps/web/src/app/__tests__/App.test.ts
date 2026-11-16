import { render, screen, within } from '@testing-library/vue';
import { describe, expect, it } from 'vitest';

import App from '../App.vue';

describe('App', () => {
  it('renders the wordmark as the page heading inside the main landmark', () => {
    render(App);

    const heading = within(screen.getByRole('main')).getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('imageboard');
  });
});
