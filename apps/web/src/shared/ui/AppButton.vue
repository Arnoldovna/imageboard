<script setup lang="ts">
/**
 * The one button of the app (maw §6): `text` (A, underlined, default), `outlined` (B) and `accent` (B + accent fill,
 * at most once per view: the upload submit). Labels are lowercase and start with a verb ("load more", "delete
 * image"). Native attributes (`disabled`, `autofocus`, `aria-*`) fall through to the `<button>`.
 */
export type AppButtonVariant = 'text' | 'outlined' | 'accent';

const { variant = 'text', type = 'button' } = defineProps<{
  variant?: AppButtonVariant;
  type?: 'button' | 'submit' | 'reset';
}>();

defineSlots<{ default(): unknown }>();
</script>

<template>
  <button
    class="app-button"
    :class="{ 'app-button--outlined': variant === 'outlined', 'app-button--accent': variant === 'accent' }"
    :type="type"
  >
    <slot />
  </button>
</template>

<style scoped src="./AppButton.css"></style>
