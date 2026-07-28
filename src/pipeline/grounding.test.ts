/**
 * Tests for quote grounding.
 *
 * The whole value of this check rests on where the line sits. Too strict and it fires on
 * a curly apostrophe, which trains a reader to ignore it; too loose and a paraphrase
 * passes, which is the case it exists to catch. Both edges are pinned here, against the
 * typography that actually appears in `data/docs/`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Extraction } from '../types.js';
import { canonicalize, checkGrounding, isGrounded } from './grounding.js';

const DOCUMENT = [
  'Von: andrea.vogt@bluewin.ch',
  'Betreff: Schadenmeldung Kollision - Police CH-MOT-2019-447215',
  '',
  'Am 14.03.2025 gegen 07:40 Uhr bin ich auf der Birmensdorferstrasse in Zürich',
  'auf das vor mir haltende Fahrzeug aufgefahren. Verletzt wurde niemand.',
  '',
  'Die Garage Wettstein AG hat den Schaden auf CHF 12’450.00 geschätzt.',
  'Der vereinbarte Selbstbehalt von CHF 500.00 ist mir bekannt.',
  '',
  'Andrea Vogt',
].join('\n');

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    policyNumber: 'CH-MOT-2019-447215',
    claimantName: 'Andrea Vogt',
    dateOfLoss: '2025-03-14',
    claimType: 'motor',
    amount: 12450,
    currency: 'CHF',
    missingFields: [],
    sourceQuotes: [],
    ...overrides,
  };
}

describe('isGrounded', () => {
  it('accepts a span copied verbatim', () => {
    assert.equal(isGrounded('Die Garage Wettstein AG', DOCUMENT), true);
  });

  it('accepts a span whose apostrophe is a different code point', () => {
    // The document uses U+2019; a model may well emit U+0027. Same number either way.
    assert.equal(isGrounded("CHF 12'450.00", DOCUMENT), true);
    assert.equal(isGrounded('CHF 12’450.00', DOCUMENT), true);
  });

  it('accepts a span broken across a line break', () => {
    assert.equal(isGrounded('Birmensdorferstrasse in Zürich auf das vor mir', DOCUMENT), true);
  });

  it('accepts a dash written as any of its variants', () => {
    assert.equal(isGrounded('Schadenmeldung Kollision — Police', DOCUMENT), true);
    assert.equal(isGrounded('Schadenmeldung Kollision – Police', DOCUMENT), true);
  });

  it('ignores case and surrounding whitespace', () => {
    assert.equal(isGrounded('  ANDREA VOGT  ', DOCUMENT), true);
  });

  it('rejects a paraphrase', () => {
    assert.equal(isGrounded('The garage estimated the damage at CHF 12450', DOCUMENT), false);
  });

  it('rejects a span stitched together from two places in the document', () => {
    assert.equal(isGrounded('Die Garage Wettstein AG ist mir bekannt', DOCUMENT), false);
  });

  it('rejects a changed digit', () => {
    assert.equal(isGrounded('CHF 12’451.00', DOCUMENT), false);
  });

  it('rejects an empty span rather than matching everything', () => {
    // '' is a substring of every string. Left unguarded this would silently ground
    // an empty quote and report the run as perfectly evidenced.
    assert.equal(isGrounded('', DOCUMENT), false);
    assert.equal(isGrounded('   ', DOCUMENT), false);
  });
});

describe('canonicalize', () => {
  it('folds only typography and whitespace', () => {
    assert.equal(canonicalize('CHF  12’450.00\n'), "chf 12'450.00");
    // Word order is content, not formatting.
    assert.notEqual(canonicalize('Andrea Vogt'), canonicalize('Vogt Andrea'));
  });
});

describe('checkGrounding', () => {
  it('separates fabricated spans from absent ones', () => {
    const report = checkGrounding(
      extraction({
        sourceQuotes: [
          { field: 'policyNumber', quote: 'Police CH-MOT-2019-447215' },
          { field: 'amount', quote: 'geschätzter Schaden CHF 12’450.00' },
        ],
      }),
      DOCUMENT,
    );

    assert.deepEqual(report.ungrounded, ['amount']);
    // Four fields carry a value and no span at all - a different defect from the above.
    assert.deepEqual(report.uncited, ['claimantName', 'dateOfLoss', 'claimType', 'currency']);
    assert.deepEqual(report.quotedButNull, []);
  });

  it('flags a span attached to a field the model set to null', () => {
    const report = checkGrounding(
      extraction({
        amount: null,
        missingFields: ['amount'],
        sourceQuotes: [{ field: 'amount', quote: 'CHF 12’450.00' }],
      }),
      DOCUMENT,
    );

    assert.deepEqual(report.quotedButNull, ['amount']);
    assert.deepEqual(report.ungrounded, [], 'the span is real; only the instruction was ignored');
    assert.ok(!report.uncited.includes('amount'), 'a null field is not owed a span');
  });

  it('taints a field on one bad span among several', () => {
    const report = checkGrounding(
      extraction({
        sourceQuotes: [
          { field: 'claimantName', quote: 'Andrea Vogt' },
          { field: 'claimantName', quote: 'Frau Andrea Vogt-Meier' },
        ],
      }),
      DOCUMENT,
    );

    assert.deepEqual(report.ungrounded, ['claimantName']);
    assert.equal(report.checks.filter((c) => c.grounded).length, 1);
  });

  it('reports a clean extraction as fully grounded and fully cited', () => {
    const report = checkGrounding(
      extraction({
        sourceQuotes: [
          { field: 'policyNumber', quote: 'CH-MOT-2019-447215' },
          { field: 'claimantName', quote: 'Andrea Vogt' },
          { field: 'dateOfLoss', quote: 'Am 14.03.2025' },
          { field: 'claimType', quote: 'Schadenmeldung Kollision' },
          { field: 'amount', quote: 'CHF 12’450.00' },
          { field: 'currency', quote: 'CHF 12’450.00' },
        ],
      }),
      DOCUMENT,
    );

    assert.deepEqual(report.ungrounded, []);
    assert.deepEqual(report.uncited, []);
    assert.deepEqual(report.quotedButNull, []);
    assert.equal(report.checks.length, 6);
  });
});
