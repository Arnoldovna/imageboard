<script setup lang="ts">
import { computed } from 'vue';

import AppButton from './AppButton.vue';
import InlineError from './InlineError.vue';
import ModalDialog from './ModalDialog.vue';

/**
 * Confirmation for a destructive action (F-37): a narrow `ModalDialog` (stacked in the top layer above another
 * dialog when needed) with the question as its heading, one sentence of consequence, and two buttons. Focus starts
 * on "cancel", so Enter or Space right after opening never destroys anything. Esc counts as cancel.
 *
 * The owner keeps it mounted while the action runs (`busy`) and shows a failure through `error`; the dialog stays
 * open then, so the person can retry or cancel. While busy the confirm button is an AppButton in its `busy` state:
 * it was just pressed and keeps focus inside the dialog (WCAG 2.4.3), and its clicks are ignored, so a double press
 * never confirms twice.
 */
const props = withDefaults(
  defineProps<{
    /** The question, e.g. "Delete this image?" */
    title: string;
    /** The consequence, e.g. "This cannot be undone." */
    message?: string;
    confirmLabel: string;
    cancelLabel?: string;
    busy?: boolean;
    /** Label while busy, e.g. "Deleting…"; defaults to `confirmLabel`. */
    busyLabel?: string;
    error?: string | null;
  }>(),
  { message: undefined, cancelLabel: 'cancel', busyLabel: undefined, error: null },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const confirmText = computed(() => (props.busy ? (props.busyLabel ?? props.confirmLabel) : props.confirmLabel));
</script>

<template>
  <ModalDialog :title="title" size="narrow" :show-close="false" @close="emit('cancel')">
    <div class="confirm-dialog">
      <p v-if="message !== undefined" class="confirm-dialog__message">{{ message }}</p>
      <InlineError v-if="error !== null" :message="error" :retryable="false" />
      <div class="confirm-dialog__actions">
        <AppButton autofocus @click="emit('cancel')">{{ cancelLabel }}</AppButton>
        <AppButton variant="outlined" :busy="busy" @click="emit('confirm')">{{ confirmText }}</AppButton>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped src="./ConfirmDialog.css"></style>
