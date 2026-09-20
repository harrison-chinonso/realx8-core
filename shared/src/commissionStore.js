const { QueryTypes } = require('sequelize');
const { commissionLabel } = require('./commissionLabel');
const crypto = require('crypto');
const { isDuplicateError, insertReturningId, q } = require('./dialect');
const { asMinor } = require('./money');
const { historyFor } = require('./realtorStatus');
const { screenDeal } = require('./commissionFraud');
const {
  calculate, checkRelease, ROLE,
  vestedAmount, applyHoldback, isMatured,
  reverseLine, withinClawbackWindow, recoveryFromPayout, cascadesToUpline,
  applyDeductions, dispositionFor, redistribute, DISPOSITION,
} = require('./commission');
const { policyFor, GATE, LAPSE_SCOPE, PARTIAL_RELEASE } = require('./commission/policy');

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
 * then its project, then the company default — and above all of them, a
 * CAMPAIGN.
 *
 * A campaign outranks a property-scoped plan because it is the more deliberate
 * statement: a company that runs "double commission through December" means it
 * to apply to the December sales it is trying to cause, including the ones on
 * properties that carry their own plan. Losing to a property scope would make a
 * campaign silently inapplicable to exactly the inventory it was launched for.
 *
 * It is also the scope that expires. A campaign plan's version carries an
 * `effective_to`, so it stops applying on its own rather than by somebody
 * remembering to archive it — and deals attributed during it keep resolving to
 * it forever, which is what makes the December figures still explicable in
 * March.
 */
const resolvePlanVersion = async (sequelize, {
  companyId, propertyId, projectId, campaignId = null, unitId = null, at,
}) => {
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
          (p.scope_type = 'campaign' AND p.scope_id = :campaignId)
          OR (p.scope_type = 'unit' AND p.scope_id = :unitId)
          OR (p.scope_type = 'property' AND p.scope_id = :propertyId)
          OR (p.scope_type = 'project' AND p.scope_id = :projectId)
          OR (p.scope_type IS NULL AND p.is_default IS TRUE)
        )
      ORDER BY
        /**
         * Most specific first. A plan pinned to ONE unit beats one covering the
         * whole property, which beats the project, which beats the company
         * default — otherwise pinning a plan to a unit could not express
         * anything a property plan did not already say.
         *
         * A campaign still outranks all of them: it is time-boxed and
         * deliberate, and a company running one means it to apply to the sales
         * it is trying to cause, including on inventory that carries its own
         * plan.
         */
        CASE p.scope_type
          WHEN 'campaign' THEN 0
          WHEN 'unit' THEN 1
          WHEN 'property' THEN 2
          WHEN 'project' THEN 3
          ELSE 4 END,
        v.effective_from DESC,
        v.id DESC`,
    {
      replacements: {
        companyId: companyId ?? null,
        propertyId: propertyId ?? -1,
        projectId: projectId ?? -1,
        // -1 rather than NULL: a campaign-scoped plan must not match a deal
        // that belongs to no campaign, and NULL = NULL is never true anyway.
        campaignId: campaignId ?? -1,
        // -1 rather than NULL for the same reason: a deal with no unit must not
        // match a unit-scoped plan, and NULL = NULL is never true anyway.
        unitId: unitId ?? -1,
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
    unitId: deal.unit_id ?? null,
    campaignId: deal.campaign_id ?? null,
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

  /**
   * The engine input is built once and RETURNED alongside the answer.
   *
   * A backtest asks what a different plan would have cost over deals already
   * closed, which means re-running `calculate` with the same participants and a
   * different plan. Reassembling the participants in the reporting layer would
   * give the comparison a second opinion about who was on the deal, and the two
   * opinions would drift — at which point the backtest is answering a question
   * about itself rather than about the plan.
   */
  const input = {
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
  };

  return { result: calculate(input), planVersion, input };
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
      /**
       * An award is entitled and valued like anything else, and settled by
       * handing over a prize rather than by a transfer. Recorded on the row
       * because every later stage has to know — a payout run that swept it up
       * would pay the value of the prize on top of the prize.
       */
      payoutType: line.trace?.payout_type === 'NON_CASH' ? 'NON_CASH' : 'CASH',
    };

    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `INSERT INTO commission_entitlements
           (company_id, deal_ref, invoice_id, property_id, realtor_id, plan_version_id,
            rule_id, rule_type, role, generation, gross_minor, constrained_minor,
            released_minor, forfeited_minor, status, attribution_date,
            eligibility_check, trace, payout_type, created_at)
         VALUES
           (:companyId, :dealRef, :invoiceId, :propertyId, :realtorId, :planVersionId,
            :ruleId, :ruleType, :role, :generation, :gross, :constrained,
            0, 0, 'ACCRUED', :attributionDate, :eligibility, :trace, :payoutType, NOW())`,
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
      /**
       * An award posts as AWARD, not ACCRUAL.
       *
       * The wallet is derived from the ledger, so an award booked as an accrual
       * would show the realtor a balance that includes the notional value of a
       * prize they have already been given — and they would, reasonably, try to
       * withdraw it. The entry is still made, because the company incurred the
       * cost and the books have to carry it; it is simply not cash.
       */
      entryType: line.payoutType === 'NON_CASH' ? 'AWARD' : 'ACCRUAL',
      amountMinor: line.constrained,
      description: line.payoutType === 'NON_CASH'
        ? `Non-cash award earned on ${line.dealRef}`
        : `Commission accrued on ${line.dealRef}`,
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

  /**
   * Screened AFTER the accrual is committed, and outside its transaction.
   *
   * Deliberately not a gate. A check that ran inside the transaction could fail
   * it, which would withhold a real commission because a pattern-matcher was
   * unsure — and the person able to judge would not find out until the realtor
   * complained. Outside and after, the worst a broken check can do is fail to
   * raise a flag.
   */
  if (!transaction) {
    await recordFlags(sequelize, deal, result).catch((error) => {
      console.warn(`[commission] screening failed for ${deal.deal_ref}: ${error.message}`);
    });
  }

  return { accrued, result, planVersion };
};

/** Screen a freshly accrued deal and store whatever it turns up. */
const recordFlags = async (sequelize, deal, result) => {
  const screening = await screenDeal(sequelize, {
    dealRef: deal.deal_ref,
    invoiceId: deal.invoice_id ?? null,
    companyId: deal.company_id ?? null,
    sellerId: deal.selling_realtor_id,
    participants: result.entitlements || [],
    at: deal.attribution_date || new Date(),
  });

  for (const item of screening.findings) {
    /**
     * Keyed on the pattern rather than on the moment, so the same shape noticed
     * on the next deal in the cluster updates one flag instead of raising a
     * tenth copy of it. A reviewer looking at ten identical rows learns nothing
     * they did not learn from the first.
     */
    const key = idempotencyKey('flag', item.code, deal.selling_realtor_id, item.evidence?.field ?? deal.deal_ref);
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO commission_flags
         (company_id, deal_ref, realtor_id, code, severity, summary, evidence,
          status, idempotency_key, created_at)
       VALUES
         (:companyId, :dealRef, :realtorId, :code, :severity, :summary, :evidence,
          'OPEN', :key, NOW())`,
      {
        replacements: {
          companyId: deal.company_id ?? null,
          dealRef: deal.deal_ref,
          realtorId: deal.selling_realtor_id ?? null,
          code: item.code,
          severity: item.severity,
          summary: String(item.summary).slice(0, 500),
          evidence: JSON.stringify(item.evidence).slice(0, 60000),
          key,
        },
        type: QueryTypes.INSERT,
      },
    ).catch((error) => {
      // Already flagged. Not an error — see the note on the key.
      if (!isDuplicateError(error)) throw error;
    });
  }

  return screening;
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
 * ── Called on every receipt, not only on the last one ───────────────────────
 *
 * Phase 1 released in full when an invoice finished being paid, because that
 * was the only trigger. With PRO_RATA, ON_THRESHOLD and ON_INITIAL_DEPOSIT a
 * release can become due on any instalment, so this runs after every approved
 * payment and vests whatever the trigger now allows.
 *
 * `vestedAmount` returns the CUMULATIVE figure and the difference against
 * `released_minor` is what posts. That is what makes a replayed receipt a no-op
 * instead of a second release, and it is why the function is not given an
 * increment to add.
 *
 * @param {object} options
 * @param {string} options.dealRef
 * @param {number} options.receivedMinor  cumulative receipts against the deal
 * @param {boolean} options.confirmed     whether the deal itself is confirmed
 */
const releaseForDeal = async (sequelize, {
  dealRef, at = new Date(), reason = null,
  receivedMinor = null, confirmed = true, milestonesMet = [], elapsedDays = null,
}) => {
  const entitlements = await sequelize.query(
    `SELECT id, company_id, realtor_id, deal_ref, plan_version_id, attribution_date,
            gross_minor, constrained_minor, released_minor, held_minor, paid_minor, status
       FROM commission_entitlements
      WHERE deal_ref = :dealRef AND status IN ('ACCRUED', 'PARTIALLY_RELEASED')`,
    { replacements: { dealRef }, type: QueryTypes.SELECT },
  );
  if (!entitlements.length) return { released: 0, forfeited: 0, vested_minor: 0 };

  const histories = await historyFor(sequelize, entitlements.map((row) => row.realtor_id));
  const vesting = await vestingConfigFor(sequelize, entitlements[0].plan_version_id);
  const policy = vesting.policy;

  /**
   * The base the trigger measures against is the deal's, not the line's.
   *
   * A pro-rata release is "the buyer has paid 40% of the sale", which is one
   * fact about the deal — asking it per entitlement would compare a receipt
   * against one participant's commission and vest everybody at once on the
   * first instalment.
   */
  const base = await commissionableBaseFor(sequelize, dealRef);
  const received = receivedMinor === null ? base : asMinor(receivedMinor);

  let released = 0;
  /*
   * Who money actually moved to on this pass.
   *
   * Returned so a caller can ask a question that needs the BEFORE and AFTER
   * of one realtor's balance — the payout-threshold crossing is the first —
   * without re-deriving the participant set from the deal and getting a
   * different answer than the loop below reached.
   */
  const releasedTo = new Map();
  let forfeited = 0;
  let vestedTotal = 0;
  const ineligible = [];

  await sequelize.transaction(async (transaction) => {
    for (const line of entitlements) {
      const entitled = asMinor(line.constrained_minor);
      const already = asMinor(line.released_minor);

      const vested = vestedAmount(vesting, {
        entitlement_minor: entitled,
        commissionable_base_minor: base,
        received_minor: received,
        confirmed,
        milestones_met: milestonesMet,
        elapsed_days: elapsedDays ?? daysSince(line.attribution_date, at),
      });

      const held = applyHoldback(vested.vested_minor, entitled, vesting, {
        holdback_released: vesting.holdback_released === true,
      });

      let payable = Math.min(held.vested_minor, entitled);

      /**
       * FORBID: an entitlement is released whole or not at all.
       *
       * For a company whose books cannot represent a part-paid commission, a
       * partial release is not a smaller payment — it is a row their accounting
       * has no way to describe. The trigger still decides WHEN the whole thing
       * vests; it simply may not vest a fraction of it.
       */
      if (policy.partial_release === PARTIAL_RELEASE.FORBID && payable < entitled) payable = 0;

      const increment = payable - already;

      /**
       * Nothing new has vested. Not an error and not a forfeiture — the buyer
       * simply has not reached the next threshold — so the line is left exactly
       * as it is, including its status.
       */
      if (increment <= 0) continue;

      const check = checkRelease(
        { id: line.realtor_id, status_history: histories.get(Number(line.realtor_id)) || [] },
        at,
      );

      /**
       * ADVISORY: the check ran, is recorded, and does not withhold anything.
       *
       * §7.9 reads the lapse as releasing anyway where AC-011 reads it as
       * forfeiting, and both are real policies — a company that treats
       * suspension as an administrative state rather than a financial penalty
       * means the first. The check is stored either way, so the history of who
       * was suspended when is identical; only the money differs.
       */
      if (!check.eligible && policy.gate === GATE.ADVISORY) {
        check.check.policy = GATE.ADVISORY;
        check.check.result = 'PASS_ADVISORY';
      }

      if (!check.eligible && policy.gate === GATE.ENFORCE) {
        /**
         * Not active at this checkpoint. Only the increment that would have
         * vested NOW is forfeited — not the whole remaining entitlement.
         *
         * The distinction matters for a reinstatement: under
         * HOLD_PENDING_REINSTATEMENT a realtor whose suspension is later
         * cleared resumes the ordinary schedule (FR-ELG-009), and forfeiting
         * the entire balance on the first missed instalment would leave nothing
         * to resume. What is lost is what was due while they were out.
         */
        /**
         * How much is lost: what fell due now, or the whole unreleased balance.
         *
         * INCREMENT leaves something for a reinstatement to resume, which is
         * what makes HOLD_PENDING_REINSTATEMENT coherent. REMAINING is the
         * harsher reading, and genuinely what some companies mean by
         * forfeiture — the entitlement is gone, not paused.
         */
        const lost = policy.lapse_scope === LAPSE_SCOPE.REMAINING
          ? Math.max(entitled - already, 0)
          : increment;
        const disposition = dispositionFor(vesting, check.check?.reason);
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `UPDATE commission_entitlements
              SET forfeited_minor = forfeited_minor + :amount,
                  status = CASE WHEN :disposition = 'HOLD_PENDING_REINSTATEMENT'
                                THEN 'HELD' ELSE 'FORFEITED' END,
                  eligibility_check = :check, updated_at = NOW()
            WHERE id = :id`,
          {
            replacements: {
              id: line.id,
              amount: lost,
              disposition,
              check: JSON.stringify({ ...check.check, disposition, lapse_scope: policy.lapse_scope }),
            },
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
          entryType: disposition === DISPOSITION.HOLD_PENDING_REINSTATEMENT ? 'HOLD' : 'FORFEIT',
          amountMinor: lost,
          description: `${disposition === DISPOSITION.HOLD_PENDING_REINSTATEMENT ? 'Held' : 'Forfeited'}`
            + ` — not active at release${reason ? ` (${reason})` : ''}`,
          key: idempotencyKey('forfeit', line.id, lost, new Date(at).toISOString()),
          metadata: { eligibility_check: check.check, disposition, lapse_scope: policy.lapse_scope },
        });
        forfeited += 1;
        ineligible.push({ ...line, forfeited_minor: lost, disposition });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `UPDATE commission_entitlements
            SET released_minor = :payable, held_minor = :held,
                status = CASE WHEN :payable >= constrained_minor THEN 'RELEASED'
                              ELSE 'PARTIALLY_RELEASED' END,
                released_at = NOW(), eligibility_check = :check, vesting = :vestingTrace,
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            id: line.id,
            payable,
            held: held.held_minor,
            check: JSON.stringify(check.check),
            vestingTrace: JSON.stringify(vested).slice(0, 60000),
          },
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
        // Keyed on the cumulative figure, so the same receipt replayed writes
        // the same key and posts once.
        amountMinor: increment,
        description: `Commission released on ${line.deal_ref}`,
        key: idempotencyKey('release', line.id, payable),
        metadata: { vesting: vested.reason, cumulative_minor: payable },
      });
      released += 1;
      vestedTotal += increment;
      releasedTo.set(
        Number(line.realtor_id),
        (releasedTo.get(Number(line.realtor_id)) || 0) + increment,
      );
    }

    /**
     * FR-ELG-007: forfeited value under a REDISTRIBUTE plan goes to whoever is
     * still standing on the same deal, rather than being retained.
     *
     * Done after the loop because it needs to know who survived it — sharing it
     * out one line at a time would give the first eligible participant the
     * whole of a forfeiture that later participants should have shared.
     */
    const forfeitures = ineligible.filter((line) => line.disposition === DISPOSITION.REDISTRIBUTE);
    if (forfeitures.length) {
      const pot = forfeitures.reduce((total, line) => total + line.forfeited_minor, 0);
      const survivors = entitlements.filter(
        (line) => !ineligible.some((out) => out.id === line.id),
      );
      const shared = redistribute(pot, survivors);

      for (const allocation of shared.allocations) {
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `UPDATE commission_entitlements
              SET constrained_minor = constrained_minor + :amount, updated_at = NOW()
            WHERE id = :id`,
          { replacements: { id: allocation.entitlement_id, amount: allocation.amount_minor }, type: QueryTypes.UPDATE, transaction },
        );
        // eslint-disable-next-line no-await-in-loop
        await postLedger(sequelize, transaction, {
          companyId: entitlements[0].company_id,
          realtorId: allocation.realtor_id,
          dealRef,
          entitlementId: allocation.entitlement_id,
          entryType: 'ADJUSTMENT',
          amountMinor: allocation.amount_minor,
          description: 'Share of forfeited commission redistributed',
          key: idempotencyKey('redistribute', allocation.entitlement_id, pot),
          metadata: { from_forfeiture_minor: pot },
        });
      }
    }
  });

  return {
    released,
    forfeited,
    vested_minor: vestedTotal,
    base_minor: base,
    received_minor: received,
    released_to: [...releasedTo].map(([realtor_id, amount_minor]) => ({ realtor_id, amount_minor })),
  };
};

/** Whole days between a deal's attribution and a release checkpoint. */
const daysSince = (from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(Math.floor((end.getTime() - start.getTime()) / 86400000), 0);
};

/**
 * The vesting settings out of a plan version's stored config.
 *
 * Read from the version rather than from the plan, for the same reason the
 * rules are: a deal vests on the trigger that was in force when it was
 * attributed. Changing a live plan from ON_FULL_PAYMENT to PRO_RATA must not
 * retroactively vest money on deals agreed under the old terms.
 *
 * Defaults to ON_FULL_PAYMENT, which is what Phase 1 did — so a plan written
 * before vesting was configurable behaves exactly as it did.
 */
const vestingConfigFor = async (sequelize, planVersionId) => {
  const fallback = { release_trigger: 'ON_FULL_PAYMENT', policy: policyFor({}) };
  if (!planVersionId) return fallback;

  const [row] = await sequelize.query(
    `SELECT v.config, v.company_id, p.scope_type
       FROM commission_plan_versions v
       JOIN commission_plans p ON p.id = v.plan_id
      WHERE v.id = :id LIMIT 1`,
    { replacements: { id: planVersionId }, type: QueryTypes.SELECT },
  );
  if (!row) return fallback;

  let config;
  try {
    config = JSON.parse(row.config);
  } catch {
    return fallback;
  }

  /**
   * A scoped plan inherits from its company's DEFAULT plan.
   *
   * Phase 1 had no vesting trigger at all, so the engine supplied one. Making
   * it configurable is not enough on its own: a company that sets a trigger on
   * its default plan and then scopes a plan to one estate would find the estate
   * silently back on the engine's fallback — the setting failing to apply to
   * exactly the inventory somebody cared enough to scope a plan to.
   *
   * So the company default is read and passed as the inherited policy. Only for
   * SCOPED plans: the default plan is the top of the chain and has nothing
   * above it.
   */
  let inherited = null;
  if (row.scope_type) {
    const [parent] = await sequelize.query(
      `SELECT v.config
         FROM commission_plan_versions v
         JOIN commission_plans p ON p.id = v.plan_id
        WHERE p.is_default IS TRUE
          AND p.status = 'active'
          AND v.status = 'active'
          AND (p.company_id ${row.company_id == null ? 'IS NULL' : '= :companyId'})
        ORDER BY v.effective_from DESC
        LIMIT 1`,
      {
        replacements: row.company_id == null ? {} : { companyId: row.company_id },
        type: QueryTypes.SELECT,
      },
    );
    if (parent) {
      try { inherited = policyFor(JSON.parse(parent.config)); } catch { inherited = null; }
    }
  }

  const policy = policyFor(config, inherited);

  return {
    ...config,
    ...(config.vesting || config.release || {}),
    // The resolved answers win over whatever spelling produced them, so every
    // later reader sees one value rather than choosing between three keys.
    release_trigger: policy.release_trigger,
    policy,
  };
};

/**
 * The base a deal's commission was computed from.
 *
 * Taken from the entitlements' own trace rather than recomputed, because the
 * trace is what the money was actually calculated on. Re-deriving it from the
 * invoice would reintroduce the very drift versioning exists to prevent: a
 * discount corrected after accrual would change the denominator of a pro-rata
 * release while the numerator stayed as accrued.
 */
const commissionableBaseFor = async (sequelize, dealRef) => {
  const rows = await sequelize.query(
    `SELECT trace FROM commission_entitlements
      WHERE deal_ref = :dealRef AND trace IS NOT NULL LIMIT 5`,
    { replacements: { dealRef }, type: QueryTypes.SELECT },
  );
  for (const row of rows) {
    try {
      const trace = JSON.parse(row.trace);
      const base = asMinor(trace.commissionable_base_minor ?? trace.basis_amount_minor);
      if (base > 0) return base;
    } catch { /* a trace that will not parse is not worth failing a release over */ }
  }
  return 0;
};

// ── Revising and taking back ────────────────────────────────────────────────

/**
 * Re-run a deal that has changed, and reverse the difference (§7.10, FR-ADJ-004).
 *
 * Not a delete and re-accrue. A renegotiation from 50M to 45M reduces everybody
 * proportionally and leaves the original trace intact, so the question "what
 * were we paying before, and why" still has an answer. Deleting the lines would
 * make a downward revision indistinguishable from a deal that had always been
 * worth 45M.
 *
 * Each participant's position is drained cheapest-first — unreleased accrual,
 * then wallet, then a receivable — because reaching for the receivable while an
 * unreleased accrual sits against the same deal demands money back from
 * somebody the company is still about to pay.
 */
const reviseForDeal = async (sequelize, deal, { reason = 'deal_revised', at = new Date() } = {}) => {
  const { result, planVersion, skipped } = await computeForDeal(sequelize, deal);
  if (skipped) return { revised: 0, skipped };

  const existing = await sequelize.query(
    `SELECT id, company_id, realtor_id, deal_ref, rule_id, role, generation,
            constrained_minor, released_minor, paid_minor, attribution_date, status
       FROM commission_entitlements
      WHERE deal_ref = :dealRef`,
    { replacements: { dealRef: deal.deal_ref }, type: QueryTypes.SELECT },
  );
  if (!existing.length) return { revised: 0, skipped: 'nothing_accrued' };

  const windowOpen = withinClawbackWindow(planVersion, existing[0].attribution_date, at);
  const cascade = cascadesToUpline(planVersion);

  const keyOf = (line) => [line.realtor_id, line.rule_id || '', line.role, line.generation || 0].join('|');
  const revisedBy = new Map(result.entitlements.map((line) => [
    [line.realtor_id, line.rule_id || '', line.role, line.generation || 0].join('|'),
    asMinor(line.constrained_minor),
  ]));

  let revised = 0;
  const receivables = [];

  await sequelize.transaction(async (transaction) => {
    for (const line of existing) {
      /**
       * A participant the recomputation no longer pays revises to zero, rather
       * than being skipped. An upline dropped by a compression change has to
       * give the money back like anybody else — leaving them out would pay them
       * on a structure that no longer exists.
       */
      const now = revisedBy.get(keyOf(line)) ?? 0;

      /**
       * `PROTECT_UPLINE`: a generational override rewards having built the
       * team, and a company may decide a buyer defaulting is not the sponsor's
       * fault. Only the seller gives it back.
       */
      if (!cascade && line.role === ROLE.UPLINE) continue;

      const outcome = reverseLine({
        constrained_minor: line.constrained_minor,
        released_minor: line.released_minor,
        paid_minor: line.paid_minor,
      }, now);
      if (outcome.unchanged) continue;

      /**
       * Past the clawback window, paid money is final (FR-ADJ-006) — but the
       * unreleased and unpaid parts are still the company's and still reverse.
       * Treating the whole line as final would keep paying a realtor for a deal
       * that has shrunk, out of an accrual nobody has touched.
       */
      const clawback = windowOpen ? outcome.clawback_minor : 0;

      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `UPDATE commission_entitlements
            SET constrained_minor = :revised,
                released_minor = :released,
                clawed_back_minor = clawed_back_minor + :clawback,
                status = CASE WHEN :revised <= 0 THEN 'REVERSED' ELSE status END,
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            id: line.id,
            revised: outcome.revised_minor,
            released: Math.max(asMinor(line.released_minor) - outcome.offset_wallet_minor, 0),
            clawback,
          },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );

      const surrendered = outcome.cancel_accrual_minor + outcome.offset_wallet_minor + clawback;
      // eslint-disable-next-line no-await-in-loop
      await postLedger(sequelize, transaction, {
        companyId: line.company_id,
        realtorId: line.realtor_id,
        dealRef: line.deal_ref,
        entitlementId: line.id,
        entryType: 'REVERSAL',
        amountMinor: surrendered,
        description: `Revised to ${outcome.revised_minor} on ${line.deal_ref} (${reason})`,
        key: idempotencyKey('reversal', line.id, outcome.revised_minor),
        metadata: {
          cancelled_accrual_minor: outcome.cancel_accrual_minor,
          offset_wallet_minor: outcome.offset_wallet_minor,
          clawback_minor: clawback,
          clawback_window_open: windowOpen,
          reason,
        },
      });

      if (clawback > 0) {
        // eslint-disable-next-line no-await-in-loop
        await raiseReceivable(sequelize, transaction, {
          companyId: line.company_id,
          realtorId: line.realtor_id,
          entitlementId: line.id,
          dealRef: line.deal_ref,
          amountMinor: clawback,
          reason,
        });
        receivables.push({ realtor_id: line.realtor_id, amount_minor: clawback });
      }
      revised += 1;
    }
  });

  return { revised, receivables, clawback_window_open: windowOpen };
};

/** Record money that has to come back, once. */
const raiseReceivable = async (sequelize, transaction, {
  companyId, realtorId, entitlementId, dealRef, amountMinor, reason,
}) => {
  const key = idempotencyKey('receivable', entitlementId, amountMinor, dealRef);
  try {
    await sequelize.query(
      `INSERT INTO commission_receivables
         (company_id, realtor_id, entitlement_id, deal_ref, amount_minor, recovered_minor,
          status, reason, raised_at, idempotency_key, created_at)
       VALUES
         (:companyId, :realtorId, :entitlementId, :dealRef, :amountMinor, 0,
          'OPEN', :reason, NOW(), :key, NOW())`,
      {
        replacements: {
          companyId: companyId ?? null,
          realtorId,
          entitlementId: entitlementId ?? null,
          dealRef: dealRef ?? null,
          amountMinor: asMinor(amountMinor),
          reason: reason ? String(reason).slice(0, 255) : null,
          key,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    return true;
  } catch (error) {
    if (isDuplicateError(error)) return false;
    throw error;
  }
};


// ── Paying it out ───────────────────────────────────────────────────────────

/**
 * Build one payout per realtor from everything released, matured and unpaid.
 *
 * ── Why a batch and not a payment per entitlement ───────────────────────────
 *
 * FR-PAY-002. A realtor with eleven entitlements across four deals should
 * receive one transfer and one advice. Paying each line separately multiplies
 * the bank charges, and gives the realtor eleven figures to reconcile against a
 * statement that shows one.
 *
 * ── Why the deduction profile is read per plan version ──────────────────────
 *
 * A payout can span deals under different plans, and withholding is a property
 * of the plan the deal was attributed under. Applying one profile to the whole
 * batch would tax a deal at a rate its own plan never specified.
 *
 * Nothing is transferred here. This writes a DRAFT for somebody to approve —
 * the approval is the control, and a function that both computed and paid would
 * make it impossible to review a run before the money moved.
 */
/**
 * A realtor asking to be paid for particular entitlements.
 *
 * ── Why this is a request and not a payout ──────────────────────────────────
 *
 * The realtor does not build the batch. Batching is where deductions, open
 * receivables and maturity are applied, and letting the person being paid
 * trigger it would let them choose a moment that suits them — before a
 * clawback lands, say. What they can do is say "these ones, please", and the
 * admin's payout run picks it up.
 *
 * ── Only what is genuinely payable ──────────────────────────────────────────
 *
 * The same scope the payout run uses: released, not already paid, cash, and
 * not already claimed by an open payout. Requesting anything else would create
 * a queue entry an admin could never act on, and the realtor would be left
 * waiting on something that was never going to happen.
 *
 * Idempotent: asking twice for the same entitlement changes nothing, so a
 * double-tap on a phone does not produce two requests.
 */
const requestPayoutFor = async (sequelize, { realtorId, entitlementIds = [], at = new Date() }) => {
  const ids = [...new Set(entitlementIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return { requested: 0, skipped: 'nothing_selected', lines: [] };

  const eligible = await sequelize.query(
    `SELECT e.id, e.deal_ref, e.released_minor, e.paid_minor, e.payout_requested_at
       FROM commission_entitlements e
      WHERE e.id IN (:ids)
        AND e.realtor_id = :realtorId
        AND e.released_minor > e.paid_minor
        AND e.status IN ('RELEASED', 'PARTIALLY_RELEASED')
        /*
         * Signed off by somebody. Accrual and vesting follow from the buyer
         * paying; approval is a decision, and it is the difference between a
         * realtor being told what they have earned and being able to ask for
         * it. Rows released before approval existed were approved by
         * backfillEntitlementApproval, so this does not withdraw anything.
         */
        AND e.approved_at IS NOT NULL
        AND e.payout_type = 'CASH'
        AND NOT EXISTS (
          SELECT 1 FROM commission_payout_lines pl
            JOIN commission_payouts po ON po.id = pl.payout_id
           WHERE pl.entitlement_id = e.id AND po.status IN ('DRAFT', 'APPROVED')
        )`,
    { replacements: { ids, realtorId }, type: QueryTypes.SELECT },
  );

  const fresh = eligible.filter((line) => !line.payout_requested_at);
  if (fresh.length) {
    await sequelize.query(
      `UPDATE commission_entitlements
          SET payout_requested_at = :at, updated_at = NOW()
        WHERE id IN (:ids) AND payout_requested_at IS NULL`,
      { replacements: { ids: fresh.map((line) => line.id), at }, type: QueryTypes.UPDATE },
    );
  }

  return {
    requested: fresh.length,
    /**
     * Said back rather than swallowed. "You chose 5, 3 were requested" is the
     * outcome a realtor needs to notice — the other two are not yet payable,
     * and letting them believe otherwise is how the support call starts.
     */
    selected: ids.length,
    already_requested: eligible.length - fresh.length,
    not_payable: ids.length - eligible.length,
    amount_minor: fresh.reduce(
      (total, line) => total + (asMinor(line.released_minor) - asMinor(line.paid_minor)), 0,
    ),
    lines: fresh.map((line) => ({ id: line.id, deal_ref: line.deal_ref })),
  };
};

/**
 * What comes off a set of payable lines, grouped by the plan version that
 * governs each of them.
 *
 * Extracted so that the figure a realtor is SHOWN and the figure a payout
 * actually withholds come from one place. They were the same number by
 * coincidence — the screen had no estimate at all — and the moment one was
 * added, two implementations of "what will be deducted" would have started
 * drifting the first time a deduction profile grew an option.
 *
 * @param {Map<number, number>} groups    plan version id → payable minor units
 * @param {Map<number, object>} versions  plan version id → its vesting config
 */
const deductionsOn = (groups, versions) => {
  const lines = [];
  let total = 0;
  for (const [versionId, amount] of groups) {
    const profile = (versions.get(Number(versionId)) || {}).deductions || [];
    if (!profile.length) continue;
    const applied = applyDeductions(amount, profile);
    total += applied.total_deducted_minor;
    lines.push(...applied.lines.map((line) => ({ ...line, plan_version_id: versionId })));
  }
  return { deductions: lines, deductions_minor: total };
};

/** Payable minor units per plan version, for a realtor's unpaid released lines. */
const groupByVersion = (lines) => {
  const groups = new Map();
  for (const line of lines) {
    const key = Number(line.plan_version_id) || 0;
    const amount = asMinor(line.released_minor) - asMinor(line.paid_minor);
    groups.set(key, (groups.get(key) || 0) + amount);
  }
  return groups;
};

/**
 * What a realtor would actually receive if they were paid out right now:
 * gross, what comes off it, and the net.
 *
 * ── Why this exists instead of deducting at release ─────────────────────────
 *
 * The wallet's `available_minor` is gross of deductions, because deductions
 * are taken when a payout batch is built. Left alone, that means the number a
 * realtor watches is larger than the number that reaches their bank, and the
 * difference is discovered on the payment. The alternative — deducting at
 * release so the balance is already net — restates money that has already been
 * released and needs a migration marker on every existing entitlement to avoid
 * taxing it twice. This is the other answer: leave the money where it is, and
 * show both figures.
 *
 * It is an ESTIMATE in one respect and exact in every other. The deduction
 * profile is read from the same plan versions and applied by the same function
 * the payout run uses, so the arithmetic cannot drift; what can still move is
 * the set of lines, if a plan version is re-configured or a line matures
 * between the two moments.
 *
 * ── Maturity is deliberately not filtered here ──────────────────────────────
 *
 * `buildPayoutsFor` pays only matured lines. This counts every released and
 * unpaid cash line, matured or not, because it has to correspond to the
 * balance the realtor is reading — a wallet showing ₦250,000 and a net
 * estimate computed on ₦90,000 of it is a worse answer than no estimate. The
 * count of lines still inside their maturity window is returned alongside, so
 * a screen can say so rather than imply the whole balance is drawable today.
 */
const payableEstimateFor = async (sequelize, realtorId, { at = new Date() } = {}) => {
  const lines = await sequelize.query(
    `SELECT e.id, e.plan_version_id, e.released_minor, e.paid_minor, e.released_at
       FROM commission_entitlements e
      WHERE e.realtor_id = :realtorId
        AND e.released_minor > e.paid_minor
        AND e.status IN ('RELEASED', 'PARTIALLY_RELEASED')
        AND e.payout_type = 'CASH'
        AND NOT EXISTS (
          SELECT 1 FROM commission_payout_lines pl
            JOIN commission_payouts po ON po.id = pl.payout_id
           WHERE pl.entitlement_id = e.id AND po.status IN ('DRAFT', 'APPROVED')
        )`,
    { replacements: { realtorId }, type: QueryTypes.SELECT },
  );

  const empty = {
    gross_minor: 0,
    deductions: [],
    deductions_minor: 0,
    recovered_minor: 0,
    net_minor: 0,
    immature_lines: 0,
  };
  if (!lines.length) return empty;

  const versions = new Map();
  for (const id of new Set(lines.map((line) => line.plan_version_id).filter(Boolean))) {
    // eslint-disable-next-line no-await-in-loop
    versions.set(Number(id), await vestingConfigFor(sequelize, id));
  }
  const configFor = (line) => versions.get(Number(line.plan_version_id)) || {};

  const gross = lines.reduce(
    (total, line) => total + (asMinor(line.released_minor) - asMinor(line.paid_minor)), 0,
  );
  const { deductions, deductions_minor: deducted } = deductionsOn(groupByVersion(lines), versions);

  /*
   * Recovery after deductions, exactly as the payout run orders it — see the
   * note in buildPayoutsFor. An estimate that recovered first would quote a
   * net the payment could never produce.
   */
  const owed = await openReceivablesFor(sequelize, realtorId);
  const owedTotal = owed.reduce(
    (total, row) => total + (asMinor(row.amount_minor) - asMinor(row.recovered_minor)), 0,
  );
  const recovery = recoveryFromPayout(gross - deducted, owedTotal, configFor(lines[0]));

  return {
    gross_minor: gross,
    deductions,
    deductions_minor: deducted,
    recovered_minor: recovery.recovered_minor,
    net_minor: recovery.net_minor,
    immature_lines: lines.filter((line) => !isMatured(configFor(line), line.released_at || at, at)).length,
  };
};

/**
 * An administrator signing off commission, so the realtor may ask to be paid.
 *
 * ── Approvable from ACCRUED, not only once vested ───────────────────────────
 *
 * The two questions are separate and are asked of different people. Vesting
 * asks whether the buyer has paid enough for the money to be due; approval
 * asks whether the company agrees the commission is owed at all. An
 * administrator can answer the second the moment the commission appears, and
 * the line still becomes requestable only when it has also vested — which is
 * the AND of the two, enforced in requestPayoutFor rather than here.
 *
 * Scoped to a company when one is given, so an administrator cannot approve
 * another tenant's commission by posting its id.
 */
const approveEntitlements = async (sequelize, {
  entitlementIds = [], approvedBy = null, companyId = null, at = new Date(),
}) => {
  const ids = [...new Set(entitlementIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return { approved: 0, already: 0, lines: [] };

  const rows = await sequelize.query(
    `SELECT id, realtor_id, deal_ref, approved_at, gross_minor, constrained_minor, released_minor
       FROM commission_entitlements
      WHERE id IN (:ids)
        ${companyId ? 'AND company_id = :companyId' : ''}
        AND status NOT IN ('REVERSED', 'CANCELLED')`,
    { replacements: { ids, companyId }, type: QueryTypes.SELECT },
  );

  const fresh = rows.filter((row) => !row.approved_at);
  if (fresh.length) {
    await sequelize.query(
      `UPDATE commission_entitlements
          SET approved_at = :at, approved_by = :approvedBy, updated_at = NOW()
        WHERE id IN (:ids) AND approved_at IS NULL`,
      {
        replacements: { ids: fresh.map((row) => row.id), at, approvedBy },
        type: QueryTypes.UPDATE,
      },
    );
  }

  return {
    approved: fresh.length,
    /*
     * Said back rather than swallowed, exactly as the payout request does.
     * "You selected 5, 3 were approved" is the outcome an administrator needs
     * to see — the other two were already signed off, and letting them believe
     * their click did something is how the same commission gets approved twice
     * in two tabs.
     */
    already: rows.length - fresh.length,
    not_approvable: ids.length - rows.length,
    lines: fresh.map((row) => ({
      id: row.id, realtor_id: row.realtor_id, deal_ref: row.deal_ref,
    })),
  };
};

/**
 * Attach "who bought, and what" to a set of entitlement rows.
 *
 * ── Read separately rather than joined ──────────────────────────────────────
 *
 * `invoices`, `users` and `properties` belong to other services. This module
 * is also exercised by verification suites that build a scratch database
 * holding the commission tables and nothing else — a LEFT JOIN there is not a
 * null column, it is a failed query, and the whole statement comes back as an
 * error rather than as a statement without labels.
 *
 * So the label is a second, failure-tolerant read, exactly as the legacy
 * commissions list beside it already is. Where it cannot resolve, the line
 * falls back to its deal reference, which is what it showed before.
 */
const labelled = async (sequelize, lines) => {
  const invoiceIds = [...new Set(lines.map((line) => line.invoice_id).filter(Boolean))];
  const propertyIds = [...new Set(lines.map((line) => line.property_id).filter(Boolean))];

  const buyers = invoiceIds.length ? await sequelize.query(
    `SELECT i.id, u.name
       FROM invoices i LEFT JOIN users u ON u.id = i.client_id
      WHERE i.id IN (:ids)`,
    { replacements: { ids: invoiceIds }, type: QueryTypes.SELECT },
  ).catch(() => []) : [];

  const places = propertyIds.length ? await sequelize.query(
    'SELECT id, name, city FROM properties WHERE id IN (:ids)',
    { replacements: { ids: propertyIds }, type: QueryTypes.SELECT },
  ).catch(() => []) : [];

  const buyerBy = new Map(buyers.map((row) => [Number(row.id), row.name]));
  const placeBy = new Map(places.map((row) => [Number(row.id), row]));

  return lines.map((line) => {
    const place = placeBy.get(Number(line.property_id));
    return {
      ...line,
      client_name: buyerBy.get(Number(line.invoice_id)) ?? null,
      property_name: place?.name ?? null,
      label: commissionLabel({
        clientName: buyerBy.get(Number(line.invoice_id)),
        propertyName: place?.name,
        city: place?.city,
        fallback: line.deal_ref,
      }),
    };
  });
};

const buildPayoutsFor = async (sequelize, {
  companyId = null, realtorIds = null, batchRef,
  periodStart = null, periodEnd = null, at = new Date(), createdBy = null,
  /**
   * Build only for entitlements a realtor has actually asked to be paid.
   *
   * Off by default, because the ordinary run pays everybody what they are owed
   * whether or not they asked — a realtor should not have to chase to be paid.
   * On, it is a way to clear the request queue without disturbing anything
   * else, which is what an admin working through requests wants.
   */
  requestedOnly = false,
} = {}) => {
  const scope = [
    'e.released_minor > e.paid_minor',
    "e.status IN ('RELEASED', 'PARTIALLY_RELEASED')",
    /*
     * Approved, on the same reasoning as the realtor's own request. The batch
     * run is an administrator's act rather than a hidden one, but paying a
     * commission nobody signed off is the thing approval exists to prevent —
     * and a realtor refused a request for a line the nightly run would have
     * paid them anyway is a rule that means nothing.
     */
    'e.approved_at IS NOT NULL',
    /**
     * Awards are settled by handing over the prize, never by a transfer.
     * Without this a non-cash line would be batched and paid, and the realtor
     * would receive the car and its value in cash.
     */
    "e.payout_type = 'CASH'",
    ...(requestedOnly ? ['e.payout_requested_at IS NOT NULL'] : []),
    /**
     * Not already claimed by a payout that is still open.
     *
     * `paid_minor` only moves when a payout is RECORDED AS PAID, so without
     * this every press of "Build payout run" re-picked the same entitlements
     * and wrote another draft for the same money. That is not merely untidy:
     * approving and paying two of those drafts pays the realtor twice, and
     * nothing downstream would have noticed.
     *
     * DRAFT and APPROVED both count as open. A CANCELLED payout releases its
     * lines back, which is what makes discarding a stale draft useful.
     */
    `NOT EXISTS (
       SELECT 1 FROM commission_payout_lines pl
       JOIN commission_payouts po ON po.id = pl.payout_id
        WHERE pl.entitlement_id = e.id
          AND po.status IN ('DRAFT', 'APPROVED')
     )`,
  ];
  const replacements = { at };
  if (companyId) { scope.push('e.company_id = :companyId'); replacements.companyId = companyId; }
  if (realtorIds?.length) { scope.push('e.realtor_id IN (:realtorIds)'); replacements.realtorIds = realtorIds; }
  if (periodStart) { scope.push('e.released_at >= :periodStart'); replacements.periodStart = periodStart; }
  if (periodEnd) { scope.push('e.released_at <= :periodEnd'); replacements.periodEnd = periodEnd; }

  const lines = await sequelize.query(
    `SELECT e.id, e.company_id, e.realtor_id, e.deal_ref, e.plan_version_id,
            e.released_minor, e.paid_minor, e.released_at, e.invoice_id, e.property_id
       FROM commission_entitlements e
      WHERE ${scope.join(' AND ')}
      ORDER BY e.realtor_id, e.id`,
    { replacements, type: QueryTypes.SELECT },
  );
  if (!lines.length) return { payouts: [], skipped: 'nothing_payable' };

  /**
   * Maturity is checked here rather than in SQL.
   *
   * The window is a plan setting, so "matured" is a different number of days
   * for different lines in the same batch, and a WHERE clause would have to
   * join to a JSON document to know which. Read the versions once, filter in
   * memory — the set is one batch, not a table scan.
   */
  const versions = new Map();
  for (const id of new Set(lines.map((line) => line.plan_version_id).filter(Boolean))) {
    // eslint-disable-next-line no-await-in-loop
    versions.set(Number(id), await vestingConfigFor(sequelize, id));
  }
  const configFor = (line) => versions.get(Number(line.plan_version_id)) || {};

  const mature = lines.filter((line) => isMatured(configFor(line), line.released_at || at, at));
  const immature = lines.length - mature.length;
  if (!mature.length) return { payouts: [], skipped: 'nothing_matured', immature };

  const byRealtor = new Map();
  for (const line of mature) {
    const key = Number(line.realtor_id);
    if (!byRealtor.has(key)) byRealtor.set(key, []);
    byRealtor.get(key).push(line);
  }

  /*
   * One lookup for the batch rather than one per realtor: the buyers and
   * properties behind a run overlap heavily, and this is the same tolerant
   * read the statement uses.
   */
  const labelBy = new Map(
    (await labelled(sequelize, mature)).map((line) => [Number(line.id), line.label]),
  );

  const built = [];

  await sequelize.transaction(async (transaction) => {
    for (const [realtorId, own] of byRealtor) {
      const gross = own.reduce(
        (total, line) => total + (asMinor(line.released_minor) - asMinor(line.paid_minor)), 0,
      );
      if (gross <= 0) continue;

      // Per plan version, for the reason in the header.
      const groups = groupByVersion(own);

      const { deductions: deductionLines, deductions_minor: deducted } = deductionsOn(groups, versions);

      /**
       * Recovery comes off AFTER deductions, against the net.
       *
       * Withholding is computed on what was earned; a clawback is repayment of
       * something already earned and already taxed. Recovering first would
       * shrink the taxable figure and under-remit — the direction of error that
       * a tax authority notices.
       */
      // eslint-disable-next-line no-await-in-loop
      const owed = await openReceivablesFor(sequelize, realtorId, { transaction });
      const owedTotal = owed.reduce(
        (total, row) => total + (asMinor(row.amount_minor) - asMinor(row.recovered_minor)), 0,
      );
      const afterDeductions = gross - deducted;
      const recovery = recoveryFromPayout(afterDeductions, owedTotal, configFor(own[0]));

      const advice = {
        gross_minor: gross,
        deductions: deductionLines,
        deductions_minor: deducted,
        recovered_minor: recovery.recovered_minor,
        net_minor: recovery.net_minor,
        /*
         * What the payment is made of, named the way the realtor would name
         * it. The deal reference travels alongside rather than instead — it is
         * what finance matches against, and the advice is a record somebody
         * may have to reconcile years later.
         *
         * Resolved at BUILD time and stored on the advice, so the breakdown
         * keeps the names as they were. A buyer who later changes their name,
         * or a property renamed for a relaunch, must not silently restate a
         * payment that has already been made.
         */
        entitlements: own.map((line) => ({
          entitlement_id: line.id,
          deal_ref: line.deal_ref,
          label: labelBy.get(Number(line.id)) || line.deal_ref,
          amount_minor: asMinor(line.released_minor) - asMinor(line.paid_minor),
        })),
      };

      /*
       * insertReturningId, not a destructured result plus a MAX(id) fallback.
       *
       * The old pair worked, but for the wrong reason on each engine: MySQL
       * returned the id, and Postgres returned nothing and fell through to
       * `SELECT MAX(id) FROM commission_payouts` — which is the id of whatever
       * row was inserted LAST, not necessarily this one. Two payout batches
       * committed close together and the entitlements below could be attached
       * to the other batch's payout. RETURNING makes the id belong to this
       * insert and no other.
       */
      // eslint-disable-next-line no-await-in-loop
      const payoutId = await insertReturningId(
        sequelize,
        `INSERT INTO commission_payouts
           (company_id, batch_ref, realtor_id, period_start, period_end,
            gross_minor, deductions_minor, recovered_minor, net_minor,
            status, advice, created_by, created_at)
         VALUES
           (:companyId, :batchRef, :realtorId, :periodStart, :periodEnd,
            :gross, :deducted, :recovered, :net,
            'DRAFT', :advice, :createdBy, NOW())`,
        {
          replacements: {
            companyId: own[0].company_id ?? companyId ?? null,
            batchRef: batchRef || `PAYOUT-${new Date(at).toISOString().slice(0, 10)}`,
            realtorId,
            periodStart,
            periodEnd,
            gross,
            deducted,
            recovered: recovery.recovered_minor,
            net: recovery.net_minor,
            advice: JSON.stringify(advice).slice(0, 60000),
            createdBy,
          },
          transaction,
        },
      );

      for (const line of own) {
        const amount = asMinor(line.released_minor) - asMinor(line.paid_minor);
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `INSERT INTO commission_payout_lines
             (payout_id, entitlement_id, realtor_id, deal_ref, amount_minor, created_at)
           VALUES (:payoutId, :entitlementId, :realtorId, :dealRef, :amount, NOW())`,
          {
            replacements: {
              payoutId, entitlementId: line.id, realtorId, dealRef: line.deal_ref, amount,
            },
            type: QueryTypes.INSERT,
            transaction,
          },
        );
      }

      built.push({ id: payoutId, realtor_id: realtorId, ...advice });
    }
  });

  return { payouts: built, immature };
};

/** Open clawbacks against a realtor, oldest first. */
const openReceivablesFor = async (sequelize, realtorId, { transaction = null } = {}) => sequelize.query(
  `SELECT id, amount_minor, recovered_minor, deal_ref
     FROM commission_receivables
    WHERE realtor_id = :realtorId AND status = 'OPEN'
      AND amount_minor > recovered_minor
    ORDER BY raised_at ASC`,
  { replacements: { realtorId }, type: QueryTypes.SELECT, transaction },
);


/** A finance officer signs the batch. Nothing has moved yet. */
const approvePayout = async (sequelize, payoutId, { userId = null } = {}) => {
  const [, changed] = await sequelize.query(
    `UPDATE commission_payouts
        SET status = 'APPROVED', approved_by = :userId, approved_at = NOW(), updated_at = NOW()
      WHERE id = :id AND status = 'DRAFT'`,
    { replacements: { id: payoutId, userId }, type: QueryTypes.UPDATE },
  );
  return { approved: changed ?? 0 };
};

/**
 * The money has left. Record it against the entitlements and the ledger.
 *
 * Only from APPROVED, and only once: `paid_minor` is what every later reversal
 * reads to decide whether it may cancel an accrual or must raise a receivable,
 * so marking a payout paid twice would double that figure and make the next
 * revision demand back money that never left.
 */
const markPayoutPaid = async (sequelize, payoutId, { reference = null, userId = null, at = new Date() } = {}) => {
  const [payout] = await sequelize.query(
    'SELECT * FROM commission_payouts WHERE id = :id LIMIT 1',
    { replacements: { id: payoutId }, type: QueryTypes.SELECT },
  );
  if (!payout) return { skipped: 'no_such_payout' };
  if (payout.status !== 'APPROVED') return { skipped: `not_approved:${payout.status}` };

  const lines = await sequelize.query(
    'SELECT * FROM commission_payout_lines WHERE payout_id = :id',
    { replacements: { id: payoutId }, type: QueryTypes.SELECT },
  );

  /**
   * Every line must still be owed, in full, before anything is transferred.
   *
   * Belt and braces behind the NOT EXISTS above. A batch built before that
   * guard existed — or one left open while the same money went out through
   * another batch — would otherwise add to `paid_minor` a second time and pay
   * the realtor twice. Refusing is the right answer rather than paying a
   * reduced amount: the advice the realtor was shown states a figure, and
   * quietly paying less than it says is its own kind of wrong.
   */
  const stale = [];
  for (const line of lines) {
    // eslint-disable-next-line no-await-in-loop
    const [entitlement] = await sequelize.query(
      `SELECT released_minor, paid_minor FROM commission_entitlements WHERE id = :id`,
      { replacements: { id: line.entitlement_id }, type: QueryTypes.SELECT },
    );
    const owed = entitlement
      ? asMinor(entitlement.released_minor) - asMinor(entitlement.paid_minor)
      : 0;
    if (owed < asMinor(line.amount_minor)) {
      stale.push({ entitlement_id: line.entitlement_id, deal_ref: line.deal_ref, still_owed_minor: owed });
    }
  }
  if (stale.length) {
    return {
      skipped: 'already_paid',
      stale,
      message: 'Some of this batch has already been paid through another payout. '
        + 'Cancel it and build a fresh run.',
    };
  }

  await sequelize.transaction(async (transaction) => {
    for (const line of lines) {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `UPDATE commission_entitlements
            SET paid_minor = paid_minor + :amount, status = 'PAID', updated_at = NOW()
          WHERE id = :id`,
        { replacements: { id: line.entitlement_id, amount: asMinor(line.amount_minor) }, type: QueryTypes.UPDATE, transaction },
      );
      // eslint-disable-next-line no-await-in-loop
      await postLedger(sequelize, transaction, {
        companyId: payout.company_id,
        realtorId: line.realtor_id,
        dealRef: line.deal_ref,
        entitlementId: line.entitlement_id,
        entryType: 'PAYOUT',
        amountMinor: asMinor(line.amount_minor),
        description: `Paid in batch ${payout.batch_ref}`,
        key: idempotencyKey('payout', payoutId, line.entitlement_id),
        metadata: { payout_id: payoutId, reference },
        createdBy: userId,
      });
    }

    /**
     * What was withheld, posted separately.
     *
     * Without this the ledger says 450,000 was paid out when 427,500 left the
     * bank — the difference went to a tax authority, and the books carried no
     * liability for it. The PAYOUT entries stay at gross, because that is what
     * each entitlement discharged; this contra-entry puts the withheld part
     * back against cash and raises the liability:
     *
     *   Dr Commission Payable   450,000   (the PAYOUT entries)
     *   Cr Bank                 450,000
     *   Dr Bank                  22,500   (this entry)
     *   Cr Withholding Payable   22,500
     *
     * Net effect on cash is 427,500, which is what actually moved.
     */
    const withheld = asMinor(payout.deductions_minor);
    if (withheld > 0) {
      await postLedger(sequelize, transaction, {
        companyId: payout.company_id,
        realtorId: payout.realtor_id,
        entryType: 'DEDUCTION',
        amountMinor: withheld,
        description: `Withheld from batch ${payout.batch_ref}`,
        key: idempotencyKey('deduction', payoutId, withheld),
        metadata: { payout_id: payoutId },
        createdBy: userId,
      });
    }

    /**
     * The cash book entry, written where the money actually leaves (ACC-0.6).
     *
     * ── Why it moved here ──────────────────────────────────────────────────
     *
     * It used to be written by settling a DEBIT NOTE raised against the
     * payout. That note existed to give a payout an approval step and a place
     * to record the cash movement, back when the payout run had neither —
     * `commissionService.payOut` still carries the comment explaining that it
     * deliberately writes no transaction and delegates to the note.
     *
     * The run has since grown its own control: build, approve, pay. The note
     * had become a second approval of the same money, on a document whose name
     * means the opposite of what it did — a debit note charges a customer, and
     * this pays a realtor. So the note is gone and the entry is written at the
     * moment somebody records that the transfer happened, which is the correct
     * moment and one step shorter.
     *
     * NET, not gross. Withholding never left the building — the DEDUCTION
     * entry above raises the tax liability for it — so the cash book records
     * what the bank actually sent. Recovery against a clawback likewise never
     * left.
     */
    const cashOut = Math.max(asMinor(payout.net_minor), 0);
    if (cashOut > 0) {
      await sequelize.query(
        `INSERT INTO transactions
           (user_id, ${q(sequelize, 'type')}, entry_type, amount, description,
            payment_method, status, reference, company_id, created_at)
         VALUES (:userId, 'commission_payout', 'debit', :amount, :description,
            :method, 'completed', :reference, :companyId, NOW())`,
        {
          replacements: {
            userId: payout.realtor_id,
            amount: cashOut / 100,
            description: `Commission payout ${payout.batch_ref}`,
            method: 'transfer',
            reference: reference || payout.batch_ref,
            companyId: payout.company_id ?? null,
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      ).catch((error) => {
        /*
         * One reference, one transaction — `transactions` carries a unique
         * index on (company_id, reference). A replayed "mark paid" finds its
         * own row already there, which is the same no-op the entitlement
         * updates above already are.
         */
        if (!/duplicate|unique/i.test(error.message || '')) throw error;
      });
    }

    /**
     * The recovery is applied when the payout is PAID, not when it is built.
     *
     * A draft that is never paid must not have reduced what the realtor still
     * owes — otherwise cancelling a batch quietly forgives a clawback.
     */
    let outstanding = asMinor(payout.recovered_minor);
    if (outstanding > 0) {
      const owed = await openReceivablesFor(sequelize, payout.realtor_id, { transaction });
      for (const receivable of owed) {
        if (outstanding <= 0) break;
        const remaining = asMinor(receivable.amount_minor) - asMinor(receivable.recovered_minor);
        const take = Math.min(remaining, outstanding);
        outstanding -= take;

        /**
         * The new status is decided HERE, not in the UPDATE.
         *
         * A CASE that reads `recovered_minor` in the same statement that
         * assigns it means two different things on the two engines: MySQL
         * evaluates SET clauses left to right, so the CASE sees the ALREADY
         * incremented value and every partial recovery closes as fully
         * recovered; Postgres evaluates every clause against the old row and
         * gets it right. The same statement, silently forgiving the balance of
         * a clawback on one engine and not the other.
         *
         * Both numbers are already known in JavaScript, so nothing is gained by
         * asking the database to derive them.
         */
        const closed = take >= remaining;
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          `UPDATE commission_receivables
              SET recovered_minor = recovered_minor + :take,
                  status = :status,
                  closed_at = :closedAt,
                  updated_at = NOW()
            WHERE id = :id`,
          {
            replacements: {
              id: receivable.id,
              take,
              status: closed ? 'RECOVERED' : 'OPEN',
              closedAt: closed ? new Date() : null,
            },
            type: QueryTypes.UPDATE,
            transaction,
          },
        );
        // eslint-disable-next-line no-await-in-loop
        await postLedger(sequelize, transaction, {
          companyId: payout.company_id,
          realtorId: payout.realtor_id,
          dealRef: receivable.deal_ref,
          entryType: 'RECOVERY',
          amountMinor: take,
          description: `Recovered against batch ${payout.batch_ref}`,
          key: idempotencyKey('recovery', payoutId, receivable.id, take),
          metadata: { receivable_id: receivable.id },
        });
      }
    }

    await sequelize.query(
      `UPDATE commission_payouts
          SET status = 'PAID', paid_at = :at, payment_reference = :reference, updated_at = NOW()
        WHERE id = :id AND status = 'APPROVED'`,
      { replacements: { id: payoutId, at, reference }, type: QueryTypes.UPDATE, transaction },
    );
  });

  return { paid: lines.length, net_minor: asMinor(payout.net_minor) };
};


/**
 * Discard a payout that has not been paid.
 *
 * Needed because an open payout now HOLDS its entitlements: without a way to
 * cancel one, a draft built by mistake would block those lines from ever being
 * batched again. Cancelling releases them back to the next run.
 *
 * Refuses a PAID batch. That one records money that has left, and the way to
 * undo it is a reversal against the deal, not deleting the record of the
 * payment.
 */
const cancelPayout = async (sequelize, payoutId, { userId = null } = {}) => {
  const [, changed] = await sequelize.query(
    `UPDATE commission_payouts
        SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = :id AND status IN ('DRAFT', 'APPROVED')`,
    { replacements: { id: payoutId, userId }, type: QueryTypes.UPDATE },
  );
  return { cancelled: changed ?? 0 };
};

/**
 * A realtor's statement for a period (FR-PAY-008).
 *
 * Built from the ledger and the entitlements rather than from the payouts,
 * because the question a realtor asks is "what did I earn and where has it got
 * to" — and the answer includes money that has accrued and not vested, which no
 * payout has ever seen.
 */
const statementFor = async (sequelize, realtorId, { from = null, to = null } = {}) => {
  const bounds = [];
  const replacements = { realtorId };
  if (from) { bounds.push('AND e.attribution_date >= :from'); replacements.from = from; }
  if (to) { bounds.push('AND e.attribution_date <= :to'); replacements.to = to; }

  const lines = await sequelize.query(
    `SELECT e.id, e.deal_ref, e.rule_type, e.role, e.generation, e.status,
            e.gross_minor, e.constrained_minor, e.released_minor, e.held_minor,
            e.paid_minor, e.forfeited_minor, e.clawed_back_minor, e.attribution_date,
            e.payout_type, e.payout_requested_at, e.approved_at, e.invoice_id, e.property_id,
            /*
             * Whether this line could be requested for payment right now.
             * Computed here rather than re-derived by each screen, because the
             * conditions are the payout run's own and the two disagreeing would
             * offer a realtor a button that does nothing.
             */
            CASE WHEN e.released_minor > e.paid_minor
                  AND e.status IN ('RELEASED', 'PARTIALLY_RELEASED')
                  AND e.approved_at IS NOT NULL
                  AND e.payout_type = 'CASH'
                  AND e.payout_requested_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM commission_payout_lines pl
                      JOIN commission_payouts po ON po.id = pl.payout_id
                     WHERE pl.entitlement_id = e.id AND po.status IN ('DRAFT', 'APPROVED')
                  )
                 THEN 1 ELSE 0 END AS can_request_payout
       FROM commission_entitlements e
      WHERE e.realtor_id = :realtorId ${bounds.join(' ')}
      ORDER BY e.attribution_date DESC, e.id DESC`,
    { replacements, type: QueryTypes.SELECT },
  );

  const payouts = await sequelize.query(
    `SELECT id, batch_ref, gross_minor, deductions_minor, recovered_minor, net_minor,
            status, paid_at, advice
       FROM commission_payouts
      WHERE realtor_id = :realtorId
      ORDER BY created_at DESC`,
    { replacements: { realtorId }, type: QueryTypes.SELECT },
  );

  const owed = await openReceivablesFor(sequelize, realtorId);

  /**
   * The OLDER flat-rate commissions, included deliberately.
   *
   * Exactly one system pays a given sale — the engine where a plan is in
   * force, the flat rate otherwise — but a realtor's history can span the
   * switch, and they do not care which internal table holds which. Reading only
   * the engine gave a realtor on a flat-rate company a permanently empty
   * statement, and a realtor whose company switched a statement that began
   * mid-career.
   *
   * Never throws: the statement is worth showing without this if the older
   * table is missing or unreadable.
   */
  const legacy = await sequelize.query(
    `SELECT id, title, type, amount, status, invoice_id, basis_amount,
            requested_at, approved_at, paid_at, created_at
       FROM commissions
      WHERE employee_id = :realtorId
      ORDER BY id DESC`,
    { replacements: { realtorId }, type: QueryTypes.SELECT },
  ).catch(() => []);

  return {
    realtor_id: Number(realtorId),
    legacy,
    wallet: await walletFor(sequelize, realtorId),
    /*
     * Gross, what comes off it, and the net — for the balance shown beside it.
     * Deductions are taken when a payout is built, so the wallet's available
     * figure is gross; carrying the net here is what stops a realtor reading
     * one number and being paid another.
     */
    payable: await payableEstimateFor(sequelize, realtorId),
    /*
     * The label is built here rather than by each screen, so the statement,
     * the approval queue and the payout advice cannot name the same commission
     * three different ways.
     */
    entitlements: await labelled(sequelize, lines),
    payouts: payouts.map((payout) => ({
      ...payout,
      advice: (() => { try { return JSON.parse(payout.advice); } catch { return null; } })(),
    })),
    receivables: owed,
    owed_minor: owed.reduce(
      (total, row) => total + (asMinor(row.amount_minor) - asMinor(row.recovered_minor)), 0,
    ),
  };
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
  /**
   * Suspended rather than lost: a hold has left the accrual but may yet come
   * back if the realtor is reinstated inside the grace window (FR-ELG-009).
   * Counting it as accrued would show a realtor a balance they cannot draw;
   * counting it as forfeited would report it gone when it is recoverable.
   */
  const heldTotal = by.HOLD || 0;
  const paid = by.PAYOUT || 0;
  const recovered = by.RECOVERY || 0;
  /**
   * Withholding does not reduce what the realtor was PAID against their
   * entitlements — it is a remittance made on their behalf, and the
   * entitlement is discharged in full. So it is reported, not subtracted.
   */
  const withheld = by.DEDUCTION || 0;
  const adjustments = (by.ADJUSTMENT || 0) - (by.REVERSAL || 0);

  return {
    realtor_id: Number(realtorId),
    // Recognised but not yet vested.
    accrued_minor: accrued - released - forfeitedTotal - heldTotal,
    // Vested and not yet paid out, net of anything recovered against a clawback.
    available_minor: released + adjustments - paid - recovered,
    released_minor: released,
    forfeited_minor: forfeitedTotal,
    held_minor: heldTotal,
    paid_minor: paid,
    recovered_minor: recovered,
    withheld_minor: withheld,
  };
};

module.exports = {
  requestPayoutFor,
  approveEntitlements,
  payableEstimateFor,
  ENGINE_VERSION,
  resolvePlanVersion,
  uplineOf,
  reviseForDeal,
  raiseReceivable,
  vestingConfigFor,
  commissionableBaseFor,
  computeForDeal,
  accrueForDeal,
  recordFlags,
  releaseForDeal,
  buildPayoutsFor,
  approvePayout,
  markPayoutPaid,
  cancelPayout,
  openReceivablesFor,
  statementFor,
  walletFor,
  postLedger,
  idempotencyKey,
  ROLE,
};
