/** Stage 1: structured extraction. One strict Structured Outputs call. */

import { callStructured, type StructuredCallResult } from '../openai/client.js';
import { EXTRACTION_SCHEMA_NAME, validateExtraction } from '../schema.js';
import type { PromptSet } from '../prompts/index.js';
import type { Extraction } from '../types.js';

export async function extractFields(
  documentText: string,
  prompts: PromptSet,
): Promise<StructuredCallResult<Extraction>> {
  const result = await callStructured({
    schemaName: EXTRACTION_SCHEMA_NAME,
    schema: prompts.extractionSchema,
    instructions: prompts.extractionInstructions,
    input: prompts.buildExtractionInput(documentText),
  });

  return { ...result, data: validateExtraction(result.data) };
}
