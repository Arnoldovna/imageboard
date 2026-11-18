<script setup lang="ts">
import { PROFILE_LINKS } from './profile-links';

/**
 * Footer (F-58, B-73, maw §6): text links with their real names, no icons; `© year` on the end side. No imprint link
 * (Marina's decision, 2026-11-18): the repository and the static demo are personal, non-commercial portfolio work.
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
    </ul>
    <p class="site-footer__copyright">© {{ year }} Arnoldovna</p>
  </footer>
</template>

<style scoped src="./SiteFooter.css"></style>
