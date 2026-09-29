/**
 * Raise commission on sales whose payments were approved without it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Until raiseCommission was shared, only approving a client's uploaded receipt
 * raised commission. An admin who settled a sale from the invoice screen —
 * Record payment or Mark as paid — applied the money and held the units, and
 * the realtor earned nothing, on either the plan engine or the flat rate.
 * Nothing picked those sales up later. This does, by running the same step a
 * payment now runs, against each invoice's payments as they stand.
 *
 * ── Safe to repeat ──────────────────────────────────────────────────────────
 *
 * raiseCommission is idempotent: the engine keys its accrual on the deal and
 * releases only the difference, and the flat rate is findOrCreate on
 * (invoice, realtor). An invoice already up to date comes back unchanged.
 * Realtors are notified only of commission this run actually raises.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/recalculate-commissions.js                  # dry run, every company
 *   node scripts/recalculate-commissions.js --company=3      # dry run, one company
 *   node scripts/recalculate-commissions.js --invoice=81     # one invoice
 *   node scripts/recalculate-commissions.js --apply          # write it
 *
 * It acts on whatever database the environment points at. Dry run is the
 * default because --apply raises money owed to people.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../services/finance-service/src/models');
const {
  raiseCommission, commissionInputsFor, COMMISSION_REASON_TEXT,
} = require('../services/finance-service/src/controllers/financeController');
const { toMajor } = require('../shared/src/money');

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const apply = args.includes('--apply');
const companyId = flag('company');
const invoiceId = flag('invoice');

const main = async () => {
  const typeColumn = sequelize.getDialect() === 'postgres' ? '"type"' : '`type`';
  const candidates = await sequelize.query(
    `SELECT i.id, i.invoice_id, i.status, i.company_id, i.client_id, i.property_id,
            i.amount, i.discount, i.created_at, i.${typeColumn} AS type,
            (SELECT COUNT(*) FROM commission_entitlements e WHERE e.invoice_id = i.id) AS entitlements,
            (SELECT COUNT(*) FROM commissions c WHERE c.invoice_id = i.id) AS flat_commissions
       FROM invoices i
      WHERE (i.${typeColumn} IS NULL OR i.${typeColumn} = 'property_sale')
        AND i.status NOT IN ('cancelled', 'expired', 'draft')
        AND EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = i.id AND ip.status = 'completed')
        ${companyId ? 'AND i.company_id = :companyId' : ''}
        ${invoiceId ? 'AND i.id = :invoiceId' : ''}
      ORDER BY i.id`,
    { replacements: { companyId, invoiceId }, type: QueryTypes.SELECT },
  );

  console.log(`${candidates.length} sale invoice(s) with approved payments${apply ? '' : ' (dry run — nothing is written)'}.\n`);

  const tally = { changed: 0, unchanged: 0, skipped: 0 };
  for (const invoice of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const inputs = await commissionInputsFor(invoice);
    const label = `${invoice.invoice_id} (#${invoice.id}, ${invoice.status}, `
      + `paid ${toMajor(inputs.paidMinor)} of ${toMajor(inputs.totalMinor)})`;
    const has = `${invoice.entitlements} plan entitlement(s), ${invoice.flat_commissions} flat commission(s)`;

    if (!apply) {
      console.log(`  ${label} — currently ${has}`);
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    const outcome = await raiseCommission({ invoice, ...inputs, req: null });
    const changed = outcome.system === 'plan'
      ? Boolean(outcome.accrued || outcome.released)
      : Boolean(outcome.created);
    let result;
    if (outcome.rejected) result = `refused by the plan: ${outcome.rejected.reason}`;
    else if (outcome.system === 'plan' && !outcome.reason) {
      result = changed
        ? `plan: ${outcome.accrued || 0} recorded, ${outcome.released || 0} released`
        : 'plan: already up to date';
    } else if (outcome.created) result = `flat rate: raised ${outcome.created.amount}`;
    else result = COMMISSION_REASON_TEXT[outcome.reason] || outcome.reason || 'nothing to raise';

    if (changed) tally.changed += 1;
    else if (outcome.reason && outcome.reason !== 'already_exists') tally.skipped += 1;
    else tally.unchanged += 1;
    console.log(`  ${changed ? '+' : ' '} ${label} — ${result}`);
  }

  if (apply) {
    console.log(`\n${tally.changed} raised or released, ${tally.unchanged} already up to date, `
      + `${tally.skipped} earn nothing (reason shown).`);
    // raiseCommission sends realtor notifications without awaiting them, as a
    // request would. Give them a moment before the connection closes under them.
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
  } else {
    console.log('\nRun again with --apply to raise what is owed.');
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
