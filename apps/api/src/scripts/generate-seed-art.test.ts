import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { renderCredits, renderJpeg, SEED_MAX_EDGE } from './generate-seed-art.js';
import { renderSvg, SEED_ARTWORKS } from './seed-art/pieces.js';
import { seededRandom } from './seed-art/svg.js';
import { SEED_IMAGES, SEED_IMAGES_DIR } from './seed-content.js';

/* The seed artwork (ADR 0014, DATA-MODEL §6.2): original, reproducible, and a match for the committed files. */

describe('seed artwork', () => {
  const svgs = new Map(SEED_ARTWORKS.map((artwork) => [artwork.slug, renderSvg(artwork)]));
  const committed = new Map<string, Buffer>();
  const rendered = new Map<string, Buffer>();

  beforeAll(async () => {
    // sharp renders on its own thread pool, so the sixteen pieces render side by side.
    await Promise.all(
      SEED_ARTWORKS.map(async (artwork) => {
        committed.set(artwork.slug, await readFile(join(SEED_IMAGES_DIR, `${artwork.slug}.jpg`)));
        rendered.set(artwork.slug, await renderJpeg(artwork));
      }),
    );
  }, 60_000);

  it('has one piece per seed image, in the same order', () => {
    expect(SEED_ARTWORKS.map((artwork) => artwork.slug)).toEqual(SEED_IMAGES.map((image) => image.slug));
    expect(new Set(SEED_ARTWORKS.map((artwork) => artwork.seed)).size).toBe(SEED_ARTWORKS.length);
  });

  it('mixes portrait, landscape and square formats within the 1600 px long edge', () => {
    const shapes = new Set(
      SEED_ARTWORKS.map(({ width, height }) =>
        width === height ? 'square' : width > height ? 'landscape' : 'portrait',
      ),
    );
    expect(shapes).toEqual(new Set(['square', 'landscape', 'portrait']));
    for (const { width, height } of SEED_ARTWORKS) expect(Math.max(width, height)).toBe(SEED_MAX_EDGE);
  });

  it('draws the same SVG on every run (seeded, no clock, no Math.random)', () => {
    for (const artwork of SEED_ARTWORKS) expect(renderSvg(artwork)).toBe(svgs.get(artwork.slug));
  });

  it('is self-contained and carries the paper grain: no text, no fonts, no images or links outside the SVG', () => {
    for (const artwork of SEED_ARTWORKS) {
      const svg = svgs.get(artwork.slug) ?? '';
      expect(svg).toMatch(new RegExp(`^<svg [^>]*width="${String(artwork.width)}" height="${String(artwork.height)}"`));
      expect(svg).not.toMatch(/<(text|image|use|foreignObject|script)\b|font-family|href=|https?:\/\/(?!www\.w3\.org)/);
      expect(svg).not.toContain('NaN');
      expect(svg).toContain(
        `<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="${String(artwork.seed)}"`,
      );
      expect(svg).toMatch(/filter="url\(#grain\d+\)"[^>]*\/><\/svg>$/);
    }
  });

  it('every committed JPEG has the size of its piece and carries no metadata', async () => {
    for (const artwork of SEED_ARTWORKS) {
      const meta = await sharp(committed.get(artwork.slug)).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: artwork.width, height: artwork.height });
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
  });

  it('every committed JPEG still shows what pieces.ts draws (regenerate after an artwork change)', async () => {
    // Compared as small greyscale thumbnails with a tolerance, not byte for byte: JPEG encoders and librsvg builds
    // differ slightly between platforms, a changed picture differs a lot.
    const thumbnail = (input: Buffer | undefined) =>
      sharp(input).resize(48, 48, { fit: 'fill' }).greyscale().raw().toBuffer();
    for (const artwork of SEED_ARTWORKS) {
      const fresh = await thumbnail(rendered.get(artwork.slug));
      const stored = await thumbnail(committed.get(artwork.slug));
      const meanDifference =
        fresh.reduce((sum, value, index) => sum + Math.abs(value - (stored[index] ?? 0)), 0) / fresh.length;
      expect(meanDifference, artwork.slug).toBeLessThan(2);
    }
  });

  it('refuses a piece larger than the seed limit', async () => {
    const artwork = SEED_ARTWORKS[0];
    if (!artwork) throw new Error('no artwork');
    await expect(renderJpeg({ ...artwork, width: SEED_MAX_EDGE + 1 })).rejects.toThrow(/exceeds 1600 px/);
  });

  it('the committed CREDITS.md is what the generator writes', async () => {
    expect(await readFile(join(SEED_IMAGES_DIR, 'CREDITS.md'), 'utf8')).toBe(renderCredits());
  });
});

describe('seededRandom', () => {
  it('repeats its sequence for the same seed and stays in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(values[0]);
  });
});
