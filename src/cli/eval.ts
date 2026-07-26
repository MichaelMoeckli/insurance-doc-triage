/**
 * The eval harness.
 *
 *   npm run eval                                  the full set
 *   npm run eval:validate                         check the dataset offline, no API calls
 *   npm run eval:smoke                            the first 5 documents
 *   npx tsx src/cli/eval.ts --doc motor-04        any other flag combination
 *
 * Flags go through `npx tsx` rather than `npm run ... --`, because npm consumes any
 * `--flag` after the `--` separator as one of its own config keys and forwards only the
 * value. It is shell-dependent - it bites on Windows and PowerShell - so the two common
 * invocations get their own scripts above and `--help` explains the rest.
 *
 * Writes `results/run-<version>.json` and regenerates `results.md`.
 */

import { MODEL, PROMPT_VERSION } from '../config.js';
import { SchemaValidationError } from '../schema.js';
import { ModelResponseError } from '../openai/client.js';
import { getPromptSet } from '../prompts/index.js';
import { runPipeline } from '../pipeline/run.js';
import type { LabelledDocument } from '../types.js';
import { aggregate, compareDocument, failedDocument, type DocumentComparison } from '../eval/compare.js';
import { DatasetError, loadDataset } from '../eval/dataset.js';
import { loadRuns, renderReport, saveRun, writeReport, type RunRecord } from '../eval/report.js';

interface Options {
  validateOnly: boolean;
  limit: number | undefined;
  doc: string | undefined;
  concurrency: number;
  help: boolean;
}

const USAGE = `claim-triage eval

  npx tsx src/cli/eval.ts [options]

  --validate-only      validate the dataset offline; no API calls, nothing written
  --limit <n>          run only the first n documents
  --doc <substring>    run only documents whose id contains this substring
  --concurrency <n>    documents in flight at once (default 4)
  --help

  npm run eval             the full set
  npm run eval:validate    same as --validate-only
  npm run eval:smoke       same as --limit 5

Pass other flags through "npx tsx" rather than "npm run eval -- ...": npm treats a
"--flag" after "--" as one of its own config keys and forwards only the value.`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    validateOnly: false,
    limit: undefined,
    doc: undefined,
    concurrency: 4,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case '--validate-only':
        options.validateOnly = true;
        break;
      case '--limit':
        options.limit = Number(next());
        break;
      case '--doc':
        options.doc = next();
        break;
      case '--concurrency':
        options.concurrency = Number(next());
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        // A bare value with no flag in front of it is almost always npm having eaten
        // the flag, so say so instead of just rejecting the argument.
        throw new Error(
          arg.startsWith('-')
            ? `Unknown argument: ${arg}\n\n${USAGE}`
            : `Unexpected argument "${arg}". If you ran "npm run eval -- --limit ${arg}", npm ` +
              `stripped the flag and passed only the value.\nUse "npx tsx src/cli/eval.ts ` +
              `--limit ${arg}", or "npm run eval:smoke" / "npm run eval:validate".`,
        );
    }
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return options;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Hand-rolled rather than pulled in as a dependency: it is nine lines, and a
 * twenty-five document eval does not justify another package in the tree. Results are
 * written back by index so the output order matches the input order regardless of which
 * document finishes first - reproducible reports matter more than a few milliseconds.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function scoreDocument(doc: LabelledDocument): Promise<DocumentComparison> {
  try {
    const result = await runPipeline(doc.id, doc.text, getPromptSet());
    return compareDocument(doc.truth, result);
  } catch (error) {
    // A failed document stays in the denominator. Errors are bucketed by cause so the
    // taxonomy distinguishes "the model broke its contract" from "the network did".
    const isSchema = error instanceof SchemaValidationError || error instanceof ModelResponseError;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ! ${doc.id}: ${message}`);
    return failedDocument(doc.id, doc.truth, isSchema ? 'schema-error' : 'api-error', message);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const dataset = await loadDataset(options.doc, options.limit);
  console.error(`Dataset OK: ${dataset.length} document/label pairs validated.`);

  if (options.validateOnly) {
    console.error('--validate-only: no API calls made, nothing written.');
    return;
  }

  const prompts = getPromptSet();
  console.error(
    `Running ${dataset.length} documents - model=${MODEL} prompts=${PROMPT_VERSION} concurrency=${options.concurrency}`,
  );

  let done = 0;
  const comparisons = await mapWithConcurrency(dataset, options.concurrency, async (doc) => {
    const comparison = await scoreDocument(doc);
    console.error(`  [${++done}/${dataset.length}] ${doc.id}`);
    return comparison;
  });

  const metrics = aggregate(comparisons);
  const record: RunRecord = {
    promptVersion: prompts.version,
    promptChangelog: prompts.changelog,
    model: MODEL,
    timestamp: new Date().toISOString(),
    metrics,
    failures: comparisons.flatMap((c) => c.failures),
    documents: comparisons.map((c) => ({ id: c.documentId, summary: c.summary, completed: c.completed })),
  };

  await saveRun(record, comparisons);
  await writeReport(renderReport(record, await loadRuns()));

  const percent = (correct: number, total: number): string =>
    total === 0 ? 'n/a' : `${((correct / total) * 100).toFixed(1)}%`;

  console.error('');
  console.error(`Field accuracy (normalised): ${percent(metrics.overall.normalized.correct, metrics.overall.normalized.total)}`);
  console.error(`Field accuracy (strict):     ${percent(metrics.overall.strict.correct, metrics.overall.strict.total)}`);
  console.error(`Urgency accuracy:            ${percent(metrics.urgency.correct, metrics.urgency.total)} (${metrics.urgency.underTriaged} under-triaged)`);
  console.error(`Category accuracy:           ${percent(metrics.category.correct, metrics.category.total)}`);
  console.error(`Hard failures:               ${record.failures.filter((f) => f.severity === 'hard').length}`);
  console.error('');
  console.error('Wrote results.md and results/run-' + record.promptVersion + '.json');
}

main().catch((error: unknown) => {
  if (error instanceof DatasetError) {
    console.error(`\nDataset error: ${error.message}`);
  } else {
    console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
