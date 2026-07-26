/**
 * Thin wrapper over the OpenAI Responses API for strict Structured Outputs calls.
 *
 * Everything model-specific is contained here so the pipeline stages stay declarative:
 * they hand over a schema, a system prompt and a document, and get back parsed JSON.
 */

import OpenAI from 'openai';
import { MODEL, REASONING_EFFORT, requireApiKey } from '../config.js';
import type { TokenUsage } from '../types.js';

let cached: OpenAI | undefined;

/**
 * Lazily constructs the SDK client. Lazy so that offline commands
 * (`npm run eval -- --validate-only`) never require an API key.
 *
 * `maxRetries` covers the transport-level failures worth retrying - 429s and 5xx -
 * with the SDK's own exponential backoff. Reimplementing that by hand would be strictly
 * worse, so the only retry logic in this repo is the config below.
 */
export function getClient(): OpenAI {
  cached ??= new OpenAI({ apiKey: requireApiKey(), maxRetries: 4, timeout: 120_000 });
  return cached;
}

/** True for models that use `reasoning.effort` and reject `temperature`. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

/** Raised when the model returns no usable JSON (refusal, truncation, empty output). */
export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResponseError';
  }
}

export interface StructuredCallOptions {
  /** Schema name sent to the API; appears in errors. */
  schemaName: string;
  /** JSON Schema, strict-mode compatible. */
  schema: Record<string, unknown>;
  /** System-level instructions: task, policy, rubrics. */
  instructions: string;
  /** The user turn: the document, plus any stage-specific context. */
  input: string;
  /** Generous by default: reasoning tokens are billed as output and count here. */
  maxOutputTokens?: number;
}

export interface StructuredCallResult<T> {
  /** Parsed but not yet validated. Callers pass this to the matching validator. */
  data: T;
  usage: TokenUsage;
  latencyMs: number;
}

/**
 * Issues one strict Structured Outputs call and returns parsed JSON.
 *
 * Strict mode means the model is constrained to conforming JSON, so the failure modes
 * left to handle are the ones outside the schema's reach: an explicit refusal, and a
 * response truncated by the output-token cap. Both are surfaced loudly - a truncated
 * response that silently parsed as partial data would corrupt every metric downstream.
 */
export async function callStructured<T = unknown>(
  options: StructuredCallOptions,
): Promise<StructuredCallResult<T>> {
  const client = getClient();
  const startedAt = Date.now();

  const response = await client.responses.create({
    model: MODEL,
    instructions: options.instructions,
    input: options.input,
    max_output_tokens: options.maxOutputTokens ?? 4096,
    text: {
      format: {
        type: 'json_schema',
        name: options.schemaName,
        schema: options.schema,
        strict: true,
      },
    },
    // gpt-5 and o-series take `reasoning.effort`; earlier models take `temperature`.
    // Splitting here keeps OPENAI_MODEL genuinely swappable.
    ...(isReasoningModel(MODEL)
      ? { reasoning: { effort: REASONING_EFFORT as 'minimal' | 'low' | 'medium' | 'high' } }
      : { temperature: 0 }),
  });

  const latencyMs = Date.now() - startedAt;

  const refusal = response.output
    .flatMap((item) => (item.type === 'message' ? item.content : []))
    .find((part) => part.type === 'refusal');
  if (refusal && refusal.type === 'refusal') {
    throw new ModelResponseError(`model refused to answer: ${refusal.refusal}`);
  }

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new ModelResponseError(
      `response was truncated (${reason}); raise maxOutputTokens for ${options.schemaName}`,
    );
  }

  const text = response.output_text;
  if (!text) {
    throw new ModelResponseError(`empty response for ${options.schemaName} (status: ${response.status})`);
  }

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (error) {
    throw new ModelResponseError(
      `response was not valid JSON for ${options.schemaName}: ${(error as Error).message}`,
    );
  }

  return {
    data,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    latencyMs,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
