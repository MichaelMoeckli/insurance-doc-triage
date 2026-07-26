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

import { MODEL, estimateCostUsd } from '../config.js';
import { addUsage, type StructuredCallResult } from '../openai/client.js';
import { getPromptSet, type PromptSet } from '../prompts/index.js';
import type { ModelCallStage, ModelCallStats, TriageResult } from '../types.js';
import { checkCompleteness } from './completeness.js';
import { extractFields } from './extract.js';
import { buildSummary } from './summary.js';
import { triageClaim } from './triage.js';

/** Attaches the stage name and an indicative price to one call's usage and timing. */
function statsFor(stage: ModelCallStage, call: StructuredCallResult<unknown>): ModelCallStats {
  return {
    stage,
    usage: call.usage,
    latencyMs: call.latencyMs,
    costUsd: estimateCostUsd(MODEL, call.usage),
  };
}

export async function runPipeline(
  documentId: string,
  documentText: string,
  prompts: PromptSet = getPromptSet(),
): Promise<TriageResult> {
  const extracted = await extractFields(documentText, prompts);
  const completeness = checkCompleteness(extracted.data);
  const triaged = await triageClaim(documentText, extracted.data, completeness, prompts);

  const calls = [statsFor('extract', extracted), statsFor('triage', triaged)];
  const usage = addUsage(extracted.usage, triaged.usage);

  return {
    documentId,
    extraction: extracted.data,
    completeness,
    triage: triaged.data,
    summary: buildSummary(extracted.data, completeness, triaged.data),
    meta: {
      model: MODEL,
      promptVersion: prompts.version,
      usage,
      // The two stages are sequential, so summing them is the document's wall clock.
      latencyMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
      costUsd: estimateCostUsd(MODEL, usage),
      calls,
    },
  };
}
