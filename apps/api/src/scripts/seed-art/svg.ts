/*
 * A few string builders for the seed artwork (ADR 0014). Every piece is plain SVG 1.1 that librsvg (inside sharp)
 * renders: flat fills, strokes, clip paths and the occasional pattern. No text, no fonts, no external references, so
 * the output depends only on the code and the seed.
 */

/** Mulberry32: tiny, fast and deterministic. Good enough for "slightly irregular", not for anything secret. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two decimals are far below a pixel and keep the markup short and stable. */
export const n = (value: number): string => String(Math.round(value * 100) / 100);

type Attrs = Record<string, string | number | undefined>;

function attrs(values: Attrs): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${typeof value === 'number' ? n(value) : value}"`)
    .join('');
}

export const el = (tag: string, values: Attrs, children = ''): string =>
  children === '' ? `<${tag}${attrs(values)}/>` : `<${tag}${attrs(values)}>${children}</${tag}>`;

export const rect = (x: number, y: number, width: number, height: number, fill: string, extra: Attrs = {}) =>
  el('rect', { x, y, width, height, fill, ...extra });

export const circle = (cx: number, cy: number, r: number, fill: string, extra: Attrs = {}) =>
  el('circle', { cx, cy, r, fill, ...extra });

export const ring = (cx: number, cy: number, r: number, stroke: string, width: number, extra: Attrs = {}) =>
  el('circle', { cx, cy, r, fill: 'none', stroke, 'stroke-width': width, ...extra });

export type Point = readonly [number, number];

const points = (list: readonly Point[]): string => list.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');

export const polygon = (list: readonly Point[], fill: string, extra: Attrs = {}) =>
  el('polygon', { points: points(list), fill, ...extra });

export const polyline = (list: readonly Point[], stroke: string, width: number, extra: Attrs = {}) =>
  el('polyline', { points: points(list), fill: 'none', stroke, 'stroke-width': width, ...extra });

export const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width: number,
  extra: Attrs = {},
) => el('line', { x1, y1, x2, y2, stroke, 'stroke-width': width, ...extra });

export const path = (d: string, fill: string, extra: Attrs = {}) => el('path', { d, fill, ...extra });

export const group = (children: string, extra: Attrs = {}) => el('g', extra, children);

/** Polar to cartesian; angles in degrees, 0° pointing right, growing clockwise (SVG's y axis points down). */
export function polar(cx: number, cy: number, r: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
}

/** A pie wedge from `from`° to `to`° (clockwise) with radius `r`. */
export function wedge(cx: number, cy: number, r: number, from: number, to: number): string {
  return `M${n(cx)} ${n(cy)}L${arc(cx, cy, r, from, to).slice(1)}Z`;
}

/** An open arc stroke from `from`° to `to`° (clockwise). */
export function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const large = to - from > 180 ? '1' : '0';
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M${n(x1)} ${n(y1)}A${n(r)} ${n(r)} 0 ${large} 1 ${n(x2)} ${n(y2)}`;
}

/** `count` alternating wedges between `from`° and `to`°, coloured from `colours` in turn. */
export function sunburst(
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
  count: number,
  colours: readonly string[],
): string {
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, index) =>
    path(wedge(cx, cy, r, from + index * step, from + (index + 1) * step), colours[index % colours.length] ?? 'none'),
  ).join('');
}

/** Mirrors a list of points across the vertical line x = `axis` (for symmetric shapes drawn as one half). */
export const mirror = (list: readonly Point[], axis: number): Point[] =>
  [...list].reverse().map(([x, y]) => [2 * axis - x, y] as const);

/** A stepped (ziggurat) outline: `steps` as [halfWidth, topY] pairs from the base upwards, centred on `cx`. */
export function ziggurat(cx: number, baseY: number, steps: readonly (readonly [number, number])[]): Point[] {
  const left: Point[] = [];
  let previousY = baseY;
  for (const [half, top] of steps) {
    left.push([cx - half, previousY], [cx - half, top]);
    previousY = top;
  }
  return [...left, ...mirror(left, cx)];
}

export interface Canvas {
  width: number;
  height: number;
  /** When set, `document()` lays a matte paper grain over the whole picture, seeded with this number. */
  grainSeed?: number;
}

/** A fine paper grain (feTurbulence takes the seed, so it is deterministic), multiplied over the picture. */
function grain({ width, height }: Canvas, seed: number): { defs: string; layer: string } {
  const id = `grain${String(seed)}`;
  return {
    defs:
      `<filter id="${id}" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="${String(seed)}" stitchTiles="stitch"/>` +
      '<feColorMatrix type="saturate" values="0"/></filter>',
    layer: rect(0, 0, width, height, '#000', { filter: `url(#${id})`, opacity: 0.2, style: 'mix-blend-mode:multiply' }),
  };
}

/** The root element. `defs` holds clip paths and patterns; the grain (if the canvas asks for it) goes on top. */
export function document(canvas: Canvas, body: string, defs = ''): string {
  const { width, height } = canvas;
  const paper = canvas.grainSeed === undefined ? { defs: '', layer: '' } : grain(canvas, canvas.grainSeed);
  const allDefs = defs + paper.defs;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" ` +
    `viewBox="0 0 ${String(width)} ${String(height)}" shape-rendering="geometricPrecision">` +
    (allDefs === '' ? '' : `<defs>${allDefs}</defs>`) +
    body +
    paper.layer +
    '</svg>'
  );
}

/** Where a `petal()` sits and its outline, ready to be painted with `paint()`. */
export interface PetalShape {
  transform: string;
  d: string;
}

/**
 * A petal or leaf: a pointed teardrop of `length` and `width` growing from (x, y) in direction `degrees` (0° points
 * up, growing clockwise). `bulge` moves the widest point along the length (0.3 = near the base, 0.6 = near the tip).
 */
export function petal(x: number, y: number, length: number, width: number, degrees: number, bulge = 0.4): PetalShape {
  const w = width / 2;
  const a = -length * bulge;
  const b = -length * (bulge + 0.35);
  return {
    transform: `translate(${n(x)} ${n(y)}) rotate(${n(degrees)})`,
    d: `M0 0C${n(w * 1.3)} ${n(a)} ${n(w * 0.7)} ${n(b)} 0 ${n(-length)}C${n(-w * 0.7)} ${n(b)} ${n(-w * 1.3)} ${n(a)} 0 0Z`,
  };
}

export const paint = (shape: PetalShape, fill: string, extra: Attrs = {}): string =>
  el('path', { ...shape, fill, ...extra });

/** The `d` of a row of half circles (scalloped waves) of radius `r` along y, shifted left by `offset`. */
export function scallopRow(y: number, r: number, offset: number, width: number): string {
  let d = `M${n(-offset)} ${n(y)}`;
  for (let x = -offset; x < width + 2 * r; x += 2 * r) d += `A${n(r)} ${n(r)} 0 0 1 ${n(x + 2 * r)} ${n(y)}`;
  return d;
}

/** A smooth curve through `list` (Catmull-Rom converted to cubic Béziers), optionally closed. */
export function smooth(list: readonly Point[], closed = false): string {
  const count = list.length;
  const at = (index: number): Point => {
    const wrapped = closed ? ((index % count) + count) % count : Math.min(Math.max(index, 0), count - 1);
    return list[wrapped] ?? [0, 0];
  };
  const [sx, sy] = at(0);
  let d = `M${n(sx)} ${n(sy)}`;
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const [x0, y0] = at(index - 1);
    const [x1, y1] = at(index);
    const [x2, y2] = at(index + 1);
    const [x3, y3] = at(index + 2);
    d +=
      `C${n(x1 + (x2 - x0) / 6)} ${n(y1 + (y2 - y0) / 6)} ` +
      `${n(x2 - (x3 - x1) / 6)} ${n(y2 - (y3 - y1) / 6)} ${n(x2)} ${n(y2)}`;
  }
  return closed ? `${d}Z` : d;
}

/** A five-pointed star (or any `spikes`) centred on (cx, cy). */
export function star(cx: number, cy: number, outer: number, inner: number, spikes = 5): Point[] {
  return Array.from({ length: spikes * 2 }, (_, index) =>
    polar(cx, cy, index % 2 === 0 ? outer : inner, -90 + (index * 180) / spikes),
  );
}
