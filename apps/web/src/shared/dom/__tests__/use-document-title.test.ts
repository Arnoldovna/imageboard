import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick, shallowRef } from 'vue';

import { formatDocumentTitle, useDocumentTitle } from '../use-document-title';

describe('formatDocumentTitle (F-53)', () => {
  it('uses the app title alone without a page title', () => {
    expect(formatDocumentTitle()).toBe('Imageboard');
    expect(formatDocumentTitle(null)).toBe('Imageboard');
    expect(formatDocumentTitle('   ')).toBe('Imageboard');
  });

  it('puts the page first: "<page> · Imageboard"', () => {
    expect(formatDocumentTitle('Fog over the pines')).toBe('Fog over the pines · Imageboard');
    expect(formatDocumentTitle(' Page not found ')).toBe('Page not found · Imageboard');
  });
});

describe('useDocumentTitle', () => {
  it('follows a reactive title and does not restore anything on unmount', async () => {
    const title = shallowRef<string | null>(null);
    const Page = defineComponent({
      setup() {
        useDocumentTitle(title);
        return () => null;
      },
    });

    const wrapper = mount(Page);
    expect(document.title).toBe('Imageboard');

    title.value = 'Rooftops from the fifth floor';
    await nextTick();
    expect(document.title).toBe('Rooftops from the fifth floor · Imageboard');

    document.title = 'Page not found · Imageboard';
    wrapper.unmount();
    expect(document.title).toBe('Page not found · Imageboard');
  });
});
