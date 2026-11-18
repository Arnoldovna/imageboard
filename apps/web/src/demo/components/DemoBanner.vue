<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';

import { usePublishedBlockSize } from '../../shared/dom/use-published-block-size';
import { resetDemo } from '../start-demo';

/**
 * Live-demo notice (PLAN Etappe 3b), shown only in the demo build: a flat accent field above the header (maw §1,
 * §4: on-accent text only). "reset demo" restores the seed and reloads the page; it runs once even if pressed twice.
 * Its height is published as `--demo-banner-block-size`, so the page shell below stays one screen tall (App.css).
 */
const banner = useTemplateRef<HTMLElement>('banner');
usePublishedBlockSize(banner, '--demo-banner-block-size');

const resetting = ref(false);
const failed = ref(false);

async function reset(): Promise<void> {
  if (resetting.value) return;
  resetting.value = true;
  failed.value = false;
  try {
    await resetDemo();
  } catch {
    failed.value = true;
    resetting.value = false;
  }
}
</script>

<template>
  <aside ref="banner" class="demo-banner" aria-label="Live demo">
    <div class="demo-banner__inner">
      <p class="demo-banner__text" lang="de">Demo – Daten bleiben nur in deinem Browser</p>
      <button class="demo-banner__reset" type="button" :aria-disabled="resetting ? 'true' : undefined" @click="reset">
        {{ resetting ? 'resetting…' : 'reset demo' }}
      </button>
      <p v-if="failed" class="demo-banner__error" role="alert">
        The demo could not be reset. Reload the page and try again.
      </p>
    </div>
  </aside>
</template>

<style scoped src="./DemoBanner.css"></style>
