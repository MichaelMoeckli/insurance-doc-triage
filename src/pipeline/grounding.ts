/**
 * Stage 2b: quote grounding. Like completeness, deliberately not a model call.
 *
 * The extraction schema asks the model to cite, for every field it filled in, the
 * verbatim span it took the value from. That is a claim about the document, and it is
 * decidable without a model and without a label: either the span is in the text or it is
 * not. Checking it costs a substring search and turns `sourceQuotes` from decoration
 * into the cheapest hallucination detector in the pipeline.
 *
 * It runs here rather than in the eval on purpose. A label exists for 25 documents; a
 * document arriving in production has none, and this is one of the few signals that still
 * works there - which is what makes it usable as a routing gate rather than only as a
 * post-hoc metric.
 *
 * What it does *not* do is check that the quote supports the value. `CHF 500.00` is a
 * real span of `motor-01` and grounds nothing about the claimed amount - it is the
 * deductible. Grounding is a necessary condition for trusting a field, never a sufficient
 * one, and the eval reports it beside field accuracy rather than folded into it.
 */

import {
  EXTRACTED_FIELDS,
  type Extraction,
  type ExtractedField,
  type GroundingReport,
  type QuoteCheck,
} from '../types.js';

/**
 * Typographic variants that carry no meaning here, written as escapes so the character
 * classes below stay readable in a diff and cannot be mangled by an editor.
 *
 * U+2018/2019 curly quotes, U+02BC modifier apostrophe, U+2032 prime, U+00B4 acute -
 * a Swiss thousands separator arrives as any of these, and `12’450.00` against
 * `12'450.00` is a font difference, not a fabrication.
 */
const APOSTROPHES = /[‘’ʼ′´`]/g;
const DOUBLE_QUOTES = /[“”″]/g;
/** Hyphen through horizontal bar (U+2010-U+2015) plus the minus sign (U+2212). */
const DASHES = /[‐-―−]/g;

/**
 * Folds away the differences that are not the model's fault, and nothing else.
 *
 * Everything past typography and whitespace stays significant. Digits, letters, word
 * order and content punctuation are compared as written, so a quote that has been
 * paraphrased, summarised, or stitched together from two parts of the document fails -
 * which is the whole point of the check.
 */
export function canonicalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(APOSTROPHES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    // Any run of whitespace, so a line break landing inside a quoted span is harmless.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when the cited span occurs in the document, modulo whitespace and typography. */
export function isGrounded(quote: string, documentText: string): boolean {
  const needle = canonicalize(quote);
  return needle !== '' && canonicalize(documentText).includes(needle);
}

export function checkGrounding(extraction: Extraction, documentText: string): GroundingReport {
  const haystack = canonicalize(documentText);

  const checks: QuoteCheck[] = extraction.sourceQuotes.map((entry) => {
    const needle = canonicalize(entry.quote);
    return {
      field: entry.field,
      quote: entry.quote,
      grounded: needle !== '' && haystack.includes(needle),
    };
  });

  const quotedFields = new Set<ExtractedField>(checks.map((check) => check.field));

  // A field may be cited more than once. One bad span taints it: the model has shown it
  // will produce a span that is not there, which is exactly what the signal is for.
  const ungrounded: ExtractedField[] = [];
  for (const check of checks) {
    if (!check.grounded && !ungrounded.includes(check.field)) ungrounded.push(check.field);
  }

  const uncited: ExtractedField[] = [];
  const quotedButNull: ExtractedField[] = [];
  for (const field of EXTRACTED_FIELDS) {
    const hasValue = extraction[field] !== null;
    if (hasValue && !quotedFields.has(field)) uncited.push(field);
    if (!hasValue && quotedFields.has(field)) quotedButNull.push(field);
  }

  return { checks, ungrounded, uncited, quotedButNull };
}
