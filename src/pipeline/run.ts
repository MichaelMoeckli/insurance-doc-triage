/**
 * Pipeline orchestration: document text in, TriageResult out.
 *
 *   extract (model)  ->  completeness (deterministic)  ->  triage (model)  ->  summary
 *
 * The two model calls are sequential by necessity: triage is conditioned on the
 * validated extraction and the completeness flags, so it cannot start until stage 1
 * lands. Throughput comes from running whole documents concurrently instead (see
 * `src/cli/eval.ts`).
 */

import { MODEL } from '../config.js';
import { addUsage } from '../openai/client.js';
import { getPromptSet, type PromptSet } from '../prompts/index.js';
import type { TriageResult } from '../types.js';
import { checkCompleteness } from './completeness.js';
import { extractFields } from './extract.js';
import { buildSummary } from './summary.js';
import { triageClaim } from './triage.js';

export async function runPipeline(
  documentId: string,
  documentText: string,
  prompts: PromptSet = getPromptSet(),
): Promise<TriageResult> {
  const extracted = await extractFields(documentText, prompts);
  const completeness = checkCompleteness(extracted.data);
  const triaged = await triageClaim(documentText, extracted.data, completeness, prompts);

  return {
    documentId,
    extraction: extracted.data,
    completeness,
    triage: triaged.data,
    summary: buildSummary(extracted.data, completeness, triaged.data),
    meta: {
      model: MODEL,
      promptVersion: prompts.version,
      usage: addUsage(extracted.usage, triaged.usage),
      latencyMs: extracted.latencyMs + triaged.latencyMs,
    },
  };
}
