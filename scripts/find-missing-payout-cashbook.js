/**
 * Finds paid commission payouts with no cash-book entry, and can restore them.
 *
 * ── Why some are missing ────────────────────────────────────────────────────
 *
 * Recording a payout writes one `transactions` row (type commission_payout) —
 * the cash book's record that money left. Its reference used to be the
 * payout's BATCH ref, and every payout built on the same day shares one
 * (PAYOUT-2026-10-01). The reference is unique per company, so the second
 * payout of a day collided with the first: on MySQL the duplicate was caught
 * and the row silently skipped, so the payout shows PAID and the cash book
 * never heard about it. (On Postgres the collision aborted the whole payment
 * instead, so nothing was half-written there.) Fixed: each payout now gets
 * its own reference, `<batch>-<payout id>`.
 *
 * And before 2026-09-20 payouts wrote no cash-book row at all — that is when
 * the entry moved from the retired debit note to the payout itself — so any
 * paid before then are listed separately as LEGACY.
 *
 * Only the cash book is affected. The commission ledger and the general
 * ledger were written before the collision, and are not touched here.
 *
 * ── How a payout counts as recorded ─────────────────────────────────────────
 *
 * A commission_payout row in the same company, either carrying the payout's
 * own reference (`<batch>-<id>`), or — the old shape — carrying its batch ref
 * or bank reference AND paid to the same realtor for the same amount. Each row
 * is claimed by one payout only, oldest first, so two same-day payouts cannot
 * both claim the one row the first of them wrote.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/find-missing-payout-cashbook.js                 report only
 *   node scripts/find-missing-payout-cashbook.js --company=4      one company
 *   node scripts/find-missing-payout-cashbook.js --apply          restore the rows
 *   node scripts/find-missing-payout-cashbook.js --apply --skip-legacy
 *                                    restore only those paid since 2026-09-20
 *
 * Restoring writes one row per missing payout: its own reference, the net
 * amount, the realtor, dated when the payout was paid. Re-running is safe —
 * a restored payout is found by its reference and left alone. Uses the
 * finance-service connection, so it runs against whichever database cred.env
 * (or the environment) points at, MySQL or Postgres.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../services/finance-service/src/models');
const { q, isDuplicateError } = require('../shared/src/dialect');
const { asMinor, toMajor } = require('../shared/src/money');

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const apply = args.includes('--apply');
const skipLegacy = args.includes('--skip-legacy');
const companyId = flag('company') ? Number(flag('company')) : null;

/** When payouts began writing a cash-book row of their own (ac69a08). */
const CASH_BOOK_SINCE = new Date('2026-09-20T00:00:00Z');

const ownReference = (payout) => `${payout.batch_ref}-${payout.id}`;
const sameCompany = (a, b) => (a ?? null) === null ? (b ?? null) === null : Number(a) === Number(b);

const main = async () => {
  const scope = companyId ? 'AND p.company_id = :companyId' : '';
  const payouts = await sequelize.query(
    `SELECT p.id, p.company_id, p.batch_ref, p.realtor_id, p.net_minor, p.paid_at,
            p.payment_reference, u.name AS realtor_name
       FROM commission_payouts p
       LEFT JOIN users u ON u.id = p.realtor_id
      WHERE p.status = 'PAID' AND p.net_minor > 0 ${scope}
      ORDER BY p.id ASC`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );

  // Oldest first, in JavaScript: the engines disagree on where a NULL paid_at
  // sorts, and the order decides which of two same-day payouts claims a row.
  payouts.sort((a, b) => (new Date(a.paid_at || 0) - new Date(b.paid_at || 0)) || (Number(a.id) - Number(b.id)));

  const cashRows = await sequelize.query(
    `SELECT t.id, t.company_id, t.user_id, t.amount, t.reference
       FROM transactions t
      WHERE t.${q(sequelize, 'type')} = 'commission_payout'
        ${companyId ? 'AND t.company_id = :companyId' : ''}`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );

  const claimed = new Set();
  const claim = (predicate) => {
    const row = cashRows.find((r) => !claimed.has(r.id) && predicate(r));
    if (row) claimed.add(row.id);
    return row || null;
  };

  // Pass 1: rows written in the current shape name their payout outright.
  const recorded = new Set();
  payouts.forEach((payout) => {
    if (claim((r) => sameCompany(r.company_id, payout.company_id) && r.reference === ownReference(payout))) {
      recorded.add(payout.id);
    }
  });
  // Pass 2: the old shape — batch or bank reference, same realtor, same amount.
  payouts.filter((p) => !recorded.has(p.id)).forEach((payout) => {
    const amountMinor = asMinor(payout.net_minor);
    const row = claim((r) => sameCompany(r.company_id, payout.company_id)
      && [payout.batch_ref, payout.payment_reference].filter(Boolean).includes(r.reference)
      && Number(r.user_id) === Number(payout.realtor_id)
      && Math.round(Number(r.amount) * 100) === amountMinor);
    if (row) recorded.add(payout.id);
  });

  const missing = payouts.filter((p) => !recorded.has(p.id));
  const isLegacy = (p) => p.paid_at && new Date(p.paid_at) < CASH_BOOK_SINCE;
  const recent = missing.filter((p) => !isLegacy(p));
  const legacy = missing.filter(isLegacy);

  const describe = (p) => `  payout #${p.id}  ${p.batch_ref}  company ${p.company_id ?? '—'}  `
    + `${p.realtor_name || `realtor ${p.realtor_id}`}  ${toMajor(asMinor(p.net_minor)).toLocaleString('en-US', { minimumFractionDigits: 2 })}  `
    + `paid ${p.paid_at ? new Date(p.paid_at).toISOString().slice(0, 10) : 'unknown'}`;

  console.log(`\nChecked ${payouts.length} paid payout(s) against ${cashRows.length} commission cash-book row(s)`
    + `${companyId ? ` for company ${companyId}` : ''} on ${sequelize.getDialect()}.\n`);
  console.log(`Missing a cash-book entry: ${missing.length}`);
  if (recent.length) {
    console.log(`\n${recent.length} paid since ${CASH_BOOK_SINCE.toISOString().slice(0, 10)} (the shared batch reference):`);
    recent.forEach((p) => console.log(describe(p)));
  }
  if (legacy.length) {
    console.log(`\n${legacy.length} LEGACY — paid before ${CASH_BOOK_SINCE.toISOString().slice(0, 10)}, when payouts wrote no cash-book row:`);
    legacy.forEach((p) => console.log(describe(p)));
  }
  const totalMinor = missing.reduce((t, p) => t + asMinor(p.net_minor), 0);
  if (missing.length) console.log(`\nTotal not in the cash book: ${toMajor(totalMinor).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  if (!apply) {
    if (missing.length) console.log('\nReport only. Re-run with --apply to restore them (add --skip-legacy to leave the legacy ones).\n');
    else console.log('\nNothing to restore.\n');
    return;
  }

  const toRestore = skipLegacy ? recent : missing;
  let restored = 0;
  for (const payout of toRestore) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.query(
        `INSERT INTO transactions
           (user_id, ${q(sequelize, 'type')}, entry_type, amount, description,
            payment_method, status, reference, company_id, created_at)
         VALUES (:userId, 'commission_payout', 'debit', :amount, :description,
            'transfer', 'completed', :reference, :companyId, :createdAt)`,
        {
          replacements: {
            userId: payout.realtor_id,
            amount: toMajor(asMinor(payout.net_minor)),
            description: `Commission payout ${payout.batch_ref} (cash-book entry restored)`
              + (payout.payment_reference ? ` — bank ref ${payout.payment_reference}` : ''),
            reference: ownReference(payout),
            companyId: payout.company_id ?? null,
            createdAt: payout.paid_at ? new Date(payout.paid_at) : new Date(),
          },
          type: QueryTypes.INSERT,
        },
      );
      restored += 1;
    } catch (error) {
      // Restored by an earlier run, or by somebody at the same moment.
      if (!isDuplicateError(error)) throw error;
    }
  }
  console.log(`\nRestored ${restored} cash-book entr${restored === 1 ? 'y' : 'ies'}`
    + `${skipLegacy && legacy.length ? ` (left ${legacy.length} legacy payout(s) as they are)` : ''}.\n`);
};

main()
  .catch((error) => { console.error('Failed:', error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
