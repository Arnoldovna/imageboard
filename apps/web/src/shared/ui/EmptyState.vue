<script setup lang="ts">
/**
 * maw empty state: a left-aligned sentence in large type, one line of muted text, one action. The title is a
 * paragraph, not a heading: it sits under the section's own heading and is large only for emphasis (F-54, B-70).
 */
defineProps<{
  title: string;
  text?: string;
}>();

const slots = defineSlots<{ action?(): unknown }>();
</script>

<template>
  <div class="empty-state">
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="text !== undefined" class="empty-state__text">{{ text }}</p>
    <div v-if="slots.action !== undefined" class="empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped src="./EmptyState.css"></style>
