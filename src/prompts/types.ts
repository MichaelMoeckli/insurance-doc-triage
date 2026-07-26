import type { CompletenessReport, Extraction } from '../types.js';

/**
 * One versioned prompt set: the instructions for both model calls, plus the builders
 * that assemble each user turn.
 *
 * A version owns *everything* that could move a metric. Splitting the extraction and
 * triage instructions into separate fields is what lets a v2 change one stage and leave
 * the other identical, so the eval's per-stage numbers stay interpretable.
 */
export interface PromptSet {
  /** Must match the registry key and the `PROMPT_VERSION` value. */
  version: string;
  /** What changed relative to the previous version, and which failure category it targets. */
  changelog: string;
  extractionInstructions: string;
  triageInstructions: string;
  buildExtractionInput(documentText: string): string;
  buildTriageInput(
    documentText: string,
    extraction: Extraction,
    completeness: CompletenessReport,
  ): string;
}
