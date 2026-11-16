import { crc32, deflateSync } from 'node:zlib';

import { animationTooLarge, animationTooLong, fileMessages } from '@app/shared';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { animatedWebp, apng, gif, jpegWithGps, png, webp } from '../../../../test/fixtures.js';
import { InvalidImageError } from '../../../shared/errors/app-error.js';
import { createImageProcessor } from '../image-processor.js';
import { type ImageLimits, MAX_ANIMATION_PIXELS } from '../upload.config.js';

const DEFAULT_LIMITS: ImageLimits = {
  maxPixels: 40_000_000,
  maxFrames: 200,
  maxEdge: 2560,
  maxAnimationPixels: MAX_ANIMATION_PIXELS,
};

function processor(limits: Partial<ImageLimits> = {}) {
  return createImageProcessor({ ...DEFAULT_LIMITS, ...limits });
}

/** A PNG whose header claims `width × height` pixels, with a token IDAT: a decompression bomb for the header check. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
  };
  const chunk = (type: string, data: Buffer) => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32(data.length), typeAndData, u32(crc32(typeAndData))]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', deflateSync(Buffer.alloc(1 + width * 3))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function expectInvalidImage(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(InvalidImageError);
  await expect(promise).rejects.toMatchObject({ status: 400, code: 'invalid-image', message });
}

describe('image processor: original', () => {
  it('B-06, F-22: orients a JPEG by EXIF, re-encodes it as JPEG and strips EXIF and GPS', async () => {
    const input = jpegWithGps({ width: 32, height: 16 }, 6);
    expect((await sharp(input).metadata()).exif).toBeDefined(); // the fixture really carries EXIF

    const result = await processor().process(input, 'image/jpeg');
    const metadata = await sharp(result.original).metadata();

    expect(metadata.format).toBe('jpeg');
    expect((await fileTypeFromBuffer(result.original))?.mime).toBe('image/jpeg');
    // Orientation 6 means "rotate 90° clockwise": 32×16 stored becomes 16×32 displayed.
    expect({ width: result.width, height: result.height }).toEqual({ width: 16, height: 32 });
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 16, height: 32 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(result.original.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
  });

  it.each([
    ['PNG', png(), 'image/png', 'png'],
    ['WebP', webp(), 'image/webp', 'webp'],
  ] as const)('F-22: re-encodes %s in the same format', async (_label, input, mimeType, format) => {
    const result = await processor().process(input, mimeType);

    expect((await sharp(result.original).metadata()).format).toBe(format);
    expect((await fileTypeFromBuffer(result.original))?.mime).toBe(mimeType);
    expect({ width: result.width, height: result.height }).toEqual({ width: 24, height: 16 });
  });

  it('R-07: stores an APNG as a static PNG (first frame, no animation chunks)', async () => {
    const result = await processor().process(apng(), 'image/png');

    expect((await fileTypeFromBuffer(result.original))?.mime).toBe('image/png');
    expect(result.original.includes(Buffer.from('acTL', 'latin1'))).toBe(false);
    expect((await sharp(result.original).metadata()).pages).toBeUndefined();
  });

  it('keeps an animated GIF animated and reports the size of one frame', async () => {
    const result = await processor().process(gif(150, { width: 8, height: 8 }), 'image/gif');
    const metadata = await sharp(result.original).metadata();

    expect(metadata.format).toBe('gif');
    expect(metadata.pages).toBe(150);
    expect({ width: result.width, height: result.height }).toEqual({ width: 8, height: 8 });
  });

  it('resizes inside IMAGE_MAX_EDGE, keeping the aspect ratio', async () => {
    const result = await processor({ maxEdge: 512 }).process(png({ width: 1200, height: 600 }), 'image/png');

    expect({ width: result.width, height: result.height }).toEqual({ width: 512, height: 256 });
  });

  it('never enlarges a small image', async () => {
    const result = await processor({ maxEdge: 2560 }).process(png({ width: 24, height: 16 }), 'image/png');

    expect({ width: result.width, height: result.height }).toEqual({ width: 24, height: 16 });
  });
});

describe('image processor: preview (ADR 0018)', () => {
  it('renders a WebP inside 960 px without metadata', async () => {
    const result = await processor().process(png({ width: 2000, height: 1000 }), 'image/png');
    const metadata = await sharp(result.preview).metadata();

    expect(metadata.format).toBe('webp');
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 960, height: 480 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it('uses only the first frame of an animation', async () => {
    const result = await processor().process(gif(3, { width: 40, height: 20 }), 'image/gif');
    const metadata = await sharp(result.preview, { animated: true }).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.pages ?? 1).toBe(1);
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 40, height: 20 });
  });

  it('is oriented like the original and strips the JPEG EXIF', async () => {
    const result = await processor().process(jpegWithGps({ width: 32, height: 16 }, 6), 'image/jpeg');
    const metadata = await sharp(result.preview).metadata();

    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 16, height: 32 });
    expect(metadata.exif).toBeUndefined();
  });
});

describe('image processor: rejections (400 invalid-image)', () => {
  it('rejects more pixels per frame than UPLOAD_MAX_PIXELS before decoding', async () => {
    await expectInvalidImage(processor({ maxPixels: 383 }).process(png(), 'image/png'), fileMessages.tooManyPixels);
  });

  it('rejects a decompression bomb by its header (30000 × 30000 claimed, a few bytes sent)', async () => {
    await expectInvalidImage(
      processor().process(pngHeaderOnly(30_000, 30_000), 'image/png'),
      fileMessages.tooManyPixels,
    );
  });

  it('counts pixels per frame, not per animation: 150 frames of 8 × 8 pass a 64-pixel limit', async () => {
    const result = await processor({ maxPixels: 64 }).process(gif(150), 'image/gif');

    expect(result.width * result.height).toBe(64);
  });

  it('rejects more frames than UPLOAD_MAX_FRAMES', async () => {
    await expectInvalidImage(processor({ maxFrames: 200 }).process(gif(201), 'image/gif'), animationTooLong(200));
  });

  it('ADR 0005: rejects an animation bomb by its header (200 frames of 6000 × 6000 in a few KB)', async () => {
    // Every frame passes UPLOAD_MAX_PIXELS and 200 frames pass UPLOAD_MAX_FRAMES, but decoding it would mean
    // 7.2 gigapixels (minutes of CPU) from a file far below UPLOAD_MAX_BYTES.
    const bomb = animatedWebp(200, { width: 6000, height: 6000 });
    expect(bomb.length).toBeLessThan(16 * 1024);
    expect(await sharp(bomb).metadata()).toMatchObject({ format: 'webp', width: 6000, height: 6000, pages: 200 });

    await expectInvalidImage(processor().process(bomb, 'image/webp'), animationTooLarge(MAX_ANIMATION_PIXELS));
  });

  it('ADR 0005: counts the animation budget over all decoded frames (150 frames of 8 × 8 = 9600 pixels)', async () => {
    const result = await processor({ maxAnimationPixels: 9600 }).process(gif(150), 'image/gif');

    expect({ width: result.width, height: result.height }).toEqual({ width: 8, height: 8 });
    await expectInvalidImage(
      processor({ maxAnimationPixels: 9599 }).process(gif(150), 'image/gif'),
      animationTooLarge(9599),
    );
  });

  it('ADR 0005: the animation budget leaves still images to UPLOAD_MAX_PIXELS (APNG decodes one frame)', async () => {
    await expect(processor({ maxAnimationPixels: 1 }).process(png(), 'image/png')).resolves.toBeDefined();
    await expect(processor({ maxAnimationPixels: 1 }).process(apng(), 'image/png')).resolves.toBeDefined();
  });

  it('keeps an animated WebP inside the budget animated', async () => {
    const result = await processor().process(animatedWebp(3), 'image/webp');

    expect({ width: result.width, height: result.height }).toEqual({ width: 24, height: 16 });
    expect(await sharp(result.original).metadata()).toMatchObject({ format: 'webp', pages: 3 });
  });

  it('rejects bytes that libvips cannot read', async () => {
    const garbage = Buffer.concat([png().subarray(0, 8), Buffer.from('not a png at all, just text')]);

    await expectInvalidImage(processor().process(garbage, 'image/png'), fileMessages.unreadable);
  });

  it('rejects a truncated image instead of storing half of it', async () => {
    const input = png({ width: 64, height: 64 });
    const truncated = input.subarray(0, input.length - 40);

    await expectInvalidImage(processor().process(truncated, 'image/png'), fileMessages.unreadable);
  });

  it('rejects a polyglot whose decoder differs from the sniffed type', async () => {
    await expectInvalidImage(processor().process(jpegWithGps(), 'image/png'), fileMessages.unreadable);
  });
});
