import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Plugin } from 'vite';

// Build-time only (vite.demo.config.ts): the demo seed is the real seed of `pnpm db:seed`, read from the API's seed
// content and pictures (joined and checked exactly like `db:seed` does), so the two can never drift. The production build
// and the web Docker image never load this file.
import { joinSeed, readManifest, SEED_IMAGES_DIR, SEED_OWNER_ID } from '../../api/src/scripts/seed-content';

export const DEMO_SEED_MODULE_ID = 'virtual:demo-seed';
const RESOLVED_DEMO_SEED_MODULE_ID = `\0${DEMO_SEED_MODULE_ID}`;

export interface ImageSize {
  width: number;
  height: number;
}

/** Start-of-frame markers carry the frame size: SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Width and height from a JPEG's start-of-frame segment. Enough for the seed pictures (baseline or progressive, no
 * EXIF rotation); throws on anything that is not a well-formed JPEG, so a broken seed file fails the build.
 */
export function jpegSize(bytes: Uint8Array): ImageSize {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) throw new Error('not a JPEG (no SOI marker)');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (view.getUint8(offset) !== 0xff) throw new Error(`invalid JPEG marker at byte ${String(offset)}`);
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) break;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width === 0 || height === 0) throw new Error('JPEG frame without a size');
      return { width, height };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG without a start-of-frame segment');
}

/**
 * Source of `virtual:demo-seed`: one asset import per picture (`apps/api/seed/images/<slug>.jpg`, original artwork, MIT) plus
 * the seed owner, text, sizes and comments, in upload order.
 */
export async function demoSeedModuleSource(photosDir: string = SEED_IMAGES_DIR): Promise<string> {
  const entries = joinSeed(await readManifest(photosDir));
  const modules = await Promise.all(
    entries.map(async ({ image }, index) => {
      const path = join(photosDir, `${image.slug}.jpg`);
      const data = {
        ...jpegSize(await readFile(path)),
        mimeType: 'image/jpeg',
        authorName: image.authorName,
        title: image.title,
        description: image.description,
        createdAt: image.createdAt,
        comments: image.comments,
      };
      const name = `photo${String(index)}`;
      return {
        line: `import ${name} from ${JSON.stringify(path)};`,
        item: `{ url: ${name}, ...${JSON.stringify(data)} }`,
      };
    }),
  );
  const imports = modules.map(({ line }) => line).join('\n');
  const images = modules.map(({ item }) => item).join(',\n');
  return `${imports}\nexport const DEMO_SEED = {\nownerId: ${JSON.stringify(SEED_OWNER_ID)},\nimages: [\n${images}\n],\n};\n`;
}

/** Provides `virtual:demo-seed` (typed in src/demo/demo-seed.d.ts). Vite emits each photo as a hashed asset. */
export function demoSeedPlugin(): Plugin {
  return {
    name: 'imageboard:demo-seed',
    resolveId(id) {
      return id === DEMO_SEED_MODULE_ID ? RESOLVED_DEMO_SEED_MODULE_ID : undefined;
    },
    async load(id) {
      return id === RESOLVED_DEMO_SEED_MODULE_ID ? demoSeedModuleSource() : undefined;
    },
  };
}

/**
 * GitHub Pages has no rewrites: it serves `404.html` for unknown paths. A copy of `index.html` there boots the SPA on
 * every deep link (`/imageboard/images/3`), and Vue Router renders the matching route or the not-found page.
 */
export function spaFallbackPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'imageboard:spa-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      await copyFile(join(outDir, 'index.html'), join(outDir, '404.html'));
    },
  };
}
