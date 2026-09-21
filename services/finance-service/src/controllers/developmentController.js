const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const {
  sequelize, ExpenseType, AccountingPolicy, LedgerAccount,
} = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { postEvent } = require('../../../../shared/src/accounting/posting');
const { BASIS, projectCost } = require('../services/developmentCost');

/**
 * What a project cost, and where that cost is (ACC-10).
 *
 * ── The commercial feature that happens to be an accounting requirement ─────
 *
 * Once costs capitalise by project and release by unit, gross margin per
 * project and per unit falls out of the ledger instead of out of a
 * spreadsheet. That is the single number a developer most wants and least
 * reliably has — and it is the strongest argument for keeping the books here
 * rather than anywhere else.
 *
 * ── Three postings, and none of them is automatic ───────────────────────────
 *
 * Costs reach work in progress on their own, when a bill of a capitalisable
 * type is approved. Getting them OUT is always somebody's decision: a
 * handover releases a unit's share (ACC-8, posted there); a catch-up releases
 * what landed after a unit was already gone; a write-down says the project is
 * worth less than it cost. The last two are offered here with the figure
 * computed and the reason required, because each is a judgement an auditor
 * will ask a person about.
 */

const scope = (req) => buildCompanyScope(req);

const companyOf = (req) => (req.user?.isSuperiorAdmin
  ? (req.body?.company_id ?? req.query?.company_id ?? null)
  : (req.user?.company_id ?? null));

// ── Cost types (ACC-10.2) ───────────────────────────────────────────────────

const listExpenseTypes = asyncHandler(async (req, res) => {
  const where = { ...scope(req) };
  if (req.query.active === 'true') where.is_active = true;
  const rows = await ExpenseType.findAll({
    where,
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });
  res.json({ data: rows });
});

const createExpenseType = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'A cost type needs a name.' });

  const type = await ExpenseType.create({
    company_id: companyOf(req),
    name,
    capitalisable: Boolean(req.body.capitalisable),
    account_id: req.body.account_id || null,
    note: req.body.note || null,
    is_active: req.body.is_active === undefined ? true : Boolean(req.body.is_active),
    sort_order: Number(req.body.sort_order) || 99,
    created_by: req.user?.id ?? null,
  });
  res.status(201).json({ data: type });
});

/**
 * Editing a type changes what happens NEXT, never what already happened.
 *
 * Bills that have posted carry their own frozen `capitalise`, so turning a
 * type capitalisable today does not reach back and move last quarter's costs
 * onto the balance sheet. That is said out loud in the response because it is
 * the first thing somebody assumes the opposite of.
 */
const updateExpenseType = asyncHandler(async (req, res) => {
  const type = await ExpenseType.findOne({ where: { id: req.params.id, ...scope(req) } });
  if (!type) return res.status(404).json({ message: 'Cost type not found' });

  const was = type.capitalisable;
  await type.update({
    ...req.body,
    id: type.id,
    company_id: type.company_id,
    name: req.body.name === undefined ? type.name : String(req.body.name).trim(),
  });

  const [{ n } = { n: 0 }] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM bills WHERE expense_type_id = :id',
    { replacements: { id: type.id }, type: QueryTypes.SELECT },
  );

  res.json({
    data: type,
    message: was !== type.capitalisable && Number(n) > 0
      ? `Changed for bills raised from now on. The ${n} bill(s) already raised against `
        + `"${type.name}" keep the treatment they posted with.`
      : undefined,
  });
});

// ── Project accounting policy (ACC-8.2, ACC-10.3) ───────────────────────────

const listPolicies = asyncHandler(async (req, res) => {
  const rows = await AccountingPolicy.findAll({
    where: scope(req),
    order: [['scope', 'ASC'], ['property_id', 'ASC']],
  });
  res.json({ data: rows });
});

const SCOPES = ['company', 'property_type', 'property'];

/**
 * Set — or clear — the policy for one target.
 *
 * Upserted on the target rather than created each time, because "the policy
 * for Favour City Epe" is one fact and a second row stating it differently
 * would make the resolution order decide which is true.
 */
const savePolicy = asyncHandler(async (req, res) => {
  const policyScope = String(req.body.scope || 'company');
  if (!SCOPES.includes(policyScope)) {
    return res.status(400).json({ message: 'A policy applies to the company, a property type, or one property.' });
  }
  if (policyScope === 'property' && !req.body.property_id) {
    return res.status(400).json({ message: 'Say which property.' });
  }
  if (policyScope === 'property_type' && !req.body.property_type) {
    return res.status(400).json({ message: 'Say which kind of property.' });
  }

  const recognition = req.body.revenue_recognition || null;
  if (recognition && !['ON_INVOICE', 'ON_HANDOVER'].includes(recognition)) {
    return res.status(400).json({ message: 'Revenue is recognised on invoice or on handover.' });
  }
  const basis = req.body.cost_allocation_basis || null;
  if (basis && !Object.values(BASIS).includes(basis)) {
    return res.status(400).json({ message: 'Cost divides by saleable area or by sales value.' });
  }

  const target = {
    company_id: companyOf(req),
    scope: policyScope,
    property_id: policyScope === 'property' ? req.body.property_id : null,
    property_type: policyScope === 'property_type' ? String(req.body.property_type) : null,
  };

  const [policy] = await AccountingPolicy.findOrCreate({ where: target, defaults: target });
  await policy.update({
    revenue_recognition: recognition,
    cost_allocation_basis: basis,
    updated_by: req.user?.id ?? null,
  });

  res.json({ data: policy });
});

/**
 * ACC-10.5 — state what the project is now expected to fetch.
 *
 * Recorded as its own act, separate from the write-down it may justify: an
 * estimate that turns out not to require a write-down is still worth having
 * made, and dating it is what lets somebody see the test was performed rather
 * than assumed.
 */
const assessNrv = asyncHandler(async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  if (!propertyId) return res.status(400).json({ message: 'Say which project.' });

  const proceeds = req.body.nrv_proceeds_minor;
  if (proceeds === undefined || proceeds === null || proceeds === '') {
    return res.status(400).json({ message: 'Say what the project is now expected to fetch, net of what it will cost to finish and sell.' });
  }

  const target = {
    company_id: companyOf(req), scope: 'property', property_id: propertyId, property_type: null,
  };
  const [policy] = await AccountingPolicy.findOrCreate({ where: target, defaults: target });
  await policy.update({
    nrv_proceeds_minor: Math.max(Math.round(Number(proceeds)), 0),
    nrv_assessed_at: new Date(),
    nrv_note: req.body.note || null,
    updated_by: req.user?.id ?? null,
  });

  const project = await projectCost(sequelize, { companyId: target.company_id, propertyId });
  res.json({ data: project });
});

// ── The report (ACC-10.6) ───────────────────────────────────────────────────

/**
 * Every project carrying development cost, with what is left in it.
 *
 * Driven from the ledger rather than from the property list: a project shows
 * here because money was capitalised against it, which is also what makes
 * this the reconciliation of the WIP control account rather than a second
 * opinion about it. The totals across projects must equal the account's
 * balance, and period close checks exactly that.
 */
const wipReport = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);

  const projects = await sequelize.query(
    `SELECT l.property_id AS property_id, p.name AS property_name, p.type AS property_type,
            COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
       LEFT JOIN properties p ON p.id = l.property_id
      WHERE a.role = 'DEVELOPMENT_WIP'
        AND l.property_id IS NOT NULL
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY l.property_id, p.name, p.type
      ORDER BY p.name`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );

  const rows = [];
  for (const project of projects) {
    // eslint-disable-next-line no-await-in-loop
    const detail = await projectCost(sequelize, { companyId, propertyId: project.property_id });
    rows.push({
      ...detail,
      property_name: project.property_name,
      property_type: project.property_type,
    });
  }

  /*
   * What is in the account, read independently of the per-project sum.
   *
   * Two routes to the same number, deliberately. If they disagree, something
   * has been posted to development WIP with no property on the line — which
   * is a real defect, because such a cost belongs to no project and can never
   * be released. Better surfaced in the report that exists to prove the
   * control account than found at year end.
   */
  const [control] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN ledger_accounts a ON a.id = l.account_id
      WHERE a.role = 'DEVELOPMENT_WIP'
        AND e.company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );

  const allocatedTotal = rows.reduce((sum, row) => sum + row.movements.balance_minor, 0);
  const controlBalance = Number(control?.balance || 0);

  res.json({
    data: {
      projects: rows,
      control_balance_minor: controlBalance,
      projects_balance_minor: allocatedTotal,
      unassigned_minor: controlBalance - allocatedTotal,
      catch_up_minor: rows.reduce((sum, row) => sum + row.catch_up_minor, 0),
    },
  });
});

const projectDetail = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.query.company_id ?? null) : (req.user?.company_id ?? null);
  const data = await projectCost(sequelize, { companyId, propertyId: req.params.propertyId });
  res.json({ data });
});

// ── Getting cost out of WIP ─────────────────────────────────────────────────

/**
 * ACC-10.4, afterwards — release what landed after the units had gone.
 *
 * The amount is computed, not typed: it is the difference between what each
 * handed-over unit is allocated now and what was released at the time. A
 * figure somebody could type would be a figure somebody could choose, and
 * this one goes straight to gross margin.
 */
const postCatchUp = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id ?? null) : (req.user?.company_id ?? null);
  const propertyId = Number(req.params.propertyId);

  const project = await projectCost(sequelize, { companyId, propertyId });
  if (!project.catch_up_minor) {
    return res.status(409).json({
      message: 'Nothing to release. Every handed-over unit has already been charged its share.',
    });
  }

  const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);
  const result = await postEvent(sequelize, {
    rule: 'cost_catch_up',
    companyId,
    entryDate,
    source: 'cost_catch_up',
    /*
     * Keyed by project and date rather than by a row id, because there is no
     * row — this posting has no document behind it. Two catch-ups on the same
     * project on the same day are the same act, and the idempotency key makes
     * the second one a no-op rather than a double charge to cost of sales.
     */
    sourceId: `${propertyId}:${entryDate}`,
    memo: `Cost catch-up on project ${propertyId} — costs landing after handover`,
    createdBy: req.user?.id ?? null,
    input: {
      amountMinor: project.catch_up_minor,
      dimensions: { property_id: propertyId },
    },
  });

  if (result?.skipped) {
    return res.status(409).json({
      message: result.skipped === 'posting_disabled'
        ? 'This company is not posting to the ledger yet, so there is nothing to release.'
        : `Nothing was posted (${result.skipped}).`,
    });
  }

  /*
   * The handover rows are caught up too, so the NEXT run does not offer the
   * same money again. The journal is the record; these figures are what the
   * catch-up is measured against next time.
   */
  for (const unit of project.units.filter((u) => u.outstanding_minor !== 0)) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `UPDATE handovers SET cost_released_minor = cost_released_minor + :amount, updated_at = NOW()
        WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}
          AND property_unit_id = :unitId AND status = 'recorded'`,
      {
        replacements: { amount: unit.outstanding_minor, companyId, unitId: unit.unit_id },
        type: QueryTypes.UPDATE,
      },
    );
  }

  res.json({
    data: await projectCost(sequelize, { companyId, propertyId }),
    message: `Released to cost of sales. Journal ${result?.reference ?? ''}`.trim(),
  });
});

/**
 * ACC-10.5 — write the project down to what it will fetch.
 *
 * Refused unless an assessment has been recorded, and refused when the
 * assessment does not call for one. A write-down that somebody can enter
 * freehand is an earnings lever; a write-down that follows from a stated
 * expectation is an accounting estimate.
 */
const postWriteDown = asyncHandler(async (req, res) => {
  const companyId = req.user?.isSuperiorAdmin
    ? (req.body.company_id ?? null) : (req.user?.company_id ?? null);
  const propertyId = Number(req.params.propertyId);

  const project = await projectCost(sequelize, { companyId, propertyId });
  if (project.policy.nrv_proceeds_minor == null) {
    return res.status(422).json({
      message: 'Record what the project is now expected to fetch first. A write-down follows from that figure, not from a number typed here.',
    });
  }
  if (!project.nrv_shortfall_minor) {
    return res.status(409).json({
      message: 'The project is carried below what it is expected to fetch, so no write-down is due.',
    });
  }

  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ message: 'Say why. A write-down is an estimate somebody has to stand behind.' });
  }

  const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);
  const result = await postEvent(sequelize, {
    rule: 'write_down',
    companyId,
    entryDate,
    source: 'write_down',
    sourceId: `${propertyId}:${entryDate}`,
    memo: `Write-down on project ${propertyId} — ${reason.slice(0, 160)}`,
    createdBy: req.user?.id ?? null,
    input: {
      amountMinor: project.nrv_shortfall_minor,
      dimensions: { property_id: propertyId },
    },
  });

  if (result?.skipped) {
    return res.status(409).json({
      message: result.skipped === 'posting_disabled'
        ? 'This company is not posting to the ledger yet.'
        : `Nothing was posted (${result.skipped}).`,
    });
  }

  res.json({
    data: await projectCost(sequelize, { companyId, propertyId }),
    message: 'Written down to net realisable value.',
  });
});

/** The accounts a cost type can code to — expenses and assets only. */
const codingAccounts = asyncHandler(async (req, res) => {
  const rows = await LedgerAccount.findAll({
    where: { ...scope(req), is_active: true },
    order: [['code', 'ASC']],
  });
  res.json({ data: rows.filter((row) => ['expense', 'asset'].includes(row.type)) });
});

module.exports = {
  listExpenseTypes,
  createExpenseType,
  updateExpenseType,
  listPolicies,
  savePolicy,
  assessNrv,
  wipReport,
  projectDetail,
  postCatchUp,
  postWriteDown,
  codingAccounts,
};
