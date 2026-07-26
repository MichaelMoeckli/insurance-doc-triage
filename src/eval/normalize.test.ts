/**
 * Tests for the normalization rules.
 *
 * These matter more than they look: every rule here decides what counts as a correct
 * answer, so a bug in this file silently moves every number in results.md. Run with
 * `npm test`. No test framework - `node:test` ships with Node.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  amountsEqual,
  looksLikeSeparatorError,
  normalizeCurrency,
  normalizeDate,
  normalizeName,
  normalizePolicyNumber,
  sameSet,
} from './normalize.js';

describe('normalizeDate', () => {
  it('passes ISO dates through', () => {
    assert.equal(normalizeDate('2025-03-14'), '2025-03-14');
    assert.equal(normalizeDate('2025-3-4'), '2025-03-04');
  });

  it('converts Swiss and European day-first notation', () => {
    assert.equal(normalizeDate('14.03.2025'), '2025-03-14');
    assert.equal(normalizeDate('14/03/2025'), '2025-03-14');
    assert.equal(normalizeDate('3/4/2025'), '2025-04-03');
  });

  it('rejects values that are not a resolvable calendar day', () => {
    // These are exactly the cases the pipeline should report as missing rather than
    // guess, so normalisation must not rescue them.
    assert.equal(normalizeDate('2025-03'), null);
    assert.equal(normalizeDate('March 2025'), null);
    assert.equal(normalizeDate('letzten Dienstag'), null);
    assert.equal(normalizeDate(''), null);
  });

  it('rejects impossible dates', () => {
    assert.equal(normalizeDate('2025-02-30'), null);
    assert.equal(normalizeDate('32.01.2025'), null);
    assert.equal(normalizeDate('2025-13-01'), null);
  });

  it('accepts a real leap day and rejects a fake one', () => {
    assert.equal(normalizeDate('29.02.2024'), '2024-02-29');
    assert.equal(normalizeDate('29.02.2025'), null);
  });
});

describe('normalizeName', () => {
  it('strips stacked salutations and titles', () => {
    assert.equal(normalizeName('Dr. iur. Katrin Roth'), 'katrin roth');
    assert.equal(normalizeName('Frau Andrea Vogt'), 'andrea vogt');
    assert.equal(normalizeName('Mr Peter Steiner'), 'peter steiner');
  });

  it('collapses whitespace and case', () => {
    assert.equal(normalizeName('  Andrea   VOGT '), 'andrea vogt');
  });

  it('keeps names that merely start with a title-like syllable', () => {
    assert.equal(normalizeName('Frankie Mertens'), 'frankie mertens');
  });

  it('does not merge two different people', () => {
    assert.notEqual(normalizeName('Goran Petrović'), normalizeName('Vesna Petrović'));
  });
});

describe('normalizePolicyNumber', () => {
  it('upper-cases and removes whitespace', () => {
    assert.equal(normalizePolicyNumber(' ch-mot-2019-447215 '), 'CH-MOT-2019-447215');
  });

  it('keeps hyphens, so a different rendering stays a mismatch', () => {
    assert.notEqual(normalizePolicyNumber('CHMOT2019447215'), normalizePolicyNumber('CH-MOT-2019-447215'));
  });
});

describe('amount comparison', () => {
  it('treats rappen-level noise as equal', () => {
    assert.ok(amountsEqual(12450, 12450.001));
    assert.ok(!amountsEqual(12450, 12450.01));
  });

  it('recognises separator misparses by their surviving digits', () => {
    assert.ok(looksLikeSeparatorError(12450, 12.45));
    assert.ok(looksLikeSeparatorError(8500, 8.5));
    assert.ok(looksLikeSeparatorError(3200, 3.2));
  });

  it('does not label a genuinely different number as a separator problem', () => {
    assert.ok(!looksLikeSeparatorError(12450, 12500));
    assert.ok(!looksLikeSeparatorError(7350, 500));
    assert.ok(!looksLikeSeparatorError(1840, 0));
  });
});

describe('helpers', () => {
  it('compares missingFields as an unordered set', () => {
    assert.ok(sameSet(['amount', 'currency'], ['currency', 'amount']));
    assert.ok(!sameSet(['amount'], ['amount', 'currency']));
    assert.ok(sameSet([], []));
  });

  it('upper-cases currency codes', () => {
    assert.equal(normalizeCurrency(' chf '), 'CHF');
  });
});
