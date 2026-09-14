const { QueryTypes } = require('sequelize');
const { asMinor } = require('./money');
const { columnsOf, quoteIdent } = require('./dialect');

/**
 * Patterns in commission data that are worth a human look (§7.14, FR-FRD-*).
 *
 * ── Everything here FLAGS. Nothing here refuses ─────────────────────────────
 *
 * That is the whole design decision, and it goes against instinct. A rule that
 * blocked an accrual it judged suspicious would, on its first false positive,
 * stop a legitimate realtor being paid for a real sale — and the person who
 * could tell it was legitimate is precisely the person who would not find out
 * until the realtor complained. Meanwhile the genuine cases are rarely obvious
 * from one deal: what identifies them is the shape across many, which is
 * something a reviewer can see and a per-deal gate cannot.
 *
 * So each check returns a finding with the evidence attached, and somebody
 * decides. The cost of a missed flag is a delayed investigation; the cost of a
 * wrong block is an unpaid commission and a realtor who stops trusting the
 * system.
 *
 * ── Why these five ──────────────────────────────────────────────────────────
 *
 * They are the ones that pay out money the structure was never meant to pay:
 * commission routed to the buyer, a genealogy that pays somebody twice, sales
 * timed to clear a threshold, a chain of accounts held by one person, and a
 * cancellation pattern that collects a release and then unwinds the sale.
 */

const SEVERITY = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

const finding = (code, severity, summary, evidence) => ({
  code, severity, summary, evidence,
});

/**
 * Commission on your own purchase (FR-FRD-001).
 *
 * The clearest case there is: the buyer and the earner are the same person, or
 * the buyer's own account is in the upline being paid on the sale. It is a
 * discount taken as commission, and it matters because a discount is approved
 * and a commission is not.
 */
const selfDealing = async (sequelize, { dealRef, invoiceId, participants }) => {
  if (!invoiceId) return [];
  const [buyer] = await sequelize.query(
    `SELECT u.id, u.realtor_id, u.email
       FROM invoices i JOIN users u ON u.id = i.client_id
      WHERE i.id = :invoiceId LIMIT 1`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT },
  );
  if (!buyer) return [];

  const earners = new Set(participants.map((p) => Number(p.realtor_id)));
  const findings = [];

  if (earners.has(Number(buyer.id))) {
    findings.push(finding('SELF_PURCHASE', SEVERITY.HIGH,
      'The buyer is being paid commission on their own purchase.',
      { deal_ref: dealRef, buyer_user_id: buyer.id }));
  }

  if (buyer.realtor_id && earners.has(Number(buyer.realtor_id))) {
    findings.push(finding('BUYER_UPLINE_EARNS', SEVERITY.MEDIUM,
      'The realtor the buyer is attributed to is also earning on the sale — legitimate '
      + 'in most companies, and worth confirming this is one of them.',
      { deal_ref: dealRef, buyer_user_id: buyer.id, attributed_to: buyer.realtor_id }));
  }

  return findings;
};

/**
 * One person, several accounts, all in the same leg (FR-FRD-002).
 *
 * A genealogy pays by depth, so inserting accounts you control between yourself
 * and a real upline collects the intermediate tiers. What gives it away is that
 * the accounts share something a real person does not share with their sponsor.
 *
 * ── The fields are discovered, not assumed ──────────────────────────────────
 *
 * Which identity columns exist differs by installation — a payout bank account
 * is the strongest signal available, because the money has to land somewhere
 * real, and this schema does not carry one on `users` today. Naming the columns
 * unconditionally would make the whole check throw on a missing column, and
 * `screenDeal` would record "a check could not be completed" for every deal
 * forever, which reads as noise and gets ignored.
 *
 * So the check asks the schema what it has and reports what it compared. A
 * caller that needs to know how strong the screening was can read
 * `fields_checked`; nothing here pretends to have looked at a column that is
 * not there.
 */
const IDENTITY_FIELDS = [
  // Strongest first: an invented email costs nothing, but a payout account has
  // to be one somebody can actually withdraw from.
  { column: 'bank_account_number', label: 'bank account', severity: SEVERITY.HIGH },
  { column: 'account_number', label: 'bank account', severity: SEVERITY.HIGH },
  { column: 'phone', label: 'phone number', severity: SEVERITY.MEDIUM },
  { column: 'address', label: 'address', severity: SEVERITY.LOW },
];

const sharedIdentity = async (sequelize, { dealRef, participants }) => {
  const ids = [...new Set(participants.map((p) => Number(p.realtor_id)).filter(Boolean))];
  if (ids.length < 2) return [];

  const available = await columnsOf(sequelize, 'users');
  const fields = IDENTITY_FIELDS.filter((field) => available?.has(field.column));
  if (!fields.length) return [];

  const selected = fields.map((field) => quoteIdent(sequelize, field.column)).join(', ');
  const rows = await sequelize.query(
    `SELECT id, ${selected} FROM users WHERE id IN (:ids) AND deleted_at IS NULL`,
    { replacements: { ids }, type: QueryTypes.SELECT },
  );

  const findings = [];

  for (const field of fields) {
    const groups = new Map();
    rows.forEach((row) => {
      const value = row[field.column];
      if (value === null || value === undefined || String(value).trim() === '') return;
      const key = String(value).trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.id);
    });

    groups.forEach((members, value) => {
      if (members.length < 2) return;
      findings.push(finding('SHARED_IDENTITY', field.severity,
        `${members.length} participants on this deal share the same ${field.label}.`,
        {
          deal_ref: dealRef,
          field: field.column,
          value,
          realtor_ids: members,
          fields_checked: fields.map((f) => f.column),
        }));
    });
  }

  return findings;
};

/**
 * Sales timed or sized to clear a threshold (FR-FRD-003).
 *
 * A plan that pays more above a volume threshold creates an incentive to split
 * one sale into several, or to book a sale in the period that needs it. The
 * signal is a cluster: several deals by one realtor, within days, each just
 * under or just over the line.
 */
const thresholdGaming = async (sequelize, { companyId, realtorId, at, windowDays = 7 }) => {
  const from = new Date(at);
  from.setDate(from.getDate() - windowDays);

  const rows = await sequelize.query(
    `SELECT deal_ref, MIN(attribution_date) AS attributed,
            COALESCE(SUM(constrained_minor), 0) AS commission
       FROM commission_entitlements
      WHERE realtor_id = :realtorId
        AND role = 'DIRECT'
        AND attribution_date >= :from AND attribution_date <= :at
        ${companyId ? 'AND company_id = :companyId' : ''}
      GROUP BY deal_ref`,
    {
      replacements: { realtorId, from, at: new Date(at), ...(companyId ? { companyId } : {}) },
      type: QueryTypes.SELECT,
    },
  );

  if (rows.length < 4) return [];
  return [finding('DEAL_VELOCITY', SEVERITY.MEDIUM,
    `${rows.length} deals attributed to one realtor within ${windowDays} days.`,
    {
      realtor_id: realtorId,
      window_days: windowDays,
      deals: rows.map((row) => row.deal_ref),
      total_commission_minor: rows.reduce((total, row) => total + asMinor(row.commission), 0),
    })];
};

/**
 * A sale that is released and then unwound (FR-FRD-004).
 *
 * The pattern that costs real money: sell, collect enough instalments to trip
 * the release, take the payout, cancel. It only shows up over time, which is
 * why it is asked of a realtor's HISTORY rather than of the deal in front of
 * you — one cancellation is a buyer changing their mind, and four in a quarter
 * where each was released first is a method.
 */
const releaseThenCancel = async (sequelize, { companyId, realtorId, months = 6, at = new Date() }) => {
  const from = new Date(at);
  from.setMonth(from.getMonth() - months);

  const rows = await sequelize.query(
    `SELECT deal_ref, released_minor, paid_minor, clawed_back_minor, status
       FROM commission_entitlements
      WHERE realtor_id = :realtorId
        AND role = 'DIRECT'
        AND status = 'REVERSED'
        AND released_minor > 0
        AND attribution_date >= :from
        ${companyId ? 'AND company_id = :companyId' : ''}`,
    {
      replacements: { realtorId, from, ...(companyId ? { companyId } : {}) },
      type: QueryTypes.SELECT,
    },
  );

  if (rows.length < 2) return [];
  return [finding('RELEASE_THEN_CANCEL', SEVERITY.HIGH,
    `${rows.length} deals in ${months} months released commission and were then reversed.`,
    {
      realtor_id: realtorId,
      deals: rows.map((row) => row.deal_ref),
      paid_before_reversal_minor: rows.reduce((total, row) => total + asMinor(row.paid_minor), 0),
    })];
};

/**
 * A genealogy that loops (FR-FRD-005).
 *
 * `uplineOf` already stops walking when it sees a realtor twice, so a cycle
 * cannot hang the engine. That guard is silent, though, and a silent guard on
 * corrupt data is a problem hidden rather than solved: the chain it returns is
 * truncated, so somebody who should have been paid was not, and nobody is told.
 * Detected explicitly so the data gets fixed.
 */
const genealogyCycle = async (sequelize, { realtorId, maxDepth = 12 }) => {
  const seen = new Set([Number(realtorId)]);
  let current = Number(realtorId);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [row] = await sequelize.query(
      'SELECT realtor_id FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
      { replacements: { id: current }, type: QueryTypes.SELECT },
    );
    const next = row?.realtor_id ? Number(row.realtor_id) : null;
    if (!next) return [];
    if (seen.has(next)) {
      return [finding('GENEALOGY_CYCLE', SEVERITY.HIGH,
        'The upline chain loops back on itself, so it is being silently truncated and '
        + 'somebody above the loop is not being paid.',
        { realtor_id: realtorId, repeats_at: next, chain: [...seen] })];
    }
    seen.add(next);
    current = next;
  }
  return [];
};

/**
 * Every check, for one deal that has just accrued.
 *
 * Never throws. A fraud check that failed and took the accrual down with it
 * would stop commission being paid for a reason that has nothing to do with
 * whether it is owed — the opposite of what the checks are for.
 */
const screenDeal = async (sequelize, { dealRef, invoiceId, companyId, sellerId, participants, at = new Date() }) => {
  const checks = [
    () => selfDealing(sequelize, { dealRef, invoiceId, participants }),
    () => sharedIdentity(sequelize, { dealRef, participants }),
    () => thresholdGaming(sequelize, { companyId, realtorId: sellerId, at }),
    () => releaseThenCancel(sequelize, { companyId, realtorId: sellerId, at }),
    () => genealogyCycle(sequelize, { realtorId: sellerId }),
  ];

  const findings = [];
  for (const check of checks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      findings.push(...await check());
    } catch (error) {
      /**
       * A check that cannot run is reported as a check that could not run, not
       * as a clean result. "We looked and found nothing" and "we could not
       * look" are different answers and must not be shown as the same one.
       */
      findings.push(finding('CHECK_FAILED', SEVERITY.LOW,
        'A fraud check could not be completed.', { error: error.message }));
    }
  }

  return {
    deal_ref: dealRef,
    findings,
    highest_severity: findings.reduce(
      (worst, item) => (item.severity === SEVERITY.HIGH ? SEVERITY.HIGH
        : (worst === SEVERITY.HIGH ? worst : item.severity)),
      null,
    ),
  };
};

module.exports = {
  SEVERITY, screenDeal,
  selfDealing, sharedIdentity, thresholdGaming, releaseThenCancel, genealogyCycle,
};
