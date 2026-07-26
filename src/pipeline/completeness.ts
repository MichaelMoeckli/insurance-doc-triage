/**
 * Stage 2: completeness. Deliberately not a model call.
 *
 * "Is this required field null?" is a loop over a constant. Asking a language model
 * would add latency, cost and a new failure mode in exchange for nothing. The useful
 * question - *does the model know what it does not know?* - is answered by comparing
 * its self-reported `missingFields` against this deterministic check, which is what
 * `disagreements` records and what the eval's `missed-missing-field` and
 * `spurious-missing-field` categories score.
 */

import { REQUIRED_FIELDS, type CompletenessReport, type Extraction, type ExtractedField, type RequiredField } from '../types.js';

export function checkCompleteness(extraction: Extraction): CompletenessReport {
  const missing = REQUIRED_FIELDS.filter((field) => extraction[field] === null);

  const declared = new Set<ExtractedField>(extraction.missingFields);
  const actuallyMissing = new Set<RequiredField>(missing);

  const disagreements: ExtractedField[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (declared.has(field) !== actuallyMissing.has(field)) disagreements.push(field);
  }

  return { missing: [...missing], isComplete: missing.length === 0, disagreements };
}
