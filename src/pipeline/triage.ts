/** Stage 3: urgency, category and next action. One strict Structured Outputs call. */

import { callStructured, type StructuredCallResult } from '../openai/client.js';
import { TRIAGE_SCHEMA_NAME, validateTriage } from '../schema.js';
import type { PromptSet } from '../prompts/index.js';
import type { CompletenessReport, Extraction, Triage } from '../types.js';

export async function triageClaim(
  documentText: string,
  extraction: Extraction,
  completeness: CompletenessReport,
  prompts: PromptSet,
): Promise<StructuredCallResult<Triage>> {
  const result = await callStructured({
    schemaName: TRIAGE_SCHEMA_NAME,
    schema: prompts.triageSchema,
    instructions: prompts.triageInstructions,
    input: prompts.buildTriageInput(documentText, extraction, completeness),
  });

  return { ...result, data: validateTriage(result.data) };
}
