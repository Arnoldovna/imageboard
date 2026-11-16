<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { computed, useId } from 'vue';

import { formatDate } from '../../../shared/format/date';
import { imageLocation } from '../../../shared/routing/routes';

/**
 * One gallery tile (F-03, F-09, F-55 revised, B-65, B-68): a single link to `/images/:id` holding the preview and the
 * title, with the author and the date as visible text right below it.
 *
 * - The link contains only the preview (`alt=""`) and the title, so its accessible name is exactly the title and its
 *   visible text is part of that name (WCAG 2.5.3 Label in Name). The image is `alt=""` because the title is already
 *   text in the same link (WCAG H2: no doubled name).
 * - Author and date sit outside the link and describe it through `aria-describedby`. The link's stretched
 *   pseudo-element (ImageTile.css) keeps the whole tile one click target.
 * - `width`/`height` come from the stored dimensions, so the frame reserves its space (CLS, F-09). Tiles in the
 *   first row (`eager`) load at once, the rest lazily.
 * - Ids come from `useId()`, unique per instance (B-68: no repeated ids). `data-image-id` lets GallerySection
 *   focus the tile link again after the detail dialog closes.
 */
const { image, eager } = defineProps<{
  image: ImageDto;
  eager?: boolean;
}>();

const metaId = useId();
const date = computed(() => formatDate(image.createdAt));
</script>

<template>
  <div class="image-tile">
    <RouterLink
      class="image-tile__link"
      :to="imageLocation(image.id)"
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
      <span class="image-tile__title">{{ image.title }}</span>
    </RouterLink>
    <!-- The explicit space keeps "Marit 21 Sep 2026" apart in the accessible description; the gap is CSS. -->
    <p :id="metaId" class="image-tile__meta">
      <span class="image-tile__author">{{ image.authorName }}</span>{{ ' '
      }}<time class="image-tile__date" :datetime="image.createdAt">{{ date }}</time>
    </p>
  </div>
</template>

<style scoped src="./ImageTile.css"></style>
