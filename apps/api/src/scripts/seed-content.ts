import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/*
 * The demo content of `pnpm db:seed` (DATA-MODEL §6, ADR 0014): hand-written titles, descriptions, names and comments
 * with fixed dates, so README screenshots are reproducible. The photographs and their fixed object keys live in
 * `seed/images/manifest.json`; the two are joined by `slug`. Titles and descriptions were adjusted to what each chosen
 * photo actually shows (DATA-MODEL §6.2: the subjects in §6.4 are briefs, not claims).
 */

/** Owner of every seed row. No session can ever hold it (sessions get random v4 UUIDs), so visitors cannot delete
 *  demo content (DATA-MODEL §6.1). */
export const SEED_OWNER_ID = '5eed0000-0000-4000-8000-000000000001';

/** `apps/api/seed/images/` (from `src/scripts/` and from `dist/scripts/` alike). */
export const SEED_IMAGES_DIR = fileURLToPath(new URL('../../seed/images/', import.meta.url));

export const SEED_LICENCE = 'Unsplash License';

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
    slug: 'fog-over-the-pines',
    title: 'Fog over the pines',
    authorName: 'Marit',
    description: 'Took the early bus out of town just for this. Twenty minutes later the sun burned it all off.',
    createdAt: '2026-09-21T06:42:00.000Z',
    comments: [
      c('Henrik', 'Worth the early bus.', '2026-09-21T08:05:00.000Z'),
      c('Bea', 'This is exactly what I needed on a Monday.', '2026-09-21T12:31:00.000Z'),
    ],
  },
  {
    slug: 'last-train-gone',
    title: 'Last train already gone',
    authorName: 'Jonas from Leipzig',
    description: 'Walking home it is, then. The station is very quiet after one.',
    createdAt: '2026-09-24T23:58:00.000Z',
    comments: [
      c('Noor', 'The fog under those lamps is lovely.', '2026-09-25T07:12:00.000Z'),
      c('Pavel', 'Been there. Many times.', '2026-09-25T09:40:00.000Z'),
      c('Jonas from Leipzig', 'Forty minutes on foot, for the record.', '2026-09-25T10:02:00.000Z'),
    ],
  },
  {
    slug: 'second-coffee',
    title: 'Second coffee, first idea',
    authorName: 'wen',
    description: 'Corner table at the café, no meetings until eleven.',
    createdAt: '2026-09-27T09:15:00.000Z',
    // No comments: shows the empty comments state.
    comments: [],
  },
  {
    slug: 'dog-refuses-to-pose',
    title: 'Bruno refuses to pose',
    authorName: 'Anouk',
    description: 'This was attempt number nine. He knew exactly what I wanted and did the opposite.',
    createdAt: '2026-09-30T17:20:00.000Z',
    comments: [
      c('Lucía', 'Attempt nine is the winner though.', '2026-09-30T17:48:00.000Z'),
      c('Kofi', 'Give Bruno a treat from me.', '2026-09-30T19:03:00.000Z'),
      c('Anouk', 'He got two.', '2026-09-30T19:10:00.000Z'),
      c('Sanne', 'That look.', '2026-10-01T08:22:00.000Z'),
    ],
  },
  {
    slug: 'lake-twice',
    title: 'The ridge, twice',
    authorName: 'Henrik',
    description: 'No wind at all for about ten minutes, so the lake did the rest.',
    createdAt: '2026-10-03T07:05:00.000Z',
    comments: [
      c('Marit', 'Where is this? I want to go.', '2026-10-03T09:30:00.000Z'),
      c('Henrik', 'Two hours by train, then a long walk uphill.', '2026-10-03T11:14:00.000Z'),
    ],
  },
  {
    slug: 'north-sea-october',
    title: 'North Sea in October',
    authorName: 'Sanne',
    description: 'Cold enough for a hat, warm enough to sit on the dunes for an hour.',
    createdAt: '2026-10-06T15:31:00.000Z',
    // 25 comments: the first page (20) shows "Show older comments" (DATA-MODEL §6.5).
    comments: [
      c('Marit', 'The light on that grass is doing a lot of work.', '2026-10-06T15:52:00.000Z'),
      c('Kofi', 'Which beach is this?', '2026-10-06T16:05:00.000Z'),
      c('Sanne', 'A long way past the last car park. Worth the walk.', '2026-10-06T16:31:00.000Z'),
      c('Kofi', 'Noted for next year.', '2026-10-06T16:39:00.000Z'),
      c('Henrik', 'The light up there in autumn is something else.', '2026-10-06T18:20:00.000Z'),
      c('Bea', 'I can almost hear the wind.', '2026-10-06T20:45:00.000Z'),
      c('Pavel', 'Hat weather indeed.', '2026-10-06T22:10:00.000Z'),
      c('Lucía', 'We went in September and it was already freezing.', '2026-10-07T01:20:00.000Z'),
      c('Sanne', 'Still saw two people swimming. Brave.', '2026-10-07T04:05:00.000Z'),
      c('Dariusz', 'Brave or something else.', '2026-10-07T06:05:00.000Z'),
      c('Noor', 'This makes me want to book a train ticket right now.', '2026-10-07T09:05:00.000Z'),
      c('wen', 'Do it.', '2026-10-07T09:14:00.000Z'),
      c('Ines K.', 'The grass on the dunes looks almost silver.', '2026-10-07T12:09:00.000Z'),
      c('Yuki', 'Are those waves as cold as they look?', '2026-10-07T14:39:00.000Z'),
      c('Sanne', 'Colder. I only went in up to my ankles.', '2026-10-07T15:01:00.000Z'),
      c('ole_b', 'Good composition, the path leads you straight into the waves.', '2026-10-07T18:09:00.000Z'),
      c('Anouk', 'Bruno would lose his mind on that beach.', '2026-10-07T20:59:00.000Z'),
      c('Sanne', 'Bring him, there were dogs everywhere.', '2026-10-07T23:19:00.000Z'),
      c('Tomás R.', 'Saving this as my wallpaper, hope that is fine.', '2026-10-08T01:59:00.000Z'),
      c('Sanne', 'Of course.', '2026-10-08T02:30:00.000Z'),
      c('Jonas from Leipzig', 'Fish sandwich afterwards, I hope.', '2026-10-08T05:35:00.000Z'),
      c('Sanne', 'Two. It was cold.', '2026-10-08T05:47:00.000Z'),
      c('Marit', 'Correct decision.', '2026-10-08T08:57:00.000Z'),
      c('Henrik', 'Coming back to this one a lot.', '2026-10-08T11:55:00.000Z'),
      c('Lucía', 'Same. It is very calm to look at.', '2026-10-08T14:35:00.000Z'),
    ],
  },
  {
    slug: 'long-way-round',
    title: 'Commute, the long way round',
    authorName: 'Kofi',
    description: 'Added four kilometres to the ride home because the evening was too good to waste.',
    createdAt: '2026-10-09T18:47:00.000Z',
    comments: [
      c('Dariusz', 'Best kind of detour.', '2026-10-09T19:30:00.000Z'),
      c('Yuki', 'Is that the river path?', '2026-10-10T08:12:00.000Z'),
      c('Kofi', 'Yes, the stretch after the old mill.', '2026-10-10T08:40:00.000Z'),
    ],
  },
  {
    slug: 'balconies',
    title: 'Balconies all the way down',
    authorName: 'Lucía',
    description: "Leaned out of a friend's window for this. Half the town was walking below.",
    createdAt: '2026-10-12T11:02:00.000Z',
    comments: [c('Ines K.', 'Third row, second from the left. That one.', '2026-10-12T13:27:00.000Z')],
  },
  {
    slug: 'before-the-storm',
    title: 'Before the storm',
    authorName: 'Dariusz',
    description: 'It started raining about five minutes after this. I was not dressed for it.',
    createdAt: '2026-10-15T16:10:00.000Z',
    comments: [
      c('ole_b', 'The colour of that sky.', '2026-10-15T16:45:00.000Z'),
      c('Dariusz', 'Soaked to the bone, still worth it.', '2026-10-15T18:02:00.000Z'),
    ],
  },
  {
    slug: 'library-card',
    title: 'Library card renewed after six years',
    authorName: 'Ines K.',
    description: 'They still had my old address. Starting with something short.',
    createdAt: '2026-10-18T13:44:00.000Z',
    comments: [
      c('Bea', 'What did you pick?', '2026-10-18T14:30:00.000Z'),
      c('Ines K.', 'Something with very small print, due in three weeks.', '2026-10-18T15:05:00.000Z'),
      c('wen', 'Libraries are the best.', '2026-10-19T09:20:00.000Z'),
    ],
  },
  {
    slug: 'bridge-in-the-fog',
    title: 'Bridge in the fog',
    authorName: 'Pavel',
    description: 'Could not see the other bank this morning. One runner, otherwise just me.',
    createdAt: '2026-10-22T08:26:00.000Z',
    comments: [c('Anouk', 'Moody in the best way.', '2026-10-22T12:40:00.000Z')],
  },
  {
    slug: 'first-snow',
    title: 'First snow on the peaks',
    authorName: 'Yuki',
    description: 'Overnight, without any warning. Down in the valley it was still raining.',
    createdAt: '2026-10-26T07:58:00.000Z',
    comments: [
      c('Henrik', 'Early this year.', '2026-10-26T09:15:00.000Z'),
      c('Marit', 'Skis are coming out of the cellar.', '2026-10-26T10:03:00.000Z'),
      c('Yuki', 'Not yet, give it a month.', '2026-10-26T10:30:00.000Z'),
    ],
  },
  {
    slug: 'borrowed-view',
    title: "The neighbour's garden, borrowed view",
    authorName: 'Bea',
    description:
      'I have no garden, but my kitchen window looks onto this. Found the photo from April and it cheered me up.',
    createdAt: '2026-10-30T10:12:00.000Z',
    comments: [
      c('Lucía', 'Best kind of garden: someone else waters it.', '2026-10-30T11:40:00.000Z'),
      c('Bea', 'Exactly my philosophy.', '2026-10-30T12:02:00.000Z'),
    ],
  },
  {
    slug: 'low-tide',
    title: 'Rocks at low tide',
    authorName: 'ole_b',
    description: 'The water came back faster than I expected. Wet shoes all the way home.',
    createdAt: '2026-11-03T14:39:00.000Z',
    comments: [
      c('Sanne', 'Classic.', '2026-11-03T16:10:00.000Z'),
      c('Noor', 'Lovely textures.', '2026-11-04T08:55:00.000Z'),
    ],
  },
  {
    slug: 'no-other-cars',
    title: 'The road with no other cars',
    authorName: 'Noor',
    description: 'Saw maybe three cars in an hour. Stopped in the middle of the road for this one.',
    createdAt: '2026-11-07T12:05:00.000Z',
    comments: [
      c('Tomás R.', 'Careful out there.', '2026-11-07T12:40:00.000Z'),
      c('Noor', 'Checked twice, promise.', '2026-11-07T12:58:00.000Z'),
      c('Kofi', 'Where does it go?', '2026-11-07T18:22:00.000Z'),
      c('Noor', 'To a very small village with a very good bakery.', '2026-11-07T19:05:00.000Z'),
    ],
  },
  {
    slug: 'fifth-floor',
    title: 'Rooftops from the fifth floor',
    authorName: 'Tomás R.',
    description: 'New flat, no lift, but this view makes the stairs bearable.',
    createdAt: '2026-11-12T19:23:00.000Z',
    comments: [
      c('Jonas from Leipzig', 'Congratulations on the new place.', '2026-11-12T20:10:00.000Z'),
      c('Pavel', 'Five floors builds character.', '2026-11-13T07:45:00.000Z'),
      c('Tomás R.', 'Thank you both. Ask me again in winter.', '2026-11-13T08:30:00.000Z'),
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

/** `images/<uuid v4>.jpg`: every seed photo is a JPEG, and the key must satisfy the DB CHECK on `object_key`. */
const SEED_OBJECT_KEY = /^images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** One manifest entry as `fetch-seed-images.ts` reads it: `author`, `sourceUrl` and `fetchedAt` are filled by it. */
export const SeedManifestDraftEntry = z.strictObject({
  slug,
  picsumId: z.number().int().nonnegative(),
  objectKey: z.string().regex(SEED_OBJECT_KEY),
  author: z.string().min(1).optional(),
  sourceUrl: z.url({ protocol: /^https$/ }).optional(),
  licence: z.literal(SEED_LICENCE),
  fetchedAt: z.iso.date().optional(),
});
export type SeedManifestDraftEntry = z.infer<typeof SeedManifestDraftEntry>;

/** A complete entry, as the committed manifest has it and the seed requires it (credits are not optional). */
export const SeedManifestEntry = SeedManifestDraftEntry.required();
export type SeedManifestEntry = z.infer<typeof SeedManifestEntry>;

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

const manifestOf = <T extends z.ZodType<{ slug: string; objectKey: string; picsumId: number }>>(entry: T) =>
  z
    .array(entry)
    .refine((entries) => uniqueBy(entries, (e) => e.slug), 'slugs must be unique')
    .refine((entries) => uniqueBy(entries, (e) => e.objectKey), 'object keys must be unique')
    .refine((entries) => uniqueBy(entries, (e) => String(e.picsumId)), 'Picsum ids must be unique');

export const SeedManifestDraft = manifestOf(SeedManifestDraftEntry);
export const SeedManifest = manifestOf(SeedManifestEntry);

export const MANIFEST_FILE = 'manifest.json';

/** Reads and validates `<dir>/manifest.json` with the given schema. Errors name the file and the failing paths. */
export async function readManifest<T>(dir: string, schema: z.ZodType<T>): Promise<T> {
  const path = join(dir, MANIFEST_FILE);
  const result = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!result.success) throw new Error(`Invalid seed manifest ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export interface SeedEntry {
  image: SeedImage;
  file: SeedManifestEntry;
}

/**
 * Pairs every content entry with its manifest entry, in content order. Both sides must name exactly the same slugs, so
 * a photo without text (or text without a photo) fails loudly instead of being skipped.
 */
export function joinSeed(
  manifest: readonly SeedManifestEntry[],
  images: readonly SeedImage[] = SEED_IMAGES,
): SeedEntry[] {
  const bySlug = new Map(manifest.map((entry) => [entry.slug, entry]));
  const entries: SeedEntry[] = [];
  const withoutPhoto: string[] = [];
  for (const image of images) {
    const file = bySlug.get(image.slug);
    if (file) entries.push({ image, file });
    else withoutPhoto.push(image.slug);
  }
  const slugs = new Set(images.map((image) => image.slug));
  const withoutContent = manifest.filter((entry) => !slugs.has(entry.slug)).map((entry) => entry.slug);
  if (withoutPhoto.length > 0 || withoutContent.length > 0) {
    const list = (values: string[]) => (values.length > 0 ? values.join(', ') : '-');
    throw new Error(
      `Seed content and manifest disagree. Without a photo: ${list(withoutPhoto)}; without content: ${list(withoutContent)}`,
    );
  }
  return entries;
}
