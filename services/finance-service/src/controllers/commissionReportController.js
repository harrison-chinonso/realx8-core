const asyncHandler = require('../utils/asyncHandler');
const { insertReturningId } = require('../../../../shared/src/dialect');
const { sequelize } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const analytics = require('../../../../shared/src/commissionAnalytics');
const { asMinor, toMajor } = require('../../../../shared/src/money');
const { nextNumber } = require('../../../../shared/src/documentSequence');
const store = require('../../../../shared/src/commissionStore');
const {
  realtorVerification, realtorBlockedMessage, staffBlockedMessage,
} = require('../../../../shared/src/realtorVerification');

/**
 * What the engine has cost, what it still owes, and what it would pay a
 * realtor — plus the payout run itself (§8, FR-ANL-*, FR-PAY-*).
 *
 * ── Company scope is applied HERE and not left to the caller ────────────────
 *
 * Every function in commissionAnalytics takes a companyId and will happily
 * report across all of them when given none — which is correct for a platform
 * admin and a data leak for anybody else. The scope comes from
 * `buildCompanyScope`, the same helper the rest of finance uses, so a company
 * admin cannot widen it by passing a query parameter: a caller who HAS a
 * company gets theirs, and only a caller with none may ask for another.
 */

const companyOf = (req) => {
  const scope = buildCompanyScope(req);
  if (Object.prototype.hasOwnProperty.call(scope, 'company_id')) return scope.company_id;
  return req.query?.company_id ?? req.body?.company_id ?? null;
};

/** The window every report shares. */
const windowOf = (req) => ({
  companyId: companyOf(req),
  from: req.query.from || null,
  to: req.query.to || null,
});

const summary = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.summaryFor(sequelize, windowOf(req)) });
});

const breakage = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.breakageFor(sequelize, windowOf(req)) });
});

const costOfSale = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.costOfSaleFor(sequelize, windowOf(req)) });
});

const leaderboard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.leaderboardFor(sequelize, windowOf(req)) });
});

const liability = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analytics.liabilityFor(sequelize, windowOf(req)) });
});

const glExport = asyncHandler(async (req, res) => {
  const data = await analytics.glExportFor(sequelize, windowOf(req));
  /**
   * An unbalanced export is returned WITH its imbalance rather than refused.
   *
   * The accountant asking for it needs to see the figures to find out what is
   * wrong; a 500 would tell them only that something is. `balanced` is on the
   * payload precisely so a consumer cannot mistake one for the other.
   */
  res.json({ success: true, data });
});

/**
 * What a candidate plan would have cost over deals already closed (FR-SIM-001).
 *
 * A POST because the plan is a document in the body, not because anything is
 * written — the backtest writes nothing at all (FR-SIM-005).
 */
const backtest = asyncHandler(async (req, res) => {
  const plan = req.body?.plan || req.body?.config;
  if (!plan) {
    return res.status(400).json({ success: false, message: 'A candidate plan is required.' });
  }
  const data = await analytics.backtest(sequelize, { ...windowOf(req), plan });
  return res.json({ success: true, data });
});

/**
 * Patterns the screening raised, for somebody to look at (§7.14).
 *
 * OPEN first and worst first, because the list is read top-down and the worst
 * thing outstanding is the only item that matters if nothing else gets read.
 */
const listFlags = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const where = [];
  const replacements = {};
  if (companyId) { where.push('company_id = :companyId'); replacements.companyId = companyId; }
  where.push(req.query.status ? 'status = :status' : "status = 'OPEN'");
  if (req.query.status) replacements.status = req.query.status;

  const rows = await sequelize.query(
    `SELECT id, deal_ref, realtor_id, code, severity, summary, evidence, status,
            reviewed_at, review_note, created_at
       FROM commission_flags
      WHERE ${where.join(' AND ')}
      ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
               created_at DESC`,
    { replacements, type: require('sequelize').QueryTypes.SELECT },
  );

  res.json({
    success: true,
    data: rows.map((row) => ({
      ...row,
      evidence: (() => { try { return JSON.parse(row.evidence); } catch { return null; } })(),
    })),
  });
});

/**
 * A human's verdict on a flag.
 *
 * DISMISSED and CONFIRMED are both closures and both meaningful: a pattern
 * dismissed once is a pattern somebody has already judged, and re-raising it as
 * new on the next deal would train the reviewer to ignore the list.
 */
const reviewFlag = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!['REVIEWED', 'DISMISSED', 'CONFIRMED'].includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'A flag is reviewed, dismissed or confirmed.',
    });
  }

  const [, changed] = await sequelize.query(
    `UPDATE commission_flags
        SET status = :status, reviewed_by = :userId, reviewed_at = NOW(),
            review_note = :note, updated_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: req.params.id,
        status,
        userId: req.user?.id ?? null,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : null,
      },
      type: require('sequelize').QueryTypes.UPDATE,
    },
  );
  if (!changed) return res.status(404).json({ success: false, message: 'No such flag.' });
  return res.json({ success: true, data: { id: Number(req.params.id), status } });
});

// ── Payout runs ─────────────────────────────────────────────────────────────

const listPayouts = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const where = [];
  const replacements = {};
  if (companyId) { where.push('company_id = :companyId'); replacements.companyId = companyId; }
  if (req.query.status) { where.push('status = :status'); replacements.status = req.query.status; }
  if (req.query.realtor_id) { where.push('realtor_id = :realtorId'); replacements.realtorId = req.query.realtor_id; }

  const rows = await sequelize.query(
    /**
     * `advice` is selected, and its absence was not cosmetic.
     *
     * The list drives the payout screen, and the screen renders the advice —
     * gross, each deduction, any recovery, net — from this row. Without the
     * column the modal opened empty, and because the "record as paid" form sits
     * inside that block, an APPROVED batch could never be marked paid. One
     * missing column, two dead controls.
     */
    `SELECT id, batch_ref, realtor_id, gross_minor, deductions_minor, recovered_minor,
            net_minor, status, advice, approved_at, paid_at, payment_reference, created_at
       FROM commission_payouts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC`,
    { replacements, type: require('sequelize').QueryTypes.SELECT },
  );
  res.json({
    success: true,
    data: rows.map((row) => ({
      ...row,
      advice: (() => { try { return JSON.parse(row.advice); } catch { return null; } })(),
    })),
  });
});

const buildPayouts = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const result = await store.buildPayoutsFor(sequelize, {
    companyId,
    batchRef: req.body?.batch_ref || null,
    periodStart: req.body?.period_start || null,
    periodEnd: req.body?.period_end || null,
    realtorIds: req.body?.realtor_ids || null,
    // Lets an admin clear the request queue on its own, without building a run
    // for everybody who happens to be owed something.
    requestedOnly: req.body?.requested_only === true,
    createdBy: req.user?.id ?? null,
  });
  res.json({ success: true, data: result });
});

/**
 * How many payout requests are waiting, so an admin can see there are any.
 *
 * A request nobody knows about is the same as no request: the realtor believes
 * they have asked and the admin has nothing telling them so.
 */
const pendingPayoutRequests = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const rows = await sequelize.query(
    `SELECT e.realtor_id, u.name AS realtor_name,
            COUNT(*) AS line_count,
            SUM(e.released_minor - e.paid_minor) AS amount_minor,
            MIN(e.payout_requested_at) AS asked_at
       FROM commission_entitlements e
       LEFT JOIN users u ON u.id = e.realtor_id
      WHERE e.payout_requested_at IS NOT NULL
        AND e.released_minor > e.paid_minor
        ${companyId ? 'AND e.company_id = :companyId' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM commission_payout_lines pl
            JOIN commission_payouts po ON po.id = pl.payout_id
           WHERE pl.entitlement_id = e.id AND po.status IN ('DRAFT', 'APPROVED')
        )
      GROUP BY e.realtor_id, u.name
      ORDER BY MIN(e.payout_requested_at) ASC`,
    { replacements: companyId ? { companyId } : {}, type: QueryTypes.SELECT },
  );
  res.json({ success: true, data: rows });
});

/**
 * Raise a debit note for a payout, so the money can go for approval.
 *
 * ── Why this is a button and not a form to fill in again ───────────────────
 *
 * The flow is: build a payout run, raise a note to credit the realtor, have it
 * approved, pay it, then come back and mark the commission paid. The middle
 * step is where an admin would otherwise retype a realtor, an amount and a
 * reference that the payout already knows — and every retyped amount is a
 * chance to pay the wrong one.
 *
 * The note is raised for the payout's NET, not its gross: net is what actually
 * leaves, after the plan's deductions and any recovery against an outstanding
 * receivable. Raising the gross would over-pay by exactly the amount the
 * company had already withheld.
 */
const raiseNoteForPayout = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const [payout] = await sequelize.query(
    `SELECT p.id, p.batch_ref, p.realtor_id, p.status, p.net_minor, p.company_id,
            u.name AS realtor_name
       FROM commission_payouts p
       LEFT JOIN users u ON u.id = p.realtor_id
      WHERE p.id = :id ${companyId ? 'AND p.company_id = :companyId' : ''}`,
    {
      replacements: { id: req.params.id, ...(companyId ? { companyId } : {}) },
      type: QueryTypes.SELECT,
    },
  );
  if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });

  /*
   * The same rule as raising a note by hand — a payout run must not be a way
   * around it. This is the door that would have been missed: the note is
   * created here rather than through the debit-note endpoint, so the guard
   * there never sees it.
   */
  const verification = await realtorVerification(sequelize, payout.realtor_id);
  if (!verification.verified) {
    return res.status(422).json({
      success: false,
      message: staffBlockedMessage(payout.realtor_name, verification.status),
      verification_status: verification.status || 'none',
    });
  }

  /**
   * Only from APPROVED. A draft payout is a proposal — raising a note against
   * one would put money into an approval queue for a batch that might still be
   * cancelled, and the note would be approved for an amount that no longer
   * exists.
   */
  if (payout.status !== 'APPROVED') {
    return res.status(409).json({
      success: false,
      message: payout.status === 'PAID'
        ? 'This payout has already been paid.'
        : `This payout is ${payout.status.toLowerCase()}. Approve it before raising a note.`,
    });
  }

  const [existing] = await sequelize.query(
    `SELECT id, debit_note_id, status FROM debit_notes
      WHERE source_payout_id = :payoutId LIMIT 1`,
    { replacements: { payoutId: payout.id }, type: QueryTypes.SELECT },
  ).catch(() => [null]);
  if (existing) {
    return res.status(409).json({
      success: false,
      message: `${existing.debit_note_id} has already been raised for this payout.`,
      data: existing,
    });
  }

  const amount = toMajor(asMinor(payout.net_minor));
  if (!(amount > 0)) {
    return res.status(422).json({ success: false, message: 'This payout has nothing left to pay.' });
  }

  const reference = await nextNumber(sequelize, {
    docType: 'debit_notes', table: 'debit_notes', field: 'debit_note_id',
    prefix: 'DN-', companyId: payout.company_id ?? companyId ?? null,
  });

  const id = await insertReturningId(
    sequelize,
    `INSERT INTO debit_notes
       (debit_note_id, client_id, party_type, amount, status, reason,
        source_payout_id, created_by, company_id, created_at)
     VALUES (:reference, :realtorId, 'realtor', :amount, 'pending_approval', :reason,
        :payoutId, :createdBy, :companyId, NOW())`,
    {
      replacements: {
        reference,
        realtorId: payout.realtor_id,
        amount,
        reason: `Commission payout ${payout.batch_ref} for ${payout.realtor_name || `realtor #${payout.realtor_id}`}.`,
        payoutId: payout.id,
        createdBy: req.user?.id ?? null,
        companyId: payout.company_id ?? companyId ?? null,
      },
    },
  );

  return res.status(201).json({
    success: true,
    data: { id, debit_note_id: reference, amount, status: 'pending_approval' },
  });
});

const approve = asyncHandler(async (req, res) => {
  const result = await store.approvePayout(sequelize, req.params.id, { userId: req.user?.id ?? null });
  if (!result.approved) {
    return res.status(409).json({ success: false, message: 'Only a draft payout can be approved.' });
  }
  return res.json({ success: true, data: result });
});

/**
 * Discard a draft or approved batch. An open payout holds its entitlements, so
 * without this a run built by mistake would block that money from ever being
 * batched again.
 */
const cancel = asyncHandler(async (req, res) => {
  const result = await store.cancelPayout(sequelize, req.params.id, { userId: req.user?.id ?? null });
  if (!result.cancelled) {
    return res.status(409).json({
      success: false,
      message: 'Only a draft or approved payout can be cancelled. A paid one is reversed, not deleted.',
    });
  }
  return res.json({ success: true, data: result });
});

const pay = asyncHandler(async (req, res) => {
  const result = await store.markPayoutPaid(sequelize, req.params.id, {
    reference: req.body?.reference || null,
    userId: req.user?.id ?? null,
  });
  if (result.skipped) {
    return res.status(409).json({ success: false, message: `Cannot pay: ${result.skipped}` });
  }
  return res.json({ success: true, data: result });
});

/**
 * A realtor's own statement (FR-PAY-008).
 *
 * Always the CALLER's own. A realtor asking for somebody else's earnings is not
 * a case this endpoint serves, and taking the id from the path would make the
 * authorisation a matter of remembering to check it.
 */
/**
 * Which money figures a realtor may see on their own statement, and which they
 * may not yet.
 *
 * ── The amount is WITHHELD, not blurred ─────────────────────────────────────
 *
 * A commission is created the moment a purchase is attributed, and the realtor
 * should see straight away that one is coming — silence for weeks reads as
 * "nothing happened" and generates a support call per sale. But the figure at
 * that point is provisional: a cap can re-prorate it when a later line lands on
 * the same deal, a revision can reduce it, a clawback can remove it. Showing a
 * provisional number is worse than showing none, because the realtor remembers
 * the first number they saw and treats every later correction as being cheated.
 *
 * So the amounts are removed from the RESPONSE rather than hidden by the
 * screen. Blurring in CSS leaves the figure in the payload, where anybody who
 * opens the network tab can read it — which makes the whole exercise
 * decorative, and worse, decorative in a way that looks deliberate.
 *
 * ── Where the line falls ────────────────────────────────────────────────────
 *
 * ACCRUED is "underway": earned in principle, not yet signed off. Anything
 * beyond it has been through release, which is the point at which the figure
 * stops moving on its own — and an admin approving a payout is acting on that
 * settled figure. From there the realtor sees everything.
 */
const PROVISIONAL_STATUSES = new Set(['ACCRUED']);

const MONEY_FIELDS = [
  'gross_minor', 'constrained_minor', 'released_minor', 'held_minor',
  'paid_minor', 'forfeited_minor', 'clawed_back_minor',
];

/** The statement as the earner may see it. */
const forEarner = (data) => ({
  ...data,
  entitlements: (data.entitlements || []).map((line) => {
    if (!PROVISIONAL_STATUSES.has(String(line.status || '').toUpperCase())) {
      return { ...line, amount_visible: true };
    }
    const hidden = { ...line, amount_visible: false };
    MONEY_FIELDS.forEach((field) => { delete hidden[field]; });
    return hidden;
  }),
  /**
   * The wallet is a sum over the ledger, and the ledger only carries released
   * money — so it never contained a provisional figure to leak. Left as it is.
   */
});

const myStatement = asyncHandler(async (req, res) => {
  const realtorId = req.user?.realtor_id ?? req.user?.id ?? null;
  if (!realtorId) {
    return res.status(400).json({ success: false, message: 'No realtor is attached to this account.' });
  }
  const data = await store.statementFor(sequelize, realtorId, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  return res.json({ success: true, data: forEarner(data) });
});

/**
 * A realtor asking to be paid for particular commissions.
 *
 * Strictly their own — the id comes from the session, never from the body, so
 * there is no shape of request that asks for somebody else's money.
 */
const requestMyPayout = asyncHandler(async (req, res) => {
  const realtorId = req.user?.realtor_id ?? req.user?.id ?? null;
  if (!realtorId) {
    return res.status(400).json({ success: false, message: 'No realtor is attached to this account.' });
  }

  /*
   * Earning is not the same as being paid.
   *
   * An unverified realtor keeps accruing — nothing about their entitlements
   * changes — but cannot ask for the money. Checked before the selection is
   * even read, so the answer is about them rather than about which rows they
   * happened to tick, and worded so they know whether to submit, wait, or fix
   * a rejection.
   */
  const verification = await realtorVerification(sequelize, realtorId);
  if (!verification.verified) {
    return res.status(403).json({
      success: false,
      message: realtorBlockedMessage(verification.status),
      verification_status: verification.status || 'none',
    });
  }

  const ids = Array.isArray(req.body?.entitlement_ids) ? req.body.entitlement_ids : [];
  if (!ids.length) {
    return res.status(400).json({ success: false, message: 'Choose at least one commission to request.' });
  }

  const result = await store.requestPayoutFor(sequelize, { realtorId, entitlementIds: ids });

  if (!result.requested && result.not_payable === result.selected) {
    return res.status(422).json({
      success: false,
      message: 'None of those are ready to be paid yet. A commission can be requested once it has been released.',
    });
  }

  return res.json({ success: true, data: result });
});

const statementFor = asyncHandler(async (req, res) => {
  const data = await store.statementFor(sequelize, req.params.realtorId, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json({ success: true, data });
});

module.exports = {
  summary, breakage, costOfSale, leaderboard, liability, glExport, backtest,
  listFlags, reviewFlag,
  listPayouts, buildPayouts, approve, pay, cancel, myStatement, statementFor,
  requestMyPayout, pendingPayoutRequests, raiseNoteForPayout,
};
