const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * Whether a realtor level's `commission_percentage` actually decides anything.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * Two tables answered "what does a Premium realtor earn?". `realtor_levels`
 * carries a `commission_percentage`, which is what the realtor is shown on
 * their dashboard and what an administrator edits on the Realtor Levels
 * screen. The flat-rate generator never read it: it looks up
 * `commission_rules`, a different table keyed by level. So a company could
 * display 12% and pay 10%, or display 12% and pay nothing at all, and neither
 * screen said a word about the other.
 *
 * ── Why the fix is an opt-in and not a fallback ─────────────────────────────
 *
 * The obvious repair is to let the generator fall back to the level's rate
 * when no rule matches. That would be a silent change of behaviour in the
 * worst possible direction: every company that has configured no commission
 * rules pays nothing today, and would begin paying a percentage of every
 * completed sale on the day it shipped, without anybody deciding anything.
 *
 * Commission is money leaving the company. Nothing here may start paying
 * because a default was left in place — a company has to say so. So:
 *
 *   OFF (the default, and what every existing company has):
 *       the level's rate decides nothing on the flat-rate path. No rule, no
 *       commission, exactly as before.
 *
 *   ON:
 *       an explicit commission rule still wins where one matches; where none
 *       does, the realtor's own level rate applies, and the commission records
 *       that this is where its rate came from.
 *
 * The engine path is different and needs no opt-in: a company that has
 * ACTIVATED a plan version has already said what pays, and the engine reads
 * `commission_percentage` as part of that plan. Activating a plan is the
 * opt-in.
 *
 * ── Why "in force" is reported rather than just the number ──────────────────
 *
 * The dashboard's job is to tell a realtor what they earn. A number that
 * decides nothing is worse than no number, because it is indistinguishable
 * from one that does. Every reader of the rate gets `in_force` and `source`
 * beside it, so a screen can say "set by your commission rules" rather than
 * quote a figure that will not be paid.
 */

const SETTINGS_GROUP = 'commission';
const SETTINGS_KEY = 'use_level_rate';

/** Anything but an explicit yes is no. A mistyped setting must not start paying. */
const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Has this company opted in to paying its levels' rates on the flat-rate path?
 *
 * Fails CLOSED. Every other settings lookup in this codebase falls back to its
 * built-in on error because the built-in is harmless; the harmless answer here
 * is "do not pay", so an unreadable setting means off.
 */
const levelRateOptIn = async (sequelize, companyId) => {
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
    // A company's own answer wins, including a company that has turned OFF
    // something the platform turned on.
    if (own) return truthy(own.value);
    return truthy(platform?.value);
  } catch (error) {
    console.error('[level-rate] opt-in lookup failed, treating as off:', error.message);
    return false;
  }
};

/**
 * What a realtor's level rate means for them right now.
 *
 * @returns {{ percentage: number|null, in_force: boolean, source: string }}
 *   source is 'plan' (an activated commission plan reads it),
 *   'level' (the flat-rate opt-in is on), or 'rules' (it decides nothing —
 *   commission_rules does).
 */
const levelRateStatus = async (sequelize, { companyId, percentage }) => {
  const rate = percentage === null || percentage === undefined ? null : Number(percentage);

  /*
   * An active plan means the engine pays, and the engine reads the level rate.
   * Asked with the same resolution the engine uses rather than "does a plan row
   * exist", so a plan whose effective period has lapsed is not mistaken for one
   * in force — the same care commissionBridge takes for the same reason.
   */
  try {
    // Required lazily: commissionStore reaches for models this module's callers
    // may not have loaded, and a top-level require would pull them in on boot.
    // eslint-disable-next-line global-require
    const { resolvePlanVersion } = require('./commissionStore');
    const planVersion = await resolvePlanVersion(sequelize, {
      companyId: companyId ?? null, propertyId: null, at: new Date(),
    });
    if (planVersion && !planVersion.unreadable) {
      return { percentage: rate, in_force: true, source: 'plan' };
    }
  } catch (error) {
    console.error('[level-rate] plan lookup failed:', error.message);
  }

  if (await levelRateOptIn(sequelize, companyId)) {
    return { percentage: rate, in_force: true, source: 'level' };
  }

  /*
   * The number is still returned. An administrator editing the ladder needs to
   * see what they typed, and hiding it would make the field look broken —
   * `in_force` is what tells a screen not to present it as what the realtor
   * earns.
   */
  return { percentage: rate, in_force: false, source: 'rules' };
};

module.exports = {
  levelRateOptIn, levelRateStatus, SETTINGS_GROUP, SETTINGS_KEY,
};
