/** Environment and path configuration. Loaded once, at import time. */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TokenUsage } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved from this file so the CLIs work from any cwd. */
export const ROOT = path.resolve(HERE, '..');

export const PATHS = {
  docs: path.join(ROOT, 'data', 'docs'),
  labels: path.join(ROOT, 'data', 'labels'),
  results: path.join(ROOT, 'results'),
  rawResults: path.join(ROOT, 'results', 'raw'),
  report: path.join(ROOT, 'results.md'),
} as const;

export const DEFAULT_MODEL = 'gpt-5-mini';
export const DEFAULT_PROMPT_VERSION = 'v1';
export const DEFAULT_REASONING_EFFORT = 'low';

/** Model id for this run. */
export const MODEL = process.env['OPENAI_MODEL']?.trim() || DEFAULT_MODEL;

/** Prompt set for this run. The knob for the v1 -> v2 eval loop. */
export const PROMPT_VERSION = process.env['PROMPT_VERSION']?.trim() || DEFAULT_PROMPT_VERSION;

export const REASONING_EFFORT = process.env['OPENAI_REASONING_EFFORT']?.trim() || DEFAULT_REASONING_EFFORT;

/**
 * Reads the API key, failing with an actionable message rather than a stack trace from
 * inside the SDK. Called lazily so that `--validate-only` runs need no key at all.
 */
export function requireApiKey(): string {
  const key = process.env['OPENAI_API_KEY']?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  return key;
}

/**
 * Indicative per-million-token prices in USD, used only to print a rough cost for an
 * eval run. Hard-coded prices go stale; this is a sanity check on spend, not billing.
 * Unknown models simply report no estimate.
 */
export const MODEL_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/**
 * Estimated USD cost of one call's token usage.
 *
 * Returns `null` rather than 0 for an unpriced model: a missing price and a free call
 * are different facts, and reporting the first as the second would quietly understate
 * spend the moment someone sets `OPENAI_MODEL` to something not listed above.
 *
 * Reasoning tokens are billed as output tokens and are already included in the API's
 * `output_tokens`, so no separate term is needed here. Cached input tokens are *not*
 * discounted by this estimate, which makes it an upper bound once caching is in play.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICING_USD_PER_MTOK[model];
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}
