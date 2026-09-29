/**
 * Why did (or didn't) this sale pay its realtor?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every gate between an approved payment and a payout request fails quietly,
 * by design — a commission problem must never undo a payment — so "the realtor
 * sees nothing" has a dozen possible causes and no error message. This walks
 * them in the order the application does and says which one stopped the sale:
 *
 *   the invoice → the buyer's realtor → which plan was in force when the
 *   invoice was raised → what the engine computes (rates, eligibility,
 *   exclusions) → what was actually stored → what has been released → whether
 *   the realtor can request it (verification, minimum payout).
 *
 * WRITES NOTHING. The engine is run through computeForDeal, which is the
 * calculation without the persistence — the same call the plan simulator
 * makes. To raise what it finds missing, use recalculate-commissions.js.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/explain-commission.js 81          # by invoice id
 *   node scripts/explain-commission.js INV-0011    # or by invoice reference
 *
 * It reads whatever database the environment points at.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../services/finance-service/src/models');
const { dealFromInvoice } = require('../services/finance-service/src/services/commissionBridge');
const {
  resolvePlanVersion, computeForDeal, vestingConfigFor, walletFor,
} = require('../shared/src/commissionStore');
const { readPaymentPlan } = require('../shared/src/paymentPlanGateway');
const { realtorVerification } = require('../shared/src/realtorVerification');
const { payoutThresholdMinor } = require('../shared/src/payoutThreshold');
const { asMinor, toMinor, toMajor } = require('../shared/src/money');

const target = process.argv[2];
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const col = (name) => (sequelize.getDialect() === 'postgres' ? `"${name}"` : `\`${name}\``);
const money = (minor) => toMajor(asMinor(minor)).toLocaleString(undefined, { minimumFractionDigits: 2 });
const day = (value) => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '—');

const blockers = [];
const ok = (text) => console.log(`  ✓ ${text}`);
const info = (text) => console.log(`    ${text}`);
const fail = (text, fix) => {
  console.log(`  ✗ ${text}`);
  if (fix) console.log(`      → ${fix}`);
  blockers.push(text);
};
const heading = (text) => console.log(`\n${text}`);

const main = async () => {
  if (!target) {
    console.log('Usage: node scripts/explain-commission.js <invoice id or reference>');
    process.exitCode = 1;
    return;
  }

  // ── 1. The invoice ────────────────────────────────────────────────────────
  const [invoice] = await q(
    `SELECT * FROM invoices WHERE ${/^\d+$/.test(target) ? 'id = :target' : 'invoice_id = :target'} LIMIT 1`,
    { target },
  );
  if (!invoice) {
    console.log(`No invoice ${target}.`);
    process.exitCode = 1;
    return;
  }
  heading(`1. Invoice ${invoice.invoice_id} (#${invoice.id})`);
  info(`status ${invoice.status}, company ${invoice.company_id ?? '—'}, raised ${day(invoice.created_at)}`);
  if (invoice.type === 'service_fee') fail('This is a service-fee invoice. Only property sales earn commission.');
  if (['cancelled', 'expired'].includes(invoice.status)) fail(`The invoice is ${invoice.status}.`);

  const payments = await q(
    `SELECT ip.id, ip.amount, ip.payment_method, ip.status, ip.created_at, r.id AS receipt_id
       FROM invoice_payments ip
       LEFT JOIN receipts r ON r.invoice_payment_id = ip.id
      WHERE ip.invoice_id = :id ORDER BY ip.id`,
    { id: invoice.id },
  );
  const paidMinor = payments.filter((p) => p.status === 'completed').reduce((t, p) => t + toMinor(p.amount), 0);
  const loaded = await readPaymentPlan(sequelize, invoice.id);
  const totalMinor = loaded ? asMinor(loaded.plan.total_minor) : toMinor(invoice.amount);
  const paidInFull = invoice.status === 'paid';
  if (!paidMinor) fail('No approved payments on this invoice yet.');
  else ok(`${money(paidMinor)} approved of ${money(totalMinor)}${paidInFull ? ' — paid in full' : ''}`);
  payments.forEach((p) => info(`payment #${p.id}: ${p.amount} by ${p.payment_method} on ${day(p.created_at)} — `
    + `${p.receipt_id ? `approved from receipt #${p.receipt_id}` : 'recorded from the invoice screen'}`));

  // ── 2. Who earns ──────────────────────────────────────────────────────────
  heading('2. The buyer\'s realtor');
  const [buyer] = await q('SELECT id, name, realtor_id, company_id FROM users WHERE id = :id', { id: invoice.client_id });
  let realtor = null;
  if (!buyer) fail(`Buyer #${invoice.client_id} does not exist.`);
  else if (!buyer.realtor_id) {
    fail(`${buyer.name} (#${buyer.id}) is not assigned to a realtor, so nobody earns on this sale.`,
      'Assign the buyer to their realtor, then recalculate this invoice.');
  } else {
    [realtor] = await q(
      `SELECT u.id, u.name, u.type, u.is_active, u.deleted_at, u.company_id, u.realtor_level_id,
              l.name AS level_name, l.commission_percentage AS level_rate
         FROM users u LEFT JOIN realtor_levels l ON l.id = u.realtor_level_id
        WHERE u.id = :id`,
      { id: buyer.realtor_id },
    );
    if (!realtor) fail(`The buyer points at realtor #${buyer.realtor_id}, who does not exist.`);
    else {
      ok(`${buyer.name} → ${realtor.name} (#${realtor.id}, ${realtor.type}, `
        + `${realtor.is_active ? 'active' : 'inactive'}${realtor.deleted_at ? ', DELETED' : ''})`);
      if (realtor.type !== 'realtor') fail(`User #${realtor.id} is a ${realtor.type}, not a realtor.`);
      if (invoice.company_id && realtor.company_id && Number(realtor.company_id) !== Number(invoice.company_id)) {
        fail(`The realtor belongs to company ${realtor.company_id}, the sale to company ${invoice.company_id}.`);
      }
      info(realtor.realtor_level_id
        ? `level "${realtor.level_name}", level rate ${realtor.level_rate ?? 'not set'}${realtor.level_rate == null ? '' : '%'}`
        : 'no realtor level');
    }
  }

  // ── 3. Which system, and which plan ───────────────────────────────────────
  const deal = await dealFromInvoice(invoice, totalMinor);
  const attributedAt = deal?.attribution_date || invoice.created_at;
  heading(`3. The commission plan in force on ${day(attributedAt)} (when the invoice was raised)`);
  const plans = await q(
    `SELECT p.id, p.name, p.status, p.is_default, p.scope_type, p.scope_id,
            v.id AS version_id, v.version, v.status AS version_status, v.effective_from, v.effective_to,
            -- Compared in SQL, exactly as resolvePlanVersion does. The columns
            -- are written by NOW() in some places and by the app in others, so
            -- comparing the values in JavaScript can be off by the server's
            -- timezone offset and blame a plan that in fact applied.
            CASE WHEN v.effective_from <= :at THEN 1 ELSE 0 END AS started,
            CASE WHEN v.effective_to IS NOT NULL AND v.effective_to <= :at THEN 1 ELSE 0 END AS ended
       FROM commission_plans p
       LEFT JOIN commission_plan_versions v ON v.plan_id = p.id
      WHERE p.company_id ${invoice.company_id == null ? 'IS NULL' : '= :companyId'}
      ORDER BY p.id, v.version`,
    { companyId: invoice.company_id, at: new Date(attributedAt) },
  );
  if (!plans.length) info('This company has no commission plans.');
  plans.forEach((p) => {
    const why = [];
    if (p.status !== 'active') why.push(`plan is ${p.status}`);
    if (p.version_status !== 'active') why.push(`version is ${p.version_status || 'missing'}`);
    if (p.version_id && !Number(p.started)) why.push('its start date is AFTER the invoice was raised');
    if (Number(p.ended)) why.push('it had ended before the invoice was raised');
    if (!p.scope_type && !p.is_default) why.push('not assigned to anything and not the company default');
    const scope = p.scope_type ? `${p.scope_type} #${p.scope_id}` : (p.is_default ? 'company default' : 'unassigned');
    info(`plan #${p.id} "${p.name}" v${p.version ?? '?'} (${scope}): ${why.length ? why.join('; ') : 'in force (applies only within its scope)'}`);
  });

  const planVersion = deal ? await resolvePlanVersion(sequelize, {
    companyId: deal.company_id, propertyId: deal.property_id, unitId: deal.unit_id, at: attributedAt,
  }) : null;

  if (planVersion && !planVersion.unreadable) {
    ok(`Plan "${planVersion.plan_name}" version ${planVersion.version} (#${planVersion.id}) applies — the plan engine pays this sale.`);
  } else if (planVersion?.unreadable) {
    fail(`Plan "${planVersion.plan_name}" applies but its configuration cannot be read.`);
  } else {
    fail('No plan was in force when this invoice was raised, so the flat-rate system applies instead.',
      plans.length
        ? 'Activate the plan with a start date on or before the invoice date (a new version), then recalculate.'
        : 'Create and activate a plan, or configure commission rules / level rates.');
  }

  // ── 4a. The flat-rate path ────────────────────────────────────────────────
  if (!planVersion) {
    heading('4. Flat-rate commission');
    const [flat] = await q('SELECT id, amount, status, created_at FROM commissions WHERE invoice_id = :id LIMIT 1', { id: invoice.id });
    if (flat) ok(`Commission #${flat.id} of ${flat.amount} exists (${flat.status}).`);
    else {
      if (!paidInFull) fail('The flat-rate system only raises commission once the invoice is paid in full.');
      const [rules] = await q('SELECT COUNT(*) AS n FROM commission_rules WHERE company_id = :companyId', { companyId: invoice.company_id });
      const [levelSetting] = await q(
        `SELECT ${col('value')} AS value, company_id FROM settings
          WHERE ${col('group')} = 'commission' AND ${col('key')} = 'use_level_rate'
            AND (company_id = :companyId OR company_id IS NULL) ORDER BY company_id DESC LIMIT 1`,
        { companyId: invoice.company_id },
      );
      info(`${rules.n} commission rule(s); level-rate fallback ${levelSetting?.value === 'true' ? 'ON' : 'off'}`);
      if (!Number(rules.n) && levelSetting?.value !== 'true') fail('No commission rules and the level-rate fallback is off.');
      if (levelSetting?.value === 'true' && realtor && !Number(realtor.level_rate)) {
        fail('The level-rate fallback is on but this realtor\'s level has no commission percentage.');
      }
      if (paidInFull) info('Nothing stored although it could be raised — run recalculate-commissions.js --invoice=' + invoice.id);
    }
  }

  // ── 4b. The plan engine ───────────────────────────────────────────────────
  if (planVersion && !planVersion.unreadable && deal) {
    heading('4. What the plan computes for this sale');
    const computed = await computeForDeal(sequelize, deal);
    if (computed.skipped) fail(`The engine skipped the sale: ${computed.skipped}.`);
    const result = computed.result || {};
    info(`commissionable base ${money(result.commissionable_base_minor)}, pool ${money(result.pool_minor)}`);
    (result.entitlements || []).forEach((e) => {
      const rate = e.trace?.rate ?? e.trace?.value;
      info(`${e.role} → realtor #${e.realtor_id}: ${money(e.constrained_minor ?? e.gross_minor)} `
        + `(rate ${rate ?? '?'} from ${e.trace?.rate_source || 'rule'})`);
      if (e.trace?.rate_source === 'UNRESOLVED' || e.trace?.rate_source === 'UNRESOLVED_FIXED_AMOUNT') {
        fail(`The plan has no rate for realtor #${e.realtor_id}: the rule sets none, their level has none, and the plan has no default.`,
          'Give the rule a rate, set a rate for their level on the rule, or set a commission % on their realtor level.');
      } else if (Number(e.realtor_id) === Number(realtor?.id) && !asMinor(e.constrained_minor ?? e.gross_minor)) {
        fail('The seller\'s entitlement works out to zero.');
      }
    });
    (result.excluded || []).forEach((x) => {
      const check = x.eligibility_check;
      fail(`Realtor #${x.realtor_id} (${x.role}) excluded: ${x.reason}`
        + (check ? ` — status ${check.status ?? 'UNKNOWN'} on ${day(check.evaluated_at)}` : ''),
        check && !check.status
          ? 'They have no status history covering the invoice date. Restarting user-service seeds history for realtors that have none, dated to account creation.'
          : null);
    });
    if (result.rejected) fail(`The plan refused the sale: ${result.rejected.reason || JSON.stringify(result.rejected)}`);
    if (!(result.entitlements || []).length && !(result.excluded || []).length) {
      fail('The plan produced no participants at all — check that it has a DIRECT_SALE rule.');
    }
    if (realtor) {
      const history = await q(
        'SELECT status, effective_from, reason FROM realtor_status_history WHERE user_id = :id ORDER BY effective_from, id',
        { id: realtor.id },
      ).catch(() => []);
      info(`status history: ${history.length ? history.map((h) => `${h.status} from ${day(h.effective_from)}`).join(' → ') : 'NONE'}`);
    }

    // ── 5. What was stored and released ─────────────────────────────────────
    heading('5. What has actually been recorded');
    const stored = await q(
      `SELECT id, realtor_id, role, gross_minor, constrained_minor, released_minor, forfeited_minor, status
         FROM commission_entitlements WHERE deal_ref = :ref ORDER BY id`,
      { ref: deal.deal_ref },
    );
    const vesting = await vestingConfigFor(sequelize, planVersion.id);
    info(`release trigger: ${vesting.release_trigger}`);
    if (!stored.length) {
      fail(`Nothing recorded for ${deal.deal_ref}, although the plan would pay it.`,
        `Run: node scripts/recalculate-commissions.js --invoice=${invoice.id} --apply`);
    }
    stored.forEach((e) => info(`entitlement #${e.id} realtor #${e.realtor_id} ${e.role}: ${money(e.constrained_minor)} owed, `
      + `${money(e.released_minor)} released, ${money(e.forfeited_minor)} forfeited — ${e.status}`));
    const sellerRow = stored.find((e) => Number(e.realtor_id) === Number(realtor?.id));
    if (sellerRow && !asMinor(sellerRow.released_minor)) {
      fail(`Recorded but not released yet — the plan releases ${vesting.release_trigger}.`,
        vesting.release_trigger === 'ON_FULL_PAYMENT' ? 'It releases when the invoice is paid in full.' : null);
    }
    const flags = await q('SELECT code, severity, summary, status FROM commission_flags WHERE deal_ref = :ref', { ref: deal.deal_ref }).catch(() => []);
    flags.forEach((f) => info(`flag ${f.code} (${f.severity}, ${f.status}): ${f.summary}`));
  }

  // ── 6. Can the realtor ask for it? ────────────────────────────────────────
  if (realtor) {
    heading(`6. Can ${realtor.name} request a payout?`);
    const wallet = await walletFor(sequelize, realtor.id);
    const [flatOpen] = await q(
      "SELECT COALESCE(SUM(amount), 0) AS open FROM commissions WHERE employee_id = :id AND status IN ('created', 'approved')",
      { id: realtor.id },
    );
    info(`plan balance: ${money(wallet.available_minor)} available, ${money(wallet.accrued_minor)} not yet released; `
      + `flat-rate: ${flatOpen.open} open`);
    const verification = await realtorVerification(sequelize, realtor.id);
    if (verification.verified) ok('Identity verification approved.');
    else {
      fail(`Identity verification is ${verification.status || 'not submitted'} — payout requests are refused until it is approved.`,
        'Approve their KYC under Realtors.');
    }
    const threshold = await payoutThresholdMinor(sequelize, invoice.company_id);
    if (threshold > 0) {
      const have = Math.max(wallet.available_minor, toMinor(flatOpen.open));
      if (have < threshold) fail(`Below the company's ${money(threshold)} minimum payout (has ${money(have)}).`);
      else ok(`Above the ${money(threshold)} minimum payout.`);
    }
    info('The realtor sees all of this under My Commissions (/finance/my-commission).');
  }

  heading(blockers.length ? `First thing stopping it: ${blockers[0]}` : 'Nothing is blocking this sale.');
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
