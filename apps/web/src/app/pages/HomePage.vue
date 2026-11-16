<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { computed, useTemplateRef, watch } from 'vue';
import { useRoute } from 'vue-router';

import { GallerySection, useGalleryStore } from '../../features/gallery/index';
import { UploadPanel } from '../../features/upload/index';
import { ROUTE_NAMES } from '../../shared/routing/routes';

/**
 * `/` and its child `/images/:id`. The only place where features meet (OVERVIEW §6, ADR 0010): features emit events
 * and expose methods, HomePage applies them through the gallery store's public API. No feature imports another one
 * for this.
 *
 * - upload `uploaded(image)` → `gallery.prepend(image)` (new tile first, no reload; F-17);
 * - gallery `requestUpload` (empty state) → `uploadPanel.open()` (F-07);
 * - detail `deleted(id)` → `gallery.remove(id)` (list and scroll position stay; F-37);
 * - after the dialog has closed → `gallerySection.focusTile(id)`: the tile that opened it, or the "Gallery"
 *   heading when that tile is not loaded (deep link) or was deleted (F-15, ADR 0011).
 */
const gallery = useGalleryStore();
const route = useRoute();
const uploadPanel = useTemplateRef<InstanceType<typeof UploadPanel>>('uploadPanel');
const gallerySection = useTemplateRef<InstanceType<typeof GallerySection>>('gallerySection');

function onUploaded(image: ImageDto): void {
  gallery.prepend(image);
}

function onRequestUpload(): void {
  uploadPanel.value?.open();
}

function onImageDeleted(id: number): void {
  gallery.remove(id);
}

const openImageId = computed(() => (route.name === ROUTE_NAMES.image ? Number(route.params['id']) : null));

// `flush: 'post'` runs after the nested RouterView has unmounted the dialog, so focus lands on the page again.
watch(
  openImageId,
  (current, previous) => {
    if (current === null && previous !== null) gallerySection.value?.focusTile(previous);
  },
  { flush: 'post' },
);
</script>

<template>
  <div class="home-page">
    <UploadPanel ref="uploadPanel" @uploaded="onUploaded" />
    <GallerySection ref="gallerySection" @request-upload="onRequestUpload" />
    <RouterView v-slot="{ Component }">
      <component :is="Component" v-if="Component" @deleted="onImageDeleted" />
    </RouterView>
  </div>
</template>

<style scoped src="./HomePage.css"></style>
