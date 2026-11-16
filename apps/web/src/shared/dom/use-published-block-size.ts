import { onBeforeUnmount, onMounted, type ShallowRef } from 'vue';

type ElementRef = Readonly<ShallowRef<HTMLElement | null>>;

/**
 * Publishes the border-box block size of a pinned element as a custom property while the calling component is
 * mounted (a custom property set from JS, the one allowed inline style). The height of a pinned row depends on the
 * font, the breakpoint and its text, so CSS cannot know it. With it, the upload bar sticks below the site header, and
 * the scroll padding of the scroll container keeps whatever keyboard focus scrolls to clear of the pinned rows
 * (WCAG 2.4.11): the root's in base.css, a modal dialog's in ModalDialog.css.
 *
 * The property is set on `host` (default: the root element), follows resizes (ResizeObserver) and is removed on
 * unmount, so CSS falls back to the property's default where the element does not exist.
 */
export function usePublishedBlockSize(element: ElementRef, property: string, host?: ElementRef): void {
  let observer: ResizeObserver | undefined;
  let target: HTMLElement | undefined;

  function publish(blockSize: number): void {
    target?.style.setProperty(property, `${String(Math.ceil(blockSize))}px`);
  }

  onMounted(() => {
    const measured = element.value;
    if (measured === null) return;
    target = host === undefined ? document.documentElement : (host.value ?? undefined);
    publish(measured.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver((entries) => {
      const size = entries[0]?.borderBoxSize[0]?.blockSize;
      publish(size ?? measured.getBoundingClientRect().height);
    });
    observer.observe(measured);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    target?.style.removeProperty(property);
  });
}
