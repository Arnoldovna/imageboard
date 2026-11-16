<script setup lang="ts">
import { shallowRef } from 'vue';

import { errorMessage, isApiError } from '../../../shared/api/http';
import AppButton from '../../../shared/ui/AppButton.vue';
import ConfirmDialog from '../../../shared/ui/ConfirmDialog.vue';
import InlineError from '../../../shared/ui/InlineError.vue';
import { deleteImage } from '../image-detail.api';

/**
 * Owner-only "delete image" (F-35 UI, F-37, B-56). The parent renders it only when the image's `canDelete` is true;
 * the API still checks ownership (403 `not-owner`).
 *
 * The button opens a confirmation stacked above the detail dialog, with focus on "cancel". Confirming sends
 * `DELETE /api/images/:id`; `deleted` is emitted only after the 204, so a failed delete leaves everything as it was
 * and shows the error: inside the confirmation while it is open (so the person can retry or cancel), next to the
 * button when they cancelled while the request was running.
 *
 * While the request runs, "delete image" is `busy`, not `disabled`: it is where focus returns when the person
 * cancels the confirmation meanwhile, and a natively disabled button cannot take it (WCAG 2.4.3).
 */
const { imageId } = defineProps<{ imageId: number }>();

const emit = defineEmits<{ deleted: [] }>();

const confirming = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef<string | null>(null);

function openConfirm(): void {
  error.value = null;
  confirming.value = true;
}

function cancel(): void {
  confirming.value = false;
  // An error the confirmation already showed is done with; one that arrives after cancelling shows by the button.
  if (!busy.value) error.value = null;
}

async function confirm(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await deleteImage(imageId);
    finish();
  } catch (cause) {
    // 404: the image is already gone (deleted in another tab); the outcome the person asked for holds.
    if (isApiError(cause) && cause.status === 404) {
      finish();
      return;
    }
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

function finish(): void {
  confirming.value = false;
  emit('deleted');
}
</script>

<template>
  <div class="delete-image-control">
    <AppButton class="delete-image-control__button" :busy="busy" @click="openConfirm">delete image</AppButton>
    <InlineError v-if="!confirming && error !== null" :message="error" :retryable="false" />
    <ConfirmDialog
      v-if="confirming"
      title="Delete this image?"
      message="This cannot be undone."
      confirm-label="delete"
      busy-label="deleting…"
      :busy="busy"
      :error="error"
      @confirm="confirm"
      @cancel="cancel"
    />
  </div>
</template>

<style scoped src="./DeleteImageControl.css"></style>
