<script setup lang="ts">
import type { CommentDto } from '@app/shared';
import { computed, useId } from 'vue';

import { formatDateTime } from '../../../shared/format/date';
import AppButton from '../../../shared/ui/AppButton.vue';

/**
 * One comment (F-26): the body as text (line breaks kept through CSS, never `v-html`), then author and time. The
 * owner-only "delete comment" button (F-32) is described by this comment's author and time, so a list of controls
 * can tell the buttons apart (B-74). The article takes programmatic focus after "show older comments" (`tabindex`
 * -1), and `data-comment-id` lets the list find it.
 */
const { comment } = defineProps<{ comment: CommentDto }>();

const emit = defineEmits<{ delete: [comment: CommentDto] }>();

const id = useId();
const authorId = `${id}-author`;
const timeId = `${id}-time`;
const createdAt = computed(() => formatDateTime(comment.createdAt));
</script>

<template>
  <article class="comment-item" tabindex="-1" :data-comment-id="comment.id">
    <p class="comment-item__body">{{ comment.body }}</p>
    <div class="comment-item__footer">
      <p class="comment-item__meta">
        <span :id="authorId" class="comment-item__author">{{ comment.authorName }}</span>
        <time :id="timeId" class="comment-item__time" :datetime="comment.createdAt">{{ createdAt }}</time>
      </p>
      <AppButton
        v-if="comment.canDelete"
        class="comment-item__delete"
        :aria-describedby="`${authorId} ${timeId}`"
        @click="emit('delete', comment)"
        >delete comment</AppButton
      >
    </div>
  </article>
</template>

<style scoped src="./CommentItem.css"></style>
