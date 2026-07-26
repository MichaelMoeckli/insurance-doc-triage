/**
 * Stage 4b: the one-line human-readable summary.
 *
 * This is what a handler sees in a queue before opening anything, so it is built in
 * code, not generated. A deterministic summary cannot hallucinate a policy number, it
 * costs nothing, and it renders identically for every claim - all three matter more
 * here than fluency.
 */

import type { CompletenessReport, Extraction, Triage } from '../types.js';

/** Swiss thousands grouping: 12450.5 -> "12'450.50". */
function formatAmount(amount: number): string {
  const [whole = '0', fraction = '00'] = amount.toFixed(2).split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${sign}${grouped}.${fraction}`;
}

export function buildSummary(
  extraction: Extraction,
  completeness: CompletenessReport,
  triage: Triage,
): string {
  const money =
    extraction.amount === null
      ? 'amount unknown'
      : `${extraction.currency ?? '???'} ${formatAmount(extraction.amount)}`;

  const parts = [
    `[${triage.urgency.toUpperCase()}]`,
    triage.category,
    extraction.claimantName ?? 'unnamed claimant',
    `policy ${extraction.policyNumber ?? 'unknown'}`,
    money,
    `loss ${extraction.dateOfLoss ?? 'date unknown'}`,
  ];

  if (!completeness.isComplete) parts.push(`missing: ${completeness.missing.join(', ')}`);

  return `${parts.join(' | ')} -> ${triage.recommendedAction}`;
}
