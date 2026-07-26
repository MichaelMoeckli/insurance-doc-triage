/**
 * Loading and validating the labelled dataset.
 *
 * This runs before any API call, and it is strict on purpose. A silently malformed
 * label does not crash an eval - it produces a slightly wrong accuracy number, which is
 * far worse, because it looks like a result. Anything questionable is a hard failure
 * here instead.
 *
 * `npm run eval -- --validate-only` runs exactly this and stops, so the dataset can be
 * checked offline without an API key or a single token of spend.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import {
  CATEGORIES,
  CLAIM_TYPES,
  CURRENCIES,
  EXTRACTED_FIELDS,
  URGENCIES,
  type ExtractedField,
  type GroundTruth,
  type LabelledDocument,
} from '../types.js';
import { normalizeDate } from './normalize.js';

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetError';
  }
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Validates one label file.
 *
 * The consistency rule below is the load-bearing one: a field is null if and only if it
 * is listed in `missingFields`. It is the same rule the prompt gives the model, so if
 * the labels can drift from it the whole `missingFields` metric becomes meaningless.
 */
function parseGroundTruth(id: string, raw: unknown): GroundTruth {
  const bad = (detail: string): never => {
    throw new DatasetError(`data/labels/${id}.json: ${detail}`);
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('expected a JSON object');
  const obj = raw as Record<string, unknown>;

  const nullableString = (key: string): string | null => {
    const value = obj[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.trim() === '') bad(`${key} must be a non-empty string or null`);
    return (value as string).trim();
  };

  const dateOfLoss = nullableString('dateOfLoss');
  if (dateOfLoss !== null && normalizeDate(dateOfLoss) !== dateOfLoss) {
    bad(`dateOfLoss must be a real ISO date (YYYY-MM-DD), received ${JSON.stringify(dateOfLoss)}`);
  }

  const amountRaw = obj['amount'];
  if (amountRaw !== null && amountRaw !== undefined && typeof amountRaw !== 'number') {
    bad('amount must be a number or null');
  }
  const amount = typeof amountRaw === 'number' ? amountRaw : null;

  const claimTypeRaw = obj['claimType'];
  if (claimTypeRaw !== null && !isMember(claimTypeRaw, CLAIM_TYPES)) {
    bad(`claimType must be one of ${CLAIM_TYPES.join(' | ')} or null`);
  }

  const currencyRaw = obj['currency'];
  if (currencyRaw !== null && !isMember(currencyRaw, CURRENCIES)) {
    bad(`currency must be one of ${CURRENCIES.join(' | ')} or null`);
  }

  if (!isMember(obj['urgency'], URGENCIES)) bad(`urgency must be one of ${URGENCIES.join(' | ')}`);
  if (!isMember(obj['category'], CATEGORIES)) bad(`category must be one of ${CATEGORIES.join(' | ')}`);

  const missingRaw = obj['missingFields'];
  if (!Array.isArray(missingRaw)) bad('missingFields must be an array');
  const missingFields: ExtractedField[] = [];
  for (const entry of missingRaw as unknown[]) {
    if (!isMember(entry, EXTRACTED_FIELDS)) {
      throw new DatasetError(
        `data/labels/${id}.json: missingFields contains unknown field ${JSON.stringify(entry)}`,
      );
    }
    if (missingFields.includes(entry)) bad(`missingFields lists ${entry} twice`);
    missingFields.push(entry);
  }

  const truth: GroundTruth = {
    policyNumber: nullableString('policyNumber'),
    claimantName: nullableString('claimantName'),
    dateOfLoss,
    claimType: claimTypeRaw as GroundTruth['claimType'],
    amount,
    currency: currencyRaw as GroundTruth['currency'],
    missingFields,
    urgency: obj['urgency'] as GroundTruth['urgency'],
    category: obj['category'] as GroundTruth['category'],
    notes: typeof obj['notes'] === 'string' ? obj['notes'] : '',
  };

  // The ambiguity rule, enforced: null if and only if declared missing.
  for (const field of EXTRACTED_FIELDS) {
    const isNull = truth[field] === null;
    const isDeclared = missingFields.includes(field);
    if (isNull && !isDeclared) bad(`${field} is null but is not listed in missingFields`);
    if (!isNull && isDeclared) bad(`${field} is listed in missingFields but has a value`);
  }

  if (!truth.notes) bad('notes is required - it is what makes the failure log readable');

  return truth;
}

/**
 * Loads every document/label pair, failing on any unpaired file.
 *
 * @param only Optional substring filter on the document id, for cheap iteration on a
 *             single failing document.
 * @param limit Optional cap on the number of documents, for a cheap smoke run.
 */
export async function loadDataset(only?: string, limit?: number): Promise<LabelledDocument[]> {
  const [docFiles, labelFiles] = await Promise.all([readdir(PATHS.docs), readdir(PATHS.labels)]);

  const docIds = docFiles.filter((f) => f.endsWith('.txt')).map((f) => path.basename(f, '.txt'));
  const labelIds = new Set(labelFiles.filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')));

  if (docIds.length === 0) throw new DatasetError(`no .txt documents found in ${PATHS.docs}`);

  const missingLabels = docIds.filter((id) => !labelIds.has(id));
  const orphanLabels = [...labelIds].filter((id) => !docIds.includes(id));
  if (missingLabels.length) throw new DatasetError(`documents without a label: ${missingLabels.join(', ')}`);
  if (orphanLabels.length) throw new DatasetError(`labels without a document: ${orphanLabels.join(', ')}`);

  const selected = docIds
    .filter((id) => (only ? id.includes(only) : true))
    .sort()
    .slice(0, limit ?? Infinity);

  if (selected.length === 0) throw new DatasetError(`no documents matched --doc "${only ?? ''}"`);

  return Promise.all(
    selected.map(async (id): Promise<LabelledDocument> => {
      const docPath = path.join(PATHS.docs, `${id}.txt`);
      const [text, labelJson] = await Promise.all([
        readFile(docPath, 'utf8'),
        readFile(path.join(PATHS.labels, `${id}.json`), 'utf8'),
      ]);

      let parsed: unknown;
      try {
        parsed = JSON.parse(labelJson);
      } catch (error) {
        throw new DatasetError(`data/labels/${id}.json is not valid JSON: ${(error as Error).message}`);
      }

      if (text.trim() === '') throw new DatasetError(`data/docs/${id}.txt is empty`);

      return { id, path: docPath, text, truth: parseGroundTruth(id, parsed) };
    }),
  );
}
