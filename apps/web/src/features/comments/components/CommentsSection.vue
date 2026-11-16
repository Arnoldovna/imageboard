<script setup lang="ts">
import { useId } from 'vue';

/**
 * SCAFFOLD PLACEHOLDER (ADR 0017): final props, minimal body. The comments module (BUILD-ORDER 3.3) replaces it with
 * the list, "show older comments" and the form, keeping the `h3` "Comments" inside the image dialog (F-54).
 * Announcements go through the announcer store, which routes them into the open dialog's live region.
 */
defineProps<{ imageId: number }>();

const headingId = useId();
</script>

<template>
  <section class="comments-section" :aria-labelledby="headingId">
    <h3 :id="headingId" class="comments-section__heading">Comments</h3>
    <p class="comments-section__note">Comments cannot be shown yet.</p>
  </section>
</template>

<style scoped src="./CommentsSection.css"></style>
