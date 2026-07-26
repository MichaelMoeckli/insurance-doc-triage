/**
 * JSON Schemas for OpenAI Structured Outputs, plus runtime validators.
 *
 * These are hand-written rather than generated from a validation library. Structured
 * Outputs is the mechanism this project is demonstrating, and strict mode has rules
 * worth being explicit about:
 *
 *   - `strict: true` and `additionalProperties: false` on every object,
 *   - *every* property listed in `required` - optionality is expressed as a
 *     `["string", "null"]` type union, never by omitting the key,
 *   - closed `enum`s wherever a value must be scoreable.
 *
 * With strict mode the model is constrained to emit conforming JSON, so the validators
 * below are a belt-and-braces check rather than the primary defence. They exist because
 * an eval that silently coerces a malformed response is an eval that lies: a validation
 * failure is recorded as a `schema-error` and counted.
 */

import {
  CATEGORIES,
  CLAIM_TYPES,
  CURRENCIES,
  EXTRACTED_FIELDS,
  URGENCIES,
  type Extraction,
  type Triage,
} from './types.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Descriptions are load-bearing. They travel with the schema on every request and are
 * the cheapest place to put per-field instructions, so field-level rules live here and
 * the system prompt stays about task and policy.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'policyNumber',
    'claimantName',
    'dateOfLoss',
    'claimType',
    'amount',
    'currency',
    'missingFields',
    'sourceQuotes',
  ],
  properties: {
    policyNumber: {
      type: ['string', 'null'],
      description:
        'The policy or contract number exactly as written in the document, including any letter prefix and separators. Not the claim/file/reference number. Null if absent or ambiguous.',
    },
    claimantName: {
      type: ['string', 'null'],
      description:
        'Full name of the policyholder or claimant, without salutation or title. Not the broker, adjuster, garage, or hospital. Null if absent or ambiguous.',
    },
    dateOfLoss: {
      type: ['string', 'null'],
      description:
        'The date the loss or incident occurred, as ISO 8601 YYYY-MM-DD. Not the date the document was written or reported. Null if absent, relative ("last Tuesday"), imprecise (month only), or written in a format that admits more than one reading.',
    },
    claimType: {
      type: ['string', 'null'],
      enum: [...CLAIM_TYPES, null],
      description: 'Line of business the claim belongs to. Null only if genuinely indeterminable.',
    },
    amount: {
      type: ['number', 'null'],
      description:
        'The claimed or estimated loss amount as a plain number, no thousands separators and a dot decimal point. Swiss documents write 12’450.00 and German ones 8.500,00 - both are 12450 and 8500. Prefer the claimed/estimated total over a deductible, excess, or premium. Null if absent or ambiguous.',
    },
    currency: {
      type: ['string', 'null'],
      enum: [...CURRENCIES, null],
      description:
        'ISO 4217 code for the amount. "Fr.", "SFr.", "CHF" and "Franken" are CHF. Do not assume CHF merely because the document is Swiss - use the currency actually stated with the amount. Null if no currency is stated.',
    },
    missingFields: {
      type: 'array',
      description:
        'Names of the fields above that you set to null because the document does not state them, or states them ambiguously. Must be exactly consistent with the nulls you emitted.',
      items: { type: 'string', enum: [...EXTRACTED_FIELDS] },
    },
    sourceQuotes: {
      type: 'array',
      description:
        'For each field you did fill in, the short verbatim span from the document you took it from. Omit entries for fields you set to null.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'quote'],
        properties: {
          field: { type: 'string', enum: [...EXTRACTED_FIELDS] },
          quote: {
            type: 'string',
            description: 'Verbatim text copied from the document, at most about 100 characters.',
          },
        },
      },
    },
  },
} as const;

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['urgency', 'category', 'recommendedAction', 'rationale'],
  properties: {
    urgency: {
      type: 'string',
      enum: [...URGENCIES],
      description: 'How fast a human handler must pick this up. Apply the rubric in the instructions.',
    },
    category: {
      type: 'string',
      enum: [...CATEGORIES],
      description:
        'Routing category. Choose the closest match from the list; use "other" only when no category applies.',
    },
    recommendedAction: {
      type: 'string',
      description:
        'One imperative sentence telling the handler what to do next, naming any specific information that must be requested from the claimant.',
    },
    rationale: {
      type: 'string',
      description: 'One or two sentences justifying the urgency and category, citing the document.',
    },
  },
} as const;

/** Schema names, as sent in `text.format.name`. Also used in error messages. */
export const EXTRACTION_SCHEMA_NAME = 'extraction_result';
export const TRIAGE_SCHEMA_NAME = 'triage_result';

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/** Thrown when a model response does not match its schema. Counted as `schema-error`. */
export class SchemaValidationError extends Error {
  constructor(
    readonly schemaName: string,
    readonly detail: string,
  ) {
    super(`${schemaName}: ${detail}`);
    this.name = 'SchemaValidationError';
  }
}

function fail(schemaName: string, detail: string): never {
  throw new SchemaValidationError(schemaName, detail);
}

function asRecord(schemaName: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(schemaName, `expected an object, received ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function nullableString(schemaName: string, obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(schemaName, `${key} must be a string or null, received ${typeof value}`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nullableNumber(schemaName: string, obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(schemaName, `${key} must be a finite number or null, received ${JSON.stringify(value)}`);
  }
  return value;
}

function nullableEnum<T extends string>(
  schemaName: string,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = nullableString(schemaName, obj, key);
  if (value === null) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(schemaName, `${key} must be one of ${allowed.join(' | ')}, received ${JSON.stringify(value)}`);
  }
  return value as T;
}

function requiredEnum<T extends string>(
  schemaName: string,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = nullableEnum(schemaName, obj, key, allowed);
  if (value === null) fail(schemaName, `${key} is required`);
  return value;
}

function requiredString(schemaName: string, obj: Record<string, unknown>, key: string): string {
  const value = nullableString(schemaName, obj, key);
  if (value === null) fail(schemaName, `${key} is required and must be non-empty`);
  return value;
}

function enumArray<T extends string>(
  schemaName: string,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(schemaName, `${key} must be an array`);
  const out: T[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry)) {
      fail(schemaName, `${key} contains an unknown value ${JSON.stringify(entry)}`);
    }
    if (!out.includes(entry as T)) out.push(entry as T); // de-duplicate; set semantics
  }
  return out;
}

/** Validates and narrows a parsed extraction response. */
export function validateExtraction(value: unknown): Extraction {
  const name = EXTRACTION_SCHEMA_NAME;
  const obj = asRecord(name, value);

  const quotesRaw = obj['sourceQuotes'];
  if (quotesRaw !== undefined && quotesRaw !== null && !Array.isArray(quotesRaw)) {
    fail(name, 'sourceQuotes must be an array');
  }
  const sourceQuotes = (Array.isArray(quotesRaw) ? quotesRaw : []).map((entry, index) => {
    const quoteObj = asRecord(name, entry);
    return {
      field: requiredEnum(name, quoteObj, 'field', EXTRACTED_FIELDS),
      quote: nullableString(name, quoteObj, 'quote') ?? fail(name, `sourceQuotes[${index}].quote is empty`),
    };
  });

  return {
    policyNumber: nullableString(name, obj, 'policyNumber'),
    claimantName: nullableString(name, obj, 'claimantName'),
    dateOfLoss: nullableString(name, obj, 'dateOfLoss'),
    claimType: nullableEnum(name, obj, 'claimType', CLAIM_TYPES),
    amount: nullableNumber(name, obj, 'amount'),
    currency: nullableEnum(name, obj, 'currency', CURRENCIES),
    missingFields: enumArray(name, obj, 'missingFields', EXTRACTED_FIELDS),
    sourceQuotes,
  };
}

/** Validates and narrows a parsed triage response. */
export function validateTriage(value: unknown): Triage {
  const name = TRIAGE_SCHEMA_NAME;
  const obj = asRecord(name, value);
  return {
    urgency: requiredEnum(name, obj, 'urgency', URGENCIES),
    category: requiredEnum(name, obj, 'category', CATEGORIES),
    recommendedAction: requiredString(name, obj, 'recommendedAction'),
    rationale: requiredString(name, obj, 'rationale'),
  };
}
