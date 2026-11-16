/**
 * Remembers the focused element and moves focus back to it later (dialogs, ADR 0011). Native `<dialog>.close()`
 * restores focus on its own, but a dialog that is removed from the DOM (route change, `v-if`) does not, so the owner
 * calls `restore()` itself. Nothing happens when the element is gone (a deleted tile): the caller then decides.
 */
export function useFocusReturn(): { capture: () => void; restore: () => boolean } {
  let previous: HTMLElement | null = null;

  function capture(): void {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  /** Returns true when focus was moved back. */
  function restore(): boolean {
    const target = previous;
    previous = null;
    if (target === null || !target.isConnected || target === document.body) return false;
    target.focus();
    return document.activeElement === target;
  }

  return { capture, restore };
}
