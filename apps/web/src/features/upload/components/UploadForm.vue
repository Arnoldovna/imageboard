<script setup lang="ts">
import { formatMegabytes, LIMITS, type ImageDto } from '@app/shared';
import { computed, nextTick, useTemplateRef } from 'vue';

import { useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import AppButton from '../../../shared/ui/AppButton.vue';
import InlineError from '../../../shared/ui/InlineError.vue';
import TextField from '../../../shared/ui/TextField.vue';
import { ACCEPTED_IMAGE_LABEL } from '../client-file-check';
import { useUploadForm, type UploadField } from '../use-upload-form';
import FilePicker from './FilePicker.vue';

/**
 * The upload form (F-17, F-24, F-38, B-54, B-66): a real `<form>`, so Enter in a text field submits; visible labels
 * with required markers; the author field says the name is public and nothing more (B-12). Validation uses the
 * shared contract with `novalidate`, errors sit under each field, and a blocked submit moves focus to the first
 * invalid field (F-56). While uploading the submit reads "Uploading…" and is `busy`: it ignores presses (no double
 * upload) but keeps keyboard focus.
 */
const emit = defineEmits<{ uploaded: [image: ImageDto] }>();

const announcer = useAnnouncerStore();
const { fields, file, previewUrl, fieldErrors, formError, status, resetKey, maxBytes, selectFile, submit } =
  useUploadForm();

const submitting = computed(() => status.value === 'submitting');
const fileHint = computed(() => `${ACCEPTED_IMAGE_LABEL}, up to ${formatMegabytes(maxBytes.value)}.`);

const form = useTemplateRef<HTMLFormElement>('form');
const authorNameField = useTemplateRef<InstanceType<typeof TextField>>('authorNameField');
const titleField = useTemplateRef<InstanceType<typeof TextField>>('titleField');
const descriptionField = useTemplateRef<InstanceType<typeof TextField>>('descriptionField');
const filePicker = useTemplateRef<InstanceType<typeof FilePicker>>('filePicker');

function focusField(field: UploadField): void {
  const targets = {
    authorName: authorNameField.value,
    title: titleField.value,
    description: descriptionField.value,
    file: filePicker.value,
  } as const;
  targets[field]?.focus();
}

/**
 * A successful upload re-keys the file picker to empty it, and a focused input that is replaced drops focus to the
 * page. Put focus on the submit button then; anywhere else the person has moved on, so focus stays where it is.
 */
function restoreFocusToSubmit(): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  form.value?.querySelector<HTMLButtonElement>('.upload-form__submit')?.focus();
}

function onSelect(next: File | null): void {
  void selectFile(next);
}

async function onSubmit(): Promise<void> {
  const outcome = await submit();
  // Let the DOM show the result (errors rendered, submit enabled again) before moving focus.
  await nextTick();
  switch (outcome.status) {
    case 'uploaded':
      emit('uploaded', outcome.image);
      void announcer.announce('Image uploaded.');
      restoreFocusToSubmit();
      break;
    case 'invalid':
      focusField(outcome.field);
      break;
    // 'failed': the message is an alert (InlineError), so it is announced without moving focus.
    case 'failed':
    case 'busy':
    case 'cancelled':
      break;
  }
}

/** Focuses the first field (the panel calls this when it opens; the focus also scrolls the form into view). */
function focus(): void {
  focusField('authorName');
}

defineExpose({ focus });
</script>

<template>
  <form ref="form" class="upload-form" novalidate @submit.prevent="onSubmit">
    <TextField
      ref="authorNameField"
      v-model="fields.authorName"
      label="Name (shown publicly)"
      name="authorName"
      autocomplete="nickname"
      required
      :maxlength="LIMITS.authorName.max"
      :error="fieldErrors.authorName ?? null"
    />
    <TextField
      ref="titleField"
      v-model="fields.title"
      label="Title"
      name="title"
      autocomplete="off"
      required
      :maxlength="LIMITS.title.max"
      :error="fieldErrors.title ?? null"
    />
    <TextField
      ref="descriptionField"
      v-model="fields.description"
      label="Description (optional)"
      name="description"
      multiline
      autocomplete="off"
      :rows="4"
      :maxlength="LIMITS.description.max"
      :error="fieldErrors.description ?? null"
    />
    <FilePicker
      ref="filePicker"
      :key="resetKey"
      :file="file"
      :preview-url="previewUrl"
      :error="fieldErrors.file ?? null"
      :hint="fileHint"
      required
      @select="onSelect"
    />
    <InlineError v-if="formError !== null" :message="formError" :retryable="false" />
    <AppButton class="upload-form__submit" type="submit" variant="accent" :busy="submitting">
      {{ submitting ? 'Uploading…' : 'upload image' }}
    </AppButton>
  </form>
</template>

<style scoped src="./UploadForm.css"></style>
