import { describe, expect, it } from 'vitest';

import { CreateImageFields, fieldMessages, ImageDto, ImageMimeType, ImagePage } from '../index.js';

const dto = {
  id: 16,
  url: '/api/media/images/0b9d1f2e-3c4d-4e5f-8a6b-7c8d9e0f1a2b.jpg',
  previewUrl: '/api/media/previews/0b9d1f2e-3c4d-4e5f-8a6b-7c8d9e0f1a2b.webp',
  width: 1600,
  height: 1067,
  mimeType: 'image/jpeg',
  authorName: 'Tomás R.',
  title: 'Rooftops from the fifth floor',
  description: 'New flat, no lift, but this view makes the stairs bearable.',
  createdAt: '2026-11-12T19:23:00.000Z',
  canDelete: false,
} as const;

describe('CreateImageFields', () => {
  it('F-18: accepts valid fields and defaults the description to an empty string', () => {
    expect(CreateImageFields.parse({ authorName: ' Kofi ', title: 'Commute' })).toEqual({
      authorName: 'Kofi',
      title: 'Commute',
      description: '',
    });
  });

  it('F-18: reports every invalid field at once', () => {
    const result = CreateImageFields.safeParse({ authorName: '', title: 'a\nb', description: 'x'.repeat(2001) });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['authorName'], message: fieldMessages.authorName.required },
      { path: ['title'], message: fieldMessages.title.invalid },
      { path: ['description'], message: fieldMessages.description.tooLong },
    ]);
  });

  it('F-18: reports missing required fields with their messages', () => {
    const result = CreateImageFields.safeParse({});

    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['authorName'], message: fieldMessages.authorName.required },
      { path: ['title'], message: fieldMessages.title.required },
    ]);
  });

  it('F-21: rejects unknown fields (strict)', () => {
    const result = CreateImageFields.safeParse({ authorName: 'Kofi', title: 'T', ownerId: 'x' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('F-20: a CRLF description at the limit counts the line breaks once', () => {
    const description = `xy${'\r\nx'.repeat(999)}`;
    const parsed = CreateImageFields.parse({ authorName: 'Kofi', title: 'T', description });

    expect(parsed.description).toHaveLength(2000);
    expect(parsed.description).not.toContain('\r');
  });
});

describe('ImageDto', () => {
  it('B-27: parses the documented shape', () => {
    expect(ImageDto.parse(dto)).toEqual(dto);
    expect(ImagePage.parse({ items: [dto], nextCursor: null }).items).toHaveLength(1);
  });

  it('F-43: is a tolerant reader that strips unknown keys such as ownerId', () => {
    expect(ImageDto.parse({ ...dto, ownerId: 'leak' })).not.toHaveProperty('ownerId');
  });

  it('requires millisecond ISO timestamps and a known MIME type', () => {
    expect(ImageDto.safeParse({ ...dto, createdAt: '2026-11-12T19:23:00Z' }).success).toBe(false);
    expect(ImageDto.safeParse({ ...dto, mimeType: 'image/svg+xml' }).success).toBe(false);
  });

  it('F-19: allows exactly JPEG, PNG, WebP and GIF', () => {
    expect(ImageMimeType.options).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  });
});
