const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { q } = require('../dialect');
const { asMinor } = require('../money');
const { ROLE, ROLES, NORMAL_BALANCE } = require('./chart');

/**
 * Posting to the general ledger (ACC-2).
 *
 * ── One door ──────────────────────────────────────────────────────────────
 *
 * Every journal in the system is written by `post()`. Not because a second
 * writer would be untidy, but because the invariants below are only true if
 * there is one place they are checked — and a ledger with a second door is a
 * ledger whose balance guarantee is a convention.
 *
 *   balanced      refused at write time, inside the caller's transaction
 *                 (ACC-2.2). Not flagged afterwards: an unbalanced entry that
 *                 reaches the table has already made every statement wrong,
 *                 and the report that would have caught it runs at month end.
 *
 *   idempotent    one key per source event (ACC-2.3). The second attempt is a
 *                 no-op that returns the first entry, so a replayed job, a
 *                 retried request and two tabs all post once.
 *
 *   append-only   nothing here updates or deletes. `reverse()` is the only
 *                 correction, and it writes a new entry naming the old one
 *                 (ACC-2.4).
 *
 *   attributable  who posted it and when, separately from the accounting date
 *                 (ACC-2.7).
 *
 * ── Minor units, integers, always ─────────────────────────────────────────
 *
 * Same rule as the rest of the platform: money is integer kobo through
 * shared/src/money.js. A float in a ledger does not merely round oddly — it
 * makes debits and credits disagree by a kobo, which fails the balance check
 * on a correct entry and is maddening to diagnose.
 */

/** Accounts are resolved per company and asked for constantly; cache the map. */
const chartCache = new Map();

const cacheKey = (companyId) => String(companyId ?? 'platform');

/** Drop a company's cached chart. Called whenever an account is written. */
const forgetChart = (companyId) => { chartCache.delete(cacheKey(companyId)); };

/**
 * The company's accounts, by id, by code and by role.
 *
 * Read once per company and held, because a posting rule asks for two or three
 * roles per journal and a sale can produce several journals. Invalidated on
 * every write to the chart rather than by a TTL: a stale chart posts to the
 * wrong account, which is not a thing to let expire on its own.
 */
const chartFor = async (sequelize, companyId, { transaction = null, fresh = false } = {}) => {
  const key = cacheKey(companyId);
  if (!fresh && chartCache.has(key)) return chartCache.get(key);

  const rows = await sequelize.query(
    `SELECT id, code, name, ${q(sequelize, 'type')}, role, is_active
       FROM ledger_accounts
      WHERE company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT, transaction },
  );

  const chart = {
    byId: new Map(rows.map((row) => [Number(row.id), row])),
    byCode: new Map(rows.map((row) => [String(row.code), row])),
    byRole: new Map(rows.filter((row) => row.role).map((row) => [String(row.role), row])),
    size: rows.length,
  };
  chartCache.set(key, chart);
  return chart;
};

/**
 * Which account a line means.
 *
 * ── Why an unresolved role goes to suspense rather than throwing ──────────
 *
 * A posting rule that cannot find its account is a configuration problem, and
 * the two honest responses are to refuse the business event or to post the
 * money somewhere visible. Refusing is wrong here: the sale happened, the
 * money moved, and a payment that rolls back because a chart is missing an
 * account is a worse outcome than a suspense balance.
 *
 * So it posts to suspense and says so. A non-zero suspense fails the period
 * close checklist (ACC-7.2), which means it is loud, it blocks, and it names
 * what it is holding — rather than a journal that silently never happened.
 */
const resolveAccount = (chart, { accountId, code, role }) => {
  if (accountId && chart.byId.has(Number(accountId))) {
    return { account: chart.byId.get(Number(accountId)), asked: null, fellBack: false };
  }
  if (code && chart.byCode.has(String(code))) {
    return { account: chart.byCode.get(String(code)), asked: null, fellBack: false };
  }
  if (role && chart.byRole.has(String(role))) {
    return { account: chart.byRole.get(String(role)), asked: role, fellBack: false };
  }
  const suspense = chart.byRole.get(ROLE.SUSPENSE);
  if (!suspense) {
    // The one case that genuinely cannot proceed: no suspense account either.
    const err = new Error(
      `No account for ${role || code || accountId} and no suspense account in this chart. `
      + 'Seed the chart of accounts before posting.',
    );
    err.status = 409;
    throw err;
  }
  return { account: suspense, asked: role || code || String(accountId), fellBack: true };
};

/**
 * A stable key for one source event.
 *
 * Hashed rather than concatenated so the column has a bounded width whatever a
 * caller passes, and so a key cannot be accidentally readable as a reference
 * somebody then relies on. The inputs are the source, its id, and whatever
 * else distinguishes two journals from the same document — a payment id, an
 * instalment number.
 */
const idempotencyKey = (...parts) => crypto
  .createHash('sha256')
  .update(parts.map((part) => String(part ?? '')).join('|'))
  .digest('hex')
  .slice(0, 48);

/** Tidy a line into the shape the table holds, without deciding anything. */
const normaliseLine = (line, index) => {
  const debit = Math.max(asMinor(line.debit_minor ?? line.debit ?? 0), 0);
  const credit = Math.max(asMinor(line.credit_minor ?? line.credit ?? 0), 0);
  return {
    ...line,
    position: line.position ?? index,
    debit_minor: debit,
    credit_minor: credit,
  };
};

/**
 * Write one journal entry.
 *
 * @param sequelize
 * @param {object} entry
 *   companyId, entryDate, source, sourceId, memo, createdBy, key, lines[]
 *   A line is { role | code | accountId, debit_minor | credit_minor, memo,
 *   property_id, unit_id, branch_id, realtor_id, party_id, party_type }.
 * @param {object} options  { transaction }
 *
 * @returns {{ entry_id, reference, posted, replayed, fell_back[] }}
 */
const post = async (sequelize, entry, { transaction = null } = {}) => {
  const {
    companyId = null, entryDate, source, sourceId = null, memo = null,
    createdBy = null, key = null, lines = [], reversesEntryId = null,
    reversalReason = null,
  } = entry;

  if (!source) throw Object.assign(new Error('A journal entry must say what caused it.'), { status: 400 });

  const prepared = lines.map(normaliseLine).filter((line) => line.debit_minor || line.credit_minor);

  /**
   * Two lines minimum (ACC-2.1).
   *
   * A single-sided entry is not a journal — it is a note. Checked before the
   * balance so the message names the real problem: "one line" is more useful
   * than "debits 5000, credits 0".
   */
  if (prepared.length < 2) {
    throw Object.assign(
      new Error(`A journal entry needs at least two lines; ${source} produced ${prepared.length}.`),
      { status: 422 },
    );
  }

  const oneSided = prepared.find((line) => line.debit_minor && line.credit_minor);
  if (oneSided) {
    throw Object.assign(
      new Error('A journal line is a debit or a credit, never both.'),
      { status: 422 },
    );
  }

  const debits = prepared.reduce((total, line) => total + line.debit_minor, 0);
  const credits = prepared.reduce((total, line) => total + line.credit_minor, 0);

  /**
   * ACC-2.2, and the whole point of this function.
   *
   * Refused here, inside whatever transaction the caller opened, so the
   * business event and its journal stand or fall together. The message carries
   * both totals and the difference because the first question anybody asks is
   * "by how much".
   */
  if (debits !== credits) {
    throw Object.assign(
      new Error(
        `Journal does not balance: debits ${debits}, credits ${credits}, `
        + `difference ${Math.abs(debits - credits)} (minor units), source ${source} ${sourceId ?? ''}`.trim(),
      ),
      { status: 422 },
    );
  }
  if (debits === 0) {
    throw Object.assign(new Error('A journal entry of zero posts nothing.'), { status: 422 });
  }

  const idempotency = key || idempotencyKey(source, sourceId, debits, credits, entryDate);

  /**
   * Already posted?
   *
   * Checked before writing as well as being enforced by the unique index. The
   * check is the common path and returns the original entry; the index is the
   * backstop for two requests racing between the check and the insert, whose
   * loser is caught below.
   */
  const [existing] = await sequelize.query(
    'SELECT id, reference FROM journal_entries WHERE idempotency_key = :key LIMIT 1',
    { replacements: { key: idempotency }, type: QueryTypes.SELECT, transaction },
  );
  if (existing) {
    return {
      entry_id: Number(existing.id),
      reference: existing.reference,
      posted: false,
      replayed: true,
      fell_back: [],
    };
  }

  const chart = await chartFor(sequelize, companyId, { transaction });
  const resolved = prepared.map((line) => {
    const { account, asked, fellBack } = resolveAccount(chart, {
      accountId: line.account_id ?? line.accountId,
      code: line.code,
      role: line.role,
    });
    return { line, account, asked, fellBack };
  });

  // Numbered from the same gap-aware per-company sequence every other document
  // uses, so a journal reference behaves like an invoice number.
  // eslint-disable-next-line global-require
  const { nextNumber } = require('../documentSequence');
  const reference = await nextNumber(sequelize, {
    docType: 'journal_entries', table: 'journal_entries', field: 'reference',
    prefix: 'JE-', companyId, transaction,
  });

  const date = entryDate instanceof Date
    ? entryDate.toISOString().slice(0, 10)
    : String(entryDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

  // eslint-disable-next-line global-require
  const { insertReturningId } = require('../dialect');
  let entryId;
  try {
    entryId = await insertReturningId(
      sequelize,
      `INSERT INTO journal_entries
         (company_id, reference, entry_date, source, source_id, memo, idempotency_key,
          reverses_entry_id, reversal_reason, debit_minor, credit_minor, created_by, created_at)
       VALUES (:companyId, :reference, :date, :source, :sourceId, :memo, :key,
          :reverses, :reversalReason, :debits, :credits, :createdBy, NOW())`,
      {
        replacements: {
          companyId,
          reference,
          date,
          source,
          sourceId: sourceId === null ? null : String(sourceId),
          memo,
          key: idempotency,
          reverses: reversesEntryId,
          reversalReason,
          debits,
          credits,
          createdBy,
        },
        transaction,
      },
    );
  } catch (error) {
    /*
     * The race the pre-check cannot close: two callers both found nothing and
     * both inserted. The index refuses the loser, and the loser's answer is
     * the winner's entry — which is the same answer the pre-check would have
     * given a moment later.
     */
    if (/duplicate|unique/i.test(error.message || '')) {
      const [winner] = await sequelize.query(
        'SELECT id, reference FROM journal_entries WHERE idempotency_key = :key LIMIT 1',
        { replacements: { key: idempotency }, type: QueryTypes.SELECT, transaction },
      );
      if (winner) {
        return {
          entry_id: Number(winner.id),
          reference: winner.reference,
          posted: false,
          replayed: true,
          fell_back: [],
        };
      }
    }
    throw error;
  }

  for (const { line, account, asked } of resolved) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO journal_lines
         (entry_id, company_id, account_id, account_code, account_role,
          debit_minor, credit_minor, memo, property_id, unit_id, branch_id,
          realtor_id, party_id, party_type, position)
       VALUES (:entryId, :companyId, :accountId, :accountCode, :accountRole,
          :debit, :credit, :memo, :propertyId, :unitId, :branchId,
          :realtorId, :partyId, :partyType, :position)`,
      {
        replacements: {
          entryId,
          companyId,
          accountId: account.id,
          accountCode: account.code,
          // What the rule ASKED for, which on a fall-back differs from what it
          // got — and is the only record of why money is sitting in suspense.
          accountRole: asked ?? account.role ?? null,
          debit: line.debit_minor,
          credit: line.credit_minor,
          memo: line.memo ?? null,
          propertyId: line.property_id ?? null,
          unitId: line.unit_id ?? null,
          branchId: line.branch_id ?? null,
          realtorId: line.realtor_id ?? null,
          partyId: line.party_id ?? null,
          partyType: line.party_type ?? null,
          position: line.position,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
  }

  const fellBack = resolved.filter((row) => row.fellBack).map((row) => row.asked);
  if (fellBack.length) {
    console.warn(
      `[ledger] ${reference}: no account for ${fellBack.join(', ')} — posted to suspense. `
      + 'This will fail the period close checklist until the chart is corrected.',
    );
  }

  return {
    entry_id: Number(entryId),
    reference,
    posted: true,
    replayed: false,
    fell_back: fellBack,
  };
};

/**
 * Reverse an entry (ACC-2.4).
 *
 * Writes a NEW entry with every line's sides swapped, naming the original. The
 * original is untouched, which is the whole point: a statement produced before
 * the correction still reproduces, and the correction is visible as a
 * correction rather than as an edit nobody can see.
 *
 * Dated today by default rather than on the original's date, because reversing
 * a January entry in March is a March event — backdating it would change a
 * period that may already be closed and a statement that may already be filed.
 */
const reverse = async (sequelize, entryId, {
  reason = null, createdBy = null, entryDate = null, transaction = null,
} = {}) => {
  const [original] = await sequelize.query(
    'SELECT * FROM journal_entries WHERE id = :id LIMIT 1',
    { replacements: { id: entryId }, type: QueryTypes.SELECT, transaction },
  );
  if (!original) throw Object.assign(new Error('No such journal entry.'), { status: 404 });

  const [already] = await sequelize.query(
    'SELECT id, reference FROM journal_entries WHERE reverses_entry_id = :id LIMIT 1',
    { replacements: { id: entryId }, type: QueryTypes.SELECT, transaction },
  );
  if (already) {
    return {
      entry_id: Number(already.id), reference: already.reference, posted: false, replayed: true, fell_back: [],
    };
  }

  const lines = await sequelize.query(
    'SELECT * FROM journal_lines WHERE entry_id = :id ORDER BY position, id',
    { replacements: { id: entryId }, type: QueryTypes.SELECT, transaction },
  );

  return post(sequelize, {
    companyId: original.company_id,
    entryDate: entryDate || new Date().toISOString().slice(0, 10),
    source: 'reversal',
    sourceId: String(entryId),
    memo: `Reverses ${original.reference}${reason ? ` — ${reason}` : ''}`,
    createdBy,
    reversesEntryId: Number(entryId),
    reversalReason: reason,
    key: idempotencyKey('reversal', entryId),
    lines: lines.map((line, index) => ({
      account_id: line.account_id,
      // Swapped. That is the entire mechanic of a reversal.
      debit_minor: asMinor(line.credit_minor),
      credit_minor: asMinor(line.debit_minor),
      memo: line.memo,
      property_id: line.property_id,
      unit_id: line.unit_id,
      branch_id: line.branch_id,
      realtor_id: line.realtor_id,
      party_id: line.party_id,
      party_type: line.party_type,
      position: index,
    })),
  }, { transaction });
};

/**
 * The trial balance (ACC-5.1): every account, its debits, its credits, and the
 * balance on the side the account normally sits.
 *
 * `balanced` is on the payload for the same reason the commission GL export
 * carries it — a reader must not have to compare two totals themselves to find
 * out whether the thing they are reading is trustworthy.
 */
const trialBalance = async (sequelize, { companyId = null, from = null, to = null } = {}) => {
  const bounds = [];
  const replacements = { companyId: companyId ?? null };
  if (from) { bounds.push('AND e.entry_date >= :from'); replacements.from = from; }
  if (to) { bounds.push('AND e.entry_date <= :to'); replacements.to = to; }

  /*
   * The date window narrows the LINES, through a subquery, rather than sitting
   * on a LEFT JOIN to the entries.
   *
   * Written the obvious way first — `LEFT JOIN journal_entries e ON e.id =
   * l.entry_id AND e.entry_date >= :from` — it filtered the ENTRY and not the
   * line: a line whose entry fell outside the window still arrived with a null
   * entry beside it, and its amounts still summed. A trial balance for 2030
   * returned the whole ledger. Caught by verify:ledger asking for an empty
   * window, which is the only reason it is not in the first release.
   *
   * A line always has an entry, so the inner join below loses nothing.
   */
  const rows = await sequelize.query(
    `SELECT a.id, a.code, a.name, a.${q(sequelize, 'type')} AS type, a.role,
            COALESCE(SUM(m.debit_minor), 0) AS debit_minor,
            COALESCE(SUM(m.credit_minor), 0) AS credit_minor
       FROM ledger_accounts a
       LEFT JOIN (
         SELECT l.account_id, l.debit_minor, l.credit_minor
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE 1 = 1 ${bounds.join(' ')}
       ) m ON m.account_id = a.id
      WHERE a.company_id ${companyId ? '= :companyId' : 'IS NULL'}
      GROUP BY a.id, a.code, a.name, a.${q(sequelize, 'type')}, a.role
      HAVING COALESCE(SUM(m.debit_minor), 0) <> 0 OR COALESCE(SUM(m.credit_minor), 0) <> 0
      ORDER BY a.code`,
    { replacements, type: QueryTypes.SELECT },
  );

  const accounts = rows.map((row) => {
    const debit = Number(row.debit_minor) || 0;
    const credit = Number(row.credit_minor) || 0;
    const normal = NORMAL_BALANCE[row.type] || 'debit';
    const signed = normal === 'debit' ? debit - credit : credit - debit;
    return {
      account_id: Number(row.id),
      code: row.code,
      name: row.name,
      type: row.type,
      role: row.role,
      debit_minor: debit,
      credit_minor: credit,
      normal_balance: normal,
      balance_minor: signed,
    };
  });

  const debits = accounts.reduce((total, row) => total + row.debit_minor, 0);
  const credits = accounts.reduce((total, row) => total + row.credit_minor, 0);

  return {
    company_id: companyId ?? null,
    from,
    to,
    accounts,
    debit_minor: debits,
    credit_minor: credits,
    difference_minor: debits - credits,
    balanced: debits === credits,
  };
};

/** Whether a role is one the catalogue knows about. */
const isKnownRole = (role) => ROLES.includes(String(role || ''));

module.exports = {
  post, reverse, trialBalance, chartFor, forgetChart, idempotencyKey, isKnownRole, ROLE,
};
