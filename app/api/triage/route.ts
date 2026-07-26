/**
 * The demo's only API route: document text in, `TriageResult` out.
 *
 * It is a thin adapter, on purpose. Everything it does - the two model calls, the
 * completeness check, the summary - is `runPipeline`, the same function the CLI and the
 * eval harness call. If this route contained any triage logic of its own, the page would
 * be demonstrating something the eval numbers do not cover.
 */

import { MODEL, PROMPT_VERSION } from '../../../src/config.js';
import { getPromptSet } from '../../../src/prompts/index.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import type { ErrorResponse, TriageResponse } from '../../api-types.js';

/** Needs the Node runtime: the pipeline reads `process.env` and uses the OpenAI SDK. */
export const runtime = 'nodejs';
/** Every request calls the API, so there is nothing to cache or prerender. */
export const dynamic = 'force-dynamic';

/**
 * Roughly 5,000 tokens. A claim notification is a page or two; anything past this is a
 * paste accident, and the cap keeps one from turning into a surprise on the bill.
 */
const MAX_CHARS = 20_000;

function fail(message: string, status: number): Response {
  return Response.json({ error: message } satisfies ErrorResponse, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('Request body must be JSON.', 400);
  }

  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return fail('Paste a document first.', 400);
  }
  if (text.length > MAX_CHARS) {
    return fail(`Document is ${text.length} characters; the demo accepts up to ${MAX_CHARS}.`, 413);
  }

  try {
    const result = await runPipeline('pasted-document', text, getPromptSet());
    return Response.json({ result } satisfies TriageResponse);
  } catch (error) {
    // The message is surfaced verbatim rather than swallowed: this runs on a reviewer's
    // own machine against their own key, and "OPENAI_API_KEY is not set" is exactly the
    // thing they need to read. A deployment facing anyone else would log it and return
    // an opaque reference instead.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[triage] ${MODEL}/${PROMPT_VERSION} failed: ${message}`);
    return fail(message, 500);
  }
}
