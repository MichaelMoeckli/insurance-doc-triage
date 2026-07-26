/**
 * Run persistence and the `results.md` report.
 *
 * Each run writes `results/run-<version>.json`. The report then reads *every* run
 * record on disk and renders them side by side, so the v1 vs v2 comparison table
 * appears the moment a second version has been run - no bookkeeping, no copy-paste, and
 * no opportunity to compare a fresh run against a half-remembered old number.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, estimateCostUsd } from '../config.js';
import { EXTRACTED_FIELDS, type ExtractedField, type TokenUsage } from '../types.js';
import type { DocumentComparison, Ratio, RunMetrics } from './compare.js';
import { FAILURE_DESCRIPTIONS, tallyByCategory, type Failure, type FailureCategory } from './taxonomy.js';

/**
 * One line per document, so a run record alone is enough to re-read the outputs and to
 * rebuild the cost table.
 *
 * Tokens and latency are recorded; cost is not. Cost is derived at render time from the
 * price table in `src/config.ts`, which is explicitly expected to go stale - baking a
 * number computed against last quarter's prices into a committed record would make the
 * history quietly inconsistent.
 */
export interface RunDocumentRecord {
  id: string;
  summary: string | null;
  completed: boolean;
  /** Absent in run records written before cost tracking existed. */
  usage?: TokenUsage;
  /** Per-document wall clock, `extract` + `triage`. Absent in older records. */
  latencyMs?: number;
}

export interface RunRecord {
  promptVersion: string;
  promptChangelog: string;
  model: string;
  timestamp: string;
  metrics: RunMetrics;
  failures: Failure[];
  documents: RunDocumentRecord[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(value: Ratio): string {
  if (value.total === 0) return 'n/a';
  return `${((value.correct / value.total) * 100).toFixed(1)}%`;
}

function pctValue(value: Ratio): number {
  return value.total === 0 ? 0 : (value.correct / value.total) * 100;
}

function cell(value: Ratio): string {
  return `${pct(value)} (${value.correct}/${value.total})`;
}

function delta(current: Ratio, previous: Ratio | undefined): string {
  if (!previous) return '-';
  const diff = pctValue(current) - pctValue(previous);
  if (Math.abs(diff) < 0.05) return '=';
  return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}pp`;
}

/** Renders a cost, keeping "we cannot price this model" distinct from "it was free". */
function usd(value: number | null, digits = 4): string {
  return value === null ? 'n/a (unpriced model)' : `~$${value.toFixed(digits)}`;
}

function ms(value: number): string {
  return `${Math.round(value).toLocaleString('en')} ms`;
}

function tokens(value: number): string {
  return value.toLocaleString('en');
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Escapes the pipe characters that would otherwise break a markdown table row. */
function td(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveRun(record: RunRecord, comparisons: readonly DocumentComparison[]): Promise<void> {
  await mkdir(PATHS.rawResults, { recursive: true });
  await writeFile(
    path.join(PATHS.results, `run-${record.promptVersion}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  // Per-document detail is gitignored: useful while iterating, noise in a diff.
  await writeFile(
    path.join(PATHS.rawResults, `${record.promptVersion}-documents.json`),
    `${JSON.stringify(comparisons, null, 2)}\n`,
    'utf8',
  );
}

/** Loads every saved run, newest-version-last, for the comparison table. */
export async function loadRuns(): Promise<RunRecord[]> {
  let files: string[];
  try {
    files = await readdir(PATHS.results);
  } catch {
    return [];
  }

  const records: RunRecord[] = [];
  for (const file of files.filter((f) => /^run-.+\.json$/.test(f))) {
    try {
      records.push(JSON.parse(await readFile(path.join(PATHS.results, file), 'utf8')) as RunRecord);
    } catch {
      // A corrupt or hand-edited run record should not stop the current run from
      // reporting. It simply drops out of the comparison.
    }
  }
  return records.sort((a, b) => a.promptVersion.localeCompare(b.promptVersion, 'en', { numeric: true }));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** A document's spend, with the price applied at render time rather than at run time. */
interface DocumentCost {
  id: string;
  usage: TokenUsage;
  latencyMs: number;
  costUsd: number | null;
}

function documentCosts(record: RunRecord): DocumentCost[] {
  const rows: DocumentCost[] = [];
  for (const doc of record.documents) {
    // Documents whose pipeline threw carry no usage: whatever they spent before the
    // failure is not attributed, so averaging them in would understate cost per document.
    if (!doc.completed || !doc.usage || doc.latencyMs === undefined) continue;
    rows.push({
      id: doc.id,
      usage: doc.usage,
      latencyMs: doc.latencyMs,
      costUsd: estimateCostUsd(record.model, doc.usage),
    });
  }
  return rows;
}

/**
 * Cost and latency, per document and on average.
 *
 * The number a reader actually wants is not this run's spend - it is what the thing
 * costs at volume - so the projection to 1,000 documents is stated explicitly rather
 * than left as an exercise.
 */
function renderCostSection(record: RunRecord): string[] {
  const lines: string[] = ['## Cost and latency', ''];
  const rows = documentCosts(record);

  if (rows.length === 0) {
    lines.push(
      'This run record predates per-document cost tracking, or no document completed. ' +
        'Re-run `npm run eval` to populate this section.',
      '',
    );
    return lines;
  }

  lines.push(
    'Input and output tokens and wall-clock latency are captured per model call ' +
      '(`meta.calls` on every pipeline result) and summed per document. Costs are ' +
      'computed at render time from the indicative per-million-token prices in ' +
      '`src/config.ts` - a sanity check on spend, not a bill.',
    '',
    'Latency is the *document* wall clock: `extract` then `triage`, which run in ' +
      'sequence. Documents run concurrently during an eval, so the column below sums to ' +
      'considerably more than the elapsed time of the run.',
    '',
  );

  const costs = rows.map((r) => r.costUsd);
  const totalCost = costs.some((c) => c === null)
    ? null
    : costs.reduce((sum: number, c) => sum + (c ?? 0), 0);
  const latencies = rows.map((r) => r.latencyMs);
  const inputTotal = rows.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  const outputTotal = rows.reduce((sum, r) => sum + r.usage.outputTokens, 0);

  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Documents priced | ${rows.length} of ${record.documents.length} |`);
  lines.push(`| Model calls | ${rows.length * 2} (2 per document) |`);
  lines.push(`| Tokens | ${tokens(inputTotal)} in / ${tokens(outputTotal)} out |`);
  lines.push(`| Total cost | ${usd(totalCost)} |`);
  lines.push(`| Cost per document (mean) | ${usd(totalCost === null ? null : totalCost / rows.length, 5)} |`);
  lines.push(
    `| Projected cost per 1,000 documents | ${usd(totalCost === null ? null : (totalCost / rows.length) * 1000, 2)} |`,
  );
  lines.push(`| Latency per document (mean) | ${ms(mean(latencies))} |`);
  lines.push(`| Latency per document (median) | ${ms(median(latencies))} |`);
  lines.push(`| Latency per document (slowest) | ${ms(Math.max(...latencies))} |`);
  lines.push('');

  lines.push('| Document | Input tok | Output tok | Cost (USD) | Latency (ms) |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    lines.push(
      `| \`${td(row.id)}\` | ${tokens(row.usage.inputTokens)} | ${tokens(row.usage.outputTokens)} | ` +
        `${usd(row.costUsd, 5)} | ${tokens(row.latencyMs)} |`,
    );
  }
  lines.push(
    `| **average** | **${tokens(Math.round(inputTotal / rows.length))}** | ` +
      `**${tokens(Math.round(outputTotal / rows.length))}** | ` +
      `**${usd(totalCost === null ? null : totalCost / rows.length, 5)}** | ` +
      `**${tokens(Math.round(mean(latencies)))}** |`,
  );
  lines.push('');
  lines.push(
    'Two calls per document is the deliberate cost of splitting extraction from triage ' +
      '(see the architecture note in the README). This table is what that decision costs: ' +
      'halving it is one merged schema away, and the price is that the eval can no longer ' +
      'tell an extraction error from a classification error.',
  );
  lines.push('');
  return lines;
}

const FIELD_LABELS: Record<ExtractedField, string> = {
  policyNumber: 'policyNumber',
  claimantName: 'claimantName',
  dateOfLoss: 'dateOfLoss',
  claimType: 'claimType',
  amount: 'amount',
  currency: 'currency',
};

export function renderReport(current: RunRecord, allRuns: readonly RunRecord[]): string {
  const m = current.metrics;
  const lines: string[] = [];

  lines.push('# claim-triage evaluation report');
  lines.push('');
  lines.push('Generated by `npm run eval`. Do not edit by hand - it is overwritten on every run.');
  lines.push('');
  lines.push(`- **Prompt version:** \`${current.promptVersion}\` - ${current.promptChangelog}`);
  lines.push(`- **Model:** \`${current.model}\``);
  lines.push(`- **Documents:** ${m.documents} (${m.completed} completed the pipeline)`);
  lines.push(`- **Run at:** ${current.timestamp}`);
  lines.push(
    `- **Tokens:** ${tokens(m.usage.inputTokens)} in / ${tokens(m.usage.outputTokens)} out - ${usd(estimateCostUsd(current.model, m.usage))}`,
  );
  lines.push('');

  // --- Headline -----------------------------------------------------------
  lines.push('## Headline');
  lines.push('');
  lines.push('| Metric | Result |');
  lines.push('| --- | --- |');
  lines.push(`| Field accuracy (normalised) | ${cell(m.overall.normalized)} |`);
  lines.push(`| Field accuracy (strict) | ${cell(m.overall.strict)} |`);
  lines.push(`| Urgency accuracy | ${cell(m.urgency)} |`);
  lines.push(`| Category accuracy | ${cell(m.category)} |`);
  lines.push(`| \`missingFields\` exact set match | ${cell(m.missingFields.exact)} |`);
  lines.push(`| Under-triaged documents | ${m.urgency.underTriaged} |`);
  lines.push('');
  lines.push(
    'Strict compares exactly what the model emitted. Normalised applies the rules in ' +
      '`src/eval/normalize.ts` (date notation, case, whitespace, salutations, rappen ' +
      'rounding). A gap between the two rows is format drift, not comprehension failure.',
  );
  lines.push('');

  // --- Per field ----------------------------------------------------------
  lines.push('## Field-level accuracy');
  lines.push('');
  lines.push('| Field | Normalised | Strict |');
  lines.push('| --- | --- | --- |');
  for (const field of EXTRACTED_FIELDS) {
    const stats = m.fields[field];
    lines.push(`| \`${FIELD_LABELS[field]}\` | ${cell(stats.normalized)} | ${cell(stats.strict)} |`);
  }
  lines.push(`| **overall** | **${cell(m.overall.normalized)}** | **${cell(m.overall.strict)}** |`);
  lines.push('');

  // --- Completeness -------------------------------------------------------
  lines.push('## Completeness self-report');
  lines.push('');
  lines.push(
    'Does the model know what it does not know? Precision and recall are computed over ' +
      'every (document, field) pair, treating "declared missing" as the positive class. ' +
      'Low recall means fields are silently guessed; low precision means real values are ' +
      'thrown away.',
  );
  lines.push('');
  lines.push('| Metric | Result |');
  lines.push('| --- | --- |');
  lines.push(`| Exact set match | ${cell(m.missingFields.exact)} |`);
  lines.push(`| Precision | ${(m.missingFields.precision * 100).toFixed(1)}% |`);
  lines.push(`| Recall | ${(m.missingFields.recall * 100).toFixed(1)}% |`);
  lines.push(`| F1 | ${(m.missingFields.f1 * 100).toFixed(1)}% |`);
  lines.push('');

  // --- Classification -----------------------------------------------------
  lines.push('## Classification');
  lines.push('');
  lines.push('| Metric | Result |');
  lines.push('| --- | --- |');
  lines.push(`| Urgency accuracy | ${cell(m.urgency)} |`);
  lines.push(`| of which under-triaged | ${m.urgency.underTriaged} |`);
  lines.push(`| Category accuracy | ${cell(m.category)} |`);
  lines.push('');
  lines.push(
    'Under-triage - predicting a lower urgency than the truth - is the failure that ' +
      'costs a carrier money, because the claim sits in a queue while the exposure grows. ' +
      'Over-triage only costs handler time. They are not interchangeable and are not ' +
      'averaged together here.',
  );
  lines.push('');

  const urgencyPairs = Object.entries(m.confusion.urgency);
  if (urgencyPairs.length) {
    lines.push('### Urgency confusions');
    lines.push('');
    lines.push('| Expected -> predicted | Count |');
    lines.push('| --- | --- |');
    for (const [pair, count] of urgencyPairs.sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${td(pair)} | ${count} |`);
    }
    lines.push('');
  }

  const categoryPairs = Object.entries(m.confusion.category);
  if (categoryPairs.length) {
    lines.push('### Category confusions');
    lines.push('');
    lines.push('| Expected -> predicted | Count |');
    lines.push('| --- | --- |');
    for (const [pair, count] of categoryPairs.sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${td(pair)} | ${count} |`);
    }
    lines.push('');
  }

  // --- Cost and latency ---------------------------------------------------
  lines.push(...renderCostSection(current));

  // --- Taxonomy -----------------------------------------------------------
  lines.push('## Failure taxonomy');
  lines.push('');
  const tally = tallyByCategory(current.failures);
  if (tally.size === 0) {
    lines.push('No failures recorded.');
    lines.push('');
  } else {
    lines.push('| Category | Count | Hard | Soft | What it means |');
    lines.push('| --- | --- | --- | --- | --- |');
    const sorted = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [category, items] of sorted) {
      const hard = items.filter((f) => f.severity === 'hard').length;
      lines.push(
        `| \`${category}\` | ${items.length} | ${hard} | ${items.length - hard} | ${td(FAILURE_DESCRIPTIONS[category as FailureCategory])} |`,
      );
    }
    lines.push('');
    lines.push(
      'Hard failures count against accuracy. Soft ones do not - the normalised comparison ' +
        'passed and only the surface form was wrong - but they are still defects for any ' +
        'downstream consumer that parses the raw output.',
    );
    lines.push('');

    // --- Failure log ------------------------------------------------------
    lines.push('## Failure log');
    lines.push('');
    lines.push('| Document | Field | Category | Expected | Got | Why this document is hard |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const [, items] of sorted) {
      for (const failure of items) {
        lines.push(
          `| \`${td(failure.documentId)}\` | \`${td(failure.field)}\` | \`${failure.category}\` | ${td(failure.expected)} | ${td(failure.actual)} | ${td(failure.note)} |`,
        );
      }
    }
    lines.push('');
  }

  // --- Version comparison -------------------------------------------------
  lines.push('## Prompt version comparison');
  lines.push('');
  if (allRuns.length < 2) {
    lines.push(
      `Only \`${current.promptVersion}\` has been run. Add a version under \`src/prompts/\`, ` +
        'register it in `src/prompts/index.ts`, then run `PROMPT_VERSION=v2 npm run eval` - ' +
        'this table fills in automatically.',
    );
    lines.push('');
  } else {
    const baseline = allRuns[0]!;
    lines.push(`Deltas are against \`${baseline.promptVersion}\`, in percentage points.`);
    lines.push('');
    const header = ['Metric', ...allRuns.map((r) => `\`${r.promptVersion}\``)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);

    const row = (label: string, pick: (r: RunRecord) => Ratio): void => {
      const cells = allRuns.map((r, index) =>
        index === 0 ? cell(pick(r)) : `${cell(pick(r))} (${delta(pick(r), pick(baseline))})`,
      );
      lines.push(`| ${label} | ${cells.join(' | ')} |`);
    };

    row('Field accuracy (normalised)', (r) => r.metrics.overall.normalized);
    row('Field accuracy (strict)', (r) => r.metrics.overall.strict);
    for (const field of EXTRACTED_FIELDS) {
      row(`&nbsp;&nbsp;\`${field}\``, (r) => r.metrics.fields[field].normalized);
    }
    row('`missingFields` exact set match', (r) => r.metrics.missingFields.exact);
    row('Urgency accuracy', (r) => r.metrics.urgency);
    row('Category accuracy', (r) => r.metrics.category);
    lines.push(
      `| Under-triaged | ${allRuns.map((r) => String(r.metrics.urgency.underTriaged)).join(' | ')} |`,
    );
    lines.push(
      `| Hard failures | ${allRuns.map((r) => String(r.failures.filter((f) => f.severity === 'hard').length)).join(' | ')} |`,
    );
    lines.push('');

    lines.push('### Changelog');
    lines.push('');
    lines.push('| Version | Model | Change |');
    lines.push('| --- | --- | --- |');
    for (const run of allRuns) {
      lines.push(`| \`${run.promptVersion}\` | \`${run.model}\` | ${td(run.promptChangelog)} |`);
    }
    lines.push('');
    lines.push(
      'A version that changes more than one thing cannot be attributed. If two of these ' +
        'rows describe two changes each, the deltas above are decoration.',
    );
    lines.push('');
  }

  // --- Per-document summaries --------------------------------------------
  lines.push('## Per-document output');
  lines.push('');
  lines.push('The one-line summary the pipeline produced for each document, in run order.');
  lines.push('');
  for (const doc of current.documents) {
    lines.push(`- \`${doc.id}\` - ${doc.summary ? td(doc.summary) : '**pipeline failed**'}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

export async function writeReport(content: string): Promise<void> {
  await writeFile(PATHS.report, content, 'utf8');
}
