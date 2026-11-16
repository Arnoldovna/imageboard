import { fileMessages } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { apng, gif, jpegWithGps, htmlAsPng, pdf, png, svg, webp } from '../../../../test/fixtures.js';
import { UnsupportedImageTypeError } from '../../../shared/errors/app-error.js';
import { sniffImageType } from '../image-sniffer.js';

describe('sniffImageType', () => {
  it.each([
    ['JPEG', jpegWithGps(), 'image/jpeg'],
    ['PNG', png(), 'image/png'],
    ['WebP', webp(), 'image/webp'],
    ['GIF', gif(2), 'image/gif'],
  ] as const)('F-19: detects %s from the magic bytes', async (_label, bytes, expected) => {
    await expect(sniffImageType(bytes)).resolves.toBe(expected);
  });

  it('F-19 (R-07): accepts an animated PNG as image/png', async () => {
    await expect(sniffImageType(apng())).resolves.toBe('image/png');
  });

  it.each([
    ['SVG with a script (B-04)', svg],
    ['HTML meant to be served as .png (B-05)', htmlAsPng],
    ['PDF', pdf],
    ['plain text', Buffer.from('hello, world')],
    ['an empty buffer', Buffer.alloc(0)],
    ['a PNG signature cut short', png().subarray(0, 4)],
  ])('B-04: rejects %s with 415 unsupported-image-type', async (_label, bytes) => {
    const rejection = sniffImageType(bytes);

    await expect(rejection).rejects.toBeInstanceOf(UnsupportedImageTypeError);
    await expect(rejection).rejects.toMatchObject({
      status: 415,
      code: 'unsupported-image-type',
      message: fileMessages.unsupportedType,
    });
  });

  it('B-05: the bytes decide, whatever the client claims (the sniffer has no filename or type input)', async () => {
    // A JPEG sent as "photo.png" with image/png is still a JPEG; HTML sent the same way is still refused.
    await expect(sniffImageType(jpegWithGps())).resolves.toBe('image/jpeg');
    await expect(sniffImageType(htmlAsPng)).rejects.toBeInstanceOf(UnsupportedImageTypeError);
  });
});
