<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { nextTick, shallowRef, useId, useTemplateRef } from 'vue';

/**
 * SCAFFOLD PLACEHOLDER (ADR 0017): final contract and layout, no form yet. The upload module (BUILD-ORDER 3.4)
 * replaces the body with the real form, keeping:
 * - the one-row sticky bar on every width with `<h2><button aria-expanded aria-controls>Upload an image</button></h2>`
 *   (APG disclosure in a heading); the body is a sibling in normal page flow below the bar (ADR 0012, F-57);
 * - the root `display: contents` (UploadPanel.css), so the bar sticks within HomePage's container, which spans the
 *   whole gallery, not just this panel;
 * - emit `uploaded(image)` after a `201` (HomePage prepends it to the gallery);
 * - exposed `open()`: expands the form and focuses its first field (the gallery's empty-state button calls it).
 */
defineEmits<{ uploaded: [image: ImageDto] }>();

const expanded = shallowRef(false);
const bodyId = useId();
const body = useTemplateRef<HTMLElement>('body');

function open(): void {
  expanded.value = true;
  void nextTick(() => {
    body.value?.focus();
  });
}

defineExpose({ open });
</script>

<template>
  <div class="upload-panel">
    <div class="upload-panel__bar">
      <h2 class="upload-panel__heading">
        <button
          type="button"
          class="upload-panel__toggle"
          :aria-expanded="expanded ? 'true' : 'false'"
          :aria-controls="bodyId"
          @click="expanded = !expanded"
        >
          Upload an image
        </button>
      </h2>
    </div>
    <div v-show="expanded" :id="bodyId" ref="body" class="upload-panel__body" tabindex="-1">
      <p class="upload-panel__note">Uploading is not available yet.</p>
    </div>
  </div>
</template>

<style scoped src="./UploadPanel.css"></style>
