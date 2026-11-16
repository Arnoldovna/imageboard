<script setup lang="ts">
/**
 * The one button of the app (maw §6): `text` (A, underlined, default), `outlined` (B) and `accent` (B + accent fill,
 * at most once per view: the upload submit). Labels are lowercase and start with a verb ("load more", "delete
 * image"). Native attributes (`disabled`, `autofocus`, `aria-*`) fall through to the `<button>`.
 *
 * `busy` is the state of a button whose action is running ("loading…", "posting…", "deleting…"). It renders
 * `aria-disabled="true"` instead of `disabled` and swallows clicks (a submit button then does not submit either): a
 * natively disabled button loses keyboard focus, which would drop it to the page while the request runs (WCAG
 * 2.4.3), and a double press never runs the action twice. Use native `disabled` only for an action that is
 * unavailable, not for one that is in progress.
 */
export type AppButtonVariant = 'text' | 'outlined' | 'accent';

const {
  variant = 'text',
  type = 'button',
  busy,
} = defineProps<{
  variant?: AppButtonVariant;
  type?: 'button' | 'submit' | 'reset';
  /** Boolean prop: Vue casts an absent value to `false`. */
  busy?: boolean;
}>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();

defineSlots<{ default(): unknown }>();

function onClick(event: MouseEvent): void {
  if (busy) {
    event.preventDefault();
    return;
  }
  emit('click', event);
}
</script>

<template>
  <button
    class="app-button"
    :class="{ 'app-button--outlined': variant === 'outlined', 'app-button--accent': variant === 'accent' }"
    :type="type"
    :aria-disabled="busy ? 'true' : undefined"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<style scoped src="./AppButton.css"></style>
