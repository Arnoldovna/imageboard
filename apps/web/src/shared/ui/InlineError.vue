<script setup lang="ts">
import AppButton from './AppButton.vue';

/**
 * Inline error for a failed load or action (F-08, F-30): the message is an alert (announced when it appears), in
 * ink with a 2px error rule (colour is never the only signal), plus an optional "try again" text button.
 */
withDefaults(defineProps<{ message: string; retryable?: boolean; retryLabel?: string }>(), {
  retryable: true,
  retryLabel: 'try again',
});

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="inline-error">
    <p class="inline-error__message" role="alert">{{ message }}</p>
    <AppButton v-if="retryable" class="inline-error__retry" @click="emit('retry')">{{ retryLabel }}</AppButton>
  </div>
</template>

<style scoped src="./InlineError.css"></style>
