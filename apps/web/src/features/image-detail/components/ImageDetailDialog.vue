<script setup lang="ts">
import { useRouter } from 'vue-router';

import { useDocumentTitle } from '../../../shared/dom/use-document-title';
import { leaveToHome } from '../../../shared/routing/routes';
import ModalDialog from '../../../shared/ui/ModalDialog.vue';
import { CommentsSection } from '../../comments/index';

/**
 * SCAFFOLD PLACEHOLDER (ADR 0017): final contract, minimal body. Route component of `/images/:id` (a child of `/`,
 * rendered by HomePage's nested RouterView). The image-detail module (BUILD-ORDER 3.2) adds loading, not-found and
 * error states, the image, description, meta and the owner-only delete, keeping:
 * - prop `id` (the route param as a number; out-of-range ids get a 400 from the API, shown as "Image not found");
 * - emit `deleted(id)` after a successful delete, before the dialog closes itself (HomePage removes the tile);
 * - closing through `leaveToHome` (close button and Esc; browser Back closes it naturally, ADR 0011);
 * - the document title through `useDocumentTitle` ("<image title> · Imageboard" once loaded).
 */
defineProps<{ id: number }>();

defineEmits<{ deleted: [id: number] }>();

const router = useRouter();

useDocumentTitle(null);

function close(): void {
  void leaveToHome(router);
}
</script>

<template>
  <ModalDialog title="Image details" @close="close">
    <div class="image-detail-dialog">
      <p class="image-detail-dialog__note">Image {{ id }} cannot be shown yet.</p>
      <CommentsSection :image-id="id" />
    </div>
  </ModalDialog>
</template>

<style scoped src="./ImageDetailDialog.css"></style>
