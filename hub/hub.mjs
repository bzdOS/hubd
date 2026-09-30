#!/usr/bin/env node
/* The `hub` command: cli.mjs, loaded so that a CLI which cannot even load still answers with a
 * code that means failure.
 *
 * A module that fails to load — a file missing from a half-finished install, a syntax error, an
 * export one file expects and another no longer has — is thrown before a single line of cli.mjs
 * runs, so nothing inside it can catch that. Node then exits 1, and for `hub sense` 1 is a
 * contract: "no events". A loop reading that code went on believing its workers were fine while
 * the sensor had never started. So the failure is caught here, one level up, where it can be:
 * printed with its stack, and exited with 3 for `hub sense` (its "the sensor failed"). Every other
 * command keeps the exit code a crash always had.
 *
 * `node hub/cli.mjs` still works as before; this wrapper is what the installed `hub` runs. */
try {
  await import('./cli.mjs');
} catch (e) {
  process.stderr.write('hub: ' + ((e && e.stack) || e) + '\n');
  process.exit(process.argv[2] === 'sense' ? 3 : 1);
}
