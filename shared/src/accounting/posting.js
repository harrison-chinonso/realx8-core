const { QueryTypes } = require('sequelize');
const { q } = require('../dialect');
const { post } = require('./ledger');
const rules = require('./rules');

/**
 * Turning a business event into a journal (ACC-3).
 *
 * ── Off until a company turns it on ─────────────────────────────────────────
 *
 * Nothing posts unless the company has asked for it. Not caution for its own
 * sake: the PRD's mitigation for the biggest risk in the programme is a
 * PARALLEL RUN — post alongside the existing flow, reconcile the AR control
 * against open invoices and the bank against `transactions`, and do not retire
 * anything until they agree for a month. A switch is what makes a parallel run
 * possible at all, and it is what lets a tenant be moved onto the ledger one
 * at a time rather than all at once.
 *
 * It is also the same shape the commission engine already uses: a company with
 * an active plan is on the engine, one without keeps the flat rate. Nobody had
 * to be migrated and nobody was surprised.
 *
 * ── Never throws, and why that is the right call HERE ───────────────────────
 *
 * Every caller is in the middle of something that matters more: a payment
 * being approved, an invoice being raised, a commission being paid. A journal
 * that cannot be written must not roll back the money that has already moved.
 *
 * That is the opposite of the rule inside `post()`, which refuses an
 * unbalanced entry outright — and the two are consistent: `post` refuses to
 * write something WRONG, this refuses to break something RIGHT. A failure here
 * is logged loudly and leaves the ledger short an entry, which the trial
 * balance and the period-close checklist are there to catch.
 */

const SETTINGS_GROUP = 'accounting';
const SETTINGS_KEY = 'post_to_ledger';

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Is this company posting?
 *
 * Fails CLOSED. An unreadable setting means "not posting", which leaves the
 * ledger incomplete and visible rather than half-populated and trusted.
 */
const postingEnabled = async (sequelize, companyId) => {
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')}, company_id FROM settings
        WHERE ${q(sequelize, 'group')} = :group AND ${q(sequelize, 'key')} = :key
          AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
      {
        replacements: { group: SETTINGS_GROUP, key: SETTINGS_KEY, companyId: companyId ?? null },
        type: QueryTypes.SELECT,
      },
    );
    const own = rows.find((row) => row.company_id != null);
    const platform = rows.find((row) => row.company_id == null);
    if (own) return truthy(own.value);
    return truthy(platform?.value);
  } catch (error) {
    console.error(`[accounting] could not read the posting switch: ${error.message}`);
    return false;
  }
};

/**
 * The revenue recognition policy for a property (ACC-8.2).
 *
 * ── Three tiers, narrowest first ────────────────────────────────────────────
 *
 * The property's own policy, then one for every property of its type, then the
 * company's default. A single company-wide switch would be wrong: the same
 * developer sells off-plan units, completed units and bare land on different
 * contractual terms, and under IFRS 15 the answer depends on the contract.
 *
 * ── Unanswered means deferred ───────────────────────────────────────────────
 *
 * Nothing configured, an unreadable table, a property that does not exist —
 * every one of them lands on ON_HANDOVER. That is the conservative answer and
 * deliberately so: the unsafe direction here is also the flattering one, since
 * recognising early reports a completed sale on a hole in the ground. A rule
 * that fails towards the flattering answer is a rule that will be found
 * failing at an audit rather than in testing.
 */
const recognitionFor = async (sequelize, { propertyId, companyId }) => {
  try {
    const rows = await sequelize.query(
      `SELECT p.scope, p.revenue_recognition
         FROM accounting_policies p
         LEFT JOIN properties prop ON prop.id = :propertyId
        WHERE p.revenue_recognition IS NOT NULL
          AND p.company_id ${companyId ? '= :companyId' : 'IS NULL'}
          AND (
            (p.scope = 'property'      AND p.property_id = :propertyId)
         OR (p.scope = 'property_type' AND p.property_type = prop.type)
         OR (p.scope = 'company')
          )`,
      {
        replacements: { propertyId: propertyId ?? null, companyId: companyId ?? null },
        type: QueryTypes.SELECT,
      },
    );
    const rank = { property: 0, property_type: 1, company: 2 };
    const [best] = [...rows].sort((a, b) => rank[a.scope] - rank[b.scope]);
    if (best?.revenue_recognition && rules.RECOGNITION[best.revenue_recognition]) {
      return rules.RECOGNITION[best.revenue_recognition];
    }
  } catch (error) {
    // The table arrives with ACC-8's migration; before it exists, and if it
    // is ever unreadable, the default below is the answer.
    console.error(`[accounting] recognition policy unreadable, deferring: ${error.message}`);
  }
  return rules.RECOGNITION.ON_HANDOVER;
};

/**
 * Post one event, if this company is posting.
 *
 * @param sequelize
 * @param {object} event
 *   rule        which rule in rules.RULES
 *   companyId   whose books
 *   entryDate   the ACCOUNTING date — the event's own date, never today's
 *   source      what the journal will say caused it
 *   sourceId    its reference
 *   memo        a sentence for a person
 *   createdBy   the acting user, or null for an unattended posting
 *   input       whatever the rule needs
 * @param {object} options { transaction }
 */
const postEvent = async (sequelize, event, { transaction = null } = {}) => {
  const {
    rule, companyId = null, entryDate, source, sourceId = null,
    memo = null, createdBy = null, input = {},
  } = event;

  try {
    if (!await postingEnabled(sequelize, companyId)) {
      return { skipped: 'posting_disabled' };
    }

    const build = rules.RULES[rule];
    if (!build) {
      console.error(`[accounting] no posting rule named ${rule}`);
      return { skipped: 'no_such_rule' };
    }

    const lines = build(input);
    if (!lines.length) return { skipped: 'nothing_to_post' };

    /*
     * Asserted here as well as inside post(). The rules balance by
     * construction, so this can only fire if one has been changed badly — and
     * catching it beside the rule names the rule, where catching it at the
     * ledger door names only the entry.
     */
    const imbalance = rules.imbalanceOf(lines);
    if (imbalance !== 0) {
      console.error(
        `[accounting] rule '${rule}' produced an unbalanced entry (out by ${imbalance} minor units). `
        + 'Nothing was posted.',
      );
      return { skipped: 'rule_unbalanced', imbalance };
    }

    return await post(sequelize, {
      companyId, entryDate, source, sourceId, memo, createdBy, lines,
    }, { transaction });
  } catch (error) {
    /*
     * A closed period is not a failure of this module — it is a decision
     * somebody made, and the caller has a person in front of them who can act
     * on it. Distinguished from a genuine error so the message reaching them
     * says what to do (reopen the period, or date the entry honestly) rather
     * than "something went wrong".
     *
     * Still not thrown: the payment has been approved, the bill committed,
     * the handover recorded. A journal that cannot be written must not undo a
     * business event that already happened.
     */
    if (error.code === 'PERIOD_CLOSED') {
      console.error(`[accounting] ${source} ${sourceId ?? ''} refused: ${error.message}`);
      return { skipped: 'period_closed', message: error.message, period: error.period };
    }
    console.error(`[accounting] ${source} ${sourceId ?? ''} did not post: ${error.message}`);
    return { skipped: 'error', error: error.message };
  }
};

module.exports = {
  postEvent, postingEnabled, recognitionFor, SETTINGS_GROUP, SETTINGS_KEY,
};
