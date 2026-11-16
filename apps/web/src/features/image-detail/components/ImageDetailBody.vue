<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { computed } from 'vue';

import { formatDateTime } from '../../../shared/format/date';

/**
 * The content of a loaded image (F-11): the large original, the description and who posted it when. The title is
 * the dialog's own `h2` (F-54), so it is not repeated here.
 *
 * - The image's `alt` is its title (F-55); `width`/`height` reserve its space before it loads (no layout jump).
 * - The description is plain text; CSS `white-space: pre-line` keeps its line breaks (never `v-html`).
 * - The date is a `<time datetime>` in the viewer's time zone, "15 Nov 2026, 14:03" (F-14, B-60).
 * - The name is whatever the uploader typed; the wording never suggests a verified identity (F-38).
 */
const { image } = defineProps<{ image: ImageDto }>();

const slots = defineSlots<{ actions?(): unknown }>();

const postedAt = computed(() => formatDateTime(image.createdAt));
</script>

<template>
  <div class="image-detail-body">
    <div class="image-detail-body__frame">
      <img
        class="image-detail-body__image"
        :src="image.url"
        :alt="image.title"
        :width="image.width"
        :height="image.height"
        decoding="async"
      />
    </div>
    <div class="image-detail-body__text">
      <p v-if="image.description !== ''" class="image-detail-body__description">{{ image.description }}</p>
      <p class="image-detail-body__meta">
        Posted by {{ image.authorName }} on <time :datetime="image.createdAt">{{ postedAt }}</time>
      </p>
      <div v-if="slots.actions !== undefined" class="image-detail-body__actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./ImageDetailBody.css"></style>
