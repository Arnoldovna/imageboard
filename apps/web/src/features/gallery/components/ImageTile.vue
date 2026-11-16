<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { computed, useId } from 'vue';

import { formatDate } from '../../../shared/format/date';
import { imageLocation } from '../../../shared/routing/routes';

/**
 * One gallery tile (F-03, F-09, F-55 revised, B-65, B-68): a single link to `/images/:id` holding the preview, the
 * title, the author and the date as visible text.
 *
 * - The link is named by the visible title through `aria-labelledby`, so its accessible name is exactly the title;
 *   author and date are its description. The image is `alt=""` because the title is already text in the same link
 *   (WCAG H2: no doubled name).
 * - `width`/`height` come from the stored dimensions, so the frame reserves its space (CLS, F-09). Tiles in the
 *   first row (`eager`) load at once, the rest lazily.
 * - Ids come from `useId()`, unique per instance (B-68: no repeated ids). `data-image-id` lets GallerySection
 *   focus the tile again after the detail dialog closes.
 */
const { image, eager } = defineProps<{
  image: ImageDto;
  eager?: boolean;
}>();

const titleId = useId();
const metaId = useId();
const date = computed(() => formatDate(image.createdAt));
</script>

<template>
  <RouterLink
    class="image-tile"
    :to="imageLocation(image.id)"
    :aria-labelledby="titleId"
    :aria-describedby="metaId"
    :data-image-id="image.id"
  >
    <span class="image-tile__frame">
      <img
        class="image-tile__image"
        :src="image.previewUrl"
        alt=""
        :width="image.width"
        :height="image.height"
        :loading="eager ? 'eager' : 'lazy'"
        decoding="async"
      />
    </span>
    <span class="image-tile__caption">
      <span :id="titleId" class="image-tile__title">{{ image.title }}</span>
      <!-- The explicit space keeps "Marit 21 Sep 2026" apart in the accessible description; the gap is CSS. -->
      <span :id="metaId" class="image-tile__meta">
        <span class="image-tile__author">{{ image.authorName }}</span>{{ ' '
        }}<time class="image-tile__date" :datetime="image.createdAt">{{ date }}</time>
      </span>
    </span>
  </RouterLink>
</template>

<style scoped src="./ImageTile.css"></style>
