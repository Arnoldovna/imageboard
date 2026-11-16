/**
 * What the script entry points share (seed CLI, admin takedown, seed photo fetch): connections built from env like the
 * composition root builds them, closed again whatever happens, and one way to turn `main()` into an exit code.
 */
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

import { type Env, loadEnv, uploadConfig } from '../config/env.js';
import { createDatabase, type Database } from '../db/client.js';
import { createUploadModule } from '../features/upload/index.js';
import { createLogger } from '../shared/logging/logger.js';
import type { ImageUploadPort } from '../shared/ports/image-upload.js';
import { createS3Storage, type ObjectStorage } from '../shared/storage/object-storage.js';

/** Scripts never serve HTTP: request-only middleware a module factory asks for is this pass-through. */
export const notMounted: RequestHandler = (_req, _res, next) => {
  next();
};

/**
 * The real `ImageUploadPort`, built from env like `app.ts` builds it, so seed photos get exactly the upload pipeline
 * (ADR 0014) and the takedown discards objects with the usual retries (ADR 0008, 0019).
 */
export function createScriptUploadPort({
  env,
  storage,
  logger,
}: {
  env: Parameters<typeof uploadConfig>[0];
  storage: ObjectStorage;
  logger: Logger;
}): ImageUploadPort {
  return createUploadModule({ storage, logger, config: uploadConfig(env), mediaLimiter: notMounted }).port;
}

export interface ScriptContext {
  env: Env;
  logger: Logger;
  db: Database;
  storage: ObjectStorage;
}

/** Runs `task` with a database and storage built from `source`; both are closed afterwards, also when it throws. */
export async function withScriptContext<T>(
  source: NodeJS.ProcessEnv,
  task: (context: ScriptContext) => Promise<T>,
): Promise<T> {
  const env = loadEnv(source);
  const logger = createLogger(env);
  const database = createDatabase(env.DATABASE_URL, logger);
  try {
    const storage = createS3Storage(env);
    try {
      return await task({ env, logger, db: database.db, storage });
    } finally {
      storage.destroy();
    }
  } finally {
    await database.close();
  }
}

/** The CLI arguments without the literal `--` that pnpm forwards when arguments are passed as `pnpm <script> -- …`. */
export function cliArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--');
}

/**
 * `if (import.meta.main) await runCli('<name>', () => main(...))`: the exit code is what `main` returns; any error is
 * one line `<name>: <message>` on stderr (no stack: these are operator messages) and exit code 1.
 */
export async function runCli(name: string, main: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
