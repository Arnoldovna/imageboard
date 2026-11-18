/**
 * CLI plumbing for every script entry point, free of env, database and storage imports, so an offline script (the seed
 * art generator) loads nothing it does not need.
 */

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
