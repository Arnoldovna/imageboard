// @vitest-environment node
import { ImagePage } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import { DEMO_DB_NAME, openDemoStore } from '../demo-store';
import { demoHarness, json, pngFile, SEED, SEED_OWNER_ID, uploadForm } from './demo-fixtures';

const fields = { authorName: 'Kofi', title: 'Harbour at dusk' };

describe('demo store (IndexedDB)', () => {
  it('seeds an empty database once, owned by the seed owner, with ids in upload order', async () => {
    const { store } = await demoHarness();

    const images = await store.images();
    expect(images.map((image) => image.id)).toEqual([3, 2, 1]);
    expect(images.every((image) => image.ownerId === SEED_OWNER_ID)).toBe(true);
    expect((await store.comments(1)).map((comment) => comment.id)).toEqual([2, 1]);
    expect(await store.state()).toEqual({ ownerId: 'visitor-1', nextImageId: 4, nextCommentId: 3 });
  });

  it('keeps uploads, comments and the visitor identity across a reload of the page', async () => {
    const first = await demoHarness();
    await first.mutate('POST', '/api/images', { body: uploadForm(fields, pngFile()) });
    await first.mutate('POST', '/api/images/1/comments', json({ authorName: 'Bea', body: 'Again.' }));
    first.store.close();

    // Same browser profile (same IndexedDB), new page: no second seed, the upload is still the visitor's.
    const reloaded = await demoHarness({ factory: first.factory });
    const page = ImagePage.parse(await (await reloaded.call('GET', '/api/images')).json());
    expect(page.items.map((image) => [image.id, image.canDelete])).toEqual([
      [4, true],
      [3, false],
      [2, false],
      [1, false],
    ]);
    expect((await reloaded.store.comments(1)).map((comment) => comment.body)).toEqual([
      'Again.',
      'Exactly what I needed on a Monday.',
      'Worth the early bus.',
    ]);
    expect((await reloaded.store.state()).ownerId).toBe('visitor-1');
  });

  it('reset removes everything the visitor added and restores the seed with a new identity', async () => {
    const { store, mutate } = await demoHarness();
    await mutate('POST', '/api/images', { body: uploadForm(fields, pngFile()) });
    await mutate('POST', '/api/images/2/comments', json({ authorName: 'Bea', body: 'Hi' }));

    await store.reset();

    expect((await store.images()).map((image) => image.title)).toEqual(
      SEED.images.map((image) => image.title).reverse(),
    );
    expect(await store.file(4)).toBeUndefined();
    expect(await store.comments(2)).toEqual([]);
    expect(await store.state()).toEqual({ ownerId: 'visitor-2', nextImageId: 4, nextCommentId: 3 });
  });

  it('refuses a comment on an image that no longer exists and leaves nothing behind', async () => {
    const { store } = await demoHarness();

    await expect(
      store.insertComment({
        imageId: 99,
        ownerId: 'x',
        authorName: 'Bea',
        body: 'Hi',
        createdAt: '2026-11-18T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ name: 'MissingImageError' });
    expect((await store.state()).nextCommentId).toBe(3);
  });

  it('seeds an empty seed without failing', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const store = await openDemoStore({
      seed: { ownerId: SEED_OWNER_ID, images: [] },
      factory: new IDBFactory(),
      newOwnerId: () => 'v',
    });

    expect(await store.images()).toEqual([]);
    expect(await store.state()).toEqual({ ownerId: 'v', nextImageId: 1, nextCommentId: 1 });
  });

  it('closes and reports its connection when another tab opens a newer schema version', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const factory = new IDBFactory();
    const onClosedByNewerVersion = vi.fn();
    await openDemoStore({ seed: SEED, factory, onClosedByNewerVersion });

    const upgrade = factory.open(DEMO_DB_NAME, 2);
    await new Promise<void>((resolve, reject) => {
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
      upgrade.onerror = () => {
        reject(upgrade.error ?? new Error('upgrade failed'));
      };
    });

    expect(onClosedByNewerVersion).toHaveBeenCalledTimes(1);
  });
});
