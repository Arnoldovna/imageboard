import { defineStore } from 'pinia';
import { computed, nextTick, ref, shallowRef } from 'vue';

/** The region rendered once by App.vue; it receives messages while no modal dialog is open. */
export const APP_REGION = 'app';

/**
 * Polite live announcements (F-56, ADR 0010). `showModal()` makes everything outside the dialog inert, so App.vue's
 * region is muted while a dialog is open. Every open `ModalDialog` therefore registers its own region; messages go
 * to the top-most open dialog's region, else to the app region.
 */
export const useAnnouncerStore = defineStore('announcer', () => {
  /** Dialog regions in opening order; the last one is the top-most dialog. */
  const dialogRegions = shallowRef<readonly string[]>([]);
  const messages = ref<Record<string, string>>({});

  const activeRegion = computed(() => dialogRegions.value.at(-1) ?? APP_REGION);

  function pushRegion(id: string): void {
    dialogRegions.value = [...dialogRegions.value.filter((region) => region !== id), id];
  }

  function removeRegion(id: string): void {
    dialogRegions.value = dialogRegions.value.filter((region) => region !== id);
    messages.value = Object.fromEntries(Object.entries(messages.value).filter(([region]) => region !== id));
  }

  function messageFor(region: string): string {
    return messages.value[region] ?? '';
  }

  /**
   * Clears the target region, lets the DOM update, then writes the message, so assistive technology notices a
   * change even when the same sentence is announced twice in a row ("Comment deleted." for two comments).
   *
   * The top-most dialog may close during that update ("Image deleted.", then the detail dialog leaves). Its region
   * is gone then, so the announcement starts over in the region that is active now instead of being written into a
   * region nobody renders.
   */
  async function announce(message: string): Promise<void> {
    const region = activeRegion.value;
    messages.value = { ...messages.value, [region]: '' };
    await nextTick();
    if (activeRegion.value !== region) return announce(message);
    messages.value = { ...messages.value, [region]: message };
  }

  return { activeRegion, pushRegion, removeRegion, messageFor, announce };
});
