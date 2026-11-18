import { cleanup, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import App from '../App.vue';
import { MAW_STUDIO_IMPRINT_URL, PROFILE_LINKS } from '../layout/profile-links';
import { createAppRouter } from '../router';
import { stubApi } from './fake-api';

async function renderApp(path = '/') {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const result = render(App, { global: { plugins: [createPinia(), router] } });
  return { ...result, router };
}

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('renders the wordmark as the only h1, linking to the gallery (F-54, F-59)', async () => {
    await renderApp();

    const [heading, ...others] = screen.getAllByRole('heading', { level: 1 });
    expect(others).toHaveLength(0);
    if (heading === undefined) throw new Error('no h1');
    expect(heading.textContent.trim()).toBe('imageboard');
    const brand = within(heading).getByRole('link', { name: 'imageboard' });
    expect(brand.getAttribute('href')).toBe('/');
    expect(brand.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('form/vue')).toBeTruthy();
  });

  it('puts the routed page inside the main landmark, with the h2 outline of the gallery page (F-54)', async () => {
    await renderApp();

    const main = screen.getByRole('main');
    const sectionHeadings = within(main)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent.trim());
    expect(sectionHeadings).toEqual(['Upload an image', 'Gallery']);
  });

  it('links the footer to the GitHub and LinkedIn profiles with their names as text (F-58)', async () => {
    await renderApp();

    const footer = screen.getByRole('contentinfo');
    const github = within(footer).getByRole('link', { name: 'GitHub' });
    const linkedin = within(footer).getByRole('link', { name: 'LinkedIn' });
    expect(github.getAttribute('href')).toBe(PROFILE_LINKS.github);
    expect(linkedin.getAttribute('href')).toBe(PROFILE_LINKS.linkedin);
    for (const link of [github, linkedin]) {
      expect(link.getAttribute('rel')).toBe('me');
      expect(link.hasAttribute('target')).toBe(false);
    }
  });

  it('links the footer to the maw-studio imprint as a plain https link (PLAN Etappe 3b)', async () => {
    await renderApp();

    const imprint = within(screen.getByRole('contentinfo')).getByRole('link', { name: 'imprint' });
    expect(imprint.getAttribute('href')).toBe(MAW_STUDIO_IMPRINT_URL);
    expect(new URL(MAW_STUDIO_IMPRINT_URL).protocol).toBe('https:');
    expect(imprint.hasAttribute('rel')).toBe(false);
  });

  it('shows no live-demo banner outside the demo build', async () => {
    await renderApp();

    expect(screen.queryByRole('complementary', { name: 'Live demo' })).toBeNull();
  });

  it('starts with a skip link that moves focus to main without adding a # to the URL', async () => {
    const { router } = await renderApp();
    const skip = screen.getByRole('link', { name: 'skip to content' });
    const firstLink = screen.getAllByRole('link')[0];
    expect(firstLink).toBe(skip);

    await userEvent.click(skip);

    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(router.currentRoute.value.fullPath).toBe('/');
  });

  it('has an app-level polite live region outside main (F-56)', async () => {
    const { container } = await renderApp();

    const regions = [...container.querySelectorAll('[aria-live="polite"]')];
    expect(regions).toHaveLength(1);
    expect(regions.some((region) => screen.getByRole('main').contains(region))).toBe(false);
  });

  it('shows the not-found page with a way back for unknown paths', async () => {
    await renderApp('/images/abc');

    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 2, name: 'Page not found' })).toBeTruthy();
    expect(within(main).getByRole('link', { name: 'back to the gallery' }).getAttribute('href')).toBe('/');
  });
});
