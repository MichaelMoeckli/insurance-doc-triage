/**
 * Normalization used when scoring extracted fields.
 *
 * Every rule here loosens a comparison, so every rule is a decision about what counts
 * as "correct" - which makes this the easiest file in the repo to quietly cheat in.
 * Two guards against that:
 *
 *   1. The rules only ever normalise *representation* - separators, case, whitespace,
 *      salutations. Never content. "CH MOT 2019 447215" and "CH-MOT-2019-447215" are
 *      the same policy; 12450 and 12500 are not, and nothing here pretends otherwise.
 *   2. Every field is scored twice, strict and normalised, and both numbers reach the
 *      report. A gap between the two is a formatting problem worth seeing, not
 *      something to bury under a single lenient headline figure.
 */

/** Case-folded and whitespace-collapsed. The floor for every string comparison. */
function basic(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-CH');
}

/** Salutations and titles that appear in Swiss correspondence but are not names. */
const TITLE_PREFIX = /^(herr|frau|hr|fr|mr|mrs|ms|miss|dr|prof|iur|med)\s+/;

export function normalizeName(value: string): string {
  // Titles stack in Swiss legal correspondence: "Dr. iur. Katrin Roth".
  let out = basic(value).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  while (TITLE_PREFIX.test(out)) out = out.replace(TITLE_PREFIX, '');
  return out.trim();
}

/**
 * Policy numbers: letters and digits are the identity, but spacing and case vary with
 * how the document happened to type them. Hyphens are deliberately *kept* - stripping
 * them would let a materially different rendering pass as a match.
 */
export function normalizePolicyNumber(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Parses a date to ISO `YYYY-MM-DD`, accepting the day-first formats a model may emit
 * instead of ISO (14.03.2025, 14/03/2025, 14-03-2025).
 *
 * Returns null for anything that is not a resolvable calendar date - which includes
 * "2025-03" and "March 2025". Those are exactly the values that should have been
 * reported as missing rather than guessed, so refusing to normalise them keeps the
 * ambiguity rule enforced at scoring time too.
 */
export function normalizeDate(value: string): string | null {
  const text = value.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    return isRealDate(year!, month!, day!) ? `${year}-${pad(month!)}-${pad(day!)}` : null;
  }

  const dayFirst = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(text);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return isRealDate(year!, month!, day!) ? `${year}-${pad(month!)}-${pad(day!)}` : null;
  }

  return null;
}

function pad(value: string): string {
  return value.padStart(2, '0');
}

function isRealDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** Money equality at rappen precision. Guards against float noise, nothing more. */
export function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Heuristic: does a wrong amount look like a thousands-separator misparse rather than a
 * wrong number?
 *
 * The signature is that the significant digits survive and only the magnitude moves -
 * 12'450.00 read as 12.45, or 8.500,00 read as 8.5. This is a *taxonomy* signal used to
 * sort the failure log, never a correctness signal: both cases are counted as wrong
 * either way. It can misfile a genuine value error whose digits happen to coincide
 * (3200 vs 320), which is an acceptable price for grouping the separator failures
 * together where they can be fixed with one prompt change.
 */
export function looksLikeSeparatorError(expected: number, actual: number): boolean {
  if (expected === actual || expected === 0 || actual === 0) return false;
  const digits = (value: number): string =>
    String(Math.abs(value)).replace(/[.,]/g, '').replace(/0+$/, '') || '0';
  return digits(expected) === digits(actual);
}

/** Order-independent set equality. Used for `missingFields`. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of right) if (!left.has(item)) return false;
  return true;
}
