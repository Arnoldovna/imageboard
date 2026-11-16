<script setup lang="ts">
import { useTemplateRef } from 'vue';

import LiveAnnouncer from '../shared/a11y/LiveAnnouncer.vue';
import SiteFooter from './layout/SiteFooter.vue';
import SiteHeader from './layout/SiteHeader.vue';

/**
 * App shell (OVERVIEW §5): skip link, header, the routed page inside `<main>`, footer, and the app-level polite live
 * region (announcements while no dialog is open; ModalDialog brings its own, ADR 0010).
 */
const main = useTemplateRef<HTMLElement>('main');

/** Moves focus without changing the URL: a `#main` fragment would put a stray `#` into the history (B-59). */
function skipToContent(): void {
  main.value?.focus();
}
</script>

<template>
  <a class="skip-link" href="#main" @click.prevent="skipToContent">skip to content</a>
  <div class="app-shell">
    <SiteHeader />
    <main id="main" ref="main" class="app-shell__main" tabindex="-1">
      <RouterView />
    </main>
    <SiteFooter />
  </div>
  <LiveAnnouncer />
</template>

<style scoped src="./App.css"></style>
