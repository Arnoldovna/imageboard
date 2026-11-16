<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';

import { ROUTE_NAMES } from '../../shared/routing/routes';

/**
 * Site header (F-54, F-59, maw §6): the wordmark "imageboard" is the page's only `h1`, linking home, with the
 * legacy tagline "form/vue". Sticky from `sm` up (SiteHeader.css).
 *
 * The upload bar sticks directly below it (ADR 0012). The header's height depends on the font and the breakpoint,
 * so it is measured and published as `--site-header-block-size` on the root element (a custom property set from
 * JS, the one allowed inline style).
 */
const HEADER_SIZE_PROPERTY = '--site-header-block-size';

const header = useTemplateRef<HTMLElement>('header');
let observer: ResizeObserver | undefined;

function publish(blockSize: number): void {
  document.documentElement.style.setProperty(HEADER_SIZE_PROPERTY, `${String(Math.ceil(blockSize))}px`);
}

onMounted(() => {
  const element = header.value;
  if (element === null) return;
  publish(element.getBoundingClientRect().height);
  if (typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    const size = entries[0]?.borderBoxSize[0]?.blockSize;
    publish(size ?? element.getBoundingClientRect().height);
  });
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  document.documentElement.style.removeProperty(HEADER_SIZE_PROPERTY);
});
</script>

<template>
  <header ref="header" class="site-header">
    <h1 class="site-header__title">
      <RouterLink class="site-header__brand" :to="{ name: ROUTE_NAMES.home }">imageboard</RouterLink>
    </h1>
    <p class="site-header__tagline">form/vue</p>
  </header>
</template>

<style scoped src="./SiteHeader.css"></style>
