<script setup lang="ts">
import { computed, useId, useTemplateRef } from 'vue';

import { formatBytes } from '../../../shared/format/bytes';
import { ACCEPTED_IMAGE_TYPES } from '../client-file-check';

/**
 * Image picker (F-24, B-67). The native `<input type="file">` stays in the tab order and the accessibility tree: it
 * is only visually hidden inside its `<label>`, which carries the visible field label and a button-like "choose an
 * image". The input is named by both through `aria-labelledby` ("Image choose an image": the visible words are in the
 * name for voice control, WCAG 2.5.3, and the "required" marker is not). Keyboard users tab to the input and open the
 * system picker with Space or Enter; the label shows the focus ring through `:has(:focus-visible)` (ADR 0012). The
 * chosen file appears as name, size and preview.
 *
 * Stateless about the file: the parent passes the chosen `file` and its `previewUrl` and empties the native input
 * by re-keying this component after a successful upload.
 */
const {
  file = null,
  previewUrl = null,
  error = null,
  hint,
  required,
} = defineProps<{
  file?: File | null;
  /** Object URL owned (and revoked) by the parent; absent while the file is checked or when it failed. */
  previewUrl?: string | null;
  error?: string | null;
  hint: string;
  /** Boolean prop: Vue casts an absent value to `false`. */
  required?: boolean;
}>();

const emit = defineEmits<{ select: [file: File | null] }>();

const id = useId();
const labelId = `${id}-label`;
const buttonId = `${id}-button`;
const hintId = `${id}-hint`;
const selectionId = `${id}-selection`;
const errorId = `${id}-error`;

const hasError = computed(() => error !== null && error !== '');
const describedBy = computed(() =>
  [hasError.value ? errorId : null, file === null ? null : selectionId, hintId]
    .filter((value) => value !== null)
    .join(' '),
);
const buttonLabel = computed(() => (file === null ? 'choose an image' : 'choose another image'));
const selectionText = computed(() => (file === null ? '' : `${file.name}, ${formatBytes(file.size)}`));

const input = useTemplateRef<HTMLInputElement>('input');

function onChange(): void {
  // Cancelling the system picker empties the selection in some browsers; mirror what the input holds.
  emit('select', input.value?.files?.[0] ?? null);
}

/** Moves focus to the input (the form focuses the first invalid field after a failed submit). */
function focus(): void {
  input.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div class="file-picker">
    <label class="file-picker__control">
      <span class="file-picker__label-row">
        <span :id="labelId" class="file-picker__label">Image</span>
        <span v-if="required" class="file-picker__marker" aria-hidden="true">required</span>
      </span>
      <input
        ref="input"
        class="visually-hidden"
        type="file"
        name="file"
        :accept="ACCEPTED_IMAGE_TYPES"
        :required="required"
        :aria-labelledby="`${labelId} ${buttonId}`"
        :aria-invalid="hasError ? 'true' : undefined"
        :aria-describedby="describedBy"
        @change="onChange"
      />
      <span :id="buttonId" class="file-picker__button">{{ buttonLabel }}</span>
    </label>
    <p :id="hintId" class="file-picker__hint">{{ hint }}</p>
    <div v-if="file !== null" class="file-picker__selection">
      <!-- Decorative: the file name next to it is the text alternative. -->
      <img v-if="previewUrl !== null" class="file-picker__preview" :src="previewUrl" alt="" />
      <p :id="selectionId" class="file-picker__file-name">{{ selectionText }}</p>
    </div>
    <p v-if="hasError" :id="errorId" class="file-picker__error">{{ error }}</p>
  </div>
</template>

<style scoped src="./FilePicker.css"></style>
