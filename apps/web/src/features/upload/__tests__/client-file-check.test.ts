import { fileMessages, uploadTooLarge } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_IMAGE_TYPES, checkImageFile, sniffImageType } from '../client-file-check';

const MIB = 1024 * 1024;

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): number[] => Array.from(text, (character) => character.charCodeAt(0));

const SIGNATURES = {
  'image/jpeg': bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')),
  'image/png': bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d),
  'image/gif': bytes(...ascii('GIF89a'), 0x01, 0x00),
  'image/webp': bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBPVP8 ')),
} as const;

/** A file of `size` bytes that starts with `head` (the rest is zero). */
function fileOf(head: Uint8Array, size = 2048, name = 'harbour-at-dusk.jpg', type = 'image/jpeg'): File {
  const content = new Uint8Array(Math.max(size, 0));
  content.set(head.subarray(0, content.length));
  return new File([content], name, { type });
}

describe('sniffImageType (F-19 rules on the client)', () => {
  it.each(Object.entries(SIGNATURES))('detects %s from its first bytes', (type, head) => {
    expect(sniffImageType(head)).toBe(type);
  });

  it('accepts the older GIF87a signature', () => {
    expect(sniffImageType(bytes(...ascii('GIF87a'), 0x01, 0x00))).toBe('image/gif');
  });

  it.each([
    ['SVG', bytes(...ascii('<svg xmlns="http'))],
    ['HTML', bytes(...ascii('<!doctype html>'))],
    ['PDF', bytes(...ascii('%PDF-1.7\n%'))],
    ['a RIFF file that is not WebP (WAV)', bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WAVE'))],
    ['a truncated PNG signature', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['nothing', bytes()],
  ])('rejects %s', (_label, head) => {
    expect(sniffImageType(head)).toBeNull();
  });
});

describe('checkImageFile (F-20)', () => {
  it.each(Object.entries(SIGNATURES))('accepts a %s under the limit', async (type, head) => {
    await expect(checkImageFile(fileOf(head), 5 * MIB)).resolves.toEqual({ ok: true, type });
  });

  it('decides by content, not by name or browser type: a renamed SVG is rejected', async () => {
    const svg = fileOf(bytes(...ascii('<svg xmlns="http')), 300, 'innocent.png', 'image/png');

    await expect(checkImageFile(svg, 5 * MIB)).resolves.toEqual({ ok: false, message: fileMessages.unsupportedType });
  });

  it('accepts a real image whose name and browser type say otherwise', async () => {
    const png = fileOf(SIGNATURES['image/png'], 4096, 'scan', '');

    await expect(checkImageFile(png, 5 * MIB)).resolves.toEqual({ ok: true, type: 'image/png' });
  });

  it('accepts a file of exactly the limit and rejects one byte more with the API message', async () => {
    const limit = 2 * MIB;

    await expect(checkImageFile(fileOf(SIGNATURES['image/jpeg'], limit), limit)).resolves.toMatchObject({ ok: true });
    await expect(checkImageFile(fileOf(SIGNATURES['image/jpeg'], limit + 1), limit)).resolves.toEqual({
      ok: false,
      message: uploadTooLarge(limit),
    });
    expect(uploadTooLarge(limit)).toBe('The image must be 2 MB or smaller.');
  });

  it('reports the wrong type before the size, because a smaller PDF would not help', async () => {
    const pdf = fileOf(bytes(...ascii('%PDF-1.7\n%')), 6 * MIB, 'flyer.pdf', 'application/pdf');

    await expect(checkImageFile(pdf, 5 * MIB)).resolves.toEqual({ ok: false, message: fileMessages.unsupportedType });
  });

  it('calls an empty file unreadable', async () => {
    await expect(checkImageFile(fileOf(bytes(), 0), 5 * MIB)).resolves.toEqual({
      ok: false,
      message: fileMessages.unreadable,
    });
  });

  it('calls a file unreadable when the browser cannot read it any more', async () => {
    const gone = fileOf(SIGNATURES['image/jpeg']);
    gone.slice = () => {
      throw new DOMException('The file was moved.', 'NotReadableError');
    };

    await expect(checkImageFile(gone, 5 * MIB)).resolves.toEqual({ ok: false, message: fileMessages.unreadable });
  });
});

describe('ACCEPTED_IMAGE_TYPES', () => {
  it('lists exactly the four stored types for the input accept attribute', () => {
    expect(ACCEPTED_IMAGE_TYPES).toBe('image/jpeg,image/png,image/webp,image/gif');
  });
});
