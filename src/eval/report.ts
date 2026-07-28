/**
 * Run persistence and the `results.md` report.
 *
 * Each run writes `results/run-<version>--<model>.json`. The report then reads *every*
 * run record on disk and renders them side by side, so the comparison table appears the
 * moment a second run exists - no bookkeeping, no copy-paste, and no opportunity to
 * compare a fresh run against a half-remembered old number.
 *
 * A run is identified by the *pair* (prompt version, model), not by prompt version
 * alone. Keying on the version alone meant re-running `v2` against a different model
 * silently overwrote the record of the first one - which is the one comparison this
 * harness most needs to support, since "is 96% a prompt problem or a model ceiling?"
 * is only answerable by holding the prompt fixed and changing the model.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, estimateCostUsd } from '../config.js';
import { EXTRACTED_FIELDS, type ExtractedField, type TokenUsage } from '../types.js';
import type { DocumentComparison, GroundingMetrics, Ratio, RunMetrics, SliceMetrics } from './compare.js';
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
// Run identity
// ---------------------------------------------------------------------------

/** The pair that identifies a run. Everything below keys on this, never on version alone. */
export type RunIdentity = Pick<RunRecord, 'promptVersion' | 'model'>;

/** Human-readable run id, for CLI output, error messages and column headers. */
export function runKey(record: RunIdentity): string {
  return `${record.promptVersion}@${record.model}`;
}

/**
 * Filesystem-safe path segment. Model ids are vendor strings and only *usually* look
 * like `gpt-5-mini`; a slash or colon in one would otherwise write outside `results/`.
 *
 * Dots survive, because `gpt-4.1-mini` needs them - so leading dots are stripped
 * separately to keep the result from ever being `.` or `..`.
 */
function slug(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '');
  return cleaned || 'unknown';
}

/**
 * `<version>--<model>`, e.g. `v2--gpt-5-mini`.
 *
 * Both halves may themselves contain a hyphen, so this is deliberately not parseable
 * back into its parts - nothing needs to. The file name exists to be unique and
 * legible in a directory listing; the authoritative version and model are fields
 * inside the record.
 */
export function runSlug(record: RunIdentity): string {
  return `${slug(record.promptVersion)}--${slug(record.model)}`;
}

/** File name of a run record, relative to `results/`. */
export function runFileName(record: RunIdentity): string {
  return `run-${runSlug(record)}.json`;
}

/** Sort order for the comparison table: prompt version first, then model. */
export function compareRuns(a: RunIdentity, b: RunIdentity): number {
  const byVersion = a.promptVersion.localeCompare(b.promptVersion, 'en', { numeric: true });
  return byVersion !== 0 ? byVersion : a.model.localeCompare(b.model, 'en', { numeric: true });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveRun(record: RunRecord, comparisons: readonly DocumentComparison[]): Promise<void> {
  await mkdir(PATHS.rawResults, { recursive: true });
  await writeFile(
    path.join(PATHS.results, runFileName(record)),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  // Per-document detail is gitignored: useful while iterating, noise in a diff.
  await writeFile(
    path.join(PATHS.rawResults, `${runSlug(record)}-documents.json`),
    `${JSON.stringify(comparisons, null, 2)}\n`,
    'utf8',
  );
}

/** A parsed file is only a run record if it carries the two fields everything keys on. */
function isRunRecord(value: unknown): value is RunRecord {
  const record = value as Partial<RunRecord> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.promptVersion === 'string' &&
    record.promptVersion !== '' &&
    typeof record.model === 'string' &&
    record.model !== ''
  );
}

/**
 * Loads every saved run, ordered by `compareRuns`, for the comparison table.
 *
 * `directory` is a parameter only so the dedupe and ordering rules can be tested against
 * a temporary directory; every caller uses the default.
 */
export async function loadRuns(directory: string = PATHS.results): Promise<RunRecord[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }

  const byKey = new Map<string, RunRecord>();
  for (const file of files.filter((f) => /^run-.+\.json$/.test(f))) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      if (!isRunRecord(parsed)) continue;
      // Two files can describe the same run - a `run-v2.json` left over from before
      // records were keyed by model, beside its `run-v2--gpt-5-mini.json` replacement.
      // Keep the newer, so a stale leftover can never shadow a fresh run or appear
      // twice in the comparison table as two identical columns.
      const existing = byKey.get(runKey(parsed));
      if (!existing || existing.timestamp.localeCompare(parsed.timestamp) < 0) {
        byKey.set(runKey(parsed), parsed);
      }
    } catch {
      // A corrupt or hand-edited run record should not stop the current run from
      // reporting. It simply drops out of the comparison.
    }
  }
  return [...byKey.values()].sort(compareRuns);
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

/**
 * Quote grounding: does the model's own evidence exist in the document?
 *
 * Reported as its own section rather than folded into field accuracy, because the two
 * answer different questions. Accuracy asks whether the value is right; this asks whether
 * anything supports it. A field can be right and ungrounded (the model knew the answer
 * and invented a citation) or wrong and grounded (it quoted the deductible and called it
 * the claimed amount), and only the pair tells you whether the field can be automated.
 */
function renderGroundingSection(grounding: GroundingMetrics | undefined): string[] {
  const lines: string[] = ['## Quote grounding', ''];

  if (!grounding) {
    lines.push(
      'This run record predates quote grounding. Re-run `npm run eval` to populate this ' +
        'section - it cannot be backfilled, because the check needs the cited spans and ' +
        'run records store only the aggregate.',
      '',
    );
    return lines;
  }

  lines.push(
    'Every value the model fills in must come with the verbatim span it was taken from. ' +
      'That claim is checked against the source document by substring match in ' +
      '`src/pipeline/grounding.ts` - no model call, no ground truth - so it is one of the ' +
      'few quality signals that still works on a document arriving in production, where ' +
      'no label exists.',
    '',
    '| Metric | Result | Reads as |',
    '| --- | --- | --- |',
    `| Grounded spans | ${cell(grounding.grounded)} | Cited spans that occur in the document. Anything below 100% is fabricated evidence. |`,
    `| Cited fields | ${cell(grounding.cited)} | Filled-in fields carrying a span at all. A gap here is unverifiable output, not dishonest output. |`,
    `| Spans on null fields | ${grounding.quotedButNull} | The schema says to omit these. A non-zero count is an instruction-following defect, not a hallucination. |`,
    '',
    'Comparison is modulo whitespace and typography only - `12’450.00` matches ' +
      "`12'450.00`, and a line break inside a span is ignored. Word order, digits and " +
      'content punctuation are compared as written, so a paraphrased or stitched-together ' +
      'span fails.',
    '',
    'Grounding is necessary for trusting a field and never sufficient: `CHF 500.00` is a ' +
      'real span of `motor-01` and supports nothing about the claimed amount - it is the ' +
      'deductible. Both grounding failure categories are therefore scored **soft**. They ' +
      'are a separate axis from correctness, and folding them into the headline would ' +
      'double-count the evidence and silently redefine the hard-failure row against every ' +
      'run already recorded.',
    '',
  );
  return lines;
}

/**
 * The headline numbers, split by document language.
 *
 * A single field-accuracy figure averaged over German and English cannot answer the first
 * question a Swiss carrier asks, and this dataset was built 11/11/3 precisely so the
 * question is answerable. The bucket sizes are small enough that the caution below is
 * part of the output rather than a footnote someone might skip.
 */
function renderLanguageSection(slices: readonly SliceMetrics[] | undefined): string[] {
  const lines: string[] = ['## By document language', ''];

  if (!slices || slices.length === 0) {
    lines.push(
      'This run record predates the per-language slice. Re-run `npm run eval` to populate ' +
        'this section.',
      '',
    );
    return lines;
  }

  lines.push(
    'Language is a property of the label, not something the pipeline predicts or is ' +
      'scored on. `mixed` means substantive content appears in both languages - a ' +
      'bilingual heading, or German field labels around English prose. A Swiss proper ' +
      'noun inside an English letter is not mixed; every document in the set has those.',
    '',
  );

  lines.push('| Language | Docs | Field (norm.) | Field (strict) | `missingFields` | Urgency | Under-tri. | Category | Grounded |');
  lines.push('| --- | ---: | --- | --- | --- | --- | ---: | --- | --- |');
  for (const slice of slices) {
    lines.push(
      `| \`${td(slice.key)}\` | ${slice.documents} | ${cell(slice.fields.normalized)} | ` +
        `${cell(slice.fields.strict)} | ${cell(slice.missingFieldsExact)} | ${cell(slice.urgency)} | ` +
        `${slice.urgency.underTriaged} | ${cell(slice.category)} | ${cell(slice.grounding.grounded)} |`,
    );
  }
  lines.push('');
  lines.push(
    '**Read the counts, not the percentages.** The largest bucket here is eleven ' +
      'documents, so one flipped answer moves a per-language field figure by more than a ' +
      'point and a half, and the `mixed` row is three documents - a single failure there ' +
      'is a third of the bucket. A gap between languages is worth investigating only when ' +
      'it is several documents wide and shows the same failure category on both sides of ' +
      'it. The point of this table is to make a systematic language effect *visible* if ' +
      'one exists, not to quantify one at this sample size.',
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
  if (m.grounding) lines.push(`| Grounded source quotes | ${cell(m.grounding.grounded)} |`);
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

  // --- Quote grounding ----------------------------------------------------
  lines.push(...renderGroundingSection(m.grounding));

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

  // --- Language slice -----------------------------------------------------
  lines.push(...renderLanguageSection(m.byLanguage));

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

  // --- Run comparison -----------------------------------------------------
  //
  // Runs vary along two axes now that records are keyed by (version, model). When every
  // run on disk shares one model the model is noise in a column header, so it is only
  // shown once there is more than one - which also keeps this section byte-identical to
  // what it rendered when a run was identified by its prompt version alone.
  const models = new Set(allRuns.map((r) => r.model));
  const versions = new Set(allRuns.map((r) => r.promptVersion));
  const showModel = models.size > 1;
  const columnLabel = (run: RunRecord): string =>
    showModel ? `\`${run.promptVersion}\` · \`${run.model}\`` : `\`${run.promptVersion}\``;

  lines.push(showModel ? '## Run comparison' : '## Prompt version comparison');
  lines.push('');
  if (allRuns.length < 2) {
    lines.push(
      `Only \`${runKey(current)}\` has been run. This table fills in automatically once a ` +
        'second run record exists, along either axis: a new prompt version under ' +
        '`src/prompts/` registered in `src/prompts/index.ts`, or the same prompt version ' +
        'against a different `OPENAI_MODEL`.',
    );
    lines.push('');
  } else {
    const baseline = allRuns[0]!;
    lines.push(
      `Deltas are against \`${showModel ? runKey(baseline) : baseline.promptVersion}\`, in percentage points.`,
    );
    lines.push('');
    if (showModel && versions.size > 1) {
      // The README's own rule - one change per version - applied to the table itself.
      lines.push(
        '**Two axes are in play.** These runs differ in prompt version *and* in model, so ' +
          'a delta between two columns that differ in both is not attributable to either ' +
          'one. Read along a single axis: hold the model fixed and vary the prompt, or hold ' +
          'the prompt fixed and vary the model.',
      );
      lines.push('');
    }
    const header = ['Metric', ...allRuns.map(columnLabel)];
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

    // A metric added after some runs were recorded. The older columns get `n/a`, never a
    // zero - a run that did not measure grounding is not a run that scored 0% on it. The
    // whole row disappears if no run on disk has the metric at all.
    const optionalRow = (label: string, pick: (r: RunRecord) => Ratio | undefined): void => {
      if (!allRuns.some((run) => pick(run))) return;
      const cells = allRuns.map((run, index) => {
        const value = pick(run);
        if (!value) return 'n/a';
        return index === 0 ? cell(value) : `${cell(value)} (${delta(value, pick(baseline))})`;
      });
      lines.push(`| ${label} | ${cells.join(' | ')} |`);
    };
    optionalRow('Grounded source quotes', (r) => r.metrics.grounding?.grounded);
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
