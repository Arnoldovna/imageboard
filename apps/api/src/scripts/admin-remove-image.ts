/**
 * Takedown path (ADR 0019). From a checkout: `pnpm --filter @app/api admin:remove-image <id> --yes`. In a deployment
 * the API image contains the compiled script and the api's environment: run the image with the command
 * `dist/scripts/admin-remove-image.js <id> --yes` (locally:
 * `docker compose --profile app run --rm --no-deps api dist/scripts/admin-remove-image.js <id> --yes`).
 *
 * Loads env, builds the modules like the composition root and calls `imagesModule.adminRemove(id)`: the row goes
 * (its comments cascade), then the original and the preview are discarded with the usual retries (ADR 0008). The
 * images service logs `{ imageId, objectKey }` at `warn`. Without `--yes` nothing runs.
 */
import { IdParam } from '@app/shared';
import type { Logger } from 'pino';

import type { Database } from '../db/client.js';
import { createImagesModule } from '../features/images/index.js';
import type { ImageUploadPort } from '../shared/ports/image-upload.js';
import { cliArgs, runCli } from './script-cli.js';
import { createScriptUploadPort, notMounted, withScriptContext } from './script-runtime.js';

const USAGE = 'Usage: admin:remove-image <id> --yes';

/** `<id> --yes` in any order. The id uses the API's own rule (canonical positive integer, F-44). */
export function parseAdminRemoveArgs(argv: readonly string[]): { id: number } {
  const args = cliArgs(argv);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknownFlags = flags.filter((flag) => flag !== '--yes');
  if (unknownFlags.length > 0) throw new Error(`Unknown option(s): ${unknownFlags.join(' ')}. ${USAGE}`);
  if (positional.length !== 1) throw new Error(`Expected exactly one image id. ${USAGE}`);
  const id = IdParam.safeParse(positional[0]);
  if (!id.success) throw new Error(`Invalid image id ${JSON.stringify(positional[0])}. ${USAGE}`);
  if (!flags.includes('--yes')) {
    throw new Error(`Refusing to delete image ${String(id.data)} without --yes. This cannot be undone. ${USAGE}`);
  }
  return { id: id.data };
}

export interface AdminRemoveDeps {
  db: Database;
  logger: Logger;
  upload: ImageUploadPort;
}

/**
 * The images module's own code path, so the cascade and object cleanup are the tested ones. Its router is never
 * mounted here, so the request-only dependencies (multipart parser, limiters) are pass-throughs.
 */
export function removeImage({ db, logger, upload }: AdminRemoveDeps, id: number): Promise<'removed' | 'not-found'> {
  const imagesModule = createImagesModule({
    db,
    logger,
    upload,
    parseMultipart: notMounted,
    limiters: { uploads: notMounted, uploadsGlobalDay: notMounted, deletes: notMounted },
    pageSize: 1,
  });
  return imagesModule.adminRemove(id);
}

async function main(argv: readonly string[], source: NodeJS.ProcessEnv): Promise<number> {
  const { id } = parseAdminRemoveArgs(argv);
  return withScriptContext(source, async ({ env, logger, db, storage }) => {
    const outcome = await removeImage({ db, logger, upload: createScriptUploadPort({ env, storage, logger }) }, id);
    if (outcome === 'not-found') {
      process.stderr.write(`admin:remove-image: no image with id ${String(id)}\n`);
      return 1;
    }
    process.stdout.write(`admin:remove-image: image ${String(id)} removed (row, comments, original and preview)\n`);
    return 0;
  });
}

if (import.meta.main) {
  await runCli('admin:remove-image', () => main(process.argv.slice(2), process.env));
}
