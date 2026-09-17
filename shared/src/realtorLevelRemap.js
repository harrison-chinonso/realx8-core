const { QueryTypes } = require('sequelize');
const { tableExists } = require('./dialect');

/**
 * Moving a company off the platform's rungs and onto its own.
 *
 * ── Why this is more than an UPDATE on users ───────────────────────────────
 *
 * When a company customises the shipped ladder it gets its own copy, and the
 * copies have new ids. Every row that named the old id is now pointing at a
 * rung that company no longer uses, and none of those rows announce
 * themselves: nothing errors, nothing looks wrong, the figures just quietly
 * stop being the figures the company configured.
 *
 * There are four such places, and the one that costs money is the last:
 *
 *   users.realtor_level_id            a realtor's standing — the visible one
 *   commission_rules.realtor_level_id a flat-rate rule pinned to a level
 *   realtor_level_requests            a pending upgrade, by id and by name
 *   commission_plan_versions.config   per-level rates inside the plan JSON
 *
 * Miss the plan config and a company that had Premium on 4% and Ambassador on
 * 6% falls back to the plan's flat rate for everybody, on the next sale, with
 * no error anywhere. That is why this exists as one function rather than as
 * four updates written at the call site: the fifth place, when somebody adds
 * one, has a single obvious home.
 *
 * ── Scoped to the company, always ──────────────────────────────────────────
 *
 * Other companies are still on the platform rungs. Every statement here is
 * filtered by company, because an unscoped UPDATE would drag every tenant onto
 * one company's private ladder.
 *
 * ── Crossing into finance ──────────────────────────────────────────────────
 *
 * commission_plan_versions belongs to finance-service and the caller is
 * user-service. One database, the same crossing realtorVerification.js and
 * realtorLevel.js already make, and it has to join the caller's transaction so
 * the ladder and the rates it prices commit together. Guarded by tableExists
 * so a deployment without the commission engine is unaffected rather than
 * broken.
 */

/**
 * Repoint everything this company owns from the old level ids to the new.
 *
 * @param sequelize
 * @param {object} args
 *   companyId  whose rows to move. Required — there is no unscoped form.
 *   mapping    Map or plain object of old level id → new level id
 *   names      optional Map of new level id → its name, to refresh the
 *              denormalised name on a pending upgrade request
 *   transaction the caller's transaction
 * @returns {Promise<object>} a count per table, for the caller to log or assert
 */
const remapLevelIds = async (sequelize, {
  companyId, mapping, names = new Map(), transaction = null,
} = {}) => {
  const pairs = [...(mapping instanceof Map ? mapping : new Map(Object.entries(mapping || {})))]
    .map(([from, to]) => [Number(from), Number(to)])
    .filter(([from, to]) => from && to && from !== to);

  const moved = {
    users: 0, commission_rules: 0, level_requests: 0, plan_versions: 0,
  };
  if (!companyId || !pairs.length) return moved;

  for (const [from, to] of pairs) {
    const scope = { from, to, companyId };

    const [, users] = await sequelize.query(
      `UPDATE users SET realtor_level_id = :to
        WHERE realtor_level_id = :from AND company_id = :companyId`,
      { replacements: scope, type: QueryTypes.UPDATE, transaction },
    );
    moved.users += Number(users) || 0;

    if (await tableExists(sequelize, 'commission_rules')) {
      const [, rules] = await sequelize.query(
        `UPDATE commission_rules SET realtor_level_id = :to
          WHERE realtor_level_id = :from AND company_id = :companyId`,
        { replacements: scope, type: QueryTypes.UPDATE, transaction },
      ).catch(() => [null, 0]);
      moved.commission_rules += Number(rules) || 0;
    }

    /*
     * Pending requests only. A decided request is history — repointing it
     * would rewrite what was actually approved last March, and its stored
     * level NAME is what anybody reading it back actually wants.
     */
    const name = names.get(to) ?? names.get(String(to)) ?? null;
    const [, requested] = await sequelize.query(
      `UPDATE realtor_level_requests
          SET requested_level_id = :to
              ${name ? ', requested_level_name = :name' : ''}
        WHERE requested_level_id = :from AND company_id = :companyId AND status = 'pending'`,
      { replacements: { ...scope, name }, type: QueryTypes.UPDATE, transaction },
    );
    const [, current] = await sequelize.query(
      `UPDATE realtor_level_requests
          SET current_level_id = :to
              ${name ? ', current_level_name = :name' : ''}
        WHERE current_level_id = :from AND company_id = :companyId AND status = 'pending'`,
      { replacements: { ...scope, name }, type: QueryTypes.UPDATE, transaction },
    );
    moved.level_requests += (Number(requested) || 0) + (Number(current) || 0);
  }

  moved.plan_versions = await remapPlanConfigs(sequelize, { companyId, pairs, transaction });
  return moved;
};

/**
 * The per-level rates buried in a commission plan's JSON.
 *
 * Rewritten in JavaScript rather than SQL: the ids sit inside
 * `rules[].level_rates[].level_id`, and reaching them with string surgery
 * across two dialects is a worse bet than parsing, editing and writing back
 * the handful of rows a company has.
 *
 * A config that will not parse is left exactly as it was. It is already
 * broken, and a half-rewritten one would be harder to recover than an
 * untouched one.
 */
const remapPlanConfigs = async (sequelize, { companyId, pairs, transaction }) => {
  if (!await tableExists(sequelize, 'commission_plan_versions')) return 0;

  const lookup = new Map(pairs);
  let changed = 0;

  const rows = await sequelize.query(
    `SELECT id, config FROM commission_plan_versions
      WHERE company_id = :companyId AND config IS NOT NULL`,
    { replacements: { companyId }, type: QueryTypes.SELECT, transaction },
  ).catch(() => []);

  for (const row of rows) {
    let config;
    try {
      config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch {
      continue;
    }
    if (!config || !Array.isArray(config.rules)) continue;

    let touched = false;
    config.rules.forEach((rule) => {
      if (!Array.isArray(rule?.level_rates)) return;
      rule.level_rates.forEach((entry) => {
        const next = lookup.get(Number(entry?.level_id));
        if (next) { entry.level_id = next; touched = true; }
      });
    });
    if (!touched) continue;

    await sequelize.query(
      'UPDATE commission_plan_versions SET config = :config WHERE id = :id',
      {
        replacements: { config: JSON.stringify(config), id: row.id },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );
    changed += 1;
  }

  return changed;
};

module.exports = { remapLevelIds };
