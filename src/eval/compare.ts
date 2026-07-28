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
  LANGUAGES,
  type Category,
  type ExtractedField,
  type GroundTruth,
  type Language,
  type ModelCallStats,
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

/**
 * How far the model's own evidence held up on one document.
 *
 * Counted over cited spans rather than over documents: a document where five of six
 * fields are cited and grounded is not the same as one where a single field is, and a
 * per-document boolean would score them identically.
 */
export interface GroundingOutcome {
  /** Spans that occur in the source, over all spans cited for a non-null field. */
  grounded: number;
  quotesChecked: number;
  /** Non-null fields carrying at least one span, over all non-null fields. */
  cited: number;
  citable: number;
  /** Spans cited for a field the model set to null. A contract violation, not a lie. */
  quotedButNull: number;
}

export interface DocumentComparison {
  documentId: string;
  /** From the label. Not predicted, not scored - the axis the results are sliced on. */
  language: Language;
  /** False when the pipeline threw; every field then counts as wrong. */
  completed: boolean;
  fields: Record<ExtractedField, FieldOutcome>;
  grounding: GroundingOutcome;
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
  /** Per model call. Empty for a document whose pipeline threw before any call landed. */
  calls: ModelCallStats[];
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

  // --- Grounding --------------------------------------------------------
  //
  // Every cited span is checked, including one attached to a field the model set to null:
  // a span is a claim about the document whatever field it hangs off, and excluding some
  // of them from the honesty rate would be choosing which lies to count.
  const grounding = result.grounding;
  const citableFields = EXTRACTED_FIELDS.filter((field) => result.extraction[field] !== null);

  // One row per fabricated span - each is a distinct thing worth reading in the log.
  for (const field of grounding.ungrounded) {
    const spans = grounding.checks.filter((check) => check.field === field && !check.grounded);
    failures.push({
      documentId: result.documentId,
      field,
      category: 'ungrounded-quote',
      severity: 'soft',
      expected: 'a span occurring in the document',
      actual: spans.map((span) => JSON.stringify(span.quote)).join(' / '),
      note,
    });
  }

  // One row per document - an uncited field is usually a systematic habit rather than a
  // per-field event, and six rows on one document would drown the log.
  if (grounding.uncited.length) {
    failures.push({
      documentId: result.documentId,
      field: 'sourceQuotes',
      category: 'missing-quote',
      severity: 'soft',
      expected: `a span for each of ${show(citableFields)}`,
      actual: `no span for ${show(grounding.uncited)}`,
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
    language: truth.language,
    completed: true,
    fields,
    grounding: {
      grounded: grounding.checks.filter((check) => check.grounded).length,
      quotesChecked: grounding.checks.length,
      cited: citableFields.length - grounding.uncited.length,
      citable: citableFields.length,
      quotedButNull: grounding.checks.filter((check) => grounding.quotedButNull.includes(check.field)).length,
    },
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
    calls: result.meta.calls,
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
    language: truth.language,
    completed: false,
    fields,
    // Nothing was cited, so nothing is checkable. Zero over zero, not zero over six -
    // an errored document must not drag the grounding rate down as if the model had
    // fabricated something.
    grounding: { grounded: 0, quotesChecked: 0, cited: 0, citable: 0, quotedButNull: 0 },
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
    calls: [],
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

/** Grounding, aggregated over a set of documents. */
export interface GroundingMetrics {
  /** Cited spans that occur in the source, over all cited spans. */
  grounded: Ratio;
  /** Non-null fields carrying at least one span, over all non-null fields. */
  cited: Ratio;
  /** Spans cited for a field the model set to null, against the schema's instruction. */
  quotedButNull: number;
}

/**
 * One slice of a run - the same headline numbers restricted to a subset of documents.
 *
 * Deliberately a subset of `RunMetrics` rather than the whole of it. A slice of eight
 * documents cannot support a confusion matrix or a cost projection, and printing one
 * would invite reading far more into it than eight documents can carry.
 */
export interface SliceMetrics {
  key: string;
  documents: number;
  fields: { strict: Ratio; normalized: Ratio };
  missingFieldsExact: Ratio;
  urgency: Ratio & { underTriaged: number };
  category: Ratio;
  grounding: GroundingMetrics;
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
  /**
   * Optional because run records written before grounding existed do not carry it. The
   * report renders the section only when it is present rather than showing a zero, which
   * would misreport an old run as having fabricated every quote.
   */
  grounding?: GroundingMetrics;
  /** Optional for the same reason. One entry per language present in the run. */
  byLanguage?: SliceMetrics[];
  usage: TokenUsage;
  totalLatencyMs: number;
}

function ratio(correct: number, total: number): Ratio {
  return { correct, total };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function groundingOf(comparisons: readonly DocumentComparison[]): GroundingMetrics {
  return {
    grounded: ratio(
      sum(comparisons.map((c) => c.grounding.grounded)),
      sum(comparisons.map((c) => c.grounding.quotesChecked)),
    ),
    cited: ratio(
      sum(comparisons.map((c) => c.grounding.cited)),
      sum(comparisons.map((c) => c.grounding.citable)),
    ),
    quotedButNull: sum(comparisons.map((c) => c.grounding.quotedButNull)),
  };
}

/**
 * Splits a run along one dimension and re-derives the headline numbers per bucket.
 *
 * Generic in the key function so a second axis - `claimType`, format, urgency band - is a
 * one-line addition rather than a copy of this. `order` fixes the bucket sequence so the
 * report reads the same way on every run, and buckets with no documents are dropped: an
 * empty row invites a reader to treat `n/a` as a result.
 */
export function sliceBy<T extends string>(
  comparisons: readonly DocumentComparison[],
  order: readonly T[],
  keyOf: (comparison: DocumentComparison) => T,
): SliceMetrics[] {
  const slices: SliceMetrics[] = [];

  for (const key of order) {
    const bucket = comparisons.filter((c) => keyOf(c) === key);
    if (bucket.length === 0) continue;

    const cells = bucket.length * EXTRACTED_FIELDS.length;
    const strictCells = sum(EXTRACTED_FIELDS.map((f) => bucket.filter((c) => c.fields[f].strict).length));
    const normalizedCells = sum(
      EXTRACTED_FIELDS.map((f) => bucket.filter((c) => c.fields[f].normalized).length),
    );

    slices.push({
      key,
      documents: bucket.length,
      fields: { strict: ratio(strictCells, cells), normalized: ratio(normalizedCells, cells) },
      missingFieldsExact: ratio(bucket.filter((c) => c.missingFields.exact).length, bucket.length),
      urgency: {
        ...ratio(bucket.filter((c) => c.urgency.correct).length, bucket.length),
        underTriaged: bucket.filter((c) => c.urgency.underTriaged).length,
      },
      category: ratio(bucket.filter((c) => c.category.correct).length, bucket.length),
      grounding: groundingOf(bucket),
    });
  }

  return slices;
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
    grounding: groundingOf(comparisons),
    byLanguage: sliceBy(comparisons, LANGUAGES, (c) => c.language),
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
