import { cleanup, render, screen } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DemoBanner from '../components/DemoBanner.vue';
import { resetDemo } from '../start-demo';

vi.mock('../start-demo', () => ({ resetDemo: vi.fn() }));

afterEach(() => {
  cleanup();
});

describe('DemoBanner', () => {
  it('says in German that the data stays in this browser, as a labelled landmark', () => {
    render(DemoBanner);

    const banner = screen.getByRole('complementary', { name: 'Live demo' });
    const text = screen.getByText('Demo – Daten bleiben nur in deinem Browser');
    expect(banner.contains(text)).toBe(true);
    expect(text.getAttribute('lang')).toBe('de');
  });

  it('resets the demo once, even when pressed twice while the reset runs', async () => {
    let finish: () => void = () => undefined;
    vi.mocked(resetDemo).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(DemoBanner);

    const button = screen.getByRole('button', { name: 'reset demo' });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(resetDemo).toHaveBeenCalledTimes(1);
    expect(button.textContent.trim()).toBe('resetting…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    finish();
  });

  it('tells the visitor when the reset failed and lets them try again', async () => {
    vi.mocked(resetDemo).mockRejectedValue(new Error('IndexedDB unavailable'));
    render(DemoBanner);

    await userEvent.click(screen.getByRole('button', { name: 'reset demo' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The demo could not be reset.');
    expect(screen.getByRole('button', { name: 'reset demo' }).hasAttribute('aria-disabled')).toBe(false);
  });
});
