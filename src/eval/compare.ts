/**
 * Scoring: one pipeline output against one ground-truth label, and the aggregation of
 * many such comparisons into the numbers that go in the report.
 *
 * Two conventions run through this file.
 *
 * Strict and normalised are both kept. Strict is raw equality of what the model
 * actually emitted; normalised applies the rules in `normalize.ts`. Reporting only the
 * normalised figure would hide format drift; reporting only the strict figure would
 * punish the model for writing a correct date with dots. Both, side by side.
 *
 * Every wrong answer produces a `Failure` with a category, not just a decremented
 * counter. The counter says how well the run went; the failure log says what to change.
 */

import {
  EXTRACTED_FIELDS,
  type Category,
  type ExtractedField,
  type GroundTruth,
  type TokenUsage,
  type TriageResult,
  type Urgency,
} from '../types.js';
import {
  amountsEqual,
  looksLikeSeparatorError,
  normalizeCurrency,
  normalizeDate,
  normalizeName,
  normalizePolicyNumber,
  sameSet,
} from './normalize.js';
import type { Failure, FailureCategory } from './taxonomy.js';

export interface FieldOutcome {
  strict: boolean;
  normalized: boolean;
}

export interface DocumentComparison {
  documentId: string;
  /** False when the pipeline threw; every field then counts as wrong. */
  completed: boolean;
  fields: Record<ExtractedField, FieldOutcome>;
  missingFields: {
    expected: ExtractedField[];
    predicted: ExtractedField[];
    exact: boolean;
  };
  urgency: {
    expected: Urgency;
    predicted: Urgency | null;
    correct: boolean;
    /** Predicted less urgent than the truth. The expensive direction. */
    underTriaged: boolean;
  };
  category: {
    expected: Category;
    predicted: Category | null;
    correct: boolean;
  };
  failures: Failure[];
  usage: TokenUsage;
  latencyMs: number;
  summary: string | null;
}

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2 };

function show(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(empty)';
  return String(value);
}

/**
 * Compares one extracted field.
 *
 * The null cases are handled first and deliberately: a value where the truth has none
 * is a hallucination, and a null where the truth has a value is a miss. Collapsing both
 * into "wrong" would throw away the distinction that matters most - one is a model
 * inventing facts, the other is a model being too cautious, and they are fixed by
 * opposite prompt changes.
 */
function compareField(
  field: ExtractedField,
  expected: string | number | null,
  actual: string | number | null,
  documentId: string,
  note: string,
): { outcome: FieldOutcome; failures: Failure[] } {
  const wrong = (category: FailureCategory): { outcome: FieldOutcome; failures: Failure[] } => ({
    outcome: { strict: false, normalized: false },
    failures: [
      {
        documentId,
        field,
        category,
        severity: 'hard',
        expected: show(expected),
        actual: show(actual),
        note,
      },
    ],
  });

  if (expected === null && actual === null) {
    return { outcome: { strict: true, normalized: true }, failures: [] };
  }
  if (expected === null) return wrong('hallucinated-field');
  if (actual === null) return wrong('missed-field');

  if (field === 'amount') {
    const expectedNumber = expected as number;
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    const strict = expectedNumber === actualNumber;
    const normalized = Number.isFinite(actualNumber) && amountsEqual(expectedNumber, actualNumber);
    if (!normalized) {
      return wrong(looksLikeSeparatorError(expectedNumber, actualNumber) ? 'amount-format' : 'amount-value');
    }
    // Normalised match with a strict miss: sub-rappen noise. Recorded, not penalised.
    return {
      outcome: { strict, normalized },
      failures: strict
        ? []
        : [
            {
              documentId,
              field,
              category: 'amount-format',
              severity: 'soft',
              expected: show(expected),
              actual: show(actual),
              note,
            },
          ],
    };
  }

  const expectedText = String(expected);
  const actualText = String(actual);
  const strict = expectedText === actualText;

  if (field === 'dateOfLoss') {
    const expectedIso = normalizeDate(expectedText);
    const actualIso = normalizeDate(actualText);
    const normalized = expectedIso !== null && expectedIso === actualIso;
    if (!normalized) return wrong('date-value');
    // Correct day written in a non-ISO notation. Soft: right answer, wrong contract.
    return {
      outcome: { strict, normalized },
      failures: strict
        ? []
        : [
            {
              documentId,
              field,
              category: 'date-format',
              severity: 'soft',
              expected: expectedText,
              actual: actualText,
              note,
            },
          ],
    };
  }

  const normalizer =
    field === 'claimantName'
      ? normalizeName
      : field === 'policyNumber'
        ? normalizePolicyNumber
        : field === 'currency'
          ? normalizeCurrency
          : (value: string): string => value.trim();

  const normalized = normalizer(expectedText) === normalizer(actualText);
  if (!normalized) {
    const category: FailureCategory =
      field === 'claimantName'
        ? 'name-mismatch'
        : field === 'policyNumber'
          ? 'policy-number-mismatch'
          : field === 'currency'
            ? 'currency-mismatch'
            : 'claim-type-mismatch';
    return wrong(category);
  }

  return { outcome: { strict, normalized }, failures: [] };
}

/** Scores a completed pipeline run for one document. */
export function compareDocument(truth: GroundTruth, result: TriageResult): DocumentComparison {
  const note = truth.notes;
  const failures: Failure[] = [];
  const fields = {} as Record<ExtractedField, FieldOutcome>;

  for (const field of EXTRACTED_FIELDS) {
    const { outcome, failures: fieldFailures } = compareField(
      field,
      truth[field],
      result.extraction[field],
      result.documentId,
      note,
    );
    fields[field] = outcome;
    failures.push(...fieldFailures);
  }

  const predictedMissing = result.extraction.missingFields;
  const expectedMissing = truth.missingFields;
  const missedMissing = expectedMissing.filter((f) => !predictedMissing.includes(f));
  const spuriousMissing = predictedMissing.filter((f) => !expectedMissing.includes(f));

  if (missedMissing.length) {
    failures.push({
      documentId: result.documentId,
      field: 'missingFields',
      category: 'missed-missing-field',
      severity: 'hard',
      expected: show(expectedMissing),
      actual: show(predictedMissing),
      note,
    });
  }
  if (spuriousMissing.length) {
    failures.push({
      documentId: result.documentId,
      field: 'missingFields',
      category: 'spurious-missing-field',
      severity: 'hard',
      expected: show(expectedMissing),
      actual: show(predictedMissing),
      note,
    });
  }

  const urgencyCorrect = truth.urgency === result.triage.urgency;
  if (!urgencyCorrect) {
    failures.push({
      documentId: result.documentId,
      field: 'urgency',
      category: 'urgency-mismatch',
      severity: 'hard',
      expected: truth.urgency,
      actual: result.triage.urgency,
      note,
    });
  }

  const categoryCorrect = truth.category === result.triage.category;
  if (!categoryCorrect) {
    failures.push({
      documentId: result.documentId,
      field: 'category',
      category: 'category-mismatch',
      severity: 'hard',
      expected: truth.category,
      actual: result.triage.category,
      note,
    });
  }

  return {
    documentId: result.documentId,
    completed: true,
    fields,
    missingFields: {
      expected: [...expectedMissing],
      predicted: [...predictedMissing],
      exact: sameSet(expectedMissing, predictedMissing),
    },
    urgency: {
      expected: truth.urgency,
      predicted: result.triage.urgency,
      correct: urgencyCorrect,
      underTriaged: URGENCY_RANK[result.triage.urgency] < URGENCY_RANK[truth.urgency],
    },
    category: {
      expected: truth.category,
      predicted: result.triage.category,
      correct: categoryCorrect,
    },
    failures,
    usage: result.meta.usage,
    latencyMs: result.meta.latencyMs,
    summary: result.summary,
  };
}

/**
 * Records a document whose pipeline threw.
 *
 * Errored documents stay in the denominator. Dropping them would inflate accuracy
 * exactly when the system is least reliable, which is the moment the number most needs
 * to be trustworthy.
 */
export function failedDocument(
  documentId: string,
  truth: GroundTruth,
  category: 'schema-error' | 'api-error',
  message: string,
): DocumentComparison {
  const fields = {} as Record<ExtractedField, FieldOutcome>;
  for (const field of EXTRACTED_FIELDS) fields[field] = { strict: false, normalized: false };

  return {
    documentId,
    completed: false,
    fields,
    missingFields: { expected: [...truth.missingFields], predicted: [], exact: false },
    urgency: { expected: truth.urgency, predicted: null, correct: false, underTriaged: false },
    category: { expected: truth.category, predicted: null, correct: false },
    failures: [
      {
        documentId,
        field: 'document',
        category,
        severity: 'hard',
        expected: 'a complete pipeline run',
        actual: message,
        note: truth.notes,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    summary: null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Ratio {
  correct: number;
  total: number;
}

export interface RunMetrics {
  documents: number;
  completed: number;
  /** Per-field, strict and normalised. */
  fields: Record<ExtractedField, { strict: Ratio; normalized: Ratio }>;
  /** Micro-average across all field cells. */
  overall: { strict: Ratio; normalized: Ratio };
  missingFields: {
    /** Documents where the declared set exactly matched. */
    exact: Ratio;
    /** Over all (document, field) pairs. */
    precision: number;
    recall: number;
    f1: number;
  };
  urgency: Ratio & { underTriaged: number };
  category: Ratio;
  confusion: {
    urgency: Record<string, number>;
    category: Record<string, number>;
  };
  usage: TokenUsage;
  totalLatencyMs: number;
}

function ratio(correct: number, total: number): Ratio {
  return { correct, total };
}

export function aggregate(comparisons: readonly DocumentComparison[]): RunMetrics {
  const fields = {} as RunMetrics['fields'];
  for (const field of EXTRACTED_FIELDS) {
    const strict = comparisons.filter((c) => c.fields[field].strict).length;
    const normalized = comparisons.filter((c) => c.fields[field].normalized).length;
    fields[field] = {
      strict: ratio(strict, comparisons.length),
      normalized: ratio(normalized, comparisons.length),
    };
  }

  const cells = comparisons.length * EXTRACTED_FIELDS.length;
  const strictCells = EXTRACTED_FIELDS.reduce((sum, f) => sum + fields[f].strict.correct, 0);
  const normalizedCells = EXTRACTED_FIELDS.reduce((sum, f) => sum + fields[f].normalized.correct, 0);

  // missingFields precision/recall over every (document, field) pair.
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const c of comparisons) {
    for (const field of EXTRACTED_FIELDS) {
      const predicted = c.missingFields.predicted.includes(field);
      const expected = c.missingFields.expected.includes(field);
      if (predicted && expected) truePositives++;
      else if (predicted) falsePositives++;
      else if (expected) falseNegatives++;
    }
  }
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const urgencyConfusion: Record<string, number> = {};
  const categoryConfusion: Record<string, number> = {};
  for (const c of comparisons) {
    if (!c.urgency.correct) {
      const key = `${c.urgency.expected} -> ${c.urgency.predicted ?? 'error'}`;
      urgencyConfusion[key] = (urgencyConfusion[key] ?? 0) + 1;
    }
    if (!c.category.correct) {
      const key = `${c.category.expected} -> ${c.category.predicted ?? 'error'}`;
      categoryConfusion[key] = (categoryConfusion[key] ?? 0) + 1;
    }
  }

  return {
    documents: comparisons.length,
    completed: comparisons.filter((c) => c.completed).length,
    fields,
    overall: { strict: ratio(strictCells, cells), normalized: ratio(normalizedCells, cells) },
    missingFields: {
      exact: ratio(comparisons.filter((c) => c.missingFields.exact).length, comparisons.length),
      precision,
      recall,
      f1,
    },
    urgency: {
      ...ratio(comparisons.filter((c) => c.urgency.correct).length, comparisons.length),
      underTriaged: comparisons.filter((c) => c.urgency.underTriaged).length,
    },
    category: ratio(comparisons.filter((c) => c.category.correct).length, comparisons.length),
    confusion: { urgency: urgencyConfusion, category: categoryConfusion },
    usage: comparisons.reduce(
      (sum, c) => ({
        inputTokens: sum.inputTokens + c.usage.inputTokens,
        outputTokens: sum.outputTokens + c.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    totalLatencyMs: comparisons.reduce((sum, c) => sum + c.latencyMs, 0),
  };
}
