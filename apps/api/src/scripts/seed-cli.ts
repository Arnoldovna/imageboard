/**
 * Seed entry point: `pnpm db:seed` (sets SEED_ALLOW=true), run by `pnpm dev:setup` and `pnpm demo`.
 *
 * Phase 1a stub: the skeleton has no tables yet, so there is nothing to seed. Phase 2.4 adds runSeed() and the
 * read-only `--check` mode (ADR 0014). The guard stays here, in the entry point, and never consults NODE_ENV: the
 * production image runs with NODE_ENV=production, so an explicit opt-in is the only reliable switch
 * (conventions §8, ADR 0021 §5).
 */
export function isSeedAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['SEED_ALLOW'] === 'true';
}

if (import.meta.main) {
  if (isSeedAllowed(process.env)) {
    process.stdout.write('db:seed: nothing to seed yet\n');
  } else {
    process.stderr.write('db:seed: refusing to seed. Set SEED_ALLOW=true (the db:seed script does).\n');
    process.exitCode = 1;
  }
}
