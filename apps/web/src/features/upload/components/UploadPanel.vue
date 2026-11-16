<script setup lang="ts">
import type { ImageDto } from '@app/shared';
import { nextTick, shallowRef, useId, useTemplateRef } from 'vue';

import UploadForm from './UploadForm.vue';

/**
 * The upload panel (ADR 0012, F-57): a one-row sticky bar on every width with
 * `<h2><button aria-expanded aria-controls>Upload an image</button></h2>` (APG disclosure in a heading, so heading
 * outline and button stay one element), and the form as a sibling in normal page flow below it, collapsed by default.
 *
 * Opening moves focus to the Name field. That also scrolls the form into view, which matters because the bar is
 * sticky: someone deep in the gallery opens a form that sits at the top of the page. Collapsing keeps the entered
 * values (`v-show`), and an upload that is already running finishes.
 *
 * The root is `display: contents` (UploadPanel.css), so the bar sticks within HomePage's container, which spans the
 * whole gallery. Emits `uploaded(image)` after a `201`; HomePage prepends it to the gallery.
 */
const emit = defineEmits<{ uploaded: [image: ImageDto] }>();

const expanded = shallowRef(false);
const bodyId = useId();
const form = useTemplateRef<InstanceType<typeof UploadForm>>('form');

/** Expands the form and focuses its first field (also called by the gallery's empty state through HomePage). */
function open(): void {
  expanded.value = true;
  void nextTick(() => {
    form.value?.focus();
  });
}

function toggle(): void {
  if (expanded.value) expanded.value = false;
  else open();
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
          @click="toggle"
        >
          Upload an image
        </button>
      </h2>
    </div>
    <div v-show="expanded" :id="bodyId" class="upload-panel__body">
      <UploadForm ref="form" @uploaded="emit('uploaded', $event)" />
    </div>
  </div>
</template>

<style scoped src="./UploadPanel.css"></style>
