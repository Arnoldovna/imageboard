<script setup lang="ts">
import { MAW_STUDIO_IMPRINT_URL, PROFILE_LINKS } from './profile-links';

/**
 * Footer (F-58, B-73, maw §6): text links with their real names, no icons, and the lowercase "imprint" link to the
 * maw-studio imprint; `© year` on the end side.
 */
const year = new Date().getFullYear();
</script>

<template>
  <footer class="site-footer">
    <ul class="site-footer__links">
      <li class="site-footer__item">
        <a class="site-footer__link" :href="PROFILE_LINKS.github" rel="me">GitHub</a>
      </li>
      <li class="site-footer__item">
        <a class="site-footer__link" :href="PROFILE_LINKS.linkedin" rel="me">LinkedIn</a>
      </li>
      <li class="site-footer__item">
        <a class="site-footer__link" :href="MAW_STUDIO_IMPRINT_URL">imprint</a>
      </li>
    </ul>
    <p class="site-footer__copyright">© {{ year }} Arnoldovna</p>
  </footer>
</template>

<style scoped src="./SiteFooter.css"></style>
