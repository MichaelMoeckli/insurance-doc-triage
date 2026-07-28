/**
 * Tests for run identity.
 *
 * A run record is keyed by (prompt version, model). These tests exist because the
 * previous key - prompt version alone - silently overwrote the record of the first run
 * when the same prompt was re-run against a second model, which is exactly the
 * comparison the harness is for. A regression here does not throw; it deletes a
 * measurement. So the collision case, the stale-leftover case and the ordering are
 * pinned down explicitly.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EXTRACTED_FIELDS } from '../types.js';
import type { RunMetrics } from './compare.js';
import { compareRuns, loadRuns, renderReport, runFileName, runKey, runSlug, type RunRecord } from './report.js';

function record(promptVersion: string, model: string, timestamp: string): RunRecord {
  return {
    promptVersion,
    model,
    timestamp,
    promptChangelog: `${promptVersion} on ${model}`,
    // The report never reads these in the code paths under test.
    metrics: {} as RunRecord['metrics'],
    failures: [],
    documents: [],
  };
}

/** A zeroed `RunMetrics`, for tests about rendering rather than about aggregation. */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  const zero = { correct: 0, total: 0 };
  return {
    documents: 0,
    completed: 0,
    fields: Object.fromEntries(
      EXTRACTED_FIELDS.map((field) => [field, { strict: zero, normalized: zero }]),
    ) as RunMetrics['fields'],
    overall: { strict: zero, normalized: zero },
    missingFields: { exact: zero, precision: 1, recall: 1, f1: 1 },
    urgency: { ...zero, underTriaged: 0 },
    category: zero,
    confusion: { urgency: {}, category: {} },
    usage: { inputTokens: 0, outputTokens: 0 },
    totalLatencyMs: 0,
    ...overrides,
  };
}

describe('runKey', () => {
  it('identifies a run by version and model together', () => {
    assert.equal(runKey(record('v2', 'gpt-5-mini', '')), 'v2@gpt-5-mini');
  });

  it('separates two models running the same prompt version', () => {
    assert.notEqual(runKey(record('v2', 'gpt-5', '')), runKey(record('v2', 'gpt-5-mini', '')));
  });
});

describe('runFileName', () => {
  it('includes both halves of the key', () => {
    assert.equal(runFileName(record('v2', 'gpt-5-mini', '')), 'run-v2--gpt-5-mini.json');
  });

  it('does not collide across models', () => {
    assert.notEqual(
      runFileName(record('v2', 'gpt-5', '')),
      runFileName(record('v2', 'gpt-5-mini', '')),
    );
  });

  it('keeps the dots a real model id needs', () => {
    assert.equal(runFileName(record('v1', 'gpt-4.1-mini', '')), 'run-v1--gpt-4.1-mini.json');
  });

  it('sanitises path separators out of a vendor model id', () => {
    // A model id is an opaque vendor string; a slash in one must not escape results/.
    assert.equal(runSlug(record('v1', 'vendor/model:v2', '')), 'v1--vendor_model_v2');

    // The property that matters is that the result is one path segment, so it cannot
    // traverse - not that the characters ".." never survive anywhere in the name.
    const hostile = runFileName(record('v1', '../../etc/passwd', ''));
    assert.equal(path.basename(hostile), hostile);
    assert.ok(!hostile.includes('/') && !hostile.includes('\\'));
  });
});

describe('compareRuns', () => {
  it('orders prompt versions numerically, not lexically', () => {
    const runs = [record('v10', 'm', ''), record('v2', 'm', ''), record('v1', 'm', '')];
    assert.deepEqual(
      [...runs].sort(compareRuns).map((r) => r.promptVersion),
      ['v1', 'v2', 'v10'],
    );
  });

  it('falls back to the model when the version matches', () => {
    const runs = [record('v2', 'gpt-5-mini', ''), record('v2', 'gpt-4.1-mini', '')];
    assert.deepEqual(
      [...runs].sort(compareRuns).map((r) => r.model),
      ['gpt-4.1-mini', 'gpt-5-mini'],
    );
  });
});

/**
 * Grounding and the language slice were added after run records had been committed, so
 * the report has to render two shapes of record. The failure mode worth pinning is not a
 * crash - it is an old run being drawn as though it had *scored* zero on a metric it
 * never measured, which would put a fabricated regression in the comparison table.
 */
describe('renderReport', () => {
  /** Unlike `record`, this one carries metrics the renderer can actually read. */
  const run = (promptVersion: string, timestamp: string, m: RunMetrics): RunRecord => ({
    ...record(promptVersion, 'gpt-5-mini', timestamp),
    metrics: m,
  });

  const measured = (): RunMetrics =>
    metrics({
      documents: 3,
      completed: 3,
      grounding: {
        grounded: { correct: 17, total: 18 },
        cited: { correct: 18, total: 18 },
        quotedButNull: 2,
      },
      byLanguage: [
        {
          key: 'de',
          documents: 2,
          fields: { strict: { correct: 11, total: 12 }, normalized: { correct: 12, total: 12 } },
          missingFieldsExact: { correct: 2, total: 2 },
          urgency: { correct: 2, total: 2, underTriaged: 0 },
          category: { correct: 2, total: 2 },
          grounding: { grounded: { correct: 11, total: 12 }, cited: { correct: 12, total: 12 }, quotedButNull: 2 },
        },
        {
          key: 'en',
          documents: 1,
          fields: { strict: { correct: 6, total: 6 }, normalized: { correct: 6, total: 6 } },
          missingFieldsExact: { correct: 1, total: 1 },
          urgency: { correct: 1, total: 1, underTriaged: 0 },
          category: { correct: 1, total: 1 },
          grounding: { grounded: { correct: 6, total: 6 }, cited: { correct: 6, total: 6 }, quotedButNull: 0 },
        },
      ],
    });

  it('renders both new sections when the run measured them', () => {
    const current = run('v2', '2026-01-02T00:00:00.000Z', measured());
    const output = renderReport(current, [current]);

    assert.ok(output.includes('| Grounded spans | 94.4% (17/18) |'));
    assert.ok(output.includes('| Cited fields | 100.0% (18/18) |'));
    assert.ok(output.includes('| Spans on null fields | 2 |'));
    assert.ok(output.includes('| `de` | 2 | 100.0% (12/12) | 91.7% (11/12) |'));
    assert.ok(output.includes('| `en` | 1 | 100.0% (6/6) |'));
    assert.ok(!output.includes('predates quote grounding'));
    assert.ok(!output.includes('predates the per-language slice'));
  });

  it('says a section is unmeasured rather than rendering it as zero', () => {
    const current = run('v1', '2026-01-01T00:00:00.000Z', metrics());
    const output = renderReport(current, [current]);

    assert.ok(output.includes('predates quote grounding'));
    assert.ok(output.includes('predates the per-language slice'));
    assert.ok(!output.includes('| Grounded spans |'), 'an unmeasured metric must not render as a score');
  });

  it('marks a run that predates grounding as n/a in the comparison, never as 0%', () => {
    const older = run('v1', '2026-01-01T00:00:00.000Z', metrics());
    const newer = run('v2', '2026-01-02T00:00:00.000Z', measured());
    const output = renderReport(newer, [older, newer]);

    // The same label appears in the headline table for the current run, so look only
    // inside the comparison section - the headline row is about `newer` alone. The
    // heading itself depends on whether the runs differ in model as well as version.
    const heading = Math.max(output.indexOf('## Run comparison'), output.indexOf('## Prompt version comparison'));
    assert.ok(heading >= 0, 'the comparison section is present');
    const comparison = output.slice(heading);
    const row = comparison.split('\n').find((line) => line.startsWith('| Grounded source quotes |'));
    assert.ok(row, 'the row appears once at least one run has the metric');
    assert.ok(row.includes('n/a'));
    // The delta is against a baseline that has no value, so there is nothing to subtract.
    assert.ok(!row.includes('pp'), `a delta against an unmeasured baseline is meaningless: ${row}`);
  });

  it('omits the grounding row entirely when no run measured it', () => {
    const a = run('v1', '2026-01-01T00:00:00.000Z', metrics());
    const b = run('v2', '2026-01-02T00:00:00.000Z', metrics());
    const output = renderReport(b, [a, b]);

    assert.ok(!output.includes('| Grounded source quotes |'));
  });
});

describe('loadRuns', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'claim-triage-runs-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (file: string, value: unknown): Promise<void> =>
    writeFile(path.join(dir, file), JSON.stringify(value, null, 2), 'utf8');

  it('keeps one run per (version, model) and sorts them', async () => {
    await write('run-v2--gpt-5-mini.json', record('v2', 'gpt-5-mini', '2026-01-02T00:00:00.000Z'));
    await write('run-v1--gpt-5-mini.json', record('v1', 'gpt-5-mini', '2026-01-01T00:00:00.000Z'));
    await write('run-v2--gpt-5.json', record('v2', 'gpt-5', '2026-01-03T00:00:00.000Z'));

    const runs = await loadRuns(dir);
    assert.deepEqual(runs.map(runKey), ['v1@gpt-5-mini', 'v2@gpt-5', 'v2@gpt-5-mini']);
  });

  it('prefers the newer record when a pre-rename leftover describes the same run', async () => {
    // `run-v1.json` is what the old naming produced. It must not appear as a second,
    // identical column beside its replacement, and must not shadow the newer result.
    await write('run-v1.json', record('v1', 'gpt-5-mini', '2025-12-01T00:00:00.000Z'));

    const runs = await loadRuns(dir);
    assert.equal(runs.filter((r) => runKey(r) === 'v1@gpt-5-mini').length, 1);
    assert.equal(runs.find((r) => runKey(r) === 'v1@gpt-5-mini')?.timestamp, '2026-01-01T00:00:00.000Z');
  });

  it('skips malformed and unrelated files rather than failing the run', async () => {
    await writeFile(path.join(dir, 'run-broken.json'), '{ not json', 'utf8');
    await write('run-nokey.json', { timestamp: '2026-01-04T00:00:00.000Z' });
    await write('notes.json', record('v9', 'gpt-5', '2026-01-05T00:00:00.000Z'));

    const runs = await loadRuns(dir);
    assert.deepEqual(runs.map(runKey), ['v1@gpt-5-mini', 'v2@gpt-5', 'v2@gpt-5-mini']);
  });

  it('returns nothing for a directory that does not exist', async () => {
    assert.deepEqual(await loadRuns(path.join(dir, 'absent')), []);
  });
});
