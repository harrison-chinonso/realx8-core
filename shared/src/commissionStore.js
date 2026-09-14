const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { isDuplicateError } = require('./dialect');
const { asMinor } = require('./money');
const { historyFor } = require('./realtorStatus');
const { calculate, checkRelease, ROLE } = require('./commission');

/**
 * Everything the commission engine needs from, and gives back to, the database.
 *
 * shared/src/commission/ is a pure function of (deal, plan version, genealogy,
 * status history). This is the half that knows where those come from and what
 * to do with the answer — deliberately the only half that does, so the
 * arithmetic stays testable without a database and the simulator can run the
 * identical code without writing anything (FR-SIM-005).
 */

/** Bumped when the engine's behaviour changes; recorded on every version used. */
const ENGINE_VERSION = '1.0.0';

// ── Reading the configuration ───────────────────────────────────────────────

/**
 * The plan version in force for a deal (pipeline step 2).
 *
 * Selected by the deal's ATTRIBUTION DATE, never by "now" (§5.6). That single
 * choice is what stops a plan change silently restating what historical deals
 * paid, and it is why the version's config is stored as an immutable document
 * rather than assembled from rows that may since have moved on.
 *
 * Precedence follows §9 as far as Phase 1 goes: a plan scoped to this property,
 * then its project, then the company default. The remaining levels (campaign,
 * property type, realtor segment) resolve through the same query the moment a
 * plan is given that scope, because the ordering is expressed in the ORDER BY
 * rather than in branches.
 */
const resolvePlanVersion = async (sequelize, { companyId, propertyId, projectId, at }) => {
  const rows = await sequelize.query(
    `SELECT v.id, v.plan_id, v.version, v.config, v.engine_version, v.effective_from,
            p.name AS plan_name, p.scope_type, p.scope_id, p.is_default
       FROM commission_plan_versions v
       JOIN commission_plans p ON p.id = v.plan_id
      WHERE v.status = 'active'
        AND p.status = 'active'
        AND (p.company_id ${companyId == null ? 'IS NULL' : '= :companyId'})
        AND v.effective_from <= :at
        AND (v.effective_to IS NULL OR v.effective_to > :at)
        AND (
          (p.scope_type = 'property' AND p.scope_id = :propertyId)
          OR (p.scope_type = 'project' AND p.scope_id = :projectId)
          OR (p.scope_type IS NULL AND p.is_default IS TRUE)
        )
      ORDER BY
        CASE p.scope_type WHEN 'property' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
        v.effective_from DESC,
        v.id DESC`,
    {
      replacements: {
        companyId: companyId ?? null,
        propertyId: propertyId ?? -1,
        projectId: projectId ?? -1,
        at: new Date(at),
      },
      type: QueryTypes.SELECT,
    },
  );

  const row = rows[0];
  if (!row) return null;

  let config = null;
  try {
    config = JSON.parse(row.config);
  } catch {
    // A version whose document cannot be read must not silently pay nothing —
    // the caller raises it as an exception and the deal is quarantined
    // (FR-CLC-007).
    return { id: row.id, unreadable: true, plan_name: row.plan_name };
  }

  return {
    ...config,
    id: row.id,
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    version: row.version,
    engine_version: row.engine_version,
  };
};

// ── Reading the people ──────────────────────────────────────────────────────

/**
 * The upline chain above a realtor, nearest first.
 *
 * Walked one generation at a time through `users.realtor_id` rather than read
 * from a materialised path. The FRD asks for a path column for O(1) lookup
 * (§6.1), and that is the right answer at scale — but it is a column that must
 * be maintained transactionally on every placement change, and getting that
 * wrong corrupts the genealogy silently. The walk costs one query per
 * generation, is capped, and is correct by construction; the path is an
 * optimisation to add when the depth or the volume justifies it.
 *
 * Cycle-guarded because `realtor_id` is admin-editable and a loop is therefore
 * possible — referralController walks the same graph with the same guard.
 */
const MAX_DEPTH = 12;

const uplineOf = async (sequelize, realtorId) => {
  const chain = [];
  const seen = new Set([Number(realtorId)]);
  let currentId = realtorId;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [parent] = await sequelize.query(
      `SELECT u.id, u.name, u.realtor_code, u.realtor_id, u.company_id,
              l.id AS level_id, l.name AS level_name, l.position AS level_position,
              l.commission_percentage AS level_rate
         FROM users child
         JOIN users u ON u.id = child.realtor_id AND u.deleted_at IS NULL
         LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
        WHERE child.id = :currentId
        LIMIT 1`,
      { replacements: { currentId }, type: QueryTypes.SELECT },
    );
    if (!parent || seen.has(Number(parent.id))) break;
    seen.add(Number(parent.id));
    chain.push(parent);
    currentId = parent.id;
  }

  return chain;
};

/** A database row shaped the way the engine expects a participant's realtor. */
const toEngineRealtor = (row, history) => ({
  id: Number(row.id),
  name: row.name,
  realtor_code: row.realtor_code,
  level: row.level_id
    ? {
      id: Number(row.level_id),
      code: row.level_name,
      position: Number(row.level_position) || 0,
      direct_rate: row.level_rate === null || row.level_rate === undefined
        ? null : Number(row.level_rate),
      // Phase 1 has no per-level generational depth configured yet; unset means
      // "not limited by the level", which the engine reads as no cap.
      max_generations_earnable: row.max_generations_earnable ?? null,
    }
    : null,
  status_history: history || [],
});

const loadRealtor = async (sequelize, realtorId) => {
  const [row] = await sequelize.query(
    `SELECT u.id, u.name, u.realtor_code, u.company_id,
            l.id AS level_id, l.name AS level_name, l.position AS level_position,
            l.commission_percentage AS level_rate
       FROM users u
       LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
      WHERE u.id = :realtorId AND u.deleted_at IS NULL
      LIMIT 1`,
    { replacements: { realtorId }, type: QueryTypes.SELECT },
  );
  return row || null;
};

// ── Running a calculation ───────────────────────────────────────────────────

/**
 * Assemble every input the engine needs, then run it.
 *
 * Returns the engine's result untouched, plus the plan version it resolved.
 * Writes nothing — `persist` does that, and keeping them apart is what lets the
 * simulator call this and stop.
 */
const computeForDeal = async (sequelize, deal) => {
  const at = deal.attribution_date || new Date();

  const planVersion = await resolvePlanVersion(sequelize, {
    companyId: deal.company_id,
    propertyId: deal.property_id,
    projectId: deal.project_id,
    at,
  });
  if (!planVersion) return { skipped: 'no_plan_in_force' };
  if (planVersion.unreadable) return { skipped: 'plan_config_unreadable', planVersion };

  const seller = await loadRealtor(sequelize, deal.selling_realtor_id);
  if (!seller) return { skipped: 'no_selling_realtor' };

  const ancestors = await uplineOf(sequelize, deal.selling_realtor_id);
  const referrer = deal.referrer_id && Number(deal.referrer_id) !== Number(deal.selling_realtor_id)
    ? await loadRealtor(sequelize, deal.referrer_id)
    : null;

  // One query for every participant's history — see realtorStatus.historyFor.
  const everyone = [seller, referrer, ...ancestors].filter(Boolean).map((row) => Number(row.id));
  const histories = await historyFor(sequelize, everyone);

  const result = calculate({
    deal: {
      id: deal.deal_ref,
      gross_price_minor: asMinor(deal.gross_price_minor),
      discount_minor: asMinor(deal.discount_minor),
      unit_count: deal.unit_count || 1,
      attribution_date: at,
      property_type: deal.property_type ?? null,
      selling_realtor: toEngineRealtor(seller, histories.get(Number(seller.id))),
      referrer: referrer ? toEngineRealtor(referrer, histories.get(Number(referrer.id))) : null,
      co_agents: [],
    },
    plan: planVersion,
    ancestors: ancestors.map((row) => toEngineRealtor(row, histories.get(Number(row.id)))),
    components: deal.components || [],
  });

  return { result, planVersion };
};

// ── Writing the answer ──────────────────────────────────────────────────────

/**
 * A key that is the same for the same calculation and different for any other.
 *
 * The ledger's unique index turns a replayed event into a no-op rather than a
 * second posting (FR-CLC-002). Hashed rather than concatenated because the
 * parts include a deal reference and a rule id of unbounded length, and a key
 * that overflows its column stops being unique quietly.
 */
const idempotencyKey = (...parts) => crypto
  .createHash('sha256')
  .update(parts.map((part) => String(part ?? '')).join('|'))
  .digest('hex');

/**
 * Persist a calculation: the entitlements, and one accrual entry each.
 *
 * All inside the caller's transaction. An entitlement without its ledger entry
 * is a payable nothing accounts for; a ledger entry without its entitlement is
 * a figure nobody can explain. Neither is allowed to exist alone.
 *
 * Idempotent at the row level rather than by checking first: a check is not
 * atomic, and the duplicate it admits is a realtor paid twice.
 */
const persist = async (sequelize, transaction, { deal, result, planVersion }) => {
  const written = [];

  for (const line of result.entitlements) {
    const row = {
      companyId: deal.company_id ?? null,
      dealRef: deal.deal_ref,
      invoiceId: deal.invoice_id ?? null,
      propertyId: deal.property_id ?? null,
      realtorId: line.realtor_id,
      planVersionId: planVersion?.id ?? null,
      ruleId: String(line.rule_id ?? ''),
      ruleType: line.rule_type ?? null,
      role: line.role,
      // 0 rather than NULL — the uniqueness key includes it; see the migration.
      generation: line.generation ?? 0,
      gross: asMinor(line.gross_minor),
      constrained: asMinor(line.constrained_minor),
      attributionDate: new Date(deal.attribution_date || Date.now()),
      eligibility: JSON.stringify(line.eligibility_check ?? null),
      trace: JSON.stringify(line.trace ?? null),
    };

    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `INSERT INTO commission_entitlements
           (company_id, deal_ref, invoice_id, property_id, realtor_id, plan_version_id,
            rule_id, rule_type, role, generation, gross_minor, constrained_minor,
            released_minor, forfeited_minor, status, attribution_date,
            eligibility_check, trace, created_at)
         VALUES
           (:companyId, :dealRef, :invoiceId, :propertyId, :realtorId, :planVersionId,
            :ruleId, :ruleType, :role, :generation, :gross, :constrained,
            0, 0, 'ACCRUED', :attributionDate, :eligibility, :trace, NOW())`,
        { replacements: row, type: QueryTypes.INSERT, transaction },
      );
      written.push(row);
    } catch (error) {
      /**
       * Already recorded. The event has been replayed — a retried job, a
       * double-submitted confirmation — and the right response is to do
       * nothing, which is exactly what the unique index has already arranged.
       */
      if (!isDuplicateError(error)) throw error;
    }
  }

  // eslint-disable-next-line no-await-in-loop
  for (const line of written) {
    // eslint-disable-next-line no-await-in-loop
    await postLedger(sequelize, transaction, {
      companyId: line.companyId,
      realtorId: line.realtorId,
      dealRef: line.dealRef,
      entryType: 'ACCRUAL',
      amountMinor: line.constrained,
      description: `Commission accrued on ${line.dealRef}`,
      key: idempotencyKey('accrual', line.dealRef, line.realtorId, line.ruleId, line.role, line.generation),
    });
  }

  /**
   * Pool money that reached nobody (FR-ANL-004). Posted so the deal's total
   * commission cost reconciles against the pool without anybody having to
   * subtract one report from another.
   */
  if (result.breakage_minor > 0) {
    await postLedger(sequelize, transaction, {
      companyId: deal.company_id ?? null,
      realtorId: null,
      dealRef: deal.deal_ref,
      entryType: 'BREAKAGE',
      amountMinor: result.breakage_minor,
      description: `Unallocated pool on ${deal.deal_ref}`,
      key: idempotencyKey('breakage', deal.deal_ref, planVersion?.id),
      metadata: { excluded: result.excluded },
    });
  }

  return written.length;
};

const postLedger = async (sequelize, transaction, {
  companyId, realtorId, dealRef, entitlementId = null,
  entryType, amountMinor, description, key, metadata = null, createdBy = null,
}) => {
  try {
    await sequelize.query(
      `INSERT INTO commission_ledger_entries
         (company_id, entitlement_id, realtor_id, deal_ref, entry_type, amount_minor,
          description, idempotency_key, metadata, created_by, created_at)
       VALUES
         (:companyId, :entitlementId, :realtorId, :dealRef, :entryType, :amountMinor,
          :description, :key, :metadata, :createdBy, NOW())`,
      {
        replacements: {
          companyId: companyId ?? null,
          entitlementId,
          realtorId: realtorId ?? null,
          dealRef: dealRef ?? null,
          entryType,
          amountMinor: asMinor(amountMinor),
          description: description ? String(description).slice(0, 255) : null,
          key,
          metadata: metadata ? JSON.stringify(metadata).slice(0, 60000) : null,
          createdBy,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    return true;
  } catch (error) {
    // The same posting, again. Not an error — see idempotencyKey.
    if (isDuplicateError(error)) return false;
    throw error;
  }
};

/**
 * Calculate and record, in one transaction.
 *
 * The entry point a deal-confirmation handler calls. Returns what happened
 * rather than throwing for the ordinary refusals — no plan configured is not an
 * error, it is a company that has not set one up — but a genuine failure does
 * throw, because FR-CLC-007 requires the deal quarantined rather than silently
 * skipped.
 */
const accrueForDeal = async (sequelize, deal, { transaction = null } = {}) => {
  const { result, planVersion, skipped } = await computeForDeal(sequelize, deal);
  if (skipped) return { accrued: 0, skipped };
  if (result.rejected) return { accrued: 0, rejected: result.rejected };

  const run = (tx) => persist(sequelize, tx, { deal, result, planVersion });

  const accrued = transaction
    ? await run(transaction)
    : await sequelize.transaction((tx) => run(tx));

  return { accrued, result, planVersion };
};

// ── Releasing ───────────────────────────────────────────────────────────────

/**
 * Vest what the trigger allows, for one deal, re-checking eligibility.
 *
 * The status gate runs AGAIN here, freshly, as of the release moment — not the
 * accrual moment (§5.9, FR-ELG-002). A realtor active when the deal closed and
 * suspended before this instalment does not receive it. The amounts are never
 * recomputed: a release decides whether value vests, never what it is worth
 * (FR-ELG-014).
 *
 * Phase 1 releases in full on one trigger — the caller decides when — and
 * disposes of anything forfeited as breakage, per the phasing.
 */
const releaseForDeal = async (sequelize, { dealRef, at = new Date(), reason = null }) => {
  const entitlements = await sequelize.query(
    `SELECT id, company_id, realtor_id, deal_ref, constrained_minor, released_minor, status
       FROM commission_entitlements
      WHERE deal_ref = :dealRef AND status = 'ACCRUED'`,
    { replacements: { dealRef }, type: QueryTypes.SELECT },
  );
  if (!entitlements.length) return { released: 0, forfeited: 0 };

  const histories = await historyFor(sequelize, entitlements.map((row) => row.realtor_id));

  let released = 0;
  let forfeited = 0;

  await sequelize.transaction(async (transaction) => {
    for (const line of entitlements) {
      const outstanding = asMinor(line.constrained_minor) - asMinor(line.released_minor);
      if (outstanding <= 0) continue;

      const check = checkRelease(
        { id: line.realtor_id, status_history: histories.get(Number(line.realtor_id)) || [] },
        at,
      );

      if (!check.eligible) {
        /**
         * Not active at this checkpoint. The unreleased value is forfeited and
         * retained by the company — Phase 1's only disposition (FR-ELG-007).
         * Already-released amounts are untouched: deactivation alone never
         * claws back what has been paid (FR-ELG-004).
         */
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `UPDATE commission_entitlements
              SET status = 'FORFEITED', forfeited_minor = :amount,
                  eligibility_check = :check, updated_at = NOW()
            WHERE id = :id`,
          {
            replacements: { id: line.id, amount: outstanding, check: JSON.stringify(check.check) },
            type: QueryTypes.UPDATE,
            transaction,
          },
        );
        // eslint-disable-next-line no-await-in-loop
        await postLedger(sequelize, transaction, {
          companyId: line.company_id,
          realtorId: line.realtor_id,
          dealRef: line.deal_ref,
          entitlementId: line.id,
          entryType: 'FORFEIT',
          amountMinor: outstanding,
          description: `Forfeited — not active at release${reason ? ` (${reason})` : ''}`,
          key: idempotencyKey('forfeit', line.id, new Date(at).toISOString()),
          metadata: { eligibility_check: check.check },
        });
        forfeited += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `UPDATE commission_entitlements
            SET released_minor = constrained_minor, status = 'RELEASED',
                eligibility_check = :check, updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: { id: line.id, check: JSON.stringify(check.check) },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );
      // eslint-disable-next-line no-await-in-loop
      await postLedger(sequelize, transaction, {
        companyId: line.company_id,
        realtorId: line.realtor_id,
        dealRef: line.deal_ref,
        entitlementId: line.id,
        entryType: 'RELEASE',
        amountMinor: outstanding,
        description: `Commission released on ${line.deal_ref}`,
        key: idempotencyKey('release', line.id, outstanding),
        metadata: { eligibility_check: check.check },
      });
      released += 1;
    }
  });

  return { released, forfeited };
};

// ── Reading balances ────────────────────────────────────────────────────────

/**
 * A realtor's wallet, derived from the ledger and never stored (FR-PAY-001).
 *
 * A stored balance and a ledger disagree eventually — a failed job, a partial
 * write — and once they do, neither can be trusted and the reconciliation is
 * manual. Summing on read costs an indexed scan of one realtor's entries.
 */
const walletFor = async (sequelize, realtorId) => {
  const rows = await sequelize.query(
    `SELECT entry_type, COALESCE(SUM(amount_minor), 0) AS total
       FROM commission_ledger_entries
      WHERE realtor_id = :realtorId
      GROUP BY entry_type`,
    { replacements: { realtorId }, type: QueryTypes.SELECT },
  );

  const by = Object.fromEntries(rows.map((row) => [row.entry_type, Number(row.total) || 0]));
  const accrued = by.ACCRUAL || 0;
  const released = by.RELEASE || 0;
  const forfeitedTotal = by.FORFEIT || 0;
  const paid = by.PAYOUT || 0;
  const adjustments = (by.ADJUSTMENT || 0) - (by.REVERSAL || 0);

  return {
    realtor_id: Number(realtorId),
    // Recognised but not yet vested.
    accrued_minor: accrued - released - forfeitedTotal,
    // Vested and not yet paid out.
    available_minor: released + adjustments - paid,
    released_minor: released,
    forfeited_minor: forfeitedTotal,
    paid_minor: paid,
  };
};

module.exports = {
  ENGINE_VERSION,
  resolvePlanVersion,
  uplineOf,
  computeForDeal,
  accrueForDeal,
  releaseForDeal,
  walletFor,
  postLedger,
  idempotencyKey,
  ROLE,
};
