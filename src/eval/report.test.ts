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
import { compareRuns, loadRuns, runFileName, runKey, runSlug, type RunRecord } from './report.js';

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
