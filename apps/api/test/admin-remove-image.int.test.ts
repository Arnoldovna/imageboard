import { ImageDto } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comments, images } from '../src/db/schema/index.js';
import { parseAdminRemoveArgs, removeImage } from '../src/scripts/admin-remove-image.js';
import { createScriptUploadPort } from '../src/scripts/script-runtime.js';
import { captureLogger, createFakeStorage, type FakeStorage } from './fakes.js';
import { png } from './fixtures.js';
import { agentWithSession } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/*
 * The takedown script (ADR 0019): argument rules, and the images module's `adminRemove` path it runs, against the
 * file's database and the same fake storage the app serves media from.
 */

const SCRIPT_ENV = {
  UPLOAD_MAX_PIXELS: 40_000_000,
  UPLOAD_MAX_FRAMES: 200,
  IMAGE_MAX_EDGE: 2560,
  MEDIA_PUBLIC_BASE_URL: '/api/media',
};

describe('parseAdminRemoveArgs', () => {
  it('ADR 0019: accepts one id and --yes, in either order (and the `--` pnpm may forward)', () => {
    expect(parseAdminRemoveArgs(['42', '--yes'])).toEqual({ id: 42 });
    expect(parseAdminRemoveArgs(['--yes', '7'])).toEqual({ id: 7 });
    expect(parseAdminRemoveArgs(['--', '2147483647', '--yes'])).toEqual({ id: 2_147_483_647 });
  });

  it('ADR 0019: refuses to run without --yes', () => {
    expect(() => parseAdminRemoveArgs(['42'])).toThrow(/without --yes/);
  });

  it.each([
    ['no id', ['--yes']],
    ['two ids', ['1', '2', '--yes']],
    ['a non-canonical id', ['01', '--yes']],
    ['a negative id', ['-1', '--yes']],
    ['an id beyond integer range', ['2147483648', '--yes']],
    ['a word', ['latest', '--yes']],
    ['an unknown option', ['1', '--yes', '--force']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseAdminRemoveArgs(argv)).toThrow(/Usage: admin:remove-image <id> --yes/);
  });
});

describe('removeImage (the script path)', () => {
  let storage: FakeStorage;
  let testApp: TestApp;

  beforeAll(async () => {
    storage = createFakeStorage();
    testApp = await createTestApp({ storage });
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function uploadWithComment(): Promise<ImageDto> {
    const { agent, csrfToken } = await agentWithSession(testApp.app);
    const response = await agent
      .post('/api/images')
      .set('x-csrf-token', csrfToken)
      .field('authorName', 'Somebody')
      .field('title', 'Reported image')
      .attach('file', png(), { filename: 'reported.png', contentType: 'image/png' });
    const dto = ImageDto.parse(response.body);
    const commented = await agent
      .post(`/api/images/${String(dto.id)}/comments`)
      .set('x-csrf-token', csrfToken)
      .send({ authorName: 'Somebody', body: 'Look at this.' });
    expect(commented.status).toBe(201);
    return dto;
  }

  it('ADR 0019: removes an image of any owner with its comments, original and preview, and logs it at warn', async () => {
    const dto = await uploadWithComment();
    const objectKey = dto.url.replace(/^\/api\/media\//, '');
    const previewKey = dto.previewUrl.replace(/^\/api\/media\//, '');
    expect(storage.keys()).toEqual(expect.arrayContaining([objectKey, previewKey]));
    const { logger, lines } = captureLogger();

    const outcome = await removeImage(
      { db: testApp.db, logger, upload: createScriptUploadPort({ env: SCRIPT_ENV, storage, logger }) },
      dto.id,
    );

    expect(outcome).toBe('removed');
    expect(await testApp.db.select().from(images).where(eq(images.id, dto.id))).toEqual([]);
    expect(await testApp.db.select().from(comments).where(eq(comments.imageId, dto.id))).toEqual([]);
    expect(storage.keys()).not.toContain(objectKey);
    expect(storage.keys()).not.toContain(previewKey);
    expect((await request(testApp.app).get(dto.url)).status).toBe(404);
    expect((await request(testApp.app).get(`/api/images/${String(dto.id)}`)).status).toBe(404);
    // pino level 40 = warn.
    expect(lines).toContainEqual(expect.objectContaining({ level: 40, imageId: dto.id, objectKey }));
  });

  it('ADR 0019: an unknown id is "not-found" and touches no storage', async () => {
    const { logger } = captureLogger();
    const before = storage.calls();

    const outcome = await removeImage(
      { db: testApp.db, logger, upload: createScriptUploadPort({ env: SCRIPT_ENV, storage, logger }) },
      2_147_483_647,
    );

    expect(outcome).toBe('not-found');
    expect(storage.calls()).toEqual(before);
  });

  it('removing the same image twice: the second run reports not-found', async () => {
    const dto = await uploadWithComment();
    const { logger } = captureLogger();
    const deps = { db: testApp.db, logger, upload: createScriptUploadPort({ env: SCRIPT_ENV, storage, logger }) };

    expect(await removeImage(deps, dto.id)).toBe('removed');
    expect(await removeImage(deps, dto.id)).toBe('not-found');
  });
});
