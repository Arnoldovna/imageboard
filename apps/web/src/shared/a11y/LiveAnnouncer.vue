<script setup lang="ts">
import { computed } from 'vue';

import { APP_REGION, useAnnouncerStore } from './announcer.store';

/** A visually hidden polite live region. App.vue renders the app region; every ModalDialog renders its own. */
const { region = APP_REGION } = defineProps<{ region?: string }>();

const announcer = useAnnouncerStore();
const message = computed(() => announcer.messageFor(region));
</script>

<template>
  <div class="live-announcer" aria-live="polite" aria-atomic="true" :data-region="region">{{ message }}</div>
</template>

<style scoped src="./LiveAnnouncer.css"></style>
