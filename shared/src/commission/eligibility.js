const { EXCLUSION } = require('./vocabulary');

/**
 * The active-status gate (§7.16).
 *
 * ── Why this is not the same kind of fact as level ──────────────────────────
 *
 * A realtor's LEVEL is locked at the deal's attribution date (FR-LVL-008), so a
 * promotion three months later does not restate what an old deal pays. Status
 * is deliberately the opposite: it is re-read, from scratch, at every release
 * checkpoint. The two rules look inconsistent until you see that they protect
 * different things. Locking the level prevents rate drift. Re-reading status
 * prevents paying somebody who is no longer entitled to be paid at all — and
 * that is a fact about *now*, not about the deal.
 *
 * So a realtor who was active when the deal closed, and is terminated before
 * the third instalment vests, does not receive the third instalment. Nothing
 * about the deal changed; the person's standing did.
 *
 * ── Why it reads history rather than the realtor's current status ───────────
 *
 * FR-ELG-013. Asking "is this realtor active?" answers a question about today.
 * The engine needs "was this realtor active at 14:02 on the 3rd of March", both
 * because a release is evaluated as of its own event time and because a report
 * re-rendered next year must show the same answer it showed when the money
 * moved. Querying live status would quietly restate history every time somebody
 * was reactivated.
 */

const ACTIVE = 'active';

/**
 * The realtor's status as of an instant, from their append-only history.
 *
 * @param {object[]} history  [{ status, effective_from }], any order
 * @param {Date|string|number} at
 * @returns {{ status: string|null, effective_from: Date|null }}
 *
 * Returns a null status when the history begins after `at` — the realtor did
 * not exist, in any status, at that instant. The caller treats that as not
 * eligible, which is the safe direction: an entitlement is never created for
 * somebody the system cannot place.
 */
const statusAt = (history, at) => {
  const when = new Date(at).getTime();
  if (!Number.isFinite(when)) return { status: null, effective_from: null };

  let current = null;
  (history || []).forEach((entry) => {
    const from = new Date(entry.effective_from).getTime();
    if (!Number.isFinite(from) || from > when) return;
    // The latest transition at or before `at` wins. Two transitions sharing a
    // timestamp resolve by the later id, which the caller supplies pre-sorted;
    // here `>=` keeps the last one seen.
    if (!current || from >= new Date(current.effective_from).getTime()) current = entry;
  });

  return current
    ? { status: current.status, effective_from: new Date(current.effective_from) }
    : { status: null, effective_from: null };
};

/**
 * Whether this realtor may accrue or receive at this instant, and the record of
 * having asked (FR-ELG-011).
 *
 * The returned `check` is stored on the entitlement whether it passed or
 * failed. A forfeiture that cannot be explained without re-running the engine
 * is a forfeiture a realtor will dispute and finance cannot defend, so the
 * status, its effective date and the instant it was evaluated against are all
 * kept — see §5.8.
 */
const checkEligibility = (realtor, at, phase = 'accrual') => {
  const evaluatedAt = new Date(at);
  const { status, effective_from } = statusAt(realtor?.status_history, evaluatedAt);
  const eligible = status === ACTIVE;

  return {
    eligible,
    check: {
      phase,                                  // 'accrual' | 'release'
      realtor_id: realtor?.id ?? null,
      status,
      status_effective_from: effective_from ? effective_from.toISOString() : null,
      evaluated_at: evaluatedAt.toISOString(),
      result: eligible ? 'PASS' : 'FAIL',
      reason: eligible ? null : EXCLUSION.INELIGIBLE,
    },
  };
};

/**
 * Partitions a participant set into those who may earn and those who may not
 * (pipeline step 5h).
 *
 * Every role is gated identically — direct seller, co-agent, referrer and every
 * generational upline (FR-ELG-005) — and each is evaluated independently, so
 * one participant's suspension never changes another's outcome. An excluded
 * participant has no amount computed for them at all: they are recorded as a
 * forfeiture trace, not as a zero entitlement, because zero is a figure someone
 * might reasonably read as "the rules paid them nothing" rather than "they were
 * not allowed to be paid".
 */
const gateParticipants = (participants, at) => {
  const eligible = [];
  const excluded = [];

  (participants || []).forEach((participant) => {
    const { eligible: ok, check } = checkEligibility(participant.realtor, at, 'accrual');
    if (ok) eligible.push({ ...participant, eligibility_check: check });
    else {
      excluded.push({
        realtor_id: participant.realtor?.id ?? null,
        role: participant.role,
        generation: participant.generation ?? null,
        reason: EXCLUSION.INELIGIBLE,
        eligibility_check: check,
      });
    }
  });

  return { eligible, excluded };
};

module.exports = { ACTIVE, statusAt, checkEligibility, gateParticipants };
