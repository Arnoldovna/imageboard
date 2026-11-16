<script setup lang="ts">
import { computed, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

import { useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import { useDocumentTitle } from '../../../shared/dom/use-document-title';
import { leaveToHome, ROUTE_NAMES } from '../../../shared/routing/routes';
import InlineError from '../../../shared/ui/InlineError.vue';
import ModalDialog from '../../../shared/ui/ModalDialog.vue';
import { CommentsSection } from '../../comments/index';
import { useImageDetail } from '../use-image-detail';
import DeleteImageControl from './DeleteImageControl.vue';
import ImageDetailBody from './ImageDetailBody.vue';

/**
 * Route component of `/images/:id`, a child of `/` rendered by HomePage's nested RouterView, so the gallery stays
 * mounted behind it (ADR 0011, F-11, F-12). Contract (ADR 0017):
 * - prop `id`: the route param as a number;
 * - emit `deleted(id)` after a successful delete, before the dialog closes itself (HomePage removes the tile);
 * - closing (the "close" button, Esc, the not-found link) goes through `leaveToHome`, so it agrees with browser
 *   Back and never adds a history entry; Back itself unmounts the dialog.
 *
 * States (B-49): loading, ready, not found (404, or an id the API cannot know) and error with "try again". The
 * dialog heading is the image title once loaded (F-54), the document title "<image title> · Imageboard" or
 * "Image not found · Imageboard" (F-53). Comments load only for an image that exists.
 */
const { id } = defineProps<{ id: number }>();

const emit = defineEmits<{ deleted: [id: number] }>();

const router = useRouter();
const announcer = useAnnouncerStore();
const { state, image, retry } = useImageDetail(() => id);

const heading = computed(() => {
  switch (state.value.status) {
    case 'loading':
      return 'Loading image…';
    case 'ready':
      return state.value.image.title;
    case 'notFound':
      return 'Image not found';
    case 'error':
      return 'Image could not be loaded';
  }
});

useDocumentTitle(() => {
  if (state.value.status === 'ready') return state.value.image.title;
  return state.value.status === 'notFound' ? 'Image not found' : null;
});

let leaving = false;
let wasDeleted = false;

function close(): void {
  // Esc and a click can arrive before the route has changed; a second `router.back()` would leave the app.
  if (leaving) return;
  leaving = true;
  void leaveToHome(router);
}

/**
 * The not-found link closes like the "close" button. A modified or non-primary click (new tab or window) is left to
 * the browser, as RouterLink itself does, so it opens the gallery elsewhere instead of navigating this tab.
 */
function onBackClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  close();
}

function onDeleted(): void {
  wasDeleted = true;
  emit('deleted', id);
  close();
}

// Announced after the dialog has gone: its own live region is removed with it, and the app region behind it is
// live again (F-37, F-56). Focus is moved by HomePage (the tile is gone, so the "Gallery" heading).
onUnmounted(() => {
  if (wasDeleted) void announcer.announce('Image deleted.');
});
</script>

<template>
  <ModalDialog :title="heading" @close="close">
    <!-- The heading says "Loading image…"; the surface block holds the image's place (maw feedback pattern). -->
    <div v-if="state.status === 'loading'" class="image-detail-dialog__loading" aria-busy="true">
      <div class="image-detail-dialog__placeholder" />
    </div>

    <div v-else-if="state.status === 'notFound'" class="image-detail-dialog__missing">
      <p class="image-detail-dialog__note">This image does not exist or has been deleted.</p>
      <RouterLink v-slot="{ href }" :to="{ name: ROUTE_NAMES.home }" custom>
        <a class="image-detail-dialog__back" :href="href" @click="onBackClick">
          <span class="image-detail-dialog__arrow" aria-hidden="true">←</span>back to the gallery
        </a>
      </RouterLink>
    </div>

    <InlineError v-else-if="state.status === 'error'" :message="state.message" @retry="retry" />

    <div v-else-if="image !== null" class="image-detail-dialog__content">
      <ImageDetailBody :image="image">
        <template v-if="image.canDelete" #actions>
          <DeleteImageControl :image-id="image.id" @deleted="onDeleted" />
        </template>
      </ImageDetailBody>
      <CommentsSection :image-id="image.id" />
    </div>
  </ModalDialog>
</template>

<style scoped src="./ImageDetailDialog.css"></style>
