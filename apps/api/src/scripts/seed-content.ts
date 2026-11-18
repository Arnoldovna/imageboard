import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/*
 * The demo content of `pnpm db:seed` (DATA-MODEL §6, ADR 0014): hand-written titles, descriptions, names and comments
 * with fixed dates, so README screenshots are reproducible. The pictures are original Art Nouveau / Art Deco inspired illustrations drawn
 * by `generate-seed-art.ts`; their fixed object keys live in `seed/images/manifest.json`. Content, artwork and manifest
 * are joined by `slug`.
 */

/** Owner of every seed row. No session can ever hold it (sessions get random v4 UUIDs), so visitors cannot delete
 *  demo content (DATA-MODEL §6.1). */
export const SEED_OWNER_ID = '5eed0000-0000-4000-8000-000000000001';

/** `apps/api/seed/images/` (from `src/scripts/` and from `dist/scripts/` alike). */
export const SEED_IMAGES_DIR = fileURLToPath(new URL('../../seed/images/', import.meta.url));

export interface SeedComment {
  authorName: string;
  body: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface SeedImage {
  slug: string;
  title: string;
  authorName: string;
  description: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** Oldest first (the API lists newest first). */
  comments: readonly SeedComment[];
}

const c = (authorName: string, body: string, createdAt: string): SeedComment => ({ authorName, body, createdAt });

/** In upload order (oldest first), so ids ascend with the dates. */
export const SEED_IMAGES: readonly SeedImage[] = [
  {
    slug: 'peacock',
    title: 'Peacock',
    authorName: 'ole_b',
    description: 'Every feather is the same shape, which makes it much easier than it looks.',
    createdAt: '2026-09-21T06:42:00.000Z',
    comments: [
      c('Sanne', 'Easier than it looks, he says.', '2026-09-21T08:05:00.000Z'),
      c('Noor', 'The gold on black is beautiful.', '2026-09-21T12:31:00.000Z'),
    ],
  },
  {
    slug: 'liner-at-sunset',
    title: 'Liner at sunset',
    authorName: 'Yuki',
    description:
      'My grandfather worked on ships like this. Three funnels, because he always said the good ones had three.',
    createdAt: '2026-09-24T23:58:00.000Z',
    comments: [
      c('Henrik', 'Your grandfather was right.', '2026-09-25T07:12:00.000Z'),
      c('Marit', 'The waves are so neat.', '2026-09-25T09:40:00.000Z'),
      c('Yuki', 'Rows of half circles and a lot of patience.', '2026-09-25T10:02:00.000Z'),
    ],
  },
  {
    slug: 'tulips-on-petrol',
    title: 'Tulips on petrol',
    authorName: 'wen',
    description:
      'A wallpaper repeat I wanted to draw since I saw tiles like this in an old stairwell. Every other column is mirrored.',
    createdAt: '2026-09-27T09:15:00.000Z',
    // No comments: shows the empty comments state.
    comments: [],
  },
  {
    slug: 'lighthouse-for-my-brother',
    title: 'Lighthouse for my brother',
    authorName: 'Anouk',
    description:
      'He keeps a photo of the real one on his fridge, so this one is for next to it. Red and white, like the original.',
    createdAt: '2026-09-30T17:20:00.000Z',
    comments: [
      c('Lucía', 'He is going to love it.', '2026-09-30T17:48:00.000Z'),
      c('Kofi', 'The beams are great.', '2026-09-30T19:03:00.000Z'),
      c('Anouk', 'He already asked for a second one for the hallway.', '2026-09-30T19:10:00.000Z'),
      c('Sanne', 'Those little waves.', '2026-10-01T08:22:00.000Z'),
    ],
  },
  {
    slug: 'door-i-would-like',
    title: 'The door I would like to have',
    authorName: 'Henrik',
    description:
      'Drew the sunburst first and built the door around it. Our real front door is brown and sticks in winter.',
    createdAt: '2026-10-03T07:05:00.000Z',
    comments: [
      c('Marit', 'Where is this? I want to live there.', '2026-10-03T09:30:00.000Z'),
      c('Henrik', 'Only in my sketchbook, sadly.', '2026-10-03T11:14:00.000Z'),
    ],
  },
  {
    slug: 'fans-all-the-way-down',
    title: 'Fans all the way down',
    authorName: 'Sanne',
    description: 'A repeat pattern, about six hours of compass work. In my head it is already wallpaper.',
    createdAt: '2026-10-06T15:31:00.000Z',
    // 25 comments: the first page (20) shows "Show older comments" (DATA-MODEL §6.5).
    comments: [
      c('Marit', 'This must have taken forever.', '2026-10-06T15:52:00.000Z'),
      c('Kofi', 'Is it drawn by hand?', '2026-10-06T16:05:00.000Z'),
      c('Sanne', 'Compass, pencil and a lot of tea. Coloured on the computer afterwards.', '2026-10-06T16:31:00.000Z'),
      c('Kofi', 'Respect.', '2026-10-06T16:39:00.000Z'),
      c('Henrik', 'From far away it looks like fish scales.', '2026-10-06T18:20:00.000Z'),
      c('Bea', 'I would wear this as a dress.', '2026-10-06T20:45:00.000Z'),
      c('Pavel', 'Wallpaper, definitely.', '2026-10-06T22:10:00.000Z'),
      c('Lucía', 'My grandmother had tiles like this in her bathroom.', '2026-10-07T01:20:00.000Z'),
      c('Sanne', 'Then I need to see that bathroom.', '2026-10-07T04:05:00.000Z'),
      c('Dariusz', 'The gold rows are my favourite.', '2026-10-07T06:05:00.000Z'),
      c('Noor', 'I keep finding new patterns in it.', '2026-10-07T09:05:00.000Z'),
      c('wen', 'Same. Diagonals now.', '2026-10-07T09:14:00.000Z'),
      c('Ines K.', 'Could you print it on fabric?', '2026-10-07T12:09:00.000Z'),
      c('Yuki', 'How many fans are there?', '2026-10-07T14:39:00.000Z'),
      c('Sanne', 'I stopped counting at a hundred.', '2026-10-07T15:01:00.000Z'),
      c('ole_b', 'The thin black outline on each one is what makes it work.', '2026-10-07T18:09:00.000Z'),
      c('Anouk', 'This would make a very good blanket.', '2026-10-07T20:59:00.000Z'),
      c('Sanne', 'Working on it, actually.', '2026-10-07T23:19:00.000Z'),
      c('Tomás R.', 'Saving this as my wallpaper, hope that is fine.', '2026-10-08T01:59:00.000Z'),
      c('Sanne', 'Of course.', '2026-10-08T02:30:00.000Z'),
      c('Jonas from Leipzig', 'Bring it to the print club, they would love it.', '2026-10-08T05:35:00.000Z'),
      c('Sanne', 'In two colours? That would be a challenge.', '2026-10-08T05:47:00.000Z'),
      c('Marit', 'You like a challenge.', '2026-10-08T08:57:00.000Z'),
      c('Henrik', 'Coming back to this one a lot.', '2026-10-08T11:55:00.000Z'),
      c('Lucía', 'Same. It is very calm to look at.', '2026-10-08T14:35:00.000Z'),
    ],
  },
  {
    slug: 'tower-at-sunrise',
    title: 'Tower at sunrise',
    authorName: 'Tomás R.',
    description:
      'New flat, no lift, and a lot of time spent looking at the tower across the road. It is less golden in real life.',
    createdAt: '2026-10-09T18:47:00.000Z',
    comments: [
      c('Jonas from Leipzig', 'Congratulations on the new place.', '2026-10-09T19:30:00.000Z'),
      c('Pavel', 'Less golden, but still good?', '2026-10-10T08:12:00.000Z'),
      c('Tomás R.', 'Ask me again in winter.', '2026-10-10T08:40:00.000Z'),
    ],
  },
  {
    slug: 'antelope-mid-leap',
    title: 'Antelope, mid-leap',
    authorName: 'Lucía',
    description: 'The legs were the hard part. Version eleven is the first one that looks like it could land.',
    createdAt: '2026-10-12T11:02:00.000Z',
    comments: [c('Ines K.', 'The stripes across the sun are perfect.', '2026-10-12T13:27:00.000Z')],
  },
  {
    slug: 'leaf-net-in-blue',
    title: 'Leaf net in blue',
    authorName: 'Dariusz',
    description: 'One blue pen, one branch, no plan. The red dots came later, when it looked too tidy.',
    createdAt: '2026-10-15T16:10:00.000Z',
    comments: [
      c('ole_b', 'The red dots make it.', '2026-10-15T16:45:00.000Z'),
      c('Dariusz', 'They were almost a mistake. Kept them.', '2026-10-15T18:02:00.000Z'),
    ],
  },
  {
    slug: 'fountain-in-the-courtyard',
    title: 'Fountain in the courtyard',
    authorName: 'Ines K.',
    description: 'Based on the one in the library courtyard, with a bit more ambition. The real one has two jets.',
    createdAt: '2026-10-18T13:44:00.000Z',
    comments: [
      c('Bea', 'Which library?', '2026-10-18T14:30:00.000Z'),
      c('Ines K.', 'The old one by the river. Go in spring, when it is switched on.', '2026-10-18T15:05:00.000Z'),
      c('wen', 'Libraries are the best.', '2026-10-19T09:20:00.000Z'),
    ],
  },
  {
    slug: 'gold-on-black',
    title: 'Gold on black',
    authorName: 'Pavel',
    description: 'One colour of ink, a ruler and most of the weekend.',
    createdAt: '2026-10-22T08:26:00.000Z',
    comments: [c('Anouk', 'So much patience in this.', '2026-10-22T12:40:00.000Z')],
  },
  {
    slug: 'lotus-frieze',
    title: 'Lotus frieze',
    authorName: 'Jonas from Leipzig',
    description: 'Meant as a border for the top of a wall. Four flowers, then it repeats, in theory forever.',
    createdAt: '2026-10-26T07:58:00.000Z',
    comments: [
      c('Noor', 'The buds curling between the flowers!', '2026-10-26T09:15:00.000Z'),
      c('Pavel', 'Very calm. I like the water lines.', '2026-10-26T10:03:00.000Z'),
      c('Jonas from Leipzig', 'Took four tries to get the repeat to line up.', '2026-10-26T10:30:00.000Z'),
    ],
  },
  {
    slug: 'red-and-black-folded',
    title: 'Red and black, folded',
    authorName: 'Bea',
    description:
      'Print club this week: black ink on red paper, folded in half while it was wet. Everyone made one, I kept mine.',
    createdAt: '2026-10-30T10:12:00.000Z',
    comments: [
      c('Lucía', 'It looks like a face. Or a moth.', '2026-10-30T11:40:00.000Z'),
      c('Bea', 'Everyone sees something else. That is the fun.', '2026-10-30T12:02:00.000Z'),
    ],
  },
  {
    slug: 'iris-on-the-axis',
    title: 'Iris on the axis',
    authorName: 'Marit',
    description: 'Everything mirrored down the middle, except my patience. The curls on the stems took the longest.',
    createdAt: '2026-11-03T14:39:00.000Z',
    comments: [
      c('Henrik', 'The little curls on the stems are lovely.', '2026-11-03T16:10:00.000Z'),
      c('Bea', 'This would make a great book cover.', '2026-11-04T08:55:00.000Z'),
    ],
  },
  {
    slug: 'night-train-south',
    title: 'Night train south',
    authorName: 'Noor',
    description: 'Sketched on the actual night train, then drawn again at home on a table that did not shake.',
    createdAt: '2026-11-07T12:05:00.000Z',
    comments: [
      c('Tomás R.', 'Where were you going?', '2026-11-07T12:40:00.000Z'),
      c('Noor', 'Vienna. Slept surprisingly well.', '2026-11-07T12:58:00.000Z'),
      c('Kofi', 'The moon is great.', '2026-11-07T18:22:00.000Z'),
      c('Noor', 'It followed us most of the night.', '2026-11-07T19:05:00.000Z'),
    ],
  },
  {
    slug: 'medallion-with-stars',
    title: 'Medallion with stars',
    authorName: 'Kofi',
    description: 'A frame for a moon. The stars took longer than the moon, and the moon took longer than the frame.',
    createdAt: '2026-11-12T19:23:00.000Z',
    comments: [
      c('Dariusz', 'The chevron borders are great.', '2026-11-12T20:10:00.000Z'),
      c('Yuki', 'Is the lotus at the bottom on purpose?', '2026-11-13T07:45:00.000Z'),
      c('Kofi', 'Yes, it looked empty without it.', '2026-11-13T08:30:00.000Z'),
    ],
  },
];

/** What `db:seed` creates and `db:seed:check` expects: 16 images, 60 comments, original + preview per image. */
export const SEED_TOTALS = {
  images: SEED_IMAGES.length,
  comments: SEED_IMAGES.reduce((sum, image) => sum + image.comments.length, 0),
  objects: SEED_IMAGES.length * 2,
} as const;

// ---------------------------------------------------------------- manifest.json

/** `images/<uuid v4>.jpg`: every seed picture is a JPEG, and the key must satisfy the DB CHECK on `object_key`. */
const SEED_OBJECT_KEY = /^images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;

/** One manifest entry: the picture `<slug>.jpg` and the fixed object key it is stored under (idempotent seed). */
const SeedManifestEntry = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  objectKey: z.string().regex(SEED_OBJECT_KEY),
});
export type SeedManifestEntry = z.infer<typeof SeedManifestEntry>;

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

const SeedManifest = z
  .array(SeedManifestEntry)
  .refine((entries) => uniqueBy(entries, (e) => e.slug), 'slugs must be unique')
  .refine((entries) => uniqueBy(entries, (e) => e.objectKey), 'object keys must be unique');

const MANIFEST_FILE = 'manifest.json';

/** Reads and validates `<dir>/manifest.json`. Errors name the file and the failing paths. */
export async function readManifest(dir: string): Promise<SeedManifestEntry[]> {
  const path = join(dir, MANIFEST_FILE);
  const result = SeedManifest.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!result.success) throw new Error(`Invalid seed manifest ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export interface SeedEntry {
  image: SeedImage;
  file: SeedManifestEntry;
}

/**
 * Pairs every content entry with its manifest entry, in content order. Both sides must name exactly the same slugs, so
 * a picture without text (or text without a picture) fails loudly instead of being skipped.
 */
export function joinSeed(
  manifest: readonly SeedManifestEntry[],
  images: readonly SeedImage[] = SEED_IMAGES,
): SeedEntry[] {
  const bySlug = new Map(manifest.map((entry) => [entry.slug, entry]));
  const entries: SeedEntry[] = [];
  const withoutPicture: string[] = [];
  for (const image of images) {
    const file = bySlug.get(image.slug);
    if (file) entries.push({ image, file });
    else withoutPicture.push(image.slug);
  }
  const slugs = new Set(images.map((image) => image.slug));
  const withoutContent = manifest.filter((entry) => !slugs.has(entry.slug)).map((entry) => entry.slug);
  if (withoutPicture.length > 0 || withoutContent.length > 0) {
    const list = (values: string[]) => (values.length > 0 ? values.join(', ') : '-');
    throw new Error(
      `Seed content and manifest disagree. Without a picture: ${list(withoutPicture)}; without content: ${list(withoutContent)}`,
    );
  }
  return entries;
}
