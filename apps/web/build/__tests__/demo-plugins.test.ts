// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEED_IMAGES, SEED_IMAGES_DIR, SEED_OWNER_ID, SEED_TOTALS } from '../../../api/src/scripts/seed-content';
import { demoSeedModuleSource, jpegSize } from '../demo-plugins';

/** SOI, an APP0 segment to skip, then SOF0 with height 0x0438 (1080) and width 0x0780 (1920). */
const MINIMAL_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03,
]);

describe('jpegSize', () => {
  it('reads the frame size after other segments and fill bytes', () => {
    expect(jpegSize(MINIMAL_JPEG)).toEqual({ width: 1920, height: 1080 });
  });

  it('reads every real seed picture', async () => {
    for (const image of SEED_IMAGES) {
      const size = jpegSize(await readFile(join(SEED_IMAGES_DIR, `${image.slug}.jpg`)));
      expect(size.width, image.slug).toBeGreaterThan(0);
      expect(size.height, image.slug).toBeGreaterThan(0);
    }
  });

  it.each([
    ['a PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ['a JPEG without a frame', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
    ['a corrupt segment chain', new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00])],
  ])('rejects %s', (_name, bytes) => {
    expect(() => jpegSize(bytes)).toThrow();
  });
});

describe('demoSeedModuleSource', () => {
  it('turns the real seed (16 images, 60 comments) into asset imports plus data', async () => {
    const source = await demoSeedModuleSource();

    expect(source.match(/^import photo\d+ from /gm)).toHaveLength(SEED_TOTALS.images);
    expect(source.match(/"authorName":/g)).toHaveLength(SEED_TOTALS.images + SEED_TOTALS.comments);
    for (const image of SEED_IMAGES) expect(source).toContain(JSON.stringify(image.title));
    // The API seed's owner: no visitor ever is it, so the demo protects seed rows like the API.
    expect(source).toContain(`ownerId: ${JSON.stringify(SEED_OWNER_ID)},`);
  });
});
