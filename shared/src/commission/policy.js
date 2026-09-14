/**
 * The five choices the FRD makes twice, gathered in one place.
 *
 * Each of these is a point where the document contradicts itself, or where it
 * settles a question that different companies settle differently. The engine
 * used to answer each one for everybody — reasonably, but by fiat. It now reads
 * the answer off the plan.
 *
 * ── Every default reproduces what the engine did before ─────────────────────
 *
 * A plan written yesterday has none of these keys, and has to keep meaning
 * exactly what it meant. So the defaults are not the "best" answers; they are
 * the previous answers. Choosing differently is an act somebody performs in the
 * plan editor, recorded in a version, and visible in the trace.
 *
 * ── Why they are read here and not at each use site ─────────────────────────
 *
 * Because a setting read in two places eventually disagrees with itself. The
 * release path and the validator both need to know whether partial releases are
 * allowed; the base and the reporting layer both need to know whether penalties
 * are commissionable. One reader, one set of defaults, one place to look when
 * somebody asks what a plan actually does.
 */

/** Does an inactive status withhold money, or only record that it was noticed? */
const GATE = {
  /**
   * AC-011's reading. An inactive realtor does not receive what falls due while
   * they are inactive, and that value is disposed of by the plan's forfeiture
   * disposition.
   */
  ENFORCE: 'ENFORCE',
  /**
   * §7.9's reading, and a legitimate policy in its own right. The check still
   * runs and is still recorded on the entitlement, so the history is identical
   * — but the money is released anyway. A company that treats suspension as an
   * administrative state rather than a financial penalty wants this, and until
   * now could not have it.
   */
  ADVISORY: 'ADVISORY',
};

/** How much is lost when the gate does bite. */
const LAPSE_SCOPE = {
  /**
   * Only what fell due while they were inactive. A reinstatement then resumes
   * the ordinary schedule, because there is still something to resume.
   */
  INCREMENT: 'INCREMENT',
  /**
   * The whole unreleased balance, on the first missed checkpoint. Harsher, and
   * genuinely what some companies mean by forfeiture — the entitlement is gone,
   * not paused.
   */
  REMAINING: 'REMAINING',
};

/** Whether a trigger may release part of an entitlement at all. */
const PARTIAL_RELEASE = {
  ALLOW: 'ALLOW',
  /**
   * A company whose accounting cannot represent a part-paid commission. With
   * FORBID, a plan carrying a partial-releasing trigger fails validation rather
   * than producing rows its own books cannot describe.
   */
  FORBID: 'FORBID',
};

/** The triggers that can release less than the whole entitlement. */
const PARTIAL_TRIGGERS = ['PRO_RATA', 'MILESTONE', 'SCHEDULED'];

const DEFAULTS = {
  gate: GATE.ENFORCE,
  lapse_scope: LAPSE_SCOPE.INCREMENT,
  /**
   * §5.11 over §10.3. A cancellation penalty is not consideration for a sale —
   * it is a charge for one that did not happen — so it is outside the base by
   * default. A company that reads §10.3 literally, and pays its realtors for
   * collecting the penalty, sets this true.
   */
  penalties_commissionable: false,
  partial_release: PARTIAL_RELEASE.ALLOW,
  /**
   * What a plan vests on when it does not say. ON_FULL_PAYMENT is what the flat
   * rate path did, so a company arriving from it sees the same TIMING and a
   * different structure rather than both changing at once.
   */
  default_release_trigger: 'ON_FULL_PAYMENT',
};

/**
 * The policy in force for a plan.
 *
 * `inherited` is the company default plan's policy, where the plan being read
 * is a narrower one. A property-scoped plan that says nothing about vesting
 * should follow the company's answer rather than the engine's — otherwise
 * setting a company-wide trigger silently fails to apply to exactly the
 * properties somebody cared enough about to scope a plan to.
 */
const policyFor = (plan = {}, inherited = null) => {
  const own = plan.policy || {};
  const eligibility = plan.eligibility || {};
  const vesting = plan.vesting || plan.release || {};
  const base = plan.commissionable_base || {};
  const up = inherited || {};

  const pick = (value, inheritedValue, fallback) => {
    if (value !== undefined && value !== null) return value;
    if (inheritedValue !== undefined && inheritedValue !== null) return inheritedValue;
    return fallback;
  };

  return {
    gate: pick(own.gate ?? eligibility.gate, up.gate, DEFAULTS.gate),
    lapse_scope: pick(own.lapse_scope ?? eligibility.lapse_scope, up.lapse_scope, DEFAULTS.lapse_scope),
    penalties_commissionable: pick(
      own.penalties_commissionable ?? base.include_penalties,
      up.penalties_commissionable,
      DEFAULTS.penalties_commissionable,
    ),
    partial_release: pick(
      own.partial_release ?? vesting.partial_release,
      up.partial_release,
      DEFAULTS.partial_release,
    ),
    /**
     * The trigger itself, not merely a default for one: a scoped plan with no
     * trigger of its own follows the company plan's, then the engine's.
     */
    release_trigger: pick(
      vesting.release_trigger ?? plan.release_trigger,
      up.release_trigger,
      DEFAULTS.default_release_trigger,
    ),
  };
};

/** Whether a trigger can release part of an entitlement. */
const isPartialTrigger = (trigger) => PARTIAL_TRIGGERS.includes(String(trigger));

module.exports = {
  GATE, LAPSE_SCOPE, PARTIAL_RELEASE, PARTIAL_TRIGGERS, DEFAULTS,
  policyFor, isPartialTrigger,
};
