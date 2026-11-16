<script setup lang="ts">
import { LIMITS } from '@app/shared';

/**
 * Loading state of the first gallery page (F-06, B-57): `aria-busy` plus a plain "Loading images…" line that every
 * user can read, and one static surface block per expected tile (no shimmer, maw §8). Frame and caption match
 * ImageTile (same grid, aspect ratio, line heights), so the real tiles replace them without a jump (F-09). The blocks
 * are decorative and hidden from assistive technology.
 */
const tiles = LIMITS.imagesPage.default;
</script>

<template>
  <div class="gallery-skeleton" aria-busy="true">
    <p class="gallery-skeleton__label">Loading images…</p>
    <ul class="gallery-skeleton__grid" aria-hidden="true">
      <li v-for="tile in tiles" :key="tile" class="gallery-skeleton__tile">
        <span class="gallery-skeleton__frame"></span>
        <span class="gallery-skeleton__caption">
          <span class="gallery-skeleton__title"></span>
          <span class="gallery-skeleton__meta"></span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped src="./GallerySkeleton.css"></style>
