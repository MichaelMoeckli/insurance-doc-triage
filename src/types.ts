/**
 * Domain types for the claim-triage pipeline.
 *
 * These mirror the JSON Schemas in `schema.ts` one-for-one. The two files are kept
 * adjacent on purpose: the schema is the wire contract with the model, and these are
 * the compile-time view of the same shape. `schema.ts` exports runtime validators that
 * bridge the gap, so a drift between the two surfaces as a `schema-error` in the eval
 * rather than as an undetected `any` flowing through the pipeline.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * Broad line of business. Kept deliberately small; a real deployment would map these
 * onto the carrier's own product codes during discovery.
 */
export const CLAIM_TYPES = ['motor', 'property', 'liability', 'health', 'other'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** ISO 4217 codes seen in the Swiss market, plus an escape hatch. */
export const CURRENCIES = ['CHF', 'EUR', 'USD', 'other'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const URGENCIES = ['high', 'normal', 'low'] as const;
export type Urgency = (typeof URGENCIES)[number];

/**
 * Document language, as a property of the *label* rather than something detected.
 *
 * A Swiss composite insurer's first question is "does it work on German?", and a headline
 * averaged over both languages cannot answer it. Detecting the language at run time would
 * put a second fallible component inside the measurement, so it is hand-assigned once, in
 * the ground truth, where it can be argued with.
 *
 * `mixed` means substantive content appears in both languages - a bilingual heading, or
 * German field labels around English prose. A German company name or street address
 * inside an otherwise English letter is *not* mixed; every document in the set has Swiss
 * proper nouns, so counting those would make the category meaningless.
 */
export const LANGUAGES = ['de', 'en', 'mixed'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * Triage categories. This vocabulary is closed on purpose: an open-ended `category`
 * string cannot be scored, and "classification accuracy" over free text is not a
 * metric. Extending it is a one-line change here plus new labels.
 */
export const CATEGORIES = [
  'motor-collision',
  'motor-theft',
  'property-water',
  'property-fire',
  'property-burglary',
  'liability-third-party',
  'health-treatment',
  'health-accident',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * The fields the model may declare as missing. Restricting `missingFields` to an enum
 * (rather than free-form strings) is what makes it scoreable as a set, and it stops the
 * model inventing field names that do not exist downstream.
 */
export const EXTRACTED_FIELDS = [
  'policyNumber',
  'claimantName',
  'dateOfLoss',
  'claimType',
  'amount',
  'currency',
] as const;
export type ExtractedField = (typeof EXTRACTED_FIELDS)[number];

/**
 * Fields a claim cannot be routed without. Used by the deterministic completeness
 * check. `claimType` is intentionally absent: the model can almost always infer a line
 * of business from context, so a missing one is a model failure, not a document defect.
 */
export const REQUIRED_FIELDS = [
  'policyNumber',
  'claimantName',
  'dateOfLoss',
  'amount',
  'currency',
] as const satisfies readonly ExtractedField[];
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

// ---------------------------------------------------------------------------
// Stage 1 - extraction
// ---------------------------------------------------------------------------

/** A verbatim span from the source document backing one extracted field. */
export interface SourceQuote {
  field: ExtractedField;
  quote: string;
}

/**
 * Raw structured extraction, exactly as returned by the model.
 *
 * Every value field is nullable. The convention enforced by the prompt and by the
 * ground-truth labels is: *if a value cannot be resolved to a single unambiguous
 * reading, it is `null` and its name appears in `missingFields`.* An ambiguous date
 * ("last Tuesday", "03/04/2025") is therefore a null, not a guess.
 */
export interface Extraction {
  policyNumber: string | null;
  claimantName: string | null;
  /** ISO 8601 calendar date, `YYYY-MM-DD`. */
  dateOfLoss: string | null;
  claimType: ClaimType | null;
  amount: number | null;
  currency: Currency | null;
  missingFields: ExtractedField[];
  sourceQuotes: SourceQuote[];
}

// ---------------------------------------------------------------------------
// Stage 2 - completeness (deterministic, no model call)
// ---------------------------------------------------------------------------

export interface CompletenessReport {
  /** Required fields that came back null. */
  missing: RequiredField[];
  /** True when every required field has a value. */
  isComplete: boolean;
  /**
   * Required fields the model declared missing that our own check disagrees about,
   * in both directions. A non-empty list means the model's self-report is unreliable
   * for this document - useful as a routing signal and as an eval diagnostic.
   */
  disagreements: ExtractedField[];
}

// ---------------------------------------------------------------------------
// Stage 2b - quote grounding (deterministic, no model call)
// ---------------------------------------------------------------------------

/** One cited span, checked against the document it claims to come from. */
export interface QuoteCheck {
  field: ExtractedField;
  quote: string;
  /** The span occurs in the source, comparing modulo whitespace and typography. */
  grounded: boolean;
}

/**
 * Whether the model's own evidence holds up.
 *
 * `sourceQuotes` asks the model to name the span it took each value from. That claim is
 * checkable without a model and without the ground truth: either the span is in the
 * document or it is not. So this runs in the pipeline, not only in the eval - it is a
 * per-field confidence signal available on every document in production, where no label
 * exists.
 *
 * The three lists are kept apart because they call for opposite responses. A fabricated
 * quote means the value behind it cannot be trusted at all; an absent quote means the
 * value is unverifiable but not suspect; a quote on a null field is the model ignoring an
 * instruction while getting the value right.
 */
export interface GroundingReport {
  checks: QuoteCheck[];
  /** Cited spans that do not occur in the document. Fabricated evidence. */
  ungrounded: ExtractedField[];
  /** Fields with a value and no cited span. Absent evidence. */
  uncited: ExtractedField[];
  /** Fields set to null but quoted anyway, which the schema tells the model not to do. */
  quotedButNull: ExtractedField[];
}

// ---------------------------------------------------------------------------
// Stage 3 - triage
// ---------------------------------------------------------------------------

export interface Triage {
  urgency: Urgency;
  category: Category;
  /** Imperative next step for a human handler, one sentence. */
  recommendedAction: string;
  /** Why this urgency and category. Not scored; read during failure analysis. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Pipeline output
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The pipeline stages that issue a model call. Completeness and summary do not. */
export const MODEL_CALL_STAGES = ['extract', 'triage'] as const;
export type ModelCallStage = (typeof MODEL_CALL_STAGES)[number];

/**
 * Cost and timing for a single model call.
 *
 * Recorded per call rather than only per document, because the two calls have very
 * different shapes - triage is conditioned on an already-extracted payload - and an
 * average that merges them hides which one to optimise first.
 */
export interface ModelCallStats {
  stage: ModelCallStage;
  usage: TokenUsage;
  /** Wall clock around the HTTP call, including SDK retries. */
  latencyMs: number;
  /** Indicative only; `null` when the model has no entry in the price table. */
  costUsd: number | null;
}

export interface TriageResult {
  documentId: string;
  extraction: Extraction;
  completeness: CompletenessReport;
  grounding: GroundingReport;
  triage: Triage;
  /** One-line human-readable summary, for a handler's queue view. */
  summary: string;
  meta: {
    model: string;
    promptVersion: string;
    /** Summed over `calls`. */
    usage: TokenUsage;
    /** Summed over `calls`: per-document wall clock, since the stages are sequential. */
    latencyMs: number;
    /** Summed over `calls`; `null` if any call could not be priced. */
    costUsd: number | null;
    calls: ModelCallStats[];
  };
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * One hand-authored label per synthetic document, `data/labels/<basename>.json`.
 *
 * `notes` is not scored. It records *why* a document is hard, so the failure log in
 * `results.md` reads as an analysis rather than a diff dump.
 *
 * `language` is not scored either - nothing is asked to predict it. It exists to slice
 * the results, which is the only way a headline of "99.3%" can answer the question a
 * Swiss customer asks first.
 */
export interface GroundTruth {
  policyNumber: string | null;
  claimantName: string | null;
  dateOfLoss: string | null;
  claimType: ClaimType | null;
  amount: number | null;
  currency: Currency | null;
  missingFields: ExtractedField[];
  urgency: Urgency;
  category: Category;
  language: Language;
  notes: string;
}

/** A synthetic document paired with its label. */
export interface LabelledDocument {
  id: string;
  path: string;
  text: string;
  truth: GroundTruth;
}
