import { crc32, deflateSync } from 'node:zlib';

/*
 * Self-made image fixtures for upload tests (ADR 0005). Every byte is generated here with Node built-ins, so nothing
 * binary is committed and nothing comes from the legacy project or third parties. Encoding the inputs without the
 * library under test (sharp) also keeps them independent of it.
 *
 * - jpegWithGps(): baseline greyscale JPEG with an EXIF APP1 segment: Orientation 6 and a GPS IFD (B-06).
 * - png(), apng(), webp(), gif(frames): valid images of the allowed types; APNG and animated GIF for the frame rules.
 * - svg, htmlAsPng, pdf, oversize(): content that must be rejected (415 / 413, B-04, B-05).
 */

export interface Size {
  width: number;
  height: number;
}

type Rgb = readonly [number, number, number];

// ---------------------------------------------------------------- PNG / APNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), typeAndData, u32(crc32(typeAndData))]);
}

function ihdr({ width, height }: Size): Buffer {
  // 8-bit truecolour, no interlace.
  return pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]));
}

/** zlib stream of filter-type-0 scanlines: a horizontal two-colour split, so orientation changes are visible. */
function pngImageData({ width, height }: Size, left: Rgb, right: Rgb): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(x < width / 2 ? left : right, 1 + x * 3);
  return deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
}

export function png(size: Size = { width: 24, height: 16 }): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(size),
    pngChunk('IDAT', pngImageData(size, [184, 211, 243], [20, 20, 20])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fctl(sequence: number, { width, height }: Size): Buffer {
  // x/y offset 0, delay 1/10 s, dispose none, blend source.
  return pngChunk(
    'fcTL',
    Buffer.concat([u32(sequence), u32(width), u32(height), u32(0), u32(0), u16(1), u16(10), Buffer.from([0, 0])]),
  );
}

/** Animated PNG with two frames. file-type reports it as image/apng; the API stores it as a static PNG (F-19). */
export function apng(size: Size = { width: 24, height: 16 }): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(size),
    pngChunk('acTL', Buffer.concat([u32(2), u32(0)])),
    fctl(0, size),
    pngChunk('IDAT', pngImageData(size, [184, 211, 243], [20, 20, 20])),
    fctl(1, size),
    pngChunk('fdAT', Buffer.concat([u32(2), pngImageData(size, [20, 20, 20], [184, 211, 243])])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- GIF

const GIF_PALETTE: readonly Rgb[] = [
  [255, 255, 255],
  [184, 211, 243],
  [20, 20, 20],
  [120, 120, 120],
];

function u16le(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** Packs codes LSB-first, as GIF's LZW stream requires. */
function packBits(codes: readonly number[], width: number): Buffer {
  const bytes: number[] = [];
  let current = 0;
  let filled = 0;
  for (const code of codes) {
    for (let bit = 0; bit < width; bit += 1) {
      current |= ((code >> bit) & 1) << filled;
      filled += 1;
      if (filled === 8) {
        bytes.push(current);
        current = 0;
        filled = 0;
      }
    }
  }
  if (filled > 0) bytes.push(current);
  return Buffer.from(bytes);
}

function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const block = data.subarray(offset, offset + 255);
    parts.push(Buffer.from([block.length]), block);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * LZW image data for a frame of one palette index. A clear code before every pixel keeps the dictionary empty, so
 * every code is 3 bits wide (minimum code size 2: clear = 4, end = 5). Valid, just not compressed.
 */
function gifFrameData(pixels: number, index: number): Buffer {
  const clear = 4;
  const end = 5;
  const codes: number[] = [];
  for (let pixel = 0; pixel < pixels; pixel += 1) codes.push(clear, index);
  codes.push(end);
  return Buffer.concat([Buffer.from([2]), subBlocks(packBits(codes, 3))]);
}

/** Animated GIF89a with `frames` frames (150 passes the default cap of 200, 201 does not). */
export function gif(frames = 2, size: Size = { width: 8, height: 8 }): Buffer {
  const header = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    u16le(size.width),
    u16le(size.height),
    // Global colour table of 4 entries (2^(1+1)), colour resolution 1 bit, background 0, no aspect ratio.
    Buffer.from([0x81, 0, 0]),
    Buffer.from(GIF_PALETTE.flat()),
    // NETSCAPE2.0 application extension: loop forever.
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'latin1'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);
  const body: Buffer[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    body.push(
      // Graphic control extension: dispose "do not dispose", 0.1 s delay, no transparency.
      Buffer.from([0x21, 0xf9, 0x04, 0x04]),
      u16le(10),
      Buffer.from([0x00, 0x00]),
      // Image descriptor: full frame, no local colour table.
      Buffer.from([0x2c]),
      u16le(0),
      u16le(0),
      u16le(size.width),
      u16le(size.height),
      Buffer.from([0x00]),
      gifFrameData(size.width * size.height, 1 + (frame % 3)),
    );
  }
  return Buffer.concat([header, ...body, Buffer.from([0x3b])]);
}

// ---------------------------------------------------------------- JPEG with EXIF (orientation + GPS)

/** Values written into the EXIF GPS IFD, so tests can assert they are gone after processing (B-06). */
export const FIXTURE_GPS = {
  latitude: [52, 31, 12],
  latitudeRef: 'N',
  longitude: [13, 24, 36],
  longitudeRef: 'E',
} as const;

function jpegSegment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
}

interface IfdEntry {
  tag: number;
  type: number; // 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL
  count: number;
  /** Inline value (≤ 4 bytes, left-aligned) or data placed after the IFD. */
  value: Buffer;
}

/** Little-endian TIFF: IFD0 (Orientation, pointer to the GPS IFD), then the GPS IFD and its rational values. */
function exifTiff(orientation: number): Buffer {
  const le16 = u16le;
  const le32 = u32le;
  const rationals = (values: readonly number[]) => Buffer.concat(values.flatMap((value) => [le32(value), le32(1)]));
  const inline = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(4 - bytes.length)]);

  const ifdSize = (entries: number) => 2 + entries * 12 + 4;
  const ifd0Offset = 8;
  const gpsOffset = ifd0Offset + ifdSize(2);
  const gpsDataOffset = gpsOffset + ifdSize(5);
  const latitude = rationals(FIXTURE_GPS.latitude);
  const longitude = rationals(FIXTURE_GPS.longitude);

  const writeIfd = (entries: IfdEntry[]) =>
    Buffer.concat([
      le16(entries.length),
      ...entries.map((entry) => Buffer.concat([le16(entry.tag), le16(entry.type), le32(entry.count), entry.value])),
      le32(0),
    ]);

  const ifd0 = writeIfd([
    { tag: 0x0112, type: 3, count: 1, value: inline(le16(orientation)) },
    { tag: 0x8825, type: 4, count: 1, value: le32(gpsOffset) },
  ]);
  const gpsIfd = writeIfd([
    { tag: 0x0000, type: 1, count: 4, value: Buffer.from([2, 3, 0, 0]) },
    { tag: 0x0001, type: 2, count: 2, value: inline(Buffer.from(`${FIXTURE_GPS.latitudeRef}\0`, 'latin1')) },
    { tag: 0x0002, type: 5, count: 3, value: le32(gpsDataOffset) },
    { tag: 0x0003, type: 2, count: 2, value: inline(Buffer.from(`${FIXTURE_GPS.longitudeRef}\0`, 'latin1')) },
    { tag: 0x0004, type: 5, count: 3, value: le32(gpsDataOffset + latitude.length) },
  ]);
  return Buffer.concat([Buffer.from('II*\0', 'latin1'), le32(ifd0Offset), ifd0, gpsIfd, latitude, longitude]);
}

/**
 * Baseline greyscale JPEG of uniform mid grey. With all-ones quantisation and one-symbol Huffman tables (DC
 * category 0, AC end-of-block), every 8×8 block is two zero bits. Orientation 6 means "rotate 90° clockwise to
 * display", so a 32×16 stored image is 16×32 after `.rotate()`.
 */
export function jpegWithGps(size: Size = { width: 32, height: 16 }, orientation = 6): Buffer {
  const blocks = Math.ceil(size.width / 8) * Math.ceil(size.height / 8);
  const bits = 2 * blocks;
  const scan = Buffer.alloc(Math.ceil(bits / 8), 0);
  // Pad the last byte with 1-bits, as the standard requires.
  if (bits % 8 !== 0) scan[scan.length - 1] = 0xff >> (bits % 8);
  const oneSymbolTable = (tableClass: number) =>
    Buffer.concat([Buffer.from([tableClass]), Buffer.from([1, ...Array<number>(15).fill(0)]), Buffer.from([0])]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(orientation)])),
    jpegSegment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])),
    jpegSegment(
      0xc0,
      Buffer.concat([Buffer.from([8]), u16(size.height), u16(size.width), Buffer.from([1, 1, 0x11, 0])]),
    ),
    jpegSegment(0xc4, oneSymbolTable(0x00)),
    jpegSegment(0xc4, oneSymbolTable(0x10)),
    jpegSegment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---------------------------------------------------------------- WebP (lossless VP8L)

/** Bit writer for VP8L, which is LSB-first like GIF. */
class BitWriter {
  private readonly bytes: number[] = [];
  private position = 0;

  write(value: number, count: number): this {
    for (let bit = 0; bit < count; bit += 1) {
      const byte = this.position >> 3;
      this.bytes[byte] = (this.bytes[byte] ?? 0) | (((value >> bit) & 1) << (this.position & 7));
      this.position += 1;
    }
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** A "simple" prefix code with one symbol: zero bits per pixel for that channel. */
function singleSymbolCode(writer: BitWriter, symbol: number): void {
  writer.write(1, 1).write(0, 1); // simple code, one symbol
  if (symbol < 2) writer.write(0, 1).write(symbol, 1);
  else writer.write(1, 1).write(symbol, 8);
}

/** Solid-colour lossless WebP: no transforms, no colour cache, five one-symbol prefix codes, no pixel bits. */
export function webp(size: Size = { width: 24, height: 16 }, [red, green, blue]: Rgb = [184, 211, 243]): Buffer {
  const writer = new BitWriter()
    .write(0x2f, 8) // VP8L signature
    .write(size.width - 1, 14)
    .write(size.height - 1, 14)
    .write(0, 1) // alpha_is_used (hint)
    .write(0, 3) // version
    .write(0, 1) // no transform
    .write(0, 1) // no colour cache
    .write(0, 1); // no meta prefix codes
  for (const symbol of [green, red, blue, 255, 0]) singleSymbolCode(writer, symbol);
  const data = writer.toBuffer();
  const chunk = Buffer.concat([
    Buffer.from('VP8L', 'latin1'),
    u32le(data.length),
    data,
    data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(4 + chunk.length), Buffer.from('WEBP', 'latin1'), chunk]);
}

// ---------------------------------------------------------------- content that must be rejected

/** SVG with a script: an image to a browser, never to this API (415). */
export const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

/** HTML sent with a .png filename and image/png Content-Type (stored XSS in the legacy app, B-05). */
export const htmlAsPng = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

export const pdf = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

/** JPEG magic bytes followed by padding: rejected by size before anything is decoded (default 6 MiB > 5 MiB). */
export function oversize(bytes = 6 * 1024 * 1024): Buffer {
  const buffer = Buffer.alloc(bytes);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}
