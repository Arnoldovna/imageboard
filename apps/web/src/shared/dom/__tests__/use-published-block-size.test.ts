import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, useTemplateRef } from 'vue';

import { usePublishedBlockSize } from '../use-published-block-size';

const PROPERTY = '--pinned-test-block-size';

type ResizeCallback = (entries: { borderBoxSize: { blockSize: number }[] }[]) => void;

/** A ResizeObserver stand-in that hands its callback to the test, so a resize can be triggered by hand. */
function stubResizeObserver(): {
  resize: (blockSize: number) => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  let callback: ResizeCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeCallback) {
        callback = cb;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  return {
    resize(blockSize) {
      callback?.([{ borderBoxSize: [{ blockSize }] }]);
    },
    observe,
    disconnect,
  };
}

/** A pinned row inside a box; with `onBox` the size goes onto the box (as a dialog and its header), else the root. */
const Pinned = defineComponent({
  props: { onBox: Boolean },
  setup(props) {
    const box = useTemplateRef<HTMLElement>('box');
    const row = useTemplateRef<HTMLElement>('row');
    usePublishedBlockSize(row, PROPERTY, props.onBox ? box : undefined);
    return () => h('div', { ref: 'box' }, [h('div', { ref: 'row' })]);
  },
});

function published(): string {
  return document.documentElement.style.getPropertyValue(PROPERTY);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(PROPERTY);
});

describe('usePublishedBlockSize', () => {
  it('publishes the measured height on mount, rounded up to whole pixels', () => {
    stubResizeObserver();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 52.3));

    mount(Pinned);

    expect(published()).toBe('53px');
  });

  it('follows resizes and removes the property on unmount, so a page without the row falls back to 0', () => {
    const observer = stubResizeObserver();
    const wrapper = mount(Pinned);
    expect(observer.observe).toHaveBeenCalledWith(wrapper.element.firstElementChild);

    observer.resize(76.5);
    expect(published()).toBe('77px');

    wrapper.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(published()).toBe('');
  });

  it('still publishes once without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 40));

    mount(Pinned);

    expect(published()).toBe('40px');
  });

  it('publishes on a host element instead of the root when one is given (a dialog and its header)', () => {
    stubResizeObserver();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 70.2));

    const wrapper = mount(Pinned, { props: { onBox: true } });
    const box = wrapper.element as HTMLElement;

    expect(box.style.getPropertyValue(PROPERTY)).toBe('71px');
    expect(published()).toBe('');

    wrapper.unmount();
    expect(box.style.getPropertyValue(PROPERTY)).toBe('');
  });
});
