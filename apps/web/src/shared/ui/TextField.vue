<script setup lang="ts">
import { computed, useId, useTemplateRef } from 'vue';

/**
 * Labelled text input or textarea (F-24, F-33, B-66): visible label above, optional hint, inline error linked
 * through `aria-describedby` and `aria-invalid`. Required fields show a visible "required" marker next to the
 * label and set `aria-required`; the label text itself stays exactly `label`, so it is also the accessible name.
 * Forms use `novalidate` and the shared Zod schema instead of native validation bubbles.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    name?: string;
    multiline?: boolean;
    type?: 'text' | 'search' | 'email' | 'url';
    rows?: number;
    hint?: string;
    /** Message shown below the field; also marks it invalid. */
    error?: string | null;
    maxlength?: number;
    required?: boolean;
    autocomplete?: string;
  }>(),
  {
    name: undefined,
    type: 'text',
    rows: 4,
    hint: undefined,
    error: null,
    maxlength: undefined,
    autocomplete: undefined,
  },
);

const model = defineModel<string>({ default: '' });

const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;
const hasError = computed(() => props.error !== null && props.error !== '');
const describedBy = computed(() => {
  const ids = [hasError.value ? errorId : null, props.hint === undefined ? null : hintId].filter(
    (value) => value !== null,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
});

const control = useTemplateRef<HTMLInputElement | HTMLTextAreaElement>('control');

/** Moves focus into the field (forms focus the first invalid field after a failed submit). */
function focus(): void {
  control.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div class="text-field">
    <div class="text-field__label-row">
      <label class="text-field__label" :for="id">{{ label }}</label>
      <span v-if="required" class="text-field__marker" aria-hidden="true">required</span>
    </div>
    <textarea
      v-if="props.multiline"
      :id="id"
      ref="control"
      v-model="model"
      class="text-field__input text-field__input--multiline"
      :name="name"
      :rows="rows"
      :maxlength="maxlength"
      :autocomplete="autocomplete"
      :aria-required="props.required ? 'true' : undefined"
      :aria-invalid="hasError ? 'true' : undefined"
      :aria-describedby="describedBy"
    ></textarea>
    <input
      v-else
      :id="id"
      ref="control"
      v-model="model"
      class="text-field__input"
      :type="type"
      :name="name"
      :maxlength="maxlength"
      :autocomplete="autocomplete"
      :aria-required="props.required ? 'true' : undefined"
      :aria-invalid="hasError ? 'true' : undefined"
      :aria-describedby="describedBy"
    />
    <p v-if="hint !== undefined" :id="hintId" class="text-field__hint">{{ hint }}</p>
    <p v-if="hasError" :id="errorId" class="text-field__error">{{ error }}</p>
  </div>
</template>

<style scoped src="./TextField.css"></style>
