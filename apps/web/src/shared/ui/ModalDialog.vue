<script setup lang="ts">
import { onBeforeUnmount, onMounted, useId, useTemplateRef } from 'vue';

import { useAnnouncerStore } from '../a11y/announcer.store';
import LiveAnnouncer from '../a11y/LiveAnnouncer.vue';
import { useFocusReturn } from '../a11y/use-focus-return';
import { usePublishedBlockSize } from '../dom/use-published-block-size';
import AppButton from './AppButton.vue';

/**
 * Native modal `<dialog>` (ADR 0011, maw §6 "Modal"). It opens with `showModal()` when mounted (focus moves inside,
 * the page behind becomes inert) and closes when unmounted: the owner renders it with `v-if` or as a route view.
 *
 * - Esc (`cancel`) and the "close" button emit `close`; the owner decides (navigate back, cancel a confirmation).
 *   A backdrop click does nothing, so a half-typed comment is never lost by accident.
 * - First focus: the element with `autofocus` inside the dialog, else the first focusable one ("close").
 * - Its own polite live region is registered with the announcer while open, because App.vue's region is inert
 *   behind a modal dialog (F-56, ADR 0010).
 * - On unmount focus returns to the element that was focused before opening, if it still exists.
 * - The dialog scrolls with a pinned header ("close" stays in reach). The header's height (it grows with a long
 *   title) is published on the dialog as `--modal-dialog-header-block-size`, so the dialog's scroll padding keeps
 *   focused content clear of it (WCAG 2.4.11, ModalDialog.css).
 */
const props = withDefaults(
  defineProps<{
    /** Accessible name and visible heading (`h2`). */
    title: string;
    size?: 'wide' | 'narrow';
    showClose?: boolean;
    closeLabel?: string;
    returnFocus?: boolean;
  }>(),
  { size: 'wide', showClose: true, closeLabel: 'close', returnFocus: true },
);

const emit = defineEmits<{ close: [] }>();

defineSlots<{ default(): unknown }>();

const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const header = useTemplateRef<HTMLElement>('header');
const titleId = useId();
const regionId = `dialog-${useId()}`;
const announcer = useAnnouncerStore();
const focusReturn = useFocusReturn();
let unmounting = false;

onMounted(() => {
  focusReturn.capture();
  announcer.pushRegion(regionId);
  dialog.value?.showModal();
});

// Registered after the hook above, so the header is measured once the dialog is open (a closed dialog has no size).
usePublishedBlockSize(header, '--modal-dialog-header-block-size', dialog);

onBeforeUnmount(() => {
  unmounting = true;
  announcer.removeRegion(regionId);
  if (dialog.value?.open === true) dialog.value.close();
  if (props.returnFocus) focusReturn.restore();
});

function onCancel(event: Event): void {
  // Browsers may force-close after repeated Esc presses without user activation (close watcher rules); then the
  // event is not cancelable and `onClose` reports it instead, so `close` is emitted once either way.
  if (!event.cancelable) return;
  event.preventDefault();
  emit('close');
}

function onClose(): void {
  if (!unmounting) emit('close');
}
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-dialog"
    :class="{ 'modal-dialog--narrow': size === 'narrow' }"
    :aria-labelledby="titleId"
    aria-modal="true"
    @cancel="onCancel"
    @close="onClose"
  >
    <div ref="header" class="modal-dialog__header">
      <h2 :id="titleId" class="modal-dialog__title">{{ title }}</h2>
      <AppButton v-if="showClose" class="modal-dialog__close" @click="emit('close')">{{ closeLabel }}</AppButton>
    </div>
    <div class="modal-dialog__body">
      <slot />
    </div>
    <LiveAnnouncer :region="regionId" />
  </dialog>
</template>

<style scoped src="./ModalDialog.css"></style>
