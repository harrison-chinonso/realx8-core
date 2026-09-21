const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalise, referenceMatches, scoreCandidate, suggestFor, fingerprintOf,
} = require('../../shared/src/accounting/bankMatch');

/**
 * Pairing what the bank says with what the ledger says (ACC-6.2).
 *
 * ── What a wrong answer costs, in each direction ────────────────────────────
 *
 * A wrong MATCH is invisible: the reconciliation balances, both sides are used
 * up, and the two transactions that were actually swapped are never looked at
 * again. A wrong SUGGESTION costs a glance. Every rule below is shaped by that
 * asymmetry — the scoring is deliberately unwilling to call something certain.
 */

const LINE = {
  statement_date: '2026-05-04',
  amount_minor: 5000000,
  reference: 'TRF FRM KELVIN O/REF INV-0001',
  description: 'Inward transfer',
};

test('a reference is compared on its letters and digits alone', () => {
  assert.equal(normalise('INV-0001 '), 'INV0001');
  assert.equal(normalise('inv/0001'), 'INV0001');
});

test('a bank\'s decoration around a reference does not hide it', () => {
  assert.ok(referenceMatches('TRF FRM KELVIN O/REF INV-0001', 'INV-0001'));
});

test('a short fragment does not match everything', () => {
  // "REF" appears in half a bank's narrations.
  assert.equal(referenceMatches('REF', 'REFERENCE 12'), false);
  assert.equal(referenceMatches('', 'INV-0001'), false);
});

test('same amount, same day, reference on both is certain', () => {
  const scored = scoreCandidate(LINE, {
    entry_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001',
  });
  assert.equal(scored.certainty, 'certain');
});

test('the same amount in the opposite direction is not a match at all', () => {
  /*
   * A ₦50,000 receipt and a ₦50,000 payment on one day are the same number and
   * opposite events. Matching them would balance the reconciliation while
   * describing the company's month backwards.
   */
  assert.equal(scoreCandidate(LINE, {
    entry_date: '2026-05-04', amount_minor: -5000000, reference: 'INV-0001',
  }), null);
});

test('a different amount is not scored at all', () => {
  // An amount mismatch is a different transaction, not a weak match, and
  // scoring it would put noise in front of a person.
  assert.equal(scoreCandidate(LINE, {
    entry_date: '2026-05-04', amount_minor: 5000001, reference: 'INV-0001',
  }), null);
});

test('a matching amount with no reference is only ever possible', () => {
  const scored = scoreCandidate(LINE, {
    entry_date: '2026-05-04', amount_minor: 5000000, reference: 'SOMETHING ELSE',
  });
  assert.equal(scored.certainty, 'possible');
});

test('a reference match far outside the date window is not certain', () => {
  const scored = scoreCandidate(LINE, {
    entry_date: '2026-01-04', amount_minor: 5000000, reference: 'INV-0001',
  });
  assert.equal(scored.certainty, 'possible');
});

test('closer in time scores higher', () => {
  const sameDay = scoreCandidate(LINE, { entry_date: '2026-05-04', amount_minor: 5000000 });
  const twoDays = scoreCandidate(LINE, { entry_date: '2026-05-06', amount_minor: 5000000 });
  const months = scoreCandidate(LINE, { entry_date: '2026-08-04', amount_minor: 5000000 });

  assert.ok(sameDay.score > twoDays.score);
  assert.ok(twoDays.score > months.score);
});

test('the reference on the line DESCRIPTION counts too', () => {
  // Some banks put the payer's reference in the narration and leave the
  // reference column blank.
  const scored = scoreCandidate(
    { ...LINE, reference: null, description: 'TRF FRM KELVIN O/REF INV-0001' },
    { entry_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001' },
  );
  assert.equal(scored.certainty, 'certain');
});

test('...but a narration that does not carry it is not evidence', () => {
  const scored = scoreCandidate(
    { ...LINE, reference: null, description: 'Inward transfer' },
    { entry_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001' },
  );
  assert.equal(scored.certainty, 'possible');
});

test('candidates come back best first, and capped', () => {
  const candidates = Array.from({ length: 12 }, (unused, index) => ({
    entry_id: index,
    entry_date: '2026-05-04',
    amount_minor: 5000000,
    reference: index === 7 ? 'INV-0001' : `OTHER-${index}`,
  }));

  const ranked = suggestFor(LINE, candidates);
  assert.equal(ranked.length, 5);
  assert.equal(ranked[0].candidate.entry_id, 7);
});

test('a line with no candidates gets none', () => {
  assert.deepEqual(suggestFor(LINE, []), []);
});

// ── The fingerprint ────────────────────────────────────────────────────────

test('the same line fingerprints the same however it is spelled', () => {
  const a = fingerprintOf({
    statement_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001',
  });
  const b = fingerprintOf({
    statement_date: '2026-05-04', amount_minor: 5000000, reference: ' inv/0001 ',
  });
  // A bank re-exporting the same line with different punctuation must not
  // create a second copy of the movement.
  assert.equal(a, b);
});

test('a different day, amount or reference is a different line', () => {
  const base = { statement_date: '2026-05-04', amount_minor: 5000000, reference: 'INV-0001' };
  const print = fingerprintOf(base);

  assert.notEqual(print, fingerprintOf({ ...base, statement_date: '2026-05-05' }));
  assert.notEqual(print, fingerprintOf({ ...base, amount_minor: 5000001 }));
  assert.notEqual(print, fingerprintOf({ ...base, reference: 'INV-0002' }));
});

test('a line with no reference falls back to its description', () => {
  const withDescription = fingerprintOf({
    statement_date: '2026-05-04', amount_minor: -107500, reference: null, description: 'COMMISSION ON TURNOVER',
  });
  const different = fingerprintOf({
    statement_date: '2026-05-04', amount_minor: -107500, reference: null, description: 'STAMP DUTY',
  });
  assert.notEqual(withDescription, different);
});
