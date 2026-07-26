/**
 * Regenerates `results.md` from the run records already on disk. No API calls, no spend.
 *
 *   npm run report
 *   npx tsx src/cli/report.ts --version v1
 *
 * `npm run eval` writes the report itself, so this exists for the other case: the
 * renderer changed and the report needs to catch up. Re-running a paid eval to pick up a
 * formatting change would also silently replace the measurements the README analyses,
 * which is a bad trade - the run records are the record.
 *
 * The most recently executed run becomes the report's "current" one unless `--version`
 * says otherwise - deliberately *not* whatever `PROMPT_VERSION` happens to be set to,
 * since that env var selects the next run's prompts, not the last run's results.
 */

import { loadRuns, renderReport, writeReport } from '../eval/report.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const versionFlag = args.indexOf('--version');
  const requested = versionFlag === -1 ? undefined : args[versionFlag + 1];
  if (versionFlag !== -1 && requested === undefined) throw new Error('--version requires a value');

  const runs = await loadRuns();
  if (runs.length === 0) {
    throw new Error('No run records in results/. Run `npm run eval` first.');
  }

  const mostRecent = [...runs].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[runs.length - 1]!;
  const current = requested === undefined ? mostRecent : runs.find((r) => r.promptVersion === requested);
  if (!current) {
    throw new Error(
      `No run record for "${requested}". Available: ${runs.map((r) => r.promptVersion).join(', ')}.`,
    );
  }

  await writeReport(renderReport(current, runs));
  console.error(
    `Wrote results.md from ${runs.length} run record(s); current = ${current.promptVersion}.`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
