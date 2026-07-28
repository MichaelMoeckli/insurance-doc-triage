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
import type { Extraction, GroundTruth, TriageResult } from '../types.js';
import { aggregate, compareDocument, failedDocument, sliceBy } from './compare.js';
import { checkCompleteness } from '../pipeline/completeness.js';
import { checkGrounding } from '../pipeline/grounding.js';

/**
 * The document the fixture claims to have been extracted from.
 *
 * Real text rather than a stub, because grounding is scored by substring match against
 * it: a fixture whose quotes were not actually in its document would make every test
 * below run against a permanently ungrounded extraction.
 */
const DOCUMENT = [
  'From: lea.frei@protonmail.ch',
  'Subject: Accident abroad - policy CH-MOT-2020-661234',
  '',
  'I had an accident on 27 February 2025 on the B31 near Freiburg im Breisgau.',
  'The German garage has issued its estimate in euros: EUR 8.500,00.',
  '',
  'Lea Frei',
].join('\n');

/** Every field cited with a span that really occurs in DOCUMENT. */
const QUOTES: Extraction['sourceQuotes'] = [
  { field: 'policyNumber', quote: 'policy CH-MOT-2020-661234' },
  { field: 'claimantName', quote: 'Lea Frei' },
  { field: 'dateOfLoss', quote: '27 February 2025' },
  { field: 'claimType', quote: 'I had an accident' },
  { field: 'amount', quote: 'EUR 8.500,00' },
  { field: 'currency', quote: 'EUR 8.500,00' },
];

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
  language: 'en',
  notes: 'fixture',
};

function result(overrides: Partial<TriageResult['extraction']> = {}, triage: Partial<TriageResult['triage']> = {}): TriageResult {
  const extraction: Extraction = {
    policyNumber: 'CH-MOT-2020-661234',
    claimantName: 'Lea Frei',
    dateOfLoss: '2025-02-27',
    claimType: 'motor',
    amount: 8500,
    currency: 'EUR',
    missingFields: [],
    sourceQuotes: QUOTES,
    ...overrides,
  };

  return {
    documentId: 'fixture',
    extraction,
    completeness: { missing: [], isComplete: true, disagreements: [] },
    // Derived, not stubbed: overriding `sourceQuotes` in a test must actually change what
    // grounding sees, or the grounding tests would be asserting against a hand-written
    // answer instead of against the checker.
    grounding: checkGrounding(extraction, DOCUMENT),
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

describe('quote grounding', () => {
  it('records nothing when every field is cited with a real span', () => {
    const comparison = compareDocument(truth, result());
    assert.deepEqual(comparison.failures, []);
    assert.deepEqual(comparison.grounding, {
      grounded: 6,
      quotesChecked: 6,
      cited: 6,
      citable: 6,
      quotedButNull: 0,
    });
  });

  it('flags a fabricated span without touching field accuracy', () => {
    const comparison = compareDocument(
      truth,
      result({
        sourceQuotes: QUOTES.map((q) =>
          q.field === 'amount' ? { field: 'amount' as const, quote: 'total damage of EUR 8.500,00' } : q,
        ),
      }),
    );

    assert.deepEqual(categories(comparison), ['ungrounded-quote']);
    assert.equal(comparison.failures[0]?.severity, 'soft');
    assert.equal(comparison.failures[0]?.field, 'amount');
    assert.equal(comparison.grounding.grounded, 5);
    // The value is still right. Grounding is a separate axis and must not cost accuracy.
    assert.equal(comparison.fields.amount.strict, true);
    assert.equal(comparison.fields.amount.normalized, true);
  });

  it('reports uncited fields once per document, not once per field', () => {
    const comparison = compareDocument(truth, result({ sourceQuotes: [] }));

    assert.deepEqual(categories(comparison), ['missing-quote']);
    assert.equal(comparison.failures[0]?.severity, 'soft');
    assert.deepEqual(comparison.grounding, {
      grounded: 0,
      quotesChecked: 0,
      cited: 0,
      citable: 6,
      quotedButNull: 0,
    });
  });

  it('counts a span on a null field without calling it a failure', () => {
    // The schema says to omit quotes for null fields. Ignoring that is an
    // instruction-following defect, not fabricated evidence - the span is really there.
    const comparison = compareDocument(
      { ...truth, amount: null, missingFields: ['amount'] },
      result({ amount: null, missingFields: ['amount'] }),
    );

    assert.deepEqual(categories(comparison), []);
    assert.equal(comparison.grounding.quotedButNull, 1);
    assert.equal(comparison.grounding.citable, 5);
    assert.equal(comparison.grounding.cited, 5);
  });

  it('does not let an errored document dilute the grounding rate', () => {
    const metrics = aggregate([compareDocument(truth, result()), failedDocument('boom', truth, 'api-error', 'reset')]);

    // 6 of 6, not 6 of 12: the failed document cited nothing, so it is not evidence
    // either way about whether the model fabricates spans.
    assert.deepEqual(metrics.grounding?.grounded, { correct: 6, total: 6 });
    assert.deepEqual(metrics.grounding?.cited, { correct: 6, total: 6 });
  });
});

describe('sliceBy', () => {
  it('splits the headline numbers by language and drops empty buckets', () => {
    const de: GroundTruth = { ...truth, language: 'de' };
    const comparisons = [
      compareDocument(truth, result()),
      compareDocument(de, result()),
      compareDocument(de, result({ dateOfLoss: '2025-03-01' })),
    ];

    const slices = aggregate(comparisons).byLanguage;
    assert.deepEqual(
      slices?.map((s) => s.key),
      ['de', 'en'],
      'buckets follow the LANGUAGES order, and `mixed` is absent rather than empty',
    );

    const german = slices?.find((s) => s.key === 'de');
    assert.equal(german?.documents, 2);
    // One wrong date out of twelve German field cells.
    assert.deepEqual(german?.fields.normalized, { correct: 11, total: 12 });

    const english = slices?.find((s) => s.key === 'en');
    assert.deepEqual(english?.fields.normalized, { correct: 6, total: 6 });
  });

  it('slices any dimension, not just the one the report happens to use', () => {
    const slices = sliceBy(
      [compareDocument(truth, result()), compareDocument(truth, result({}, { urgency: 'low' }))],
      ['motor-collision', 'other'] as const,
      (c) => c.category.expected as 'motor-collision' | 'other',
    );

    assert.equal(slices.length, 1);
    assert.equal(slices[0]?.key, 'motor-collision');
    assert.equal(slices[0]?.urgency.underTriaged, 1);
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
