/**
 * Prompt set v1 - the first honest attempt.
 *
 * Written before seeing a single eval result. It states the task, the ambiguity rule
 * and the urgency rubric, and stops there. Per-field formatting guidance lives in the
 * JSON Schema field descriptions (`src/schema.ts`) rather than being duplicated here.
 *
 * Deliberately not pre-optimised: the point of the harness is to find out where this
 * breaks and then make one targeted change. See the README for the v2 recipe.
 */

import { buildExtractionSchema, buildTriageSchema } from '../schema.js';
import type { PromptSet } from './types.js';

/**
 * The urgency rubric. This exact text is mirrored in the README and was used to author
 * the ground-truth labels - if the rubric and the labels disagree, urgency accuracy
 * measures nothing. Any change here is a labelling change too.
 */
const URGENCY_RUBRIC = `Assign urgency using this rubric, in order:

- high  - any of: a person was injured; damage is ongoing or the property is unsafe
          (water still escaping, fire, structural damage); a third party has set a legal
          or regulatory deadline; the claimed amount is CHF 50,000 or more.
- low   - all of: no injury, no ongoing damage, no deadline, and either the claimed
          amount is under CHF 1,000, or the document is purely administrative (a status
          enquiry, a request for a form or a duplicate copy).
- normal - everything else.

"high" wins over "low" when both could apply. Missing fields do not raise urgency by
themselves - ask for them in recommendedAction instead.`;

const EXTRACTION_INSTRUCTIONS = `You extract structured data from insurance and finance documents for a Swiss insurer.
Documents arrive as emails, transcribed claim forms, broker notes, adjuster memos and
call transcripts, in German, English, or a mix of both.

Extract only what the document actually states. The single most important rule:

  If a field is not stated, or is stated in a way that admits more than one reading,
  set it to null AND list its name in missingFields. Never guess, and never infer a
  value from convention or from what is typical.

Concretely, these are null (and go in missingFields):
- a date given relatively ("last Tuesday", "letzten Dienstag") or without a day ("March 2025")
- a date written so that the day and month order is genuinely unclear
- an amount described only as an estimate range or as "to be determined"
- a currency that is never stated

Do not translate names or identifiers. Return the policy number as written.`;

const TRIAGE_INSTRUCTIONS = `You triage insurance claims for a Swiss insurer. You are given a document and the
structured fields already extracted from it, and you route the claim to a handler queue.

${URGENCY_RUBRIC}

Choose the routing category that best matches what actually happened, not merely the
line of business. Use "other" only when no listed category applies.

recommendedAction is one imperative sentence addressed to the handler. If required
fields are missing, name them explicitly so the handler knows what to request.`;

export const v1: PromptSet = {
  version: 'v1',
  changelog: 'Baseline. Task definition, the null-on-ambiguity rule, and the urgency rubric.',
  extractionInstructions: EXTRACTION_INSTRUCTIONS,
  triageInstructions: TRIAGE_INSTRUCTIONS,
  // No overrides: the schema descriptions exactly as v1 was measured with.
  extractionSchema: buildExtractionSchema(),
  triageSchema: buildTriageSchema(),

  buildExtractionInput(documentText) {
    return `Extract the structured fields from this document.\n\n<document>\n${documentText}\n</document>`;
  },

  buildTriageInput(documentText, extraction, completeness) {
    // Triage sees the validated extraction rather than re-deriving fields from the raw
    // text. That is the point of splitting the calls: an extraction error shows up once,
    // in the extraction metrics, instead of being laundered into a triage error too.
    const fields = JSON.stringify(
      {
        policyNumber: extraction.policyNumber,
        claimantName: extraction.claimantName,
        dateOfLoss: extraction.dateOfLoss,
        claimType: extraction.claimType,
        amount: extraction.amount,
        currency: extraction.currency,
      },
      null,
      2,
    );

    const missing = completeness.missing.length
      ? completeness.missing.join(', ')
      : 'none - all required fields are present';

    return `<document>\n${documentText}\n</document>\n\n<extracted_fields>\n${fields}\n</extracted_fields>\n\n<missing_required_fields>\n${missing}\n</missing_required_fields>\n\nTriage this claim.`;
  },
};
