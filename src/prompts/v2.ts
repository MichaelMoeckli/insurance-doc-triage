/**
 * Prompt set v2 - targets `name-mismatch`.
 *
 * The v1 run produced three hard failures. One of them was not a model failure at all:
 * on `liability-22-legal-deadline` the model returned "Bertschi Logistik AG" where the
 * label says "Stefan Hauser". The v1 schema described the field as
 *
 *     "Full name of the policyholder or claimant"
 *
 * On a liability claim those are two different parties - the policyholder is the insured
 * who caused the damage, and the claimant is the third party demanding money from them.
 * The instruction was self-contradictory, and the model picked the other reading. That is
 * a defect in the prompt, not in the model.
 *
 * This version changes exactly one string: the `claimantName` description. Everything
 * else - both instruction blocks, both input builders, every other field description -
 * is v1 verbatim, re-exported below rather than copied, so the diff cannot drift.
 *
 * The field is still *named* `claimantName`, which is itself the ambiguous word. Renaming
 * it would be the better fix, but it would touch the schema, the types, all 25 labels and
 * the scoring code at once, and a version that changes five things measures nothing. That
 * one is noted as follow-up work rather than smuggled in here.
 */

import { buildExtractionSchema, buildTriageSchema } from '../schema.js';
import type { PromptSet } from './types.js';
import { v1 } from './v1.js';

const CLAIMANT_NAME_DESCRIPTION =
  'Full name of the policyholder - the insured party the policy is written for, and the person or company on whose behalf this claim is being made. Without salutation or title. ' +
  'On a liability claim this is the insured who caused the damage, NOT the injured third party, and NOT a company or lawyer demanding payment from the insured. ' +
  'Never the broker, adjuster, garage, hospital, or employer. Null if absent or ambiguous.';

export const v2: PromptSet = {
  ...v1,
  version: 'v2',
  changelog:
    'Targets name-mismatch: the claimantName schema description said "policyholder or claimant", which are opposite parties on a liability claim. Now defines it as the policyholder explicitly. Single-string change; instructions and all other field descriptions identical to v1.',
  extractionSchema: buildExtractionSchema({ claimantName: CLAIMANT_NAME_DESCRIPTION }),
  triageSchema: buildTriageSchema(),
};
