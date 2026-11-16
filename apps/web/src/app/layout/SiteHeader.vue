<script setup lang="ts">
import { useTemplateRef } from 'vue';

import { usePublishedBlockSize } from '../../shared/dom/use-published-block-size';
import { ROUTE_NAMES } from '../../shared/routing/routes';

/**
 * Site header (F-54, F-59, maw §6): the wordmark "imageboard" is the page's only `h1`, linking home, with the
 * legacy tagline "form/vue". Sticky from `sm` up (SiteHeader.css).
 *
 * The upload bar sticks directly below it (ADR 0012). The header's height depends on the font and the breakpoint,
 * so it is measured and published as `--site-header-block-size` on the root element.
 */
const header = useTemplateRef<HTMLElement>('header');
usePublishedBlockSize(header, '--site-header-block-size');
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
