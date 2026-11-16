<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { computed, nextTick, useId, useTemplateRef } from 'vue';

import { useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import AppButton from '../../../shared/ui/AppButton.vue';
import EmptyState from '../../../shared/ui/EmptyState.vue';
import InlineError from '../../../shared/ui/InlineError.vue';
import { useGalleryStore } from '../gallery.store';
import GallerySkeleton from './GallerySkeleton.vue';
import ImageTile from './ImageTile.vue';

/**
 * The gallery (F-01, F-03 to F-10, B-46, B-47, B-57): `h2` "Gallery", the tile grid newest first, "load more" while
 * `nextCursor` is set, and the loading, empty and error states. Contract (ADR 0017):
 * - `h2` "Gallery" with `tabindex="-1"` (focus target after a deep-linked dialog closes);
 * - emit `requestUpload` from the empty state (HomePage opens the upload form, F-07);
 * - exposed `focusTile(id)`: focuses the tile link of that image, else the "Gallery" heading.
 *
 * Focus never drops to the page: "load more" stays focusable while in flight (AppButton `busy`, a native `disabled`
 * button would lose focus), and when the control it was on goes away (last page, error, retry) focus moves to the
 * next sensible place: the first new tile, the "try again" button or the heading.
 */
const emit = defineEmits<{ requestUpload: [] }>();

/** First row at four columns loads at once; everything below loads lazily (F-09). */
const EAGER_TILES = 4;

const gallery = useGalleryStore();
const announcer = useAnnouncerStore();
const headingId = useId();
const section = useTemplateRef<HTMLElement>('section');
const heading = useTemplateRef<HTMLHeadingElement>('heading');
const more = useTemplateRef<HTMLElement>('more');

const isFirstLoading = computed(() => gallery.status === 'loading' && gallery.items.length === 0);
const isEmpty = computed(() => gallery.status === 'ready' && gallery.items.length === 0 && gallery.nextCursor === null);
const firstError = computed(() =>
  gallery.status === 'error' ? `The gallery could not be loaded. ${gallery.error?.detail ?? ''}`.trim() : null,
);
const moreError = computed(() =>
  gallery.status === 'ready' && gallery.moreStatus === 'error'
    ? `More images could not be loaded. ${gallery.error?.detail ?? ''}`.trim()
    : null,
);
const hasMore = computed(() => gallery.status === 'ready' && gallery.nextCursor !== null);
const isLoadingMore = computed(() => gallery.moreStatus === 'loading');

function focusTile(id: number): void {
  const tile = section.value?.querySelector<HTMLElement>(`[data-image-id="${String(id)}"]`);
  if (tile) tile.focus();
  else heading.value?.focus();
}

defineExpose({ focusTile });

/** True when focus is inside the "load more" area or was dropped to the page (its control was removed). */
function focusIsInMore(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (more.value?.contains(active) ?? false);
}

function focusMoreControl(): void {
  more.value?.querySelector<HTMLElement>('button')?.focus();
}

function loadedMessage(count: number, isLast: boolean): string {
  const loaded = count === 1 ? '1 more image loaded.' : `${String(count)} more images loaded.`;
  if (!isLast) return loaded;
  return count === 0 ? 'All images are shown.' : `${loaded} All images are shown.`;
}

/**
 * The tiles a page appended: everything after the last tile that was already loaded. An upload that finished while
 * the page was in flight is prepended on top (F-17); it is neither counted nor focused as an "older" image.
 */
function appendedSince(before: ReadonlySet<number>): readonly ImageDto[] {
  const lastKnown = gallery.items.findLastIndex((item) => before.has(item.id));
  return gallery.items.slice(lastKnown + 1).filter((item) => !before.has(item.id));
}

/** Runs a "load more" (or its retry), then announces the result and keeps keyboard focus in a sensible place. */
async function runMore(load: () => Promise<void>): Promise<void> {
  const keepFocus = focusIsInMore();
  const before: ReadonlySet<number> = new Set(gallery.items.map((item) => item.id));
  const pending = load();
  if (keepFocus) {
    // A retry replaces "try again" with the busy "load more" button: keep focus on that control.
    await nextTick();
    focusMoreControl();
  }
  await pending;
  await nextTick();

  if (gallery.moreStatus === 'error') {
    if (keepFocus && focusIsInMore()) focusMoreControl();
    return;
  }
  const added = appendedSince(before);
  const isLast = gallery.nextCursor === null;
  void announcer.announce(loadedMessage(added.length, isLast));
  if (isLast && keepFocus && focusIsInMore()) {
    const first = added[0];
    if (first === undefined) heading.value?.focus();
    else focusTile(first.id);
  }
}

function onLoadMore(): void {
  void runMore(() => gallery.loadMore());
}

function onRetryMore(): void {
  void runMore(() => gallery.retry());
}

function onRetryFirst(): void {
  // "try again" disappears while the page loads; the heading is the stable place to continue from.
  heading.value?.focus();
  void gallery.retry();
}

// Started during setup, not in onMounted, so the very first render already shows the skeleton (F-06).
void gallery.loadFirst();
</script>

<template>
  <section ref="section" class="gallery-section" :aria-labelledby="headingId">
    <h2 :id="headingId" ref="heading" class="gallery-section__heading" tabindex="-1">Gallery</h2>

    <GallerySkeleton v-if="isFirstLoading" />

    <InlineError v-if="firstError !== null" :message="firstError" @retry="onRetryFirst" />

    <EmptyState v-if="isEmpty" title="No images yet." text="Be the first to upload one.">
      <template #action>
        <AppButton @click="emit('requestUpload')">upload an image</AppButton>
      </template>
    </EmptyState>

    <ul v-if="gallery.items.length > 0" class="gallery-section__grid">
      <li v-for="(image, index) in gallery.items" :key="image.id" class="gallery-section__item">
        <ImageTile :image="image" :eager="index < EAGER_TILES" />
      </li>
    </ul>

    <div v-if="hasMore" ref="more" class="gallery-section__more">
      <InlineError v-if="moreError !== null" :message="moreError" @retry="onRetryMore" />
      <AppButton v-else variant="outlined" :busy="isLoadingMore" @click="onLoadMore">
        {{ isLoadingMore ? 'loading…' : 'load more' }}
      </AppButton>
    </div>
  </section>
</template>

<style scoped src="./GallerySection.css"></style>
