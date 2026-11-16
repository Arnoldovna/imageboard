import { animationTooLong, fileMessages, type ImageMimeType } from '@app/shared';
import sharp, { type FormatEnum, type Metadata, type Sharp } from 'sharp';

import { InvalidImageError } from '../../shared/errors/app-error.js';
import { ANIMATED_TYPES, ENCODERS, type ImageLimits, PREVIEW } from './upload.config.js';

/** The normalised original and its preview, ready to store. Nothing here came from the client except pixels. */
export interface ProcessedImage {
  /** Re-encoded in the detected format, oriented, inside `maxEdge`, without EXIF/XMP/IPTC (F-22, B-06). */
  original: Buffer;
  /** First frame, inside 960 px, WebP (ADR 0018). */
  preview: Buffer;
  /** Of the stored original; for an animation the size of one frame. */
  width: number;
  height: number;
}

export interface ImageProcessor {
  /** `mimeType` is the sniffed type (image-sniffer.ts). Throws `InvalidImageError` (400) for anything it cannot use. */
  process(bytes: Buffer, mimeType: ImageMimeType): Promise<ProcessedImage>;
}

/** The libvips loader that must decode each sniffed type; anything else is a polyglot and is refused. */
const DECODER: Readonly<Record<ImageMimeType, keyof FormatEnum>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Fails on corrupt pixel data instead of storing a half-decoded image (ADR 0005). */
const FAIL_ON = 'error';

interface Inspection {
  frameWidth: number;
  frameHeight: number;
  /** Frames sharp will decode: all of them for GIF/WebP, one otherwise (APNG is read as its first frame). */
  decodedFrames: number;
}

function unreadable(cause: unknown): InvalidImageError {
  return new InvalidImageError(fileMessages.unreadable, cause);
}

/** sharp rejects with plain Errors; anything that is already an InvalidImageError keeps its message. */
function asInvalidImage(error: unknown): InvalidImageError {
  return error instanceof InvalidImageError ? error : unreadable(error);
}

async function readHeader(bytes: Buffer): Promise<Metadata> {
  try {
    // Header only. No pixel limit here: the per-frame check below must report "too large", not "unreadable".
    return await sharp(bytes, { failOn: FAIL_ON, limitInputPixels: false }).metadata();
  } catch (error) {
    throw unreadable(error);
  }
}

/**
 * Decompression-bomb guard before any pixel is decoded (ADR 0005): pixels per frame against UPLOAD_MAX_PIXELS and
 * frames against UPLOAD_MAX_FRAMES. The limit is per frame, so an ordinary animated GIF with many small frames passes.
 */
async function inspect(bytes: Buffer, mimeType: ImageMimeType, limits: ImageLimits): Promise<Inspection> {
  const metadata = await readHeader(bytes);
  if (metadata.format !== DECODER[mimeType]) {
    throw unreadable(new Error(`sniffed ${mimeType}, but libvips reads the bytes as ${metadata.format}`));
  }
  const frameWidth = metadata.width;
  const frameHeight = metadata.pageHeight ?? metadata.height;
  const frames = metadata.pages ?? 1;
  if (frameWidth * frameHeight > limits.maxPixels) throw new InvalidImageError(fileMessages.tooManyPixels);
  if (frames > limits.maxFrames) throw new InvalidImageError(animationTooLong(limits.maxFrames));
  return { frameWidth, frameHeight, decodedFrames: ANIMATED_TYPES.has(mimeType) ? frames : 1 };
}

function encode(pipeline: Sharp, mimeType: ImageMimeType): Sharp {
  switch (mimeType) {
    case 'image/jpeg':
      return pipeline.jpeg(ENCODERS.jpeg);
    case 'image/png':
      return pipeline.png(ENCODERS.png);
    case 'image/webp':
      return pipeline.webp(ENCODERS.webp);
    case 'image/gif':
      return pipeline.gif(ENCODERS.gif);
  }
}

function inside(maxEdge: number) {
  return { width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true } as const;
}

/**
 * The sharp pipeline of ADR 0005 and ADR 0018: inspect the header, decode with a pixel limit computed from the
 * inspected values (sharp applies `limitInputPixels` to the whole frame strip of an animation), orient by EXIF,
 * shrink inside `maxEdge`, re-encode in the same format without metadata, then render the preview from the
 * normalised original. Everything happens in memory; no temporary file exists at any step (B-19, B-34).
 */
export function createImageProcessor(limits: ImageLimits): ImageProcessor {
  return {
    async process(bytes, mimeType) {
      const { frameWidth, frameHeight, decodedFrames } = await inspect(bytes, mimeType, limits);
      try {
        const decoder = sharp(bytes, {
          failOn: FAIL_ON,
          limitInputPixels: frameWidth * frameHeight * decodedFrames + 1,
          animated: ANIMATED_TYPES.has(mimeType),
        });
        const normalised = encode(decoder.rotate().resize(inside(limits.maxEdge)), mimeType);
        const { data: original, info } = await normalised.toBuffer({ resolveWithObject: true });
        // The original was just encoded by sharp from bounded input, so decoding its first frame is safe.
        const preview = await sharp(original, { failOn: FAIL_ON, pages: 1 })
          .resize(inside(PREVIEW.maxEdge))
          .webp({ quality: PREVIEW.quality })
          .toBuffer();
        return { original, preview, width: info.width, height: info.pageHeight ?? info.height };
      } catch (error) {
        throw asInvalidImage(error);
      }
    },
  };
}
