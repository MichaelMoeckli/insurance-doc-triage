/**
 * The failure taxonomy.
 *
 * An accuracy number tells you whether to keep going. A taxonomy tells you what to
 * change. These categories are chosen so that each one maps to a different *action*:
 * a cluster of `date-format` failures is a prompt or schema fix, a cluster of
 * `hallucinated-field` failures is a policy fix, and a cluster of `under-triage`
 * urgency failures is a rubric fix - or a conversation with the customer about where
 * their thresholds actually sit.
 */

export const FAILURE_CATEGORIES = [
  'date-format',
  'date-value',
  'amount-format',
  'amount-value',
  'currency-mismatch',
  'hallucinated-field',
  'missed-field',
  'missed-missing-field',
  'spurious-missing-field',
  'name-mismatch',
  'policy-number-mismatch',
  'claim-type-mismatch',
  'urgency-mismatch',
  'category-mismatch',
  'schema-error',
  'api-error',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Rendered into results.md so the taxonomy table is self-explanatory. */
export const FAILURE_DESCRIPTIONS: Record<FailureCategory, string> = {
  'date-format': 'Right day, wrong notation - the value normalises to the correct date but was not emitted as ISO.',
  'date-value': 'Wrong date. Usually a report date or a treatment date taken for the date of loss.',
  'amount-format': 'Thousands or decimal separator misread, so the digits survive but the magnitude is wrong.',
  'amount-value': 'Wrong number. Often a deductible, franchise or premium taken for the claimed amount.',
  'currency-mismatch': 'Wrong currency code, typically CHF assumed for a Swiss insurer when the document says otherwise.',
  'hallucinated-field': 'A value was invented for a field the document does not state.',
  'missed-field': 'A field the document does state was left null.',
  'missed-missing-field': 'The value was correctly null, but the model did not declare it in missingFields.',
  'spurious-missing-field': 'A field with a value was declared missing.',
  'name-mismatch': 'Wrong person - usually a broker, adjuster, lawyer or injured third party instead of the policyholder.',
  'policy-number-mismatch': 'Wrong identifier - usually a claim, invoice or police report number.',
  'claim-type-mismatch': 'Wrong line of business.',
  'urgency-mismatch': 'Wrong urgency. Under-triage (predicting lower than the truth) is tracked separately.',
  'category-mismatch': 'Wrong routing category.',
  'schema-error': 'The model response did not satisfy the JSON schema, or could not be parsed.',
  'api-error': 'The call failed at the transport level after the SDK exhausted its retries.',
};

/**
 * `hard` failures count against accuracy. `soft` ones do not: the normalised comparison
 * passed and only the surface form was wrong. Keeping them visible rather than
 * discarding them is the point - a run at 100% normalised accuracy with twelve soft
 * date-format failures is a run whose downstream consumer is about to break.
 */
export type FailureSeverity = 'hard' | 'soft';

export interface Failure {
  documentId: string;
  /** Field name, or `document` for whole-pipeline failures. */
  field: string;
  category: FailureCategory;
  severity: FailureSeverity;
  expected: string;
  actual: string;
  /** The `notes` line from the ground-truth label: why this document is hard. */
  note: string;
}

export function tallyByCategory(failures: readonly Failure[]): Map<FailureCategory, Failure[]> {
  const tally = new Map<FailureCategory, Failure[]>();
  for (const failure of failures) {
    const bucket = tally.get(failure.category);
    if (bucket) bucket.push(failure);
    else tally.set(failure.category, [failure]);
  }
  return tally;
}
