import type { CommentDto, CreateCommentBody } from '@app/shared';
import { onScopeDispose, shallowReadonly, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';

import { errorMessage, isAbortError, isApiError } from '../../shared/api/http';
import { createComment, deleteComment, listComments } from './comments.api';

/** First page: `loading` → `ready` | `notFound` (the image is gone) | `error` (F-30). */
export type CommentsStatus = 'loading' | 'ready' | 'notFound' | 'error';
/** "Show older comments": independent of `status`, so loaded comments stay visible while a page loads or fails. */
export type CommentsMoreStatus = 'idle' | 'loading' | 'error';

/** Outcome of posting a comment. The form keeps its values on failure and shows the messages inline (F-33). */
export type CommentSendResult =
  { ok: true; comment: CommentDto } | { ok: false; message: string; fieldErrors: Readonly<Record<string, string>> };

export type CommentDeleteResult = { ok: true } | { ok: false; message: string };

/**
 * Comments of the open image (OVERVIEW §8.1, ADR 0010): scoped to the dialog, reset and re-fetched when the image id
 * changes. The previous request is aborted then, so a slow answer for another image never lands in this list (B-48).
 *
 * The list is newest first (F-27). A posted comment goes on top without a reload (F-28); "show older comments"
 * appends the next keyset page (F-31). This composable owns data and requests only; announcements and focus belong
 * to the UI (`CommentsSection`), which knows when a confirmation dialog and its live region have closed (F-56).
 */
export function useComments(imageId: MaybeRefOrGetter<number>) {
  const items = shallowRef<readonly CommentDto[]>([]);
  /** Cursor of the next older page; `null` hides "show older comments" (B-45). */
  const nextCursor = shallowRef<string | null>(null);
  const status = shallowRef<CommentsStatus>('loading');
  const moreStatus = shallowRef<CommentsMoreStatus>('idle');
  /** User-facing message behind `status` `notFound`/`error` or `moreStatus` `error`. */
  const error = shallowRef<string | null>(null);

  /** The one read in flight (first page or older page). Any newer read or an id change aborts it. */
  let reading: AbortController | null = null;

  function startRead(): AbortController {
    reading?.abort();
    reading = new AbortController();
    return reading;
  }

  function finishRead(controller: AbortController): void {
    if (reading === controller) reading = null;
  }

  async function loadFirst(): Promise<void> {
    const controller = startRead();
    const id = toValue(imageId);
    items.value = [];
    nextCursor.value = null;
    status.value = 'loading';
    moreStatus.value = 'idle';
    error.value = null;
    try {
      const page = await listComments(id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // The form is usable while this page loads. A comment posted meanwhile is already in `items` and may be
      // newer than the page's snapshot, so it stays on top instead of being overwritten (F-28).
      const loaded = new Set(page.items.map((comment) => comment.id));
      items.value = [...items.value.filter((comment) => !loaded.has(comment.id)), ...page.items];
      nextCursor.value = page.nextCursor;
      status.value = 'ready';
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      status.value = isApiError(cause) && cause.code === 'not-found' ? 'notFound' : 'error';
      error.value = errorMessage(cause);
    } finally {
      finishRead(controller);
    }
  }

  /**
   * Appends the next older page. Resolves with the comments it added, or `null` when no page was loaded (nothing
   * older, already loading, failed or aborted).
   */
  async function loadMore(): Promise<readonly CommentDto[] | null> {
    const cursor = nextCursor.value;
    if (status.value !== 'ready' || cursor === null || moreStatus.value === 'loading') return null;
    const controller = startRead();
    moreStatus.value = 'loading';
    error.value = null;
    try {
      const page = await listComments(toValue(imageId), { cursor, signal: controller.signal });
      if (controller.signal.aborted) return null;
      const known = new Set(items.value.map((comment) => comment.id));
      const added = page.items.filter((comment) => !known.has(comment.id));
      items.value = [...items.value, ...added];
      nextCursor.value = page.nextCursor;
      moreStatus.value = 'idle';
      return added;
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return null;
      moreStatus.value = 'error';
      error.value = errorMessage(cause);
      return null;
    } finally {
      finishRead(controller);
    }
  }

  /** Repeats whichever load failed, keeping the comments that are already shown. */
  async function retry(): Promise<void> {
    if (status.value === 'error') {
      await loadFirst();
    } else if (moreStatus.value === 'error') {
      await loadMore();
    }
  }

  /**
   * Posts a comment and puts it on top (F-28). Never rejects: failures come back as a result so the form can keep
   * its values and show field errors inline (F-29, F-33). A post that finishes after the dialog switched to another
   * image is saved but not shown in the other image's list.
   */
  async function add(input: CreateCommentBody): Promise<CommentSendResult> {
    const id = toValue(imageId);
    try {
      const comment = await createComment(id, input);
      if (toValue(imageId) === id) {
        items.value = [comment, ...items.value.filter((item) => item.id !== comment.id)];
      }
      return { ok: true, comment };
    } catch (cause) {
      return {
        ok: false,
        message: errorMessage(cause),
        fieldErrors: isApiError(cause) ? cause.fieldErrors : {},
      };
    }
  }

  /**
   * Deletes one of the visitor's own comments (F-32). The comment leaves the list only after the `204`, so a failed
   * delete keeps it. A `404` means it is already gone (deleted in another tab), which is what the person wanted.
   */
  async function remove(commentId: number): Promise<CommentDeleteResult> {
    try {
      await deleteComment(commentId);
    } catch (cause) {
      if (!isApiError(cause) || cause.code !== 'not-found') return { ok: false, message: errorMessage(cause) };
    }
    items.value = items.value.filter((item) => item.id !== commentId);
    return { ok: true };
  }

  watch(
    () => toValue(imageId),
    () => {
      void loadFirst();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    reading?.abort();
    reading = null;
  });

  return {
    items: shallowReadonly(items),
    nextCursor: shallowReadonly(nextCursor),
    status: shallowReadonly(status),
    moreStatus: shallowReadonly(moreStatus),
    error: shallowReadonly(error),
    loadMore,
    retry,
    add,
    remove,
  };
}
