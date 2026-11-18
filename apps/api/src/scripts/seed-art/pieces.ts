import {
  arc,
  type Canvas,
  circle,
  document,
  el,
  group,
  line,
  n,
  path,
  type Point,
  polar,
  polygon,
  polyline,
  rect,
  ring,
  seededRandom,
  sunburst,
  paint,
  petal,
  smooth,
  star,
  scallopRow,
  mirror,
  wedge,
  ziggurat,
} from './svg.js';

/*
 * The sixteen seed artworks (ADR 0014, DATA-MODEL §6.2): original compositions inspired by Art Nouveau and Art Deco in
 * general. Botanical pieces on a vertical axis (iris, tulips, lotus, whiplash stems), repeats and friezes, framed
 * medallions, a thin line drawing, Deco geometry (sunbursts, ziggurats, fans, thin gold on black) and a few reduced
 * bold graphics. Each piece is a function of its canvas and its own seeded random source, so a re-run draws exactly
 * the same picture; `renderSvg` lays the same matte paper grain over every piece. The gallery shows a centred 16:10
 * crop, so portrait pieces keep their subject in the middle band.
 */

const C = {
  black: '#0c0b0a',
  cream: '#efe4cb',
  paper: '#f3ead7',
  gold: '#c9a24b',
  goldPale: '#e3c88a',
  ochre: '#d0902f',
  mustard: '#e2aa2c',
  teal: '#0f4f53',
  tealDeep: '#0a3537',
  jade: '#3f8f73',
  jadePale: '#8cc3a5',
  oxblood: '#6c1e24',
  navy: '#17243f',
  navyDeep: '#0d1526',
  coral: '#e2684e',
  sand: '#e6d6b5',
  petrol: '#1d5459',
  olive: '#6f7136',
  oliveLight: '#a3a35a',
  violet: '#5f4b86',
  lavender: '#b4a3cc',
  salmon: '#e58f73',
  redOrange: '#dd4b26',
  lineBlue: '#2c4c8c',
  dotRed: '#cf3f2a',
} as const;

export interface SeedArtwork {
  /** Matches `SEED_IMAGES[].slug` and the manifest; the file is `<slug>.jpg`. */
  slug: string;
  width: number;
  height: number;
  /** Seed of the piece's random source (stars, lit windows, grain). */
  seed: number;
  draw: (canvas: Canvas, random: () => number) => string;
}

/** A double rule frame, inset from the edge, as on a printed poster. */
function frame({ width, height }: Canvas, colour: string, inset: number, gap = 14, heavy = 7, light = 2): string {
  return (
    rect(inset, inset, width - 2 * inset, height - 2 * inset, 'none', { stroke: colour, 'stroke-width': heavy }) +
    rect(inset + gap, inset + gap, width - 2 * (inset + gap), height - 2 * (inset + gap), 'none', {
      stroke: colour,
      'stroke-width': light,
    })
  );
}

const clip = (id: string, shape: string) => `<clipPath id="${id}">${shape}</clipPath>`;

// ------------------------------------------------------------------------------------------------ stepped tower

function steppedTower(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const tower = ziggurat(cx, H, [
    [290, 1180],
    [235, 990],
    [180, 850],
    [130, 735],
    [86, 640],
    [52, 565],
  ]);
  const spire: Point[] = [
    [cx - 30, 566],
    [cx, 300],
    [cx + 30, 566],
  ];
  const pinstripes = Array.from({ length: 23 }, (_, index) => {
    const x = cx - 275 + index * 25;
    return line(x, 300, x, H, C.gold, 3);
  }).join('');
  const ledges = [1180, 990, 850, 735, 640, 565]
    .map((y, index) => rect(cx - 300 + index * 50, y, 600 - index * 100, 12, C.black))
    .join('');
  const side = (x: number) =>
    polygon(
      ziggurat(x, H, [
        [150, 1270],
        [112, 1150],
        [74, 1075],
      ]),
      C.teal,
    ) + Array.from({ length: 5 }, (_, index) => rect(x - 60 + index * 26, 1100, 8, 500, C.tealDeep)).join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.cream) +
      sunburst(cx, 760, 1500, 0, 360, 56, [C.ochre, C.cream]) +
      circle(cx, 760, 318, C.coral) +
      ring(cx, 760, 350, C.coral, 6) +
      ring(cx, 760, 372, C.coral, 2) +
      side(170) +
      side(W - 170) +
      polygon(tower, C.black) +
      polygon(spire, C.black) +
      group(pinstripes, { 'clip-path': 'url(#tower)' }) +
      ledges +
      rect(0, H - 90, W, 90, C.black) +
      frame(canvas, C.black, 34),
    clip('tower', polygon(tower, '#000') + polygon(spire, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ night train

function nightTrain(canvas: Canvas, random: () => number): string {
  const { width: W, height: H } = canvas;
  const stars = Array.from({ length: 70 }, () =>
    circle(random() * W, random() * 380, 1.2 + random() * 2.2, C.cream, { opacity: n(0.5 + random() * 0.5) }),
  ).join('');
  const hills = [
    polygon(
      ziggurat(260, 700, [
        [300, 600],
        [210, 540],
        [120, 495],
      ]),
      C.navy,
    ),
    polygon(
      ziggurat(1380, 700, [
        [360, 620],
        [250, 560],
        [150, 520],
        [70, 490],
      ]),
      C.navy,
    ),
    polygon(
      ziggurat(860, 700, [
        [260, 640],
        [170, 600],
      ]),
      '#1e2f52',
    ),
  ].join('');
  const nose = 270;
  const body = `M${String(W + 20)} 455L${String(nose + 290)} 455C${String(nose + 120)} 455 ${String(nose + 10)} 545 ${String(nose)} 690L${String(W + 20)} 690Z`;
  const speed = [
    [500, 300, 1.0],
    [430, 335, 0.7],
    [600, 370, 0.85],
    [520, 405, 0.6],
  ]
    .map(([x, y, length]) => rect(x ?? 0, y ?? 0, (W - (x ?? 0)) * (length ?? 1) + 200, 6, C.cream, { opacity: 0.85 }))
    .join('');
  const windows = Array.from({ length: 11 }, (_, index) => rect(640 + index * 92, 492, 58, 34, C.goldPale)).join('');
  const stripes =
    rect(0, 568, W + 40, 22, C.cream) + rect(0, 606, W + 40, 10, C.cream) + rect(0, 632, W + 40, 5, C.cream);
  const wheels = Array.from({ length: 9 }, (_, index) => {
    const x = 480 + index * 135;
    return circle(x, 712, 40, C.black) + ring(x, 712, 26, C.gold, 4) + circle(x, 712, 8, C.gold);
  }).join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.navyDeep) +
      stars +
      speed +
      circle(1250, 250, 214, C.navyDeep) +
      circle(1250, 250, 140, C.cream) +
      ring(1250, 250, 172, C.cream, 3) +
      ring(1250, 250, 198, C.cream, 1.5) +
      hills +
      rect(0, 700, W, H - 700, '#0a1120') +
      line(0, 754, W, 754, C.gold, 5) +
      line(0, 772, W, 772, C.gold, 2) +
      Array.from({ length: 12 }, (_, index) => rect(index * 140 - 20, 780, 90, 14, '#1b2440')).join('') +
      wheels +
      path(body, C.coral) +
      group(windows + stripes, { 'clip-path': 'url(#train)' }) +
      rect(nose + 120, 676, W, 30, C.black) +
      circle(nose + 46, 640, 18, C.goldPale) +
      ring(nose + 46, 640, 30, C.goldPale, 3) +
      Array.from({ length: 6 }, (_, index) =>
        rect(0, 860 + index * 22, W, 6 - index * 0.6, C.navy, { opacity: 0.9 }),
      ).join(''),
    clip('train', path(body, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ peacock fan

function peacockFan(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const cy = 1210;
  const R = 760;
  const count = 26;
  const step = 180 / count;
  const fan = sunburst(cx, cy, R, 180, 360, count, [C.teal, C.jade]);
  const scallops = Array.from({ length: count }, (_, index) => {
    const [x, y] = polar(cx, cy, R, 180 + (index + 0.5) * step);
    return circle(x, y, 46, index % 2 === 0 ? C.teal : C.jade);
  }).join('');
  const spokes = Array.from({ length: count + 1 }, (_, index) => {
    const [x, y] = polar(cx, cy, R, 180 + index * step);
    return line(cx, cy, x, y, C.gold, 2);
  }).join('');
  const eyes = [
    [640, 44],
    [470, 32],
    [320, 22],
  ]
    .flatMap(([radius = 0, size = 0], row) =>
      Array.from({ length: count - row * 4 }, (_, index) => {
        const total = count - row * 4;
        const [x, y] = polar(cx, cy, radius, 180 + ((index + 0.5) * 180) / total);
        return circle(x, y, size, C.gold) + circle(x, y, size * 0.66, C.tealDeep) + circle(x, y, size * 0.34, C.navy);
      }),
    )
    .join('');
  const arcs = [700, 555, 395]
    .map((radius) => path(arc(cx, cy, radius, 180, 360), 'none', { stroke: C.gold, 'stroke-width': 3 }))
    .join('');
  const neck = `M${n(cx - 62)} 1090C${n(cx - 70)} 960 ${n(cx - 70)} 880 ${n(cx - 20)} 800C${n(cx + 10)} 760 ${n(cx + 60)} 770 ${n(cx + 52)} 820C${n(cx + 40)} 900 ${n(cx + 30)} 980 ${n(cx + 64)} 1090Z`;
  const crest = [-24, 0, 24]
    .map((dx) => line(cx + 18, 742, cx + 18 + dx * 1.8, 640, C.gold, 3) + circle(cx + 18 + dx * 1.8, 636, 11, C.gold))
    .join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.black) +
      scallops +
      fan +
      spokes +
      arcs +
      eyes +
      path(neck, '#1f4f8c') +
      el('ellipse', { cx, cy: 1180, rx: 112, ry: 160, fill: '#1f4f8c' }) +
      el('ellipse', { cx, cy: 1200, rx: 70, ry: 118, fill: '#2d6fb0' }) +
      circle(cx + 18, 770, 40, '#1f4f8c') +
      polygon(
        [
          [cx + 52, 760],
          [cx + 96, 776],
          [cx + 52, 790],
        ],
        C.gold,
      ) +
      circle(cx + 26, 764, 9, C.cream) +
      crest +
      polygon(
        ziggurat(cx, H, [
          [560, 1470],
          [440, 1400],
          [320, 1336],
        ]),
        C.gold,
      ) +
      line(cx - 560, 1470, cx + 560, 1470, C.black, 6) +
      line(cx - 440, 1400, cx + 440, 1400, C.black, 6) +
      Array.from({ length: 9 }, (_, index) => rect(cx - 280 + index * 70 - 6, 1350, 12, 40, C.black)).join(''),
  );
}

// ------------------------------------------------------------------------------------------------ gold line panel

function goldLinePanel(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const fy = 1430;
  const g = (d: string, width = 3) => path(d, 'none', { stroke: C.gold, 'stroke-width': width });
  const arcs = Array.from({ length: 8 }, (_, index) =>
    g(arc(cx, fy, 140 + index * 58, 180, 360), index % 3 === 0 ? 4 : 2),
  ).join('');
  const rays = Array.from({ length: 25 }, (_, index) => {
    const [x1, y1] = polar(cx, fy, 140, 180 + index * 7.5);
    const [x2, y2] = polar(cx, fy, 546, 180 + index * 7.5);
    return line(x1, y1, x2, y2, C.gold, 2);
  }).join('');
  const chevrons = Array.from({ length: 6 }, (_, index) => {
    const y = 150 + index * 30;
    return polyline(
      [
        [130, y],
        [cx, y + 190],
        [W - 130, y],
      ],
      C.gold,
      index === 0 ? 5 : 2,
    );
  }).join('');
  const columns = [150, W - 150]
    .map(
      (x) =>
        line(x, 470, x, 1080, C.gold, 3) +
        line(x - 14, 470, x - 14, 1080, C.gold, 1.5) +
        line(x + 14, 470, x + 14, 1080, C.gold, 1.5) +
        circle(x, 450, 12, C.gold) +
        circle(x, 1100, 12, C.gold),
    )
    .join('');
  const notch = 46;
  const inset = 60;
  const border: Point[] = [
    [inset + notch, inset],
    [W - inset - notch, inset],
    [W - inset - notch, inset + notch],
    [W - inset, inset + notch],
    [W - inset, H - inset - notch],
    [W - inset - notch, H - inset - notch],
    [W - inset - notch, H - inset],
    [inset + notch, H - inset],
    [inset + notch, H - inset - notch],
    [inset, H - inset - notch],
    [inset, inset + notch],
    [inset + notch, inset + notch],
  ];
  return document(
    canvas,
    rect(0, 0, W, H, C.black) +
      polygon(border, 'none', { stroke: C.gold, 'stroke-width': 5 }) +
      rect(inset + 22, inset + 22, W - 2 * inset - 44, H - 2 * inset - 44, 'none', {
        stroke: C.gold,
        'stroke-width': 1.5,
      }) +
      group(arcs + rays, { 'clip-path': 'url(#inner)' }) +
      path(wedge(cx, fy, 120, 180, 360), C.gold) +
      chevrons +
      ring(cx, 680, 150, C.gold, 3) +
      ring(cx, 680, 170, C.gold, 1.5) +
      sunburst(cx, 680, 140, 0, 360, 32, [C.gold, C.black]) +
      circle(cx, 680, 70, C.black) +
      ring(cx, 680, 56, C.gold, 3) +
      circle(cx, 680, 24, C.gold) +
      columns,
    clip('inner', rect(inset + 22, inset + 22, W - 2 * inset - 44, H - 2 * inset - 44, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ ocean liner

function oceanLiner(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const horizon = 720;
  const sun = { x: 1130, y: horizon, r: 360 };
  const sunBands = Array.from({ length: 7 }, (_, index) =>
    rect(0, horizon - 40 - index * 46, W, 6 + (6 - index) * 3, C.cream),
  ).join('');
  const hull: Point[] = [
    [110, 572],
    [1260, 600],
    [1225, 740],
    [270, 740],
  ];
  const decks =
    rect(330, 508, 790, 66, C.cream) +
    rect(400, 462, 640, 48, C.cream) +
    rect(480, 425, 470, 40, C.cream) +
    Array.from({ length: 30 }, (_, index) => circle(350 + index * 25.5, 540, 6, C.navy)).join('') +
    Array.from({ length: 24 }, (_, index) => rect(418 + index * 25.5, 478, 12, 14, C.navy)).join('');
  const funnel = (x: number) =>
    polygon(
      [
        [x, 428],
        [x + 34, 250],
        [x + 134, 250],
        [x + 100, 428],
      ],
      C.oxblood,
    ) +
    polygon(
      [
        [x + 28, 284],
        [x + 34, 250],
        [x + 134, 250],
        [x + 128, 284],
      ],
      C.black,
    );
  const waves = Array.from({ length: 7 }, (_, row) => {
    const y = horizon + 70 + row * 48;
    const r = 26 + row * 3;
    return path(scallopRow(y, r, row % 2 === 0 ? 0 : r, W), 'none', {
      stroke: row % 2 === 0 ? C.teal : '#25466e',
      'stroke-width': 5,
    });
  }).join('');
  const reflection = Array.from({ length: 6 }, (_, index) => {
    const half = 300 - index * 45;
    return rect(sun.x - half, horizon + 26 + index * 34, half * 2, 10, C.ochre);
  }).join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.cream) +
      group(circle(sun.x, sun.y, sun.r, C.ochre) + circle(sun.x, sun.y, sun.r - 70, C.coral) + sunBands, {
        'clip-path': 'url(#sky)',
      }) +
      rect(0, horizon, W, H - horizon, C.navy) +
      reflection +
      waves +
      funnel(520) +
      funnel(690) +
      funnel(860) +
      line(300, 560, 360, 330, C.black, 4) +
      line(1170, 590, 1150, 360, C.black, 4) +
      decks +
      polygon(hull, C.black) +
      group(rect(0, 690, W, 60, C.oxblood) + rect(0, 682, W, 6, C.cream), { 'clip-path': 'url(#hull)' }) +
      frame(canvas, C.black, 30, 12, 6, 2),
    clip('sky', rect(0, 0, W, horizon, '#000')) + clip('hull', polygon(hull, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ fountain

function fountain(canvas: Canvas, random: () => number): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const arches = Array.from({ length: 6 }, (_, index) => {
    const half = 520 - index * 60;
    const top = 150 + index * 60;
    return path(
      `M${n(cx - half)} ${n(H)}L${n(cx - half)} ${n(top + half)}A${n(half)} ${n(half)} 0 0 1 ${n(cx + half)} ${n(top + half)}L${n(cx + half)} ${n(H)}`,
      'none',
      {
        stroke: index === 0 ? C.gold : C.jade,
        'stroke-width': index === 0 ? 5 : 3,
      },
    );
  }).join('');
  const jets = Array.from({ length: 7 }, (_, index) => {
    const spread = 70 + index * 62;
    const peak = 360 + index * 34;
    const start = 610;
    const end = 1010 + index * 12;
    const curve = (side: number) =>
      path(
        `M${n(cx)} ${n(start)}Q${n(cx + side * spread * 0.9)} ${n(peak - 260)} ${n(cx + side * spread)} ${n(end)}`,
        'none',
        {
          stroke: index % 2 === 0 ? C.cream : C.jadePale,
          'stroke-width': 7 - index * 0.6,
          'stroke-linecap': 'round',
        },
      );
    return curve(-1) + curve(1);
  }).join('');
  const drops = Array.from({ length: 40 }, () => {
    const side = random() < 0.5 ? -1 : 1;
    const x = cx + side * (120 + random() * 400);
    const y = 1010 + random() * 120;
    return circle(x, y, 4 + random() * 5, C.cream, { opacity: n(0.6 + random() * 0.4) });
  }).join('');
  const bowl = (y: number, half: number, depth: number, colour: string) =>
    path(
      `M${n(cx - half)} ${n(y)}L${n(cx + half)} ${n(y)}Q${n(cx + half * 0.6)} ${n(y + depth)} ${n(cx)} ${n(y + depth)}Q${n(cx - half * 0.6)} ${n(y + depth)} ${n(cx - half)} ${n(y)}Z`,
      colour,
    );
  const pool = Array.from({ length: 13 }, (_, index) => circle(130 + index * 78.3, 1290, 39, C.jade)).join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.tealDeep) +
      arches +
      polygon(
        [
          [cx - 22, 1240],
          [cx - 9, 200],
          [cx + 9, 200],
          [cx + 22, 1240],
        ],
        C.cream,
      ) +
      circle(cx, 190, 22, C.cream) +
      circle(cx, 140, 12, C.cream) +
      circle(cx, 104, 7, C.cream) +
      jets +
      bowl(610, 150, 90, C.gold) +
      rect(cx - 26, 700, 52, 340, C.gold) +
      drops +
      pool +
      rect(0, 1290, W, H - 1290, C.jade) +
      Array.from({ length: 5 }, (_, index) => rect(0, 1340 + index * 52, W, 26, C.tealDeep)).join('') +
      bowl(1010, 360, 150, C.gold) +
      rect(cx - 80, 1160, 160, 130, C.gold) +
      rect(cx - 130, 1150, 260, 20, C.gold) +
      line(cx - 360, 1010, cx + 360, 1010, C.cream, 4) +
      frame(canvas, C.gold, 40, 14, 5, 2),
  );
}

// ------------------------------------------------------------------------------------------------ fan tiles

function fanTiles(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const r = 160;
  const schemes: [string, string, string][] = [
    [C.teal, C.cream, C.gold],
    [C.coral, C.cream, C.teal],
    [C.cream, C.teal, C.coral],
    [C.gold, C.teal, C.cream],
  ];
  let out = rect(0, 0, W, H, C.teal);
  for (let row = 0; row * (r * 0.62) < H + r * 2; row += 1) {
    const y = -r + row * r * 0.62;
    const offset = row % 2 === 0 ? 0 : r;
    for (let x = -r + offset; x < W + 2 * r; x += 2 * r) {
      const [base, band, centre] = schemes[(row + Math.round(x / (2 * r))) % schemes.length] ?? [
        C.teal,
        C.cream,
        C.gold,
      ];
      out +=
        circle(x, y, r, base) +
        ring(x, y, r * 0.82, band, r * 0.09) +
        ring(x, y, r * 0.6, band, r * 0.05) +
        ring(x, y, r * 0.42, band, r * 0.03) +
        circle(x, y, r * 0.2, centre) +
        ring(x, y, r - 3, C.black, 3);
    }
  }
  return document(canvas, out);
}

// ------------------------------------------------------------------------------------------------ leaping antelope

function leapingAntelope(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const sun = { x: cx, y: 760, r: 400 };
  const leg = (list: Point[], width: number) =>
    polyline(list, C.black, width, { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const body: Point[] = [
    [395, 780],
    [470, 715],
    [640, 690],
    [770, 700],
    [835, 735],
    [820, 800],
    [700, 835],
    [520, 840],
    [430, 825],
  ];
  const neck: Point[] = [
    [760, 712],
    [850, 585],
    [905, 600],
    [835, 770],
  ];
  const head: Point[] = [
    [845, 580],
    [905, 548],
    [975, 590],
    [968, 610],
    [905, 618],
  ];
  const horn = (dx: number) =>
    path(`M${n(870 + dx)} 568C${n(840 + dx)} 470 ${n(760 + dx)} 420 ${n(690 + dx)} 400`, 'none', {
      stroke: C.black,
      'stroke-width': 13,
      'stroke-linecap': 'round',
    });
  const plant = (x: number, flip: number) =>
    sunburst(x, H - 150, 230, flip > 0 ? 200 : 250, flip > 0 ? 290 : 340, 9, [C.gold, C.oxblood]) +
    circle(x, H - 150, 34, C.gold);
  return document(
    canvas,
    rect(0, 0, W, H, C.oxblood) +
      circle(sun.x, sun.y, sun.r + 120, '#7d2a2d') +
      ring(sun.x, sun.y, sun.r + 60, C.gold, 3) +
      ring(sun.x, sun.y, sun.r + 84, C.gold, 1.5) +
      circle(sun.x, sun.y, sun.r, C.cream) +
      group(
        Array.from({ length: 8 }, (_, index) => rect(0, sun.y + 60 + index * 42, W, 8 + index * 3.5, C.oxblood)).join(
          '',
        ),
        { 'clip-path': 'url(#sun)' },
      ) +
      plant(130, 1) +
      plant(W - 130, -1) +
      polygon(
        ziggurat(cx, H, [
          [600, 1360],
          [470, 1300],
          [330, 1250],
        ]),
        C.black,
      ) +
      line(cx - 600, 1360, cx + 600, 1360, C.gold, 4) +
      line(cx - 470, 1300, cx + 470, 1300, C.gold, 4) +
      line(cx - 330, 1250, cx + 330, 1250, C.gold, 4) +
      horn(0) +
      horn(-26) +
      leg(
        [
          [770, 780],
          [890, 840],
          [1010, 800],
        ],
        20,
      ) +
      leg(
        [
          [745, 800],
          [860, 880],
          [985, 870],
        ],
        18,
      ) +
      leg(
        [
          [470, 790],
          [330, 860],
          [190, 960],
        ],
        22,
      ) +
      leg(
        [
          [500, 815],
          [360, 910],
          [230, 1020],
        ],
        19,
      ) +
      path('M410 760Q350 720 330 690', 'none', { stroke: C.black, 'stroke-width': 14, 'stroke-linecap': 'round' }) +
      polygon(body, C.black) +
      polygon(neck, C.black) +
      polygon(head, C.black) +
      polygon(
        [
          [860, 585],
          [835, 548],
          [880, 570],
        ],
        C.black,
      ) +
      circle(915, 580, 6, C.gold) +
      line(470, 760, 800, 742, C.gold, 3) +
      frame(canvas, C.gold, 40, 14, 5, 2),
    clip('sun', circle(sun.x, sun.y, sun.r, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ sunburst door

function sunburstDoor(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const outer = ziggurat(cx, H, [
    [420, 260],
    [380, 200],
    [330, 150],
  ]);
  const archTop = 330;
  const archHalf = 300;
  const archBase = archTop + archHalf;
  const opening = `M${n(cx - archHalf)} 1340L${n(cx - archHalf)} ${n(archBase)}A${n(archHalf)} ${n(archHalf)} 0 0 1 ${n(cx + archHalf)} ${n(archBase)}L${n(cx + archHalf)} 1340Z`;
  const panel = (x: number) => {
    let out =
      rect(x, 830, 270, 510, C.black) + rect(x + 16, 846, 238, 478, 'none', { stroke: C.gold, 'stroke-width': 3 });
    for (let index = 0; index < 7; index += 1) {
      const y = 900 + index * 56;
      out += polyline(
        [
          [x + 40, y],
          [x + 135, y + 40],
          [x + 230, y],
        ],
        C.gold,
        index % 2 === 0 ? 5 : 2,
      );
    }
    return out;
  };
  return document(
    canvas,
    rect(0, 0, W, H, C.cream) +
      polygon(outer, C.black) +
      path(opening, C.ochre) +
      group(sunburst(cx, archBase + 200, 700, 180, 360, 24, [C.black, C.ochre]), { 'clip-path': 'url(#arch)' }) +
      group(
        circle(cx, archBase + 200, 210, C.gold) +
          ring(cx, archBase + 200, 240, C.gold, 6) +
          ring(cx, archBase + 200, 262, C.gold, 2),
        {
          'clip-path': 'url(#arch)',
        },
      ) +
      rect(cx - archHalf, 810, archHalf * 2, 20, C.gold) +
      panel(cx - 285) +
      panel(cx + 15) +
      path(opening, 'none', { stroke: C.gold, 'stroke-width': 8 }) +
      [1340, 1400, 1460, 1520]
        .map((y, index) => rect(cx - 340 - index * 60, y, 680 + index * 120, 60, index % 2 === 0 ? C.gold : C.ochre))
        .join('') +
      Array.from({ length: 6 }, (_, index) => {
        const y = 290 + index * 170;
        return (
          polygon(
            [
              [cx - 380, y],
              [cx - 360, y + 20],
              [cx - 380, y + 40],
              [cx - 400, y + 20],
            ],
            C.gold,
          ) +
          polygon(
            [
              [cx + 380, y],
              [cx + 400, y + 20],
              [cx + 380, y + 40],
              [cx + 360, y + 20],
            ],
            C.gold,
          )
        );
      }).join(''),
    clip('arch', path(opening, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ lighthouse

function lighthouse(canvas: Canvas, random: () => number): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const lamp = { x: cx, y: 560 };
  const beam = (angle: number, spread: number) => {
    const [ax, ay] = polar(lamp.x, lamp.y, 1400, angle - spread);
    const [bx, by] = polar(lamp.x, lamp.y, 1400, angle + spread);
    return polygon(
      [
        [lamp.x, lamp.y],
        [ax, ay],
        [bx, by],
      ],
      C.goldPale,
      { opacity: 0.85 },
    );
  };
  const stars = Array.from({ length: 50 }, () => {
    const x = random() * W;
    const y = random() * 1000;
    return circle(x, y, 1.5 + random() * 2.5, C.cream, { opacity: n(0.4 + random() * 0.6) });
  }).join('');
  const tower: Point[] = [
    [cx - 70, 640],
    [cx + 70, 640],
    [cx + 130, 1220],
    [cx - 130, 1220],
  ];
  const bands = Array.from({ length: 5 }, (_, index) => rect(0, 700 + index * 112, W, 56, C.oxblood)).join('');
  const waves = Array.from({ length: 6 }, (_, row) => {
    const y = 1300 + row * 50;
    const r = 30;
    return path(scallopRow(y, r, row % 2 === 0 ? 0 : r, W), 'none', {
      stroke: row % 2 === 0 ? C.cream : C.goldPale,
      'stroke-width': 4,
      opacity: 0.8,
    });
  }).join('');
  return document(
    canvas,
    rect(0, 0, W, H, C.navy) +
      stars +
      beam(180, 7) +
      beam(345, 5) +
      ring(lamp.x, lamp.y, 120, C.goldPale, 2, { opacity: 0.6 }) +
      ring(lamp.x, lamp.y, 170, C.goldPale, 1.5, { opacity: 0.4 }) +
      polygon(
        ziggurat(cx, H, [
          [520, 1260],
          [340, 1210],
          [200, 1170],
        ]),
        C.black,
      ) +
      polygon(tower, C.cream) +
      group(bands, { 'clip-path': 'url(#tower)' }) +
      rect(cx - 100, 618, 200, 22, C.black) +
      rect(cx - 52, 520, 104, 98, C.black) +
      rect(cx - 36, 532, 72, 74, C.goldPale) +
      line(cx, 532, cx, 606, C.black, 4) +
      polygon(
        [
          [cx - 66, 520],
          [cx, 450],
          [cx + 66, 520],
        ],
        C.oxblood,
      ) +
      line(cx, 450, cx, 410, C.black, 6) +
      circle(cx, 404, 9, C.black) +
      rect(cx - 22, 1100, 44, 120, C.black) +
      rect(0, 1270, W, H - 1270, C.navyDeep) +
      waves +
      frame(canvas, C.goldPale, 36, 14, 5, 2),
    clip('tower', polygon(tower, '#000')),
  );
}

// ------------------------------------------------------------------------------------------------ iris on the axis

/** Four rosettes, `inset` from the left/right and `insetY` from the top/bottom edge. */
function cornerEmblems(
  { width: W, height: H }: Canvas,
  inset: number,
  insetY: number,
  r: number,
  colour: string,
  ground: string,
) {
  const corners: Point[] = [
    [inset, insetY],
    [W - inset, insetY],
    [inset, H - insetY],
    [W - inset, H - insetY],
  ];
  return corners.map(([x, y]) => cornerEmblem(x, y, r, colour, ground)).join('');
}

/** A small rosette in a ring, for the corners of a frame. */
function cornerEmblem(x: number, y: number, r: number, colour: string, ground: string): string {
  return (
    circle(x, y, r, colour) +
    circle(x, y, r * 0.78, ground) +
    Array.from({ length: 8 }, (_, index) => paint(petal(x, y, r * 0.66, r * 0.3, index * 45, 0.5), colour)).join('') +
    circle(x, y, r * 0.16, ground)
  );
}

function irisAxis(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const base = 1430;
  const head = 600;
  const leaf = (side: number, top: number, reach: number, colour: string) =>
    path(
      `M${n(cx + side * 14)} ${n(base)}Q${n(cx + side * reach)} ${n((base + top) / 2 + 120)} ${n(cx + side * reach * 0.82)} ${n(top)}` +
        `Q${n(cx + side * reach * 0.55)} ${n((base + top) / 2 + 60)} ${n(cx + side * 4)} ${n(base - 60)}Z`,
      colour,
    );
  const whip = (side: number) =>
    path(
      `M${n(cx + side * 10)} 1180C${n(cx + side * 160)} 1120 ${n(cx + side * 60)} 960 ${n(cx + side * 210)} 900` +
        `C${n(cx + side * 330)} 850 ${n(cx + side * 370)} 980 ${n(cx + side * 290)} 1010` +
        `C${n(cx + side * 240)} 1030 ${n(cx + side * 220)} 970 ${n(cx + side * 265)} 960`,
      'none',
      { stroke: C.olive, 'stroke-width': 5, 'stroke-linecap': 'round' },
    );
  const bud = (side: number) =>
    path(`M${n(cx + side * 8)} 1060Q${n(cx + side * 120)} 980 ${n(cx + side * 150)} 860`, 'none', {
      stroke: C.olive,
      'stroke-width': 6,
    }) +
    paint(petal(cx + side * 150, 862, 90, 40, side * 18, 0.45), C.violet) +
    paint(petal(cx + side * 150, 862, 60, 18, side * 18, 0.45), C.lavender);
  const flower =
    // standards: three upright petals
    paint(petal(cx, head, 250, 120, 0, 0.42), C.violet) +
    paint(petal(cx, head, 190, 50, 0, 0.42), C.lavender) +
    paint(petal(cx - 18, head + 6, 210, 100, -32, 0.42), C.violet) +
    paint(petal(cx + 18, head + 6, 210, 100, 32, 0.42), C.violet) +
    // falls: three drooping petals
    paint(petal(cx - 10, head + 20, 250, 120, -118, 0.5), C.violet) +
    paint(petal(cx + 10, head + 20, 250, 120, 118, 0.5), C.violet) +
    paint(petal(cx - 10, head + 20, 190, 46, -118, 0.5), C.lavender) +
    paint(petal(cx + 10, head + 20, 190, 46, 118, 0.5), C.lavender) +
    paint(petal(cx, head + 24, 200, 110, 180, 0.5), '#4d3b72') +
    Array.from({ length: 5 }, (_, index) => circle(cx, head + 60 + index * 26, 9 - index, C.mustard)).join('') +
    paint(petal(cx, head + 50, 70, 40, 0, 0.4), C.olive);
  const archR = 360;
  return document(
    canvas,
    rect(0, 0, W, H, C.cream) +
      path(
        `M${n(cx - archR)} 1480L${n(cx - archR)} 620A${n(archR)} ${n(archR)} 0 0 1 ${n(cx + archR)} 620L${n(cx + archR)} 1480Z`,
        C.sand,
      ) +
      path(
        `M${n(cx - archR - 26)} 1500L${n(cx - archR - 26)} 620A${n(archR + 26)} ${n(archR + 26)} 0 0 1 ${n(cx + archR + 26)} 620L${n(cx + archR + 26)} 1500`,
        'none',
        {
          stroke: C.petrol,
          'stroke-width': 4,
        },
      ) +
      leaf(-1, 760, 300, C.petrol) +
      leaf(1, 760, 300, C.petrol) +
      leaf(-1, 980, 220, C.olive) +
      leaf(1, 980, 220, C.olive) +
      whip(-1) +
      whip(1) +
      bud(-1) +
      bud(1) +
      rect(cx - 7, head + 60, 14, base - head - 60, C.olive) +
      flower +
      rect(0, base, W, H - base, C.petrol) +
      Array.from({ length: 14 }, (_, index) => circle(index * 80 + 13, base, 40, C.petrol)).join('') +
      Array.from({ length: 14 }, (_, index) => circle(index * 80 + 53, base + 48, 8, C.mustard)).join('') +
      frame(canvas, C.petrol, 34, 12, 6, 2) +
      cornerEmblems(canvas, 92, 92, 46, C.violet, C.cream),
  );
}

// ------------------------------------------------------------------------------------------------ lotus frieze

function lotusFrieze(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const top = 170;
  const bottom = H - 170;
  const mid = (top + bottom) / 2 + 70;
  const lotus = (x: number) =>
    path(wedge(x, mid + 40, 120, 180, 360), C.olive) +
    paint(petal(x, mid, 190, 110, -62, 0.45), C.salmon) +
    paint(petal(x, mid, 190, 110, 62, 0.45), C.salmon) +
    paint(petal(x, mid, 210, 110, -30, 0.45), C.coral) +
    paint(petal(x, mid, 210, 110, 30, 0.45), C.coral) +
    paint(petal(x, mid, 230, 120, 0, 0.45), C.salmon) +
    paint(petal(x, mid, 150, 40, 0, 0.45), C.cream) +
    paint(petal(x, mid, 120, 30, -30, 0.45), C.cream) +
    paint(petal(x, mid, 120, 30, 30, 0.45), C.cream) +
    circle(x, mid - 6, 16, C.mustard);
  const spacing = 400;
  const xs = Array.from({ length: 4 }, (_, index) => 200 + index * spacing);
  // Between two flowers a bud on a whiplash stem: up from the water, a hard swing, a curl at the end.
  const tendril = (x: number, flip: number) =>
    path(
      `M${n(x)} ${n(mid + 60)}C${n(x - flip * 70)} ${n(mid - 20)} ${n(x + flip * 90)} ${n(mid - 90)} ${n(x + flip * 10)} ${n(mid - 170)}` +
        `C${n(x - flip * 60)} ${n(mid - 230)} ${n(x - flip * 120)} ${n(mid - 150)} ${n(x - flip * 80)} ${n(mid - 120)}` +
        `C${n(x - flip * 50)} ${n(mid - 100)} ${n(x - flip * 30)} ${n(mid - 140)} ${n(x - flip * 55)} ${n(mid - 150)}`,
      'none',
      { stroke: C.oliveLight, 'stroke-width': 6, 'stroke-linecap': 'round' },
    ) +
    paint(petal(x + flip * 10, mid - 168, 70, 34, flip * 14, 0.45), C.coral) +
    paint(petal(x + flip * 10, mid - 168, 44, 12, flip * 14, 0.45), C.cream);
  const water = Array.from({ length: 4 }, (_, row) => {
    const y = mid + 90 + row * 30;
    let d = `M0 ${n(y)}`;
    for (let x = 0; x < W; x += 80) d += `Q${n(x + 20)} ${n(y - 10)} ${n(x + 40)} ${n(y)}T${n(x + 80)} ${n(y)}`;
    return path(d, 'none', { stroke: C.cream, 'stroke-width': 3, opacity: n(0.75 - row * 0.15) });
  }).join('');
  const stems = water + [0, 400, 800, 1200, 1600].map((x, index) => tendril(x, index % 2 === 0 ? 1 : -1)).join('');
  const border = (y: number) =>
    rect(0, y, W, 70, C.mustard) +
    Array.from({ length: 41 }, (_, index) =>
      polygon(
        [
          [index * 40, y + 70],
          [index * 40 + 20, y + 18],
          [index * 40 + 40, y + 70],
        ],
        C.petrol,
      ),
    ).join('') +
    rect(0, y - 14, W, 4, C.black) +
    rect(0, y + 80, W, 4, C.black);
  return document(
    canvas,
    rect(0, 0, W, H, C.sand) +
      rect(0, top, W, bottom - top, C.petrol) +
      stems +
      xs.map(lotus).join('') +
      border(top - 84) +
      group(border(0), { transform: `translate(0 ${n(bottom + 84)}) scale(1 -1)` }),
  );
}

// ------------------------------------------------------------------------------------------------ tulip repeat

function tulipRepeat(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cell = 320;
  const tulip = (x: number, y: number, flip: number) =>
    path(
      `M${n(x)} ${n(y + 170)}C${n(x - flip * 60)} ${n(y + 110)} ${n(x + flip * 50)} ${n(y + 30)} ${n(x)} ${n(y - 20)}`,
      'none',
      { stroke: C.oliveLight, 'stroke-width': 7, 'stroke-linecap': 'round' },
    ) +
    paint(petal(x, y + 150, 150, 60, -flip * 38, 0.35), C.olive) +
    paint(petal(x, y + 120, 110, 40, flip * 42, 0.35), C.oliveLight) +
    paint(petal(x, y - 10, 120, 74, -24, 0.4), C.redOrange) +
    paint(petal(x, y - 10, 120, 74, 24, 0.4), C.redOrange) +
    paint(petal(x, y - 6, 140, 80, 0, 0.42), C.salmon) +
    path(`M${n(x - 40)} ${n(y - 34)}Q${n(x)} ${n(y + 14)} ${n(x + 40)} ${n(y - 34)}`, 'none', {
      stroke: C.cream,
      'stroke-width': 3,
    });
  let out = rect(0, 0, W, H, C.petrol);
  // Thin wavy lines between the columns hold the repeat together, like the printed ground of a wallpaper.
  for (let col = 0; col <= W / cell; col += 1) {
    const x = col * cell;
    let d = `M${n(x)} -40`;
    for (let y = -40; y < H + 80; y += 200)
      d += `Q${n(x + 46)} ${n(y + 50)} ${n(x)} ${n(y + 100)}T${n(x)} ${n(y + 200)}`;
    out += path(d, 'none', { stroke: C.sand, 'stroke-width': 3, opacity: 0.55 });
  }
  for (let col = -1; col <= W / cell; col += 1) {
    for (let row = -1; row <= H / cell; row += 1) {
      const x = col * cell + cell / 2;
      const y = row * cell + (col % 2 === 0 ? cell / 2 : cell) + 20;
      out += group(tulip(0, 0, col % 2 === 0 ? 1 : -1), { transform: `translate(${n(x)} ${n(y - 60)}) scale(1.2)` });
      out += circle(x + cell / 2, y - cell / 2 + 40, 9, C.mustard);
      out += circle(x + cell / 2, y - cell / 2 + 70, 5, C.mustard);
      out += circle(x + cell / 2, y - cell / 2 + 10, 5, C.mustard);
    }
  }
  return document(canvas, out);
}

// ------------------------------------------------------------------------------------------------ medallion with stars

function starMedallion(canvas: Canvas): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  const cy = 800;
  const rx = 330;
  const ry = 470;
  const ellipse = (grow: number, fill: string, extra: Record<string, string | number> = {}) =>
    el('ellipse', { cx, cy, rx: rx + grow, ry: ry + grow, fill, ...extra });
  const stars = Array.from({ length: 9 }, (_, index) => {
    const [x, y] = polar(cx, cy + 40, 230, 200 + index * 17.5);
    return polygon(star(x, y, 18, 7), C.mustard);
  }).join('');
  const chevronBand = (x: number) =>
    rect(x, 120, 70, H - 240, C.petrol) +
    Array.from({ length: 23 }, (_, index) =>
      polyline(
        [
          [x + 12, 150 + index * 58],
          [x + 35, 172 + index * 58],
          [x + 58, 150 + index * 58],
        ],
        C.mustard,
        5,
      ),
    ).join('');
  const cartouche = (y: number, flip: number) =>
    path(
      `M${n(cx - 200)} ${n(y)}C${n(cx - 120)} ${n(y - flip * 80)} ${n(cx - 60)} ${n(y + flip * 10)} ${n(cx)} ${n(y - flip * 50)}` +
        `C${n(cx + 60)} ${n(y + flip * 10)} ${n(cx + 120)} ${n(y - flip * 80)} ${n(cx + 200)} ${n(y)}`,
      'none',
      { stroke: C.black, 'stroke-width': 6, 'stroke-linecap': 'round' },
    ) + circle(cx, y - flip * 50 - flip * 22, 14, C.redOrange);
  return document(
    canvas,
    rect(0, 0, W, H, C.sand) +
      chevronBand(90) +
      chevronBand(W - 160) +
      ellipse(60, 'none', { stroke: C.black, 'stroke-width': 3 }) +
      ellipse(40, C.black) +
      ellipse(18, 'none', { stroke: C.mustard, 'stroke-width': 4 }) +
      ellipse(-2, 'none', { stroke: C.mustard, 'stroke-width': 1.5 }) +
      stars +
      circle(cx, cy - 40, 120, C.mustard) +
      circle(cx + 44, cy - 70, 104, C.black) +
      polygon(star(cx - 60, cy - 30, 34, 14), C.cream) +
      paint(petal(cx, cy + 330, 170, 90, -45, 0.45), C.salmon) +
      paint(petal(cx, cy + 330, 170, 90, 45, 0.45), C.salmon) +
      paint(petal(cx, cy + 330, 200, 100, 0, 0.45), C.coral) +
      paint(petal(cx, cy + 330, 130, 34, 0, 0.45), C.cream) +
      path(wedge(cx, cy + 350, 90, 180, 360), C.olive) +
      cartouche(240, 1) +
      cartouche(H - 240, -1) +
      cornerEmblems(canvas, 125, 80, 58, C.petrol, C.sand),
  );
}

// ------------------------------------------------------------------------------------------------ leaf net in blue

function leafNet(canvas: Canvas, random: () => number): string {
  const { width: W, height: H } = canvas;
  const ink = { stroke: C.lineBlue, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const stem: Point[] = [
    [180, 960],
    [420, 760],
    [640, 640],
    [900, 520],
    [1150, 360],
    [1380, 200],
  ];
  let out = path(smooth(stem), 'none', { ...ink, 'stroke-width': 4 });
  const leafAt = (x: number, y: number, degrees: number, length: number) => {
    const width = length * 0.46;
    let veins = '';
    for (let step = 1; step < 7; step += 1) {
      const t = step / 7;
      const half = (width / 2) * Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.92;
      veins += `M0 ${n(-length * t)}L${n(half)} ${n(-length * (t + 0.09))}M0 ${n(-length * t)}L${n(-half)} ${n(-length * (t + 0.09))}`;
      if (step % 2 === 0)
        veins += `M${n(half * 0.5)} ${n(-length * (t + 0.045))}L${n(half * 0.2)} ${n(-length * (t + 0.12))}`;
    }
    return (
      paint(petal(x, y, length, width, degrees, 0.45), 'none', ink) +
      el('path', {
        transform: `translate(${n(x)} ${n(y)}) rotate(${n(degrees)})`,
        d: `M0 0L0 ${n(-length * 0.96)}${veins}`,
        fill: 'none',
        ...ink,
        'stroke-width': 2,
      })
    );
  };
  for (let index = 1; index < stem.length; index += 1) {
    const [x0, y0] = stem[index - 1] ?? [0, 0];
    const [x1, y1] = stem[index] ?? [0, 0];
    for (const t of [0.35, 0.8]) {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const heading = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI + 90;
      const side = (index + (t > 0.5 ? 1 : 0)) % 2 === 0 ? 1 : -1;
      const length = 150 + random() * 90;
      out += leafAt(x, y, heading + side * (55 + random() * 15), length);
    }
  }
  out += leafAt(1380, 200, 60, 170);
  const dots = Array.from({ length: 26 }, () => {
    const t = random();
    const index = Math.min(stem.length - 2, Math.floor(t * (stem.length - 1)));
    const [x0, y0] = stem[index] ?? [0, 0];
    const [x1, y1] = stem[index + 1] ?? [0, 0];
    const f = t * (stem.length - 1) - index;
    const angle = random() * Math.PI * 2;
    const distance = 60 + random() * 160;
    return circle(
      x0 + (x1 - x0) * f + Math.cos(angle) * distance,
      y0 + (y1 - y0) * f + Math.sin(angle) * distance,
      5 + random() * 4,
      C.dotRed,
    );
  }).join('');
  return document(canvas, rect(0, 0, W, H, C.paper) + out + dots);
}

// ------------------------------------------------------------------------------------------------ red and black, folded

function foldedBlot(canvas: Canvas, random: () => number): string {
  const { width: W, height: H } = canvas;
  const cx = W / 2;
  // The left half, top to bottom; mirrored across the vertical axis, like ink folded in a sheet.
  const half: Point[] = [];
  for (let index = 0; index <= 12; index += 1) {
    const y = 220 + index * 96;
    const swell = Math.sin((index / 12) * Math.PI);
    const x = cx - 40 - swell * (330 + random() * 230) - (index % 3 === 1 ? 120 * random() : 0);
    half.push([x, y + (random() - 0.5) * 50]);
  }
  const outline: Point[] = [[cx, 190], ...half, [cx, 1420], ...mirror(half, cx)];
  const holes: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const y = 420 + index * 220 + random() * 60;
    const x = cx - 150 - random() * 180;
    const r = 26 + random() * 46;
    holes.push(circle(x, y, r, C.redOrange), circle(2 * cx - x, y, r, C.redOrange));
  }
  const drops: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const y = 260 + random() * 1100;
    const x = cx - 640 - random() * 80;
    const r = 10 + random() * 26;
    drops.push(circle(x, y, r, C.black), circle(2 * cx - x, y, r, C.black));
  }
  return document(
    canvas,
    rect(0, 0, W, H, C.redOrange) +
      path(smooth(outline, true), C.black) +
      holes.join('') +
      path(
        smooth(
          [
            [cx, 420],
            [cx - 50, 640],
            [cx, 900],
            [cx + 50, 640],
          ],
          true,
        ),
        C.redOrange,
      ) +
      drops.join('') +
      rect(0, 0, W, H, 'none', { stroke: C.black, 'stroke-width': 60 }),
  );
}

/** In seed order (oldest upload first), like `SEED_IMAGES`. */
export const SEED_ARTWORKS: readonly SeedArtwork[] = [
  { slug: 'peacock', width: 1600, height: 1600, seed: 3, draw: peacockFan },
  { slug: 'liner-at-sunset', width: 1600, height: 1067, seed: 5, draw: oceanLiner },
  { slug: 'tulips-on-petrol', width: 1600, height: 1600, seed: 11, draw: tulipRepeat },
  { slug: 'lighthouse-for-my-brother', width: 1200, height: 1600, seed: 16, draw: lighthouse },
  { slug: 'door-i-would-like', width: 1067, height: 1600, seed: 12, draw: sunburstDoor },
  { slug: 'fans-all-the-way-down', width: 1600, height: 1600, seed: 9, draw: fanTiles },
  { slug: 'tower-at-sunrise', width: 1200, height: 1600, seed: 1, draw: steppedTower },
  { slug: 'antelope-mid-leap', width: 1200, height: 1600, seed: 10, draw: leapingAntelope },
  { slug: 'leaf-net-in-blue', width: 1600, height: 1067, seed: 13, draw: leafNet },
  { slug: 'fountain-in-the-courtyard', width: 1200, height: 1600, seed: 6, draw: fountain },
  { slug: 'gold-on-black', width: 1067, height: 1600, seed: 4, draw: goldLinePanel },
  { slug: 'lotus-frieze', width: 1600, height: 900, seed: 14, draw: lotusFrieze },
  { slug: 'red-and-black-folded', width: 1600, height: 1600, seed: 7, draw: foldedBlot },
  { slug: 'iris-on-the-axis', width: 1067, height: 1600, seed: 15, draw: irisAxis },
  { slug: 'night-train-south', width: 1600, height: 1000, seed: 2, draw: nightTrain },
  { slug: 'medallion-with-stars', width: 1200, height: 1600, seed: 8, draw: starMedallion },
];

/** The SVG markup of one piece; pure, so tests can check it without rendering. */
export function renderSvg(artwork: SeedArtwork): string {
  // Every piece gets the same kind of matte paper grain, so flat colour reads as print, not as screen.
  const canvas = { width: artwork.width, height: artwork.height, grainSeed: artwork.seed };
  return artwork.draw(canvas, seededRandom(artwork.seed));
}
