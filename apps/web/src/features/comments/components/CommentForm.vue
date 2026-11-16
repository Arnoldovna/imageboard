<script setup lang="ts">
import { CreateCommentBody, LIMITS } from '@app/shared';
import { nextTick, shallowRef, useTemplateRef, type ShallowRef } from 'vue';

import AppButton from '../../../shared/ui/AppButton.vue';
import InlineError from '../../../shared/ui/InlineError.vue';
import TextField from '../../../shared/ui/TextField.vue';
import type { CommentSendResult } from '../use-comments';

/**
 * The comment form (F-28, F-33, B-55, B-66): a real `<form>` (Enter in the name field submits), Name first, then
 * Comment, both labelled and length-limited. Values are checked with the shared schema before sending, so the
 * messages match the API's (F-29). While sending the submit button is `busy` and reads "posting…": it ignores
 * presses (no double post) but keeps focus. On success the form resets the values it sent; text typed while the
 * request ran is kept, never silently dropped. On failure it keeps every value, shows the errors inline and moves
 * focus to the first invalid field (F-56).
 *
 * The owner passes `send`, which posts and resolves with the outcome (it never rejects).
 */
const { send } = defineProps<{ send: (input: CreateCommentBody) => Promise<CommentSendResult> }>();

type CommentField = 'authorName' | 'body';
type FieldErrors = Partial<Record<CommentField, string>>;

/** Fields in form order: the first invalid one gets focus. */
const FIELDS: readonly CommentField[] = ['authorName', 'body'];

const authorName = shallowRef('');
const body = shallowRef('');
const fieldErrors = shallowRef<FieldErrors>({});
const formError = shallowRef<string | null>(null);
const sending = shallowRef(false);

const authorNameField = useTemplateRef<InstanceType<typeof TextField>>('authorNameField');
const bodyField = useTemplateRef<InstanceType<typeof TextField>>('bodyField');

function isCommentField(field: PropertyKey | undefined): field is CommentField {
  return field === 'authorName' || field === 'body';
}

/** First message per field, from the client check or from the API's `errors[]`. */
function pickFieldErrors(entries: Iterable<readonly [PropertyKey | undefined, string]>): FieldErrors {
  const result: FieldErrors = {};
  for (const [field, message] of entries) {
    if (isCommentField(field)) result[field] ??= message;
  }
  return result;
}

async function focusFirstInvalid(): Promise<void> {
  await nextTick();
  const first = FIELDS.find((field) => fieldErrors.value[field] !== undefined);
  if (first === 'authorName') authorNameField.value?.focus();
  else if (first === 'body') bodyField.value?.focus();
}

/** Empties a field after a successful post unless it was edited while the post ran. */
function clearIfUnchanged(field: ShallowRef<string>, sent: string): void {
  if (field.value === sent) field.value = '';
}

async function onSubmit(): Promise<void> {
  if (sending.value) return;
  formError.value = null;

  const typed = { authorName: authorName.value, body: body.value };
  const parsed = CreateCommentBody.safeParse(typed);
  if (!parsed.success) {
    fieldErrors.value = pickFieldErrors(parsed.error.issues.map((issue) => [issue.path[0], issue.message] as const));
    await focusFirstInvalid();
    return;
  }

  fieldErrors.value = {};
  sending.value = true;
  const result = await send(parsed.data);
  sending.value = false;

  if (result.ok) {
    clearIfUnchanged(authorName, typed.authorName);
    clearIfUnchanged(body, typed.body);
    return;
  }

  fieldErrors.value = pickFieldErrors(Object.entries(result.fieldErrors));
  if (Object.keys(fieldErrors.value).length > 0) {
    await focusFirstInvalid();
    return;
  }
  formError.value = result.message;
}
</script>

<template>
  <form class="comment-form" novalidate @submit.prevent="onSubmit">
    <TextField
      ref="authorNameField"
      v-model="authorName"
      label="Name (shown publicly)"
      name="authorName"
      autocomplete="nickname"
      required
      :maxlength="LIMITS.authorName.max"
      :error="fieldErrors.authorName ?? null"
    />
    <TextField
      ref="bodyField"
      v-model="body"
      label="Comment"
      name="body"
      autocomplete="off"
      multiline
      required
      :rows="3"
      :maxlength="LIMITS.commentBody.max"
      :error="fieldErrors.body ?? null"
    />
    <InlineError v-if="formError !== null" :message="formError" :retryable="false" />
    <div class="comment-form__actions">
      <AppButton type="submit" variant="outlined" :busy="sending">{{
        sending ? 'posting…' : 'post comment'
      }}</AppButton>
    </div>
  </form>
</template>

<style scoped src="./CommentForm.css"></style>
