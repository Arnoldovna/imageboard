/**
 * Seed entry point (ADR 0014, DATA-MODEL §6):
 * - `pnpm db:seed` (sets SEED_ALLOW=true; run by `pnpm dev:setup` and `pnpm demo`) → `runSeed()`: 16 pictures through
 *   the upload pipeline into the configured bucket, rows and 60 comments into the configured database. Idempotent;
 *   a re-run also stores the objects of seed rows again whose original or preview is missing.
 * - `pnpm --filter @app/api db:seed:check` (`--check`, read-only, needs no switch) → `checkSeed()`: exits 1 unless all
 *   seed rows, comments and objects are there (CI `dev-setup-smoke`).
 *
 * The guard lives here, in the entry point, and never consults NODE_ENV: the production image runs with
 * NODE_ENV=production, so an explicit opt-in is the only reliable switch (conventions §8, ADR 0021 §5). `runSeed()`
 * itself has no guard, because tests call it with their own database and fake storage.
 */
import { cliArgs, runCli } from './script-cli.js';
import { createScriptUploadPort, withScriptContext } from './script-runtime.js';
import { checkSeed, runSeed } from './seed.js';

type CliEnv = Readonly<Record<string, string | undefined>>;

export type SeedMode = 'seed' | 'check';

export function isSeedAllowed(env: CliEnv): boolean {
  return env['SEED_ALLOW'] === 'true';
}

/**
 * `--check` → read-only check, allowed without the switch. Anything else is a write run and throws unless
 * `SEED_ALLOW === 'true'`. Unknown arguments throw, so a typo never silently turns a check into a write run.
 */
export function seedMode(argv: readonly string[], env: CliEnv): SeedMode {
  const args = cliArgs(argv);
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Usage: seed-cli.ts [--check]`);
  }
  if (args.includes('--check')) return 'check';
  if (!isSeedAllowed(env)) {
    throw new Error('Refusing to seed. Set SEED_ALLOW=true (the db:seed script does).');
  }
  return 'seed';
}

async function main(argv: readonly string[], source: NodeJS.ProcessEnv): Promise<number> {
  const mode = seedMode(argv, source);
  return withScriptContext(source, async ({ env, logger, db, storage }) => {
    if (mode === 'seed') {
      await runSeed({ db, upload: createScriptUploadPort({ env, storage, logger }), storage, logger });
      return 0;
    }
    const result = await checkSeed({ db, storage });
    const summary = `${String(result.images)}/${String(result.expected.images)} images, ${String(result.comments)}/${String(
      result.expected.comments,
    )} comments, ${String(result.objects)}/${String(result.expected.objects)} objects`;
    process.stdout.write(`db:seed:check: ${result.ok ? 'ok' : 'FAILED'}: ${summary}\n`);
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    return result.ok ? 0 : 1;
  });
}

if (import.meta.main) {
  await runCli('db:seed', () => main(process.argv.slice(2), process.env));
}
