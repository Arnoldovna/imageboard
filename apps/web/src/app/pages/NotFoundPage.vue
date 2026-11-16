<script setup lang="ts">
import { ROUTE_NAMES } from '../../shared/routing/routes';

/** Every unknown path, including `/images/abc` (OVERVIEW §8.2). Title "Page not found · Imageboard" (router meta). */
</script>

<template>
  <section class="not-found-page" aria-labelledby="not-found-title">
    <h2 id="not-found-title" class="not-found-page__title">Page not found</h2>
    <p class="not-found-page__text">There is nothing at this address. The link may be mistyped or out of date.</p>
    <RouterLink class="not-found-page__link" :to="{ name: ROUTE_NAMES.home }">
      <span class="not-found-page__arrow" aria-hidden="true">←</span>
      back to the gallery
    </RouterLink>
  </section>
</template>

<style scoped src="./NotFoundPage.css"></style>
