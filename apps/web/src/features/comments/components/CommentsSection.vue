<script setup lang="ts">
import type { CommentDto, CreateCommentBody } from '@app/shared';
import { computed, nextTick, shallowRef, useId, useTemplateRef, watch } from 'vue';

import { useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import AppButton from '../../../shared/ui/AppButton.vue';
import ConfirmDialog from '../../../shared/ui/ConfirmDialog.vue';
import InlineError from '../../../shared/ui/InlineError.vue';
import { useComments, type CommentSendResult } from '../use-comments';
import CommentForm from './CommentForm.vue';
import CommentItem from './CommentItem.vue';

/**
 * Comments of one image inside the detail dialog (F-26 to F-33): the `h3` "Comments" under the dialog's `h2` image
 * title (F-54, B-70), the form, then the list newest first as an `<ol>` of `<article>`s with loading, empty and
 * error states (F-30). "show older comments" appears only while an older page exists (F-31). Deleting asks for
 * confirmation in a stacked dialog; afterwards focus moves to the heading, because the button that had it is gone.
 *
 * Public contract (ADR 0017): prop `imageId`. Status changes are announced here through the announcer store, which
 * routes them into the top-most open dialog's live region (F-56). "Comment deleted." is announced only after the
 * confirmation dialog has closed: written into that dialog's region, it would vanish with it.
 */
const { imageId } = defineProps<{ imageId: number }>();

const { items, nextCursor, status, moreStatus, error, loadMore, retry, add, remove } = useComments(() => imageId);
const announcer = useAnnouncerStore();

const headingId = useId();
const section = useTemplateRef<HTMLElement>('section');
const heading = useTemplateRef<HTMLHeadingElement>('heading');
const content = useTemplateRef<HTMLDivElement>('content');
const list = useTemplateRef<HTMLOListElement>('list');
const more = useTemplateRef<HTMLDivElement>('more');

const loadingMore = computed(() => moreStatus.value === 'loading');
const showMore = computed(() => nextCursor.value !== null || moreStatus.value === 'error');

/**
 * After an action whose control was removed ("try again", the last "show older comments", a deleted comment), focus
 * would fall back to the page. Moves it to the first candidate that exists, else to the heading.
 */
async function keepFocus(candidates: () => readonly (HTMLElement | null | undefined)[]): Promise<void> {
  await nextTick();
  if (section.value === null || section.value.contains(document.activeElement)) return;
  const target = candidates().find((element) => element !== null && element !== undefined) ?? heading.value;
  target?.focus();
}

/**
 * "try again" gives way to the loading text, so the heading holds focus while the page loads. A renewed failure
 * shows a new "try again", and focus continues there.
 */
async function retryFirst(): Promise<void> {
  const pending = retry();
  await keepFocus(() => []);
  await pending;
  if (status.value !== 'error' || document.activeElement !== heading.value) return;
  await nextTick();
  content.value?.querySelector<HTMLElement>('button')?.focus();
}

async function send(input: CreateCommentBody): Promise<CommentSendResult> {
  const result = await add(input);
  if (result.ok) void announcer.announce('Comment added.');
  return result;
}

function olderLoadedMessage(count: number): string {
  return count === 1 ? '1 older comment loaded.' : `${String(count)} older comments loaded.`;
}

/**
 * Loads the next older page and announces it. "show older comments" is `busy` meanwhile and keeps focus; a retry's
 * "try again" gives way to that busy button, so focus moves onto it. When the button goes away afterwards (no older
 * page left) focus continues at the first older comment, after a failure at the new "try again".
 */
async function showOlder(): Promise<void> {
  const pending = loadMore();
  await keepFocus(() => [more.value?.querySelector('button')]);
  const added = await pending;
  if (added !== null) void announcer.announce(olderLoadedMessage(added.length));
  const first = added?.[0];
  await keepFocus(() => [
    first === undefined ? null : list.value?.querySelector<HTMLElement>(`[data-comment-id="${String(first.id)}"]`),
    more.value?.querySelector('button'),
  ]);
}

const pendingDelete = shallowRef<CommentDto | null>(null);
/**
 * Comments whose delete request is running. Tracked per comment: someone may cancel one confirmation while its
 * request runs and open another comment's, which must not show "deleting…" or ignore its confirm.
 */
const deletingIds = shallowRef<ReadonlySet<number>>(new Set());
const deleteError = shallowRef<string | null>(null);
const deletingPending = computed(() => pendingDelete.value !== null && deletingIds.value.has(pendingDelete.value.id));
/** A delete that finished while another comment's confirmation was open; announced once that one has closed. */
let announceDeletedOnClose = false;

function setDeleting(id: number, running: boolean): void {
  const next = new Set(deletingIds.value);
  if (running) next.add(id);
  else next.delete(id);
  deletingIds.value = next;
}

// `flush: 'post'`: after the confirmation and its live region have gone, so the message reaches the active region.
watch(
  pendingDelete,
  (comment) => {
    if (comment !== null || !announceDeletedOnClose) return;
    announceDeletedOnClose = false;
    void announcer.announce('Comment deleted.');
  },
  { flush: 'post' },
);

function askDelete(comment: CommentDto): void {
  pendingDelete.value = comment;
  deleteError.value = null;
}

function cancelDelete(): void {
  pendingDelete.value = null;
  deleteError.value = null;
}

async function confirmDelete(): Promise<void> {
  const comment = pendingDelete.value;
  if (comment === null || deletingIds.value.has(comment.id)) return;
  setDeleting(comment.id, true);
  deleteError.value = null;
  const result = await remove(comment.id);
  setDeleting(comment.id, false);
  // The person may have cancelled while the request ran; a failure then needs no message, a success still does.
  const stillAsking = pendingDelete.value?.id === comment.id;
  if (!result.ok) {
    if (stillAsking) deleteError.value = result.message;
    return;
  }
  if (stillAsking) pendingDelete.value = null;
  // The comment and its button are gone; the heading is the stable place to continue from.
  await keepFocus(() => []);
  if (pendingDelete.value === null) void announcer.announce('Comment deleted.');
  else announceDeletedOnClose = true;
}
</script>

<template>
  <section ref="section" class="comments-section" :aria-labelledby="headingId">
    <h3 :id="headingId" ref="heading" class="comments-section__heading" tabindex="-1">Comments</h3>

    <CommentForm :key="imageId" :send="send" />

    <div ref="content" class="comments-section__content" :aria-busy="status === 'loading' ? 'true' : undefined">
      <p v-if="status === 'loading'" class="comments-section__status">Loading comments…</p>
      <InlineError v-else-if="status === 'error'" :message="error ?? ''" @retry="retryFirst" />
      <InlineError v-else-if="status === 'notFound'" :message="error ?? ''" :retryable="false" />
      <template v-else>
        <p v-if="items.length === 0" class="comments-section__status">No comments yet. Start the conversation.</p>
        <ol v-else ref="list" class="comments-section__list">
          <li v-for="comment in items" :key="comment.id" class="comments-section__entry">
            <CommentItem :comment="comment" @delete="askDelete" />
          </li>
        </ol>
        <div v-if="showMore" ref="more" class="comments-section__more">
          <InlineError v-if="moreStatus === 'error'" :message="error ?? ''" @retry="showOlder" />
          <AppButton v-else :busy="loadingMore" @click="showOlder">{{
            loadingMore ? 'loading…' : 'show older comments'
          }}</AppButton>
        </div>
      </template>
    </div>

    <ConfirmDialog
      v-if="pendingDelete !== null"
      title="Delete this comment?"
      message="This cannot be undone."
      confirm-label="delete"
      busy-label="deleting…"
      :busy="deletingPending"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped src="./CommentsSection.css"></style>
