import { IMAGE_MIME_TYPES } from '@app/shared';
import { describe, expect, it } from 'vitest';

import {
  MEDIA_FILE_PATTERN,
  MEDIA_KEY_PATTERN,
  newObjectKey,
  parseObjectKey,
  PREVIEW_FILE_PATTERN,
  PREVIEW_KEY_PATTERN,
  previewKeyOf,
} from '../object-key.js';

const UUID = '0b9d3c2a-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('newObjectKey', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ] as const)('F-21, B-05: %s gets images/<uuid v4>.%s from the detected type', (mimeType, extension) => {
    const key = newObjectKey(mimeType);

    expect(key).toMatch(MEDIA_KEY_PATTERN);
    expect(key.endsWith(`.${extension}`)).toBe(true);
  });

  it('B-20: generates the key synchronously from crypto.randomUUID, a fresh one every time', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newObjectKey('image/png')));

    // A string, not a promise: there is no asynchronous step that could reject and hang the request.
    expect(typeof newObjectKey('image/png')).toBe('string');
    expect(keys.size).toBe(200);
  });

  it('every allowed type has an extension the key pattern accepts', () => {
    for (const mimeType of IMAGE_MIME_TYPES) expect(newObjectKey(mimeType, () => UUID)).toMatch(MEDIA_KEY_PATTERN);
  });
});

describe('previewKeyOf', () => {
  it('ADR 0018: derives previews/<same uuid>.webp from the original key', () => {
    expect(previewKeyOf(`images/${UUID}.jpg`)).toBe(`previews/${UUID}.webp`);
    expect(previewKeyOf(`images/${UUID}.gif`)).toMatch(PREVIEW_KEY_PATTERN);
  });

  it.each([`previews/${UUID}.webp`, `images/${UUID}.svg`, `images/../${UUID}.jpg`, 'images/x.jpg', ''])(
    'throws for %j, which is not an original key',
    (key) => {
      expect(() => previewKeyOf(key)).toThrow(/Not an image object key/);
    },
  );
});

describe('parseObjectKey and the key patterns', () => {
  it('splits a valid key into uuid and extension', () => {
    expect(parseObjectKey(`images/${UUID}.webp`)).toEqual({ uuid: UUID, extension: 'webp' });
  });

  it.each([
    ['uppercase hex', `images/${UUID.toUpperCase()}.jpg`],
    ['uppercase extension', `images/${UUID}.JPG`],
    ['jpeg spelled out', `images/${UUID}.jpeg`],
    ['svg', `images/${UUID}.svg`],
    ['html', `images/${UUID}.html`],
    ['UUID v1', 'images/0b9d3c2a-5e6f-1a1b-8c2d-3e4f5a6b7c8d.jpg'],
    ['wrong variant', 'images/0b9d3c2a-5e6f-4a1b-7c2d-3e4f5a6b7c8d.jpg'],
    ['traversal', `images/../${UUID}.jpg`],
    ['leading slash', `/images/${UUID}.jpg`],
    ['absolute URL (B-35)', `https://s3.amazonaws.com/bucket/images/${UUID}.jpg`],
    ['trailing newline', `images/${UUID}.jpg\n`],
  ])('rejects %s', (_label, key) => {
    expect(parseObjectKey(key)).toBeUndefined();
    expect(MEDIA_KEY_PATTERN.test(key)).toBe(false);
  });

  it('file patterns: originals take the four extensions, previews only webp', () => {
    expect(MEDIA_FILE_PATTERN.test(`${UUID}.png`)).toBe(true);
    expect(MEDIA_FILE_PATTERN.test(`${UUID}.webp`)).toBe(true);
    expect(MEDIA_FILE_PATTERN.test(`${UUID}.svg`)).toBe(false);
    expect(MEDIA_FILE_PATTERN.test(`../${UUID}.png`)).toBe(false);
    expect(PREVIEW_FILE_PATTERN.test(`${UUID}.webp`)).toBe(true);
    expect(PREVIEW_FILE_PATTERN.test(`${UUID}.jpg`)).toBe(false);
  });
});
