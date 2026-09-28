/**
 * Change when commission becomes payable, on every live plan.
 *
 * ── Why a script and not an UPDATE ──────────────────────────────────────────
 *
 * A deal resolves the plan version in force at its ATTRIBUTION DATE, and the
 * entitlement stores that version id. Editing a live version in place therefore
 * restates what already-computed deals were paid from — the figures move under
 * commissions that have already been requested, approved, or paid.
 *
 * So this does what the application does: writes a NEW version, validates it,
 * and activates it inside one transaction that closes the outgoing version at
 * the same instant. Two versions can never overlap, which is what decides a
 * deal's version. Existing entitlements keep the version they resolved to;
 * only deals attributed from now on see the new trigger.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/set-release-trigger.js                      # dry run, PRO_RATA
 *   node scripts/set-release-trigger.js ON_INITIAL_DEPOSIT   # dry run, that one
 *   node scripts/set-release-trigger.js PRO_RATA --apply     # write it
 *
 * It acts on whatever database the environment points at, so the same command
 * works against staging with staging's credentials in the environment. Dry run
 * is the default deliberately: this changes what the company pays and when.
 *
 * ── The triggers ────────────────────────────────────────────────────────────
 *
 *   ON_DEAL_CONFIRMATION  the whole thing, as soon as the deal is confirmed
 *   ON_INITIAL_DEPOSIT    the whole thing, once any money has arrived
 *   ON_THRESHOLD          once receipts pass a percentage of the price
 *   PRO_RATA              in step with the buyer: 40% paid, 40% payable
 *   ON_FULL_PAYMENT       nothing until the buyer has paid in full
 *   MILESTONE             against named milestones
 *   SCHEDULED             on a fixed schedule after confirmation
 *
 * PRO_RATA releases only as the buyer pays, so a sale that stalls halfway has
 * paid out halfway — which is the point. ON_INITIAL_DEPOSIT releases the whole
 * commission on a deposit and leaves you recovering it if the deal collapses.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../services/finance-service/src/models');
const { validatePlan } = require('../shared/src/commission/validate');
const { ENGINE_VERSION } = require('../shared/src/commissionStore');
const { TRIGGERS } = require('../shared/src/commission/vesting');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TRIGGER = args.find((a) => !a.startsWith('--')) || 'PRO_RATA';

const main = async () => {
  if (!TRIGGERS.includes(TRIGGER)) {
    console.error(`Unknown trigger "${TRIGGER}". One of: ${TRIGGERS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const live = await sequelize.query(
    `SELECT v.id, v.plan_id, v.company_id, v.version, v.config, p.name
       FROM commission_plan_versions v
       JOIN commission_plans p ON p.id = v.plan_id
      WHERE v.status = 'active' AND v.effective_to IS NULL
      ORDER BY v.plan_id`,
    { type: QueryTypes.SELECT },
  );

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — target ${TRIGGER} — ${live.length} live version(s)\n`);
  if (!live.length) {
    console.log('  Nothing to change.\n');
    return;
  }

  for (const row of live) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const before = config.vesting?.release_trigger || '(company default)';
    const label = `plan ${row.plan_id} "${row.name}"`;

    if (before === TRIGGER) {
      console.log(`  ${label}: already ${TRIGGER}, skipped`);
      continue;
    }

    const next = { ...config, vesting: { ...(config.vesting || {}), release_trigger: TRIGGER } };
    const verdict = validatePlan(next, { realtor_levels: [] });
    if (verdict.errors.length) {
      // Refused rather than skipped quietly: a plan that cannot be calculated
      // must never start paying, and the reason belongs on screen.
      console.log(`  ${label}: REFUSED — ${verdict.errors.map((e) => e.message || e.code).join('; ')}`);
      continue;
    }

    console.log(`  ${label}: ${before} -> ${TRIGGER}`);
    if (!APPLY) continue;

    const [{ nextVersion }] = await sequelize.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM commission_plan_versions WHERE plan_id = :planId',
      { replacements: { planId: row.plan_id }, type: QueryTypes.SELECT },
    );
    const from = new Date();

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `INSERT INTO commission_plan_versions
           (plan_id, company_id, version, effective_from, status, config, engine_version, created_by, created_at)
         VALUES (:planId, :companyId, :version, :from, 'active', :config, :engine, NULL, NOW())`,
        {
          replacements: {
            planId: row.plan_id,
            companyId: row.company_id,
            version: nextVersion,
            from,
            config: JSON.stringify(next),
            engine: ENGINE_VERSION,
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      );

      // Close the outgoing version at the instant the new one begins. Any
      // overlap would make which version a deal resolves an accident of
      // ordering.
      await sequelize.query(
        'UPDATE commission_plan_versions SET effective_to = :from WHERE id = :oldId',
        { replacements: { from, oldId: row.id }, type: QueryTypes.UPDATE, transaction },
      );

      const [{ newId }] = await sequelize.query(
        'SELECT MAX(id) AS newId FROM commission_plan_versions WHERE plan_id = :planId',
        { replacements: { planId: row.plan_id }, type: QueryTypes.SELECT, transaction },
      );
      await sequelize.query(
        `UPDATE commission_plans SET current_version_id = :newId, status = 'active', updated_at = NOW()
          WHERE id = :planId`,
        { replacements: { newId, planId: row.plan_id }, type: QueryTypes.UPDATE, transaction },
      );

      console.log(`      version ${nextVersion} is live (id ${newId}); version ${row.version} closed`);
    });
  }

  if (!APPLY) console.log('\n  Nothing was written. Re-run with --apply to make these changes.');
  console.log('\n  Entitlements already accrued keep the version they resolved to.\n');
};

main()
  .catch((error) => { console.error('FAILED:', error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
