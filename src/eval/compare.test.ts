/**
 * Tests for scoring and failure classification.
 *
 * The point of these is attribution: it is not enough that a wrong answer is counted as
 * wrong, it has to land in the failure category that implies the right fix. A
 * hallucinated field and a missed field are both "wrong" and are repaired by opposite
 * prompt changes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GroundTruth, TriageResult } from '../types.js';
import { aggregate, compareDocument, failedDocument } from './compare.js';
import { checkCompleteness } from '../pipeline/completeness.js';

const truth: GroundTruth = {
  policyNumber: 'CH-MOT-2020-661234',
  claimantName: 'Lea Frei',
  dateOfLoss: '2025-02-27',
  claimType: 'motor',
  amount: 8500,
  currency: 'EUR',
  missingFields: [],
  urgency: 'normal',
  category: 'motor-collision',
  notes: 'fixture',
};

function result(overrides: Partial<TriageResult['extraction']> = {}, triage: Partial<TriageResult['triage']> = {}): TriageResult {
  return {
    documentId: 'fixture',
    extraction: {
      policyNumber: 'CH-MOT-2020-661234',
      claimantName: 'Lea Frei',
      dateOfLoss: '2025-02-27',
      claimType: 'motor',
      amount: 8500,
      currency: 'EUR',
      missingFields: [],
      sourceQuotes: [],
      ...overrides,
    },
    completeness: { missing: [], isComplete: true, disagreements: [] },
    triage: {
      urgency: 'normal',
      category: 'motor-collision',
      recommendedAction: 'Assign to the motor desk.',
      rationale: 'Routine.',
      ...triage,
    },
    summary: 'summary',
    meta: {
      model: 'test',
      promptVersion: 'test',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      costUsd: 0,
      calls: [],
    },
  };
}

const categories = (comparison: ReturnType<typeof compareDocument>): string[] =>
  comparison.failures.map((f) => f.category);

describe('compareDocument', () => {
  it('records nothing for an exact match', () => {
    const comparison = compareDocument(truth, result());
    assert.deepEqual(comparison.failures, []);
    assert.equal(comparison.fields.amount.strict, true);
    assert.equal(comparison.urgency.correct, true);
  });

  it('treats a correct date in the wrong notation as a soft format failure', () => {
    const comparison = compareDocument(truth, result({ dateOfLoss: '27.02.2025' }));
    assert.deepEqual(categories(comparison), ['date-format']);
    assert.equal(comparison.failures[0]?.severity, 'soft');
    // Soft failures must not cost normalised accuracy, but must cost strict accuracy.
    assert.equal(comparison.fields.dateOfLoss.normalized, true);
    assert.equal(comparison.fields.dateOfLoss.strict, false);
  });

  it('separates a wrong date from a badly formatted one', () => {
    const comparison = compareDocument(truth, result({ dateOfLoss: '2025-03-01' }));
    assert.deepEqual(categories(comparison), ['date-value']);
    assert.equal(comparison.fields.dateOfLoss.normalized, false);
  });

  it('separates a separator misparse from a wrong amount', () => {
    assert.deepEqual(categories(compareDocument(truth, result({ amount: 8.5 }))), ['amount-format']);
    assert.deepEqual(categories(compareDocument(truth, result({ amount: 500 }))), ['amount-value']);
  });

  it('distinguishes a hallucinated field from a missed one', () => {
    const sparseTruth: GroundTruth = { ...truth, amount: null, currency: null, missingFields: ['amount', 'currency'] };

    const invented = compareDocument(sparseTruth, result());
    assert.ok(categories(invented).includes('hallucinated-field'));

    const omitted = compareDocument(truth, result({ amount: null, missingFields: ['amount'] }));
    assert.ok(categories(omitted).includes('missed-field'));
  });

  it('scores the model self-report in both directions', () => {
    const spurious = compareDocument(truth, result({ missingFields: ['policyNumber'] }));
    assert.ok(categories(spurious).includes('spurious-missing-field'));

    const sparseTruth: GroundTruth = { ...truth, currency: null, missingFields: ['currency'] };
    const missed = compareDocument(sparseTruth, result({ currency: null, missingFields: [] }));
    assert.ok(categories(missed).includes('missed-missing-field'));
    assert.equal(missed.missingFields.exact, false);
  });

  it('normalises away a salutation without hiding the strict miss', () => {
    const comparison = compareDocument(truth, result({ claimantName: 'Frau Lea Frei' }));
    assert.deepEqual(comparison.failures, []);
    assert.equal(comparison.fields.claimantName.normalized, true);
    assert.equal(comparison.fields.claimantName.strict, false);
  });

  it('flags under-triage but not over-triage', () => {
    const under = compareDocument(truth, result({}, { urgency: 'low' }));
    assert.equal(under.urgency.underTriaged, true);

    const over = compareDocument(truth, result({}, { urgency: 'high' }));
    assert.equal(over.urgency.correct, false);
    assert.equal(over.urgency.underTriaged, false);
  });
});

describe('failedDocument', () => {
  it('keeps errored documents in the denominator', () => {
    const failed = failedDocument('boom', truth, 'api-error', 'connection reset');
    const metrics = aggregate([compareDocument(truth, result()), failed]);

    assert.equal(metrics.documents, 2);
    assert.equal(metrics.completed, 1);
    // Six fields per document; only the successful one scores.
    assert.deepEqual(metrics.overall.normalized, { correct: 6, total: 12 });
    assert.equal(metrics.urgency.correct, 1);
  });
});

describe('aggregate', () => {
  it('computes missingFields precision and recall over field cells', () => {
    const sparseTruth: GroundTruth = { ...truth, currency: null, missingFields: ['currency'] };

    // One true positive (currency), one false positive (policyNumber).
    const comparison = compareDocument(
      sparseTruth,
      result({ currency: null, missingFields: ['currency', 'policyNumber'] }),
    );
    const metrics = aggregate([comparison]);

    assert.equal(metrics.missingFields.precision, 0.5);
    assert.equal(metrics.missingFields.recall, 1);
  });
});

describe('checkCompleteness', () => {
  it('reports missing required fields deterministically', () => {
    const report = checkCompleteness(result({ amount: null, currency: null, missingFields: ['amount', 'currency'] }).extraction);
    assert.deepEqual(report.missing, ['amount', 'currency']);
    assert.equal(report.isComplete, false);
    assert.deepEqual(report.disagreements, []);
  });

  it('catches a model whose self-report contradicts its own output', () => {
    // Says amount is missing, but emitted a value for it.
    const report = checkCompleteness(result({ missingFields: ['amount'] }).extraction);
    assert.equal(report.isComplete, true);
    assert.deepEqual(report.disagreements, ['amount']);
  });
});
