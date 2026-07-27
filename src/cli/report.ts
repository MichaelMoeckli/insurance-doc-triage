/**
 * Regenerates `results.md` from the run records already on disk. No API calls, no spend.
 *
 *   npm run report
 *   npx tsx src/cli/report.ts --version v1
 *   npx tsx src/cli/report.ts --version v2 --model gpt-5
 *
 * `npm run eval` writes the report itself, so this exists for the other case: the
 * renderer changed and the report needs to catch up. Re-running a paid eval to pick up a
 * formatting change would also silently replace the measurements the README analyses,
 * which is a bad trade - the run records are the record.
 *
 * The most recently executed run becomes the report's "current" one unless `--version`
 * or `--model` narrows it - deliberately *not* whatever `PROMPT_VERSION` and
 * `OPENAI_MODEL` happen to be set to, since those select the next run's configuration,
 * not the last run's results. Either flag may be given alone: a run is identified by
 * both, so `--version v2` with two models on disk means "the most recent v2 run".
 */

import { loadRuns, renderReport, runKey, writeReport } from '../eval/report.js';

const USAGE = `claim-triage report

  npx tsx src/cli/report.ts [options]

  --version <id>   only consider runs of this prompt version
  --model <id>     only consider runs against this model
  --help

With neither flag, the most recently executed run on disk becomes the report's current
run. All run records are rendered in the comparison table either way.`;

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const version = readFlag(args, '--version');
  const model = readFlag(args, '--model');

  const runs = await loadRuns();
  if (runs.length === 0) {
    throw new Error('No run records in results/. Run `npm run eval` first.');
  }

  const matching = runs.filter(
    (run) =>
      (version === undefined || run.promptVersion === version) &&
      (model === undefined || run.model === model),
  );
  if (matching.length === 0) {
    const asked = [version && `version "${version}"`, model && `model "${model}"`]
      .filter(Boolean)
      .join(' and ');
    throw new Error(`No run record for ${asked}. Available: ${runs.map(runKey).join(', ')}.`);
  }

  // Most recent of whatever survived the filter. Ties cannot occur: timestamps are
  // written per run at ISO millisecond precision.
  const current = [...matching].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)!;

  await writeReport(renderReport(current, runs));
  console.error(`Wrote results.md from ${runs.length} run record(s); current = ${runKey(current)}.`);
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
