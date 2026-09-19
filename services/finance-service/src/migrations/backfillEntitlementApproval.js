const { QueryTypes } = require('sequelize');
const { columnsOf } = require('../../../../shared/src/dialect');

/**
 * Approves every entitlement that was already released before approval existed.
 *
 * ── Why they are approved rather than left pending ──────────────────────────
 *
 * Requesting a payout now requires an administrator's approval. Applied to the
 * rows already in the table, that rule would retrospectively withdraw money
 * realtors can see in their wallet today and have been told is theirs — a
 * balance that was requestable yesterday would refuse them this morning, for a
 * reason that did not exist when it was released.
 *
 * So the rule binds from here forward. Anything the company had already
 * RELEASED, PAID or is HOLDING before the column arrived is treated as signed
 * off, which is the truthful reading: it got that far under the rules in force
 * at the time, and in the case of PAID the money has already gone.
 *
 * Entitlements still ACCRUED are left alone. Nobody could request those
 * yesterday either, so there is nothing to preserve and they join the new flow
 * where it starts. FORFEITED, REVERSED and CANCELLED are left alone too —
 * approving them would offer an administrator a sign-off on money that is not
 * going anywhere.
 *
 * ── Why it only runs once ───────────────────────────────────────────────────
 *
 * An administrator may decline a commission after this, and a migration that
 * re-approved on every boot would quietly undo them. The marker is written on
 * success and the rows are never touched again.
 */
const MARKER_GROUP = 'migrations';
/*
 * v2. The first version of this listed only RELEASED and PARTIALLY_RELEASED,
 * and missed PAID — so a commission the company had already paid came out of
 * the migration unapproved, and every screen that reads approval reported it
 * as awaiting sign-off. Bumping the key is what lets the corrected version run
 * on a database the narrow one has already marked done.
 */
const MARKER_KEY = 'entitlement_approval_backfilled_v2';

const quoted = (sequelize) => {
  const pg = sequelize.getDialect() === 'postgres';
  return {
    group: pg ? '"group"' : '`group`',
    key: pg ? '"key"' : '`key`',
    value: pg ? '"value"' : '`value`',
  };
};

module.exports = async function backfillEntitlementApproval(sequelize) {
  const q = quoted(sequelize);
  try {
    const columns = await columnsOf(sequelize, 'commission_entitlements');
    // Nothing to do on a database that has not reached this schema yet; the
    // column is added by createCommissionEngine on the same boot, before this.
    if (!columns || !columns.has('approved_at')) return;

    const done = await sequelize.query(
      `SELECT 1 FROM settings WHERE ${q.group} = :group AND ${q.key} = :key LIMIT 1`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.SELECT },
    );
    if (done.length) return;

    await sequelize.query(
      `UPDATE commission_entitlements
          SET approved_at = COALESCE(released_at, created_at)
        WHERE approved_at IS NULL
          AND status IN ('RELEASED', 'PARTIALLY_RELEASED', 'PAID', 'HELD')`,
      { type: QueryTypes.UPDATE },
    );

    const [{ n }] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM commission_entitlements WHERE approved_at IS NOT NULL',
      { type: QueryTypes.SELECT },
    );

    const settingColumns = (await columnsOf(sequelize, 'settings')) || new Map();
    const extra = ['created_at', 'updated_at'].filter((column) => settingColumns.has(column));
    await sequelize.query(
      `INSERT INTO settings (${q.group}, ${q.key}, ${q.value}, company_id${extra.length ? `, ${extra.join(', ')}` : ''})
       VALUES (:group, :key, 'done', NULL${extra.map(() => ', NOW()').join('')})`,
      { replacements: { group: MARKER_GROUP, key: MARKER_KEY }, type: QueryTypes.INSERT },
    );

    console.log(`[commission] ${n ?? 0} already-released entitlement(s) marked approved — `
      + 'approval binds from here forward, not retrospectively.');
  } catch (error) {
    // Best effort, like the migrations beside it. The marker is written only on
    // success, so a failure is retried on the next boot rather than lost.
    console.error(`[commission] approval backfill failed: ${error.message}`);
  }
};
