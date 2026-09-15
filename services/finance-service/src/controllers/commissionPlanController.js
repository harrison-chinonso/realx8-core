const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { buildCompanyScope } = require('../utils/crudFactory');
const { validatePlan } = require('../../../../shared/src/commission/validate');
const { applyDeductions } = require('../../../../shared/src/commission/deductions');
const { calculate } = require('../../../../shared/src/commission');
const { ENGINE_VERSION, computeForDeal } = require('../../../../shared/src/commissionStore');
const { asMinor } = require('../../../../shared/src/money');

/**
 * Managing commission plans, their versions, and what a plan would cost.
 *
 * ── The whole point of this file ────────────────────────────────────────────
 *
 * §5.1: a company's structure should be composed in the admin UI, not deployed.
 * Until something could CREATE a plan, the engine was a calculator with no way
 * to tell it the rules — the tables existed and only a hand-written INSERT
 * could fill them.
 *
 * ── Draft, then activate, and never edit what is live ───────────────────────
 *
 * A version is immutable once active (§5.6, FR-CFG-002), because a deal resolves
 * the version in force at its attribution date and restating that later would
 * silently change what old deals paid. So editing an active plan does not
 * update anything: it writes a NEW version, and closes the previous one at the
 * moment the new one begins. The history is the audit trail.
 */

const companyScope = (req) => buildCompanyScope(req);

/** A platform admin has no company of their own; everyone else has exactly one. */
const companyOf = (req) => {
  const scope = companyScope(req);
  if (Object.prototype.hasOwnProperty.call(scope, 'company_id')) return scope.company_id;
  return req.body?.company_id ?? req.query?.company_id ?? null;
};


/**
 * The realtor levels a plan's rates are judged against.
 *
 * Global levels (company_id IS NULL) plus the company's own, which is the same
 * set the Realtor Levels screen shows and the same set the engine will meet at
 * calculation time. Passed into validatePlan so it can tell whether a level
 * that the plan does not name would fall back to a rate that exists — the check
 * cannot be made inside the validator, which is pure and knows nothing about
 * this company.
 *
 * Never throws: a plan is still checkable for everything else if this lookup
 * fails, and validatePlan says plainly when it could not see the levels.
 */
const levelsFor = async (companyId) => {
  try {
    return await sequelize.query(
      `SELECT id, name, commission_percentage
         FROM realtor_levels
        WHERE is_active IS TRUE
          AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})
        ORDER BY position ASC, id ASC`,
      { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
    );
  } catch (error) {
    console.error('[commission-plans] could not read realtor levels:', error.message);
    return null;
  }
};


/**
 * The company filter for a plan query, and the one that was wrong.
 *
 * `companyOf` returns null for two completely different callers: a PLATFORM
 * admin, who has no company and may act across all of them, and an ordinary
 * user whose account carries no company. Every query below turned that null
 * into `company_id IS NULL`, so a platform admin saw only plans belonging to no
 * company — never a company's own. They could not list, open, version, archive
 * or assign anything a company admin had created.
 *
 * The two cases are told apart here:
 *
 *   platform admin, no company_id asked for  -> no filter at all
 *   platform admin, ?company_id=N            -> that company
 *   anybody else                             -> their own company
 *
 * The SQL is returned rather than a value, because "no filter" cannot be
 * expressed as one.
 */
const isPlatformAdmin = (req) => req.user?.isSuperiorAdmin === true
  || req.user?.type === 'superior_admin';

const planScope = (req, column = 'company_id') => {
  const asked = req.query?.company_id ?? req.body?.company_id ?? null;

  if (isPlatformAdmin(req)) {
    return asked
      ? { sql: `${column} = :companyId`, companyId: Number(asked) }
      : { sql: '1 = 1', companyId: null };
  }

  const own = req.user?.company_id ?? null;
  return own
    ? { sql: `${column} = :companyId`, companyId: own }
    : { sql: `${column} IS NULL`, companyId: null };
};

const parseConfig = (row) => {
  try {
    return JSON.parse(row.config);
  } catch {
    return null;
  }
};

// ── Plans ───────────────────────────────────────────────────────────────────

const listPlans = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const scope = planScope(req, 'p.company_id');
  const plans = await sequelize.query(
    `SELECT p.id, p.name, p.description, p.is_default, p.scope_type, p.scope_id,
            p.status, p.created_at, p.company_id,
            (SELECT c.name FROM companies c WHERE c.id = p.company_id) AS company_name,
            (SELECT COUNT(*) FROM commission_plan_versions v WHERE v.plan_id = p.id) AS version_count,
            (SELECT MAX(v.version) FROM commission_plan_versions v
              WHERE v.plan_id = p.id AND v.status = 'active') AS live_version
       FROM commission_plans p
      WHERE ${scope.sql}
      ORDER BY p.is_default DESC, p.name ASC`,
    { replacements: { companyId: scope.companyId }, type: QueryTypes.SELECT },
  );

  res.json({ data: plans });
});

const getPlan = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const [plan] = await sequelize.query(
    `SELECT * FROM commission_plans
      WHERE id = :id AND ${planScope(req).sql}
      LIMIT 1`,
    { replacements: { id: req.params.id, companyId: planScope(req).companyId }, type: QueryTypes.SELECT },
  );
  if (!plan) return res.status(404).json({ message: 'Commission plan not found' });

  const versions = await sequelize.query(
    `SELECT id, version, effective_from, effective_to, status, engine_version,
            created_by, approved_by, approved_at, created_at, config
       FROM commission_plan_versions
      WHERE plan_id = :planId
      ORDER BY version DESC`,
    { replacements: { planId: plan.id }, type: QueryTypes.SELECT },
  );

  res.json({
    data: {
      ...plan,
      versions: versions.map((version) => ({ ...version, config: parseConfig(version) })),
    },
  });
});

/**
 * A plan, with its first version as a draft.
 *
 * Created as a draft deliberately. An active plan starts paying the moment a
 * deal resolves it, and a structure typed into a form and saved is not yet a
 * decision — FR-CFG-006 exists for the same reason. Activation is its own act.
 */
const createPlan = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const { name, description, config, scope_type: scopeType, scope_id: scopeId } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: 'Give the plan a name.' });
  }

  const verdict = validatePlan(config || {}, {
    guardrail_percentage: req.body.guardrail_percentage,
    realtor_levels: await levelsFor(companyOf(req)),
  });

  const result = await sequelize.transaction(async (transaction) => {
    /**
     * Only one default per company. A second one would make which plan a deal
     * resolves depend on row order, which is the kind of ambiguity that shows
     * up as "some deals pay differently" months later.
     */
    const isDefault = req.body.is_default === true || req.body.is_default === 'true';
    if (isDefault) {
      await sequelize.query(
        `UPDATE commission_plans SET is_default = ${sequelize.getDialect() === 'postgres' ? 'FALSE' : '0'}
          WHERE company_id ${companyId == null ? 'IS NULL' : '= :companyId'}`,
        { replacements: { companyId }, type: QueryTypes.UPDATE, transaction },
      );
    }

    await sequelize.query(
      `INSERT INTO commission_plans
         (company_id, name, description, is_default, scope_type, scope_id, status, created_by, created_at)
       VALUES (:companyId, :name, :description, :isDefault, :scopeType, :scopeId, 'draft', :createdBy, NOW())`,
      {
        replacements: {
          companyId,
          name: String(name).trim().slice(0, 120),
          description: description || null,
          isDefault,
          scopeType: scopeType || null,
          scopeId: scopeId || null,
          createdBy: req.user?.id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    const [created] = await sequelize.query(
      `SELECT id FROM commission_plans
        WHERE company_id ${companyId == null ? 'IS NULL' : '= :companyId'} AND name = :name
        ORDER BY id DESC LIMIT 1`,
      { replacements: { companyId, name: String(name).trim().slice(0, 120) }, type: QueryTypes.SELECT, transaction },
    );

    await sequelize.query(
      `INSERT INTO commission_plan_versions
         (plan_id, company_id, version, effective_from, status, config, engine_version, created_by, created_at)
       VALUES (:planId, :companyId, 1, NOW(), 'draft', :config, :engine, :createdBy, NOW())`,
      {
        replacements: {
          planId: created.id,
          companyId,
          config: JSON.stringify(config || {}),
          engine: ENGINE_VERSION,
          createdBy: req.user?.id ?? null,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );

    return created.id;
  });

  res.status(201).json({
    data: { id: result, status: 'draft' },
    validation: verdict,
    message: verdict.ok
      ? 'Plan created as a draft. Activate it when you are ready for it to start paying.'
      : 'Plan saved as a draft, but it cannot be activated until the problems below are fixed.',
  });
});

/**
 * A new DRAFT version of an existing plan.
 *
 * The only way to change a plan that has ever been active. Nothing updates a
 * live version, so a deal already computed can never be restated by an edit.
 */
const createVersion = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const [plan] = await sequelize.query(
    `SELECT id FROM commission_plans
      WHERE id = :id AND ${planScope(req).sql} LIMIT 1`,
    { replacements: { id: req.params.id, companyId: planScope(req).companyId }, type: QueryTypes.SELECT },
  );
  if (!plan) return res.status(404).json({ message: 'Commission plan not found' });

  const verdict = validatePlan(req.body.config || {}, {
    guardrail_percentage: req.body.guardrail_percentage,
    realtor_levels: await levelsFor(companyId),
  });

  const [{ next }] = await sequelize.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM commission_plan_versions WHERE plan_id = :planId',
    { replacements: { planId: plan.id }, type: QueryTypes.SELECT },
  );

  await sequelize.query(
    `INSERT INTO commission_plan_versions
       (plan_id, company_id, version, effective_from, status, config, engine_version, created_by, created_at)
     VALUES (:planId, :companyId, :version, :from, 'draft', :config, :engine, :createdBy, NOW())`,
    {
      replacements: {
        planId: plan.id,
        companyId,
        version: next,
        from: req.body.effective_from ? new Date(req.body.effective_from) : new Date(),
        config: JSON.stringify(req.body.config || {}),
        engine: ENGINE_VERSION,
        createdBy: req.user?.id ?? null,
      },
      type: QueryTypes.INSERT,
    },
  );

  res.status(201).json({ data: { plan_id: plan.id, version: next, status: 'draft' }, validation: verdict });
});

/**
 * Make a draft version live.
 *
 * Refuses a version the validator rejects (FR-CFG-007, FR-CFG-008) — a plan
 * that cannot be calculated must not be allowed to start paying, and the
 * guardrail breach is overridable only by someone who says so explicitly.
 *
 * Closes the previous live version at the instant this one begins, so the two
 * cannot overlap (FR-CFG-003). Overlapping periods would make which version a
 * deal resolves depend on ordering.
 */
const activateVersion = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const scope = planScope(req, 'p.company_id');
  const [version] = await sequelize.query(
    `SELECT v.*, p.company_id AS plan_company
       FROM commission_plan_versions v
       JOIN commission_plans p ON p.id = v.plan_id
      WHERE v.id = :id AND ${scope.sql}
      LIMIT 1`,
    {
      replacements: { id: req.params.versionId, companyId: scope.companyId },
      type: QueryTypes.SELECT,
    },
  );
  if (!version) return res.status(404).json({ message: 'Plan version not found' });
  if (version.status === 'active') {
    return res.status(409).json({ message: 'That version is already live.' });
  }

  const config = parseConfig(version);
  if (!config) {
    return res.status(422).json({ message: 'This version\'s configuration cannot be read, so it cannot be activated.' });
  }

  const verdict = validatePlan(config, {
    guardrail_percentage: req.body?.guardrail_percentage,
    realtor_levels: await levelsFor(companyOf(req)),
  });
  const override = req.body?.override_guardrail === true;
  const blocking = verdict.errors.filter((finding) => !(override && finding.overridable));

  if (blocking.length) {
    return res.status(422).json({
      message: 'This plan cannot be activated yet.',
      validation: verdict,
      blocking,
    });
  }

  const from = req.body?.effective_from ? new Date(req.body.effective_from) : new Date();

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `UPDATE commission_plan_versions
          SET effective_to = :from
        WHERE plan_id = :planId AND status = 'active' AND effective_to IS NULL`,
      { replacements: { planId: version.plan_id, from }, type: QueryTypes.UPDATE, transaction },
    );

    await sequelize.query(
      `UPDATE commission_plan_versions
          SET status = 'active', effective_from = :from, approved_by = :actor, approved_at = NOW()
        WHERE id = :id`,
      {
        replacements: { id: version.id, from, actor: req.user?.id ?? null },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );

    await sequelize.query(
      "UPDATE commission_plans SET status = 'active', updated_at = NOW() WHERE id = :planId",
      { replacements: { planId: version.plan_id }, type: QueryTypes.UPDATE, transaction },
    );
  });

  res.json({
    data: { id: version.id, status: 'active', effective_from: from },
    validation: verdict,
    message: 'This version is now live. Deals attributed from now on resolve it.',
  });
});

/** Stop a plan paying, without touching anything it has already computed. */

/**
 * Assign a plan to what it should pay for: a unit, a property, a project, a
 * campaign, or the company as a whole.
 *
 * ── Why assignment is its own action ────────────────────────────────────────
 *
 * A plan's RULES are immutable once a version is active, because a deal
 * resolves the version in force at its attribution date and rewriting one
 * restates what old deals paid. Where a plan APPLIES is a different kind of
 * fact: it is about which future sales the company wants it to cover, and
 * changing it must not require a new version of rules nobody edited.
 *
 * Deals already attributed keep the version they resolved to — the entitlement
 * stores `plan_version_id` — so moving a plan changes what happens next and
 * nothing that has already happened.
 */
const SCOPES = ['property', 'unit', 'project', 'campaign'];

const assignPlan = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const [plan] = await sequelize.query(
    `SELECT id, company_id FROM commission_plans
      WHERE id = :id AND ${planScope(req).sql} LIMIT 1`,
    { replacements: { id: req.params.id, companyId: planScope(req).companyId }, type: QueryTypes.SELECT },
  );
  if (!plan) return res.status(404).json({ message: 'Commission plan not found' });

  const scopeType = req.body?.scope_type ? String(req.body.scope_type).toLowerCase() : null;
  const scopeId = req.body?.scope_id ?? null;
  const isDefault = Boolean(req.body?.is_default);

  if (scopeType && !SCOPES.includes(scopeType)) {
    return res.status(400).json({
      message: `A plan is assigned to one of: ${SCOPES.join(', ')} — or made the company default.`,
    });
  }
  if (scopeType && !scopeId) {
    return res.status(400).json({ message: `Choose which ${scopeType} this plan is for.` });
  }
  if (!scopeType && !isDefault) {
    return res.status(400).json({
      message: 'A plan has to apply to something: pick a property, unit, project or campaign, '
        + 'or make it the company default.',
    });
  }

  await sequelize.transaction(async (transaction) => {
    /**
     * One default per company. Demoting the previous one here rather than
     * refusing, because "make this the default" is unambiguous about what the
     * admin wants and an error telling them to go and unset the other one first
     * is a step with no decision in it.
     */
    if (!scopeType && isDefault) {
      /**
       * Scoped to the PLAN's company, not the caller's. A platform admin has no
       * company of their own, so using theirs would demote the platform-level
       * defaults and leave the company's own untouched — the opposite of what
       * was asked for.
       */
      await sequelize.query(
        `UPDATE commission_plans SET is_default = FALSE
          WHERE company_id ${plan.company_id == null ? 'IS NULL' : '= :planCompanyId'} AND id <> :id`,
        {
          replacements: { id: plan.id, planCompanyId: plan.company_id ?? null },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );
    }

    await sequelize.query(
      `UPDATE commission_plans
          SET scope_type = :scopeType, scope_id = :scopeId, is_default = :isDefault,
              updated_at = NOW()
        WHERE id = :id`,
      {
        replacements: {
          id: plan.id,
          scopeType,
          scopeId: scopeType ? Number(scopeId) : null,
          isDefault: !scopeType && isDefault,
        },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );
  });

  return res.json({
    success: true,
    data: {
      id: Number(plan.id),
      scope_type: scopeType,
      scope_id: scopeType ? Number(scopeId) : null,
      is_default: !scopeType && isDefault,
    },
  });
});

const archivePlan = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  const [affected] = await sequelize.query(
    `UPDATE commission_plans SET status = 'archived', is_default = ${sequelize.getDialect() === 'postgres' ? 'FALSE' : '0'}, updated_at = NOW()
      WHERE id = :id AND ${planScope(req).sql}`,
    { replacements: { id: req.params.id, companyId }, type: QueryTypes.UPDATE },
  );

  /**
   * Entitlements already accrued under it are untouched. Archiving says "stop
   * resolving this for new deals", not "undo what it paid" — the second is a
   * reversal and is a different, deliberate act.
   */
  res.json({ message: 'Plan archived. Deals already computed under it are unchanged.' });
});

// ── Checking a plan before trusting it ──────────────────────────────────────

/** The dry-run validator (FR-CFG-008), on a configuration that is not yet saved. */
const validateDraft = asyncHandler(async (req, res) => {
  res.json({
    data: validatePlan(req.body?.config || {}, {
      realtor_levels: await levelsFor(companyOf(req)),
      guardrail_percentage: req.body?.guardrail_percentage,
    }),
  });
});

/**
 * The deal simulator (FR-SIM-001).
 *
 * Runs the REAL engine — the same function a live calculation uses — over
 * inputs the caller supplies, and writes nothing (FR-SIM-005). That it is the
 * same function is the point: a separate simulation path would drift from the
 * engine it is meant to predict, and the drift would show up as a plan costing
 * something other than what the preview promised.
 */
const simulate = asyncHandler(async (req, res) => {
  const { config, price, unit_count: unitCount = 1, level_rate: levelRate = 6, generations = 3 } = req.body || {};

  if (!config) return res.status(400).json({ message: 'Send the plan configuration to simulate.' });
  const priceMinor = asMinor(req.body.price_minor ?? asMinor(Number(price || 0) * 100));
  if (priceMinor <= 0) return res.status(400).json({ message: 'Give the property a price to simulate against.' });

  const at = req.body.attribution_date || new Date().toISOString();
  /**
   * Synthetic participants: an active seller and a fully populated upline.
   *
   * Fully populated on purpose — this is the worst case the structure can cost
   * (FR-SIM-004), and a preview built from a sparse tree would understate it
   * exactly where an admin most needs the real number.
   */
  const active = (id) => ({
    id,
    name: id === 1 ? 'Selling realtor' : `Generation ${id - 1}`,
    level: { id: 1, code: 'SIMULATED', position: 3, direct_rate: Number(levelRate) },
    status_history: [{ status: 'active', effective_from: '2000-01-01T00:00:00Z' }],
  });

  const depth = Math.max(0, Math.min(Number(generations) || 0, 12));

  const result = calculate({
    deal: {
      id: 'SIMULATION',
      gross_price_minor: priceMinor,
      discount_minor: asMinor(req.body.discount_minor || 0),
      unit_count: Number(unitCount) || 1,
      attribution_date: at,
      selling_realtor: active(1),
      co_agents: [],
    },
    plan: config,
    ancestors: Array.from({ length: depth }, (unused, index) => active(index + 2)),
    components: req.body.components || [],
  });

  /**
   * What the selling realtor is actually PAID, once the plan's taxes and
   * charges come off.
   *
   * Computed here, by the same function the payout run uses, rather than in the
   * browser. The order these are applied in changes the answer — withholding on
   * the gross then a fee on the remainder is not the same as both on the gross
   * — so a second implementation would agree with this one right up until a
   * company configured the combination that distinguishes them, and then it
   * would quietly promise a figure the payout did not deliver.
   *
   * Applied to the seller's own entitlement, not to the pool: a charge is taken
   * from what a person receives, and the pool is not a thing anybody receives.
   */
  const charges = (config.deductions || []).filter((entry) => entry && entry.is_active !== false);
  const direct = (result.entitlements || []).find((line) => line.role === 'DIRECT');
  const net = charges.length && direct
    ? applyDeductions(direct.constrained_minor, charges)
    : null;

  res.json({
    data: {
      ...result,
      // What the structure costs as a proportion of the sale — the figure an
      // admin is actually deciding on (FR-ANL-001).
      cost_ratio: priceMinor > 0 ? result.allocated_minor / priceMinor : 0,
      net_to_seller: net,
    },
    validation: validatePlan(config, {
      guardrail_percentage: req.body.guardrail_percentage,
      realtor_levels: await levelsFor(companyOf(req)),
    }),
  });
});

/** What a REAL deal would produce, without writing any of it. */
const previewDeal = asyncHandler(async (req, res) => {
  const { result, planVersion, skipped } = await computeForDeal(sequelize, {
    ...req.body,
    company_id: companyOf(req),
  });
  if (skipped) return res.status(422).json({ message: `Cannot preview: ${skipped}` });
  res.json({ data: result, plan_version: { id: planVersion.id, name: planVersion.plan_name } });
});

module.exports = {
  listPlans, getPlan, createPlan, createVersion, activateVersion, archivePlan,
  assignPlan, validateDraft, simulate, previewDeal,
};
