<script setup lang="ts">
import { onMounted, useId, useTemplateRef } from 'vue';

import { imageLocation } from '../../../shared/routing/routes';
import AppButton from '../../../shared/ui/AppButton.vue';
import { useGalleryStore } from '../gallery.store';

/**
 * SCAFFOLD PLACEHOLDER (ADR 0017): final contract, minimal body. The gallery module (BUILD-ORDER 3.1) replaces the
 * markup with the grid, skeleton, "load more", empty state and inline error, keeping:
 * - `h2` "Gallery" with `tabindex="-1"` (focus target after a deep-linked dialog closes);
 * - emit `requestUpload` (empty-state button; HomePage opens the upload form);
 * - exposed `focusTile(id)`: focuses the tile link of that image, else the "Gallery" heading.
 */
const emit = defineEmits<{ requestUpload: [] }>();

const gallery = useGalleryStore();
const headingId = useId();
const section = useTemplateRef<HTMLElement>('section');
const heading = useTemplateRef<HTMLHeadingElement>('heading');

function focusTile(id: number): void {
  const tile = section.value?.querySelector<HTMLElement>(`[data-image-id="${String(id)}"]`);
  if (tile) tile.focus();
  else heading.value?.focus();
}

defineExpose({ focusTile });

onMounted(() => {
  void gallery.loadFirst();
});
</script>

<template>
  <section ref="section" class="gallery-section" :aria-labelledby="headingId">
    <h2 :id="headingId" ref="heading" class="gallery-section__heading" tabindex="-1">Gallery</h2>
    <ul v-if="gallery.items.length > 0" class="gallery-section__list">
      <li v-for="image in gallery.items" :key="image.id" class="gallery-section__item">
        <RouterLink class="gallery-section__link" :to="imageLocation(image.id)" :data-image-id="image.id">
          {{ image.title }}
        </RouterLink>
      </li>
    </ul>
    <div v-else class="gallery-section__placeholder">
      <p class="gallery-section__note">The gallery cannot be shown yet.</p>
      <AppButton @click="emit('requestUpload')">upload an image</AppButton>
    </div>
  </section>
</template>

<style scoped src="./GallerySection.css"></style>
