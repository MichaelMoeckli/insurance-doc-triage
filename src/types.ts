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

export interface TriageResult {
  documentId: string;
  extraction: Extraction;
  completeness: CompletenessReport;
  triage: Triage;
  /** One-line human-readable summary, for a handler's queue view. */
  summary: string;
  meta: {
    model: string;
    promptVersion: string;
    usage: TokenUsage;
    latencyMs: number;
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
  notes: string;
}

/** A synthetic document paired with its label. */
export interface LabelledDocument {
  id: string;
  path: string;
  text: string;
  truth: GroundTruth;
}
