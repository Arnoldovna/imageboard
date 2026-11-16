import { cleanup, render, screen } from '@testing-library/vue';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import { APP_REGION, useAnnouncerStore } from '../announcer.store';
import LiveAnnouncer from '../LiveAnnouncer.vue';

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

describe('useAnnouncerStore', () => {
  it('announces into the app region while no dialog is open', async () => {
    const announcer = useAnnouncerStore();

    await announcer.announce('Image uploaded.');

    expect(announcer.activeRegion).toBe(APP_REGION);
    expect(announcer.messageFor(APP_REGION)).toBe('Image uploaded.');
  });

  it('routes messages to the top-most open dialog and falls back when it closes (F-56)', async () => {
    const announcer = useAnnouncerStore();
    announcer.pushRegion('dialog-detail');
    announcer.pushRegion('dialog-confirm');

    await announcer.announce('Deleting…');
    expect(announcer.messageFor('dialog-confirm')).toBe('Deleting…');
    expect(announcer.messageFor('dialog-detail')).toBe('');

    announcer.removeRegion('dialog-confirm');
    await announcer.announce('Comment added.');
    expect(announcer.messageFor('dialog-detail')).toBe('Comment added.');
    expect(announcer.messageFor('dialog-confirm')).toBe('');

    announcer.removeRegion('dialog-detail');
    await announcer.announce('Image deleted.');
    expect(announcer.messageFor(APP_REGION)).toBe('Image deleted.');
  });

  it('F-56: a message whose dialog closes before it is written reaches the region that is active then', async () => {
    const announcer = useAnnouncerStore();
    announcer.pushRegion('dialog-detail');

    const pending = announcer.announce('Image deleted.');
    announcer.removeRegion('dialog-detail');
    await pending;

    expect(announcer.messageFor(APP_REGION)).toBe('Image deleted.');
    expect(announcer.messageFor('dialog-detail')).toBe('');
  });

  it('pushing a region again moves it to the top instead of duplicating it', () => {
    const announcer = useAnnouncerStore();
    announcer.pushRegion('a');
    announcer.pushRegion('b');
    announcer.pushRegion('a');

    expect(announcer.activeRegion).toBe('a');
    announcer.removeRegion('a');
    expect(announcer.activeRegion).toBe('b');
  });
});

describe('LiveAnnouncer', () => {
  it('renders a polite atomic region that empties before repeating the same message', async () => {
    render(LiveAnnouncer, { global: { plugins: [pinia] } });
    const announcer = useAnnouncerStore();
    const region = screen.getByText((_, element) => element?.getAttribute('aria-live') === 'polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');

    await announcer.announce('Comment deleted.');
    await nextTick();
    expect(region.textContent).toBe('Comment deleted.');

    const repeated = announcer.announce('Comment deleted.');
    await nextTick();
    expect(region.textContent).toBe('');
    await repeated;
    await nextTick();
    expect(region.textContent).toBe('Comment deleted.');
  });

  it('shows only the messages of its own region', async () => {
    render(LiveAnnouncer, { props: { region: 'dialog-x' }, global: { plugins: [pinia] } });
    const announcer = useAnnouncerStore();

    await announcer.announce('For the app region.');
    await nextTick();
    expect(screen.queryByText('For the app region.')).toBeNull();

    announcer.pushRegion('dialog-x');
    await announcer.announce('For the dialog.');
    await nextTick();
    expect(screen.getByText('For the dialog.').getAttribute('aria-live')).toBe('polite');
  });
});
