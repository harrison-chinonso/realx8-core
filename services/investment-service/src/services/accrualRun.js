const { QueryTypes } = require('sequelize');
const { toMajor, asMinor } = require('../../../../shared/src/money');
const { nextPayoutDate, hasMatured } = require('../../../../shared/src/investments/accrual');
const { recordFunding, positionOf } = require('./investmentEngine');

/**
 * The clock the investment feature did not have.
 *
 * ── Why a run rather than a trigger ─────────────────────────────────────────
 *
 * Returns accrue with time, and time is not an event anything emits. Before
 * this, a monthly return was monthly only if a person remembered to record it —
 * and the amount was whatever they typed. This sweeps every active investment
 * and creates the payouts that have actually fallen due.
 *
 * ── Idempotent, because it will be run twice ────────────────────────────────
 *
 * A scheduler retries. A deploy restarts mid-sweep. Somebody runs it by hand
 * after an outage. All three must be safe, and the safety does not come from
 * remembering what ran — it comes from the engine answering CUMULATIVE earnings
 * and this subtracting what has been paid. Run it ten times on the same day and
 * the second through tenth create nothing, because nothing further is due.
 *
 * That property is worth more than any lock: money paid twice is the single
 * worst failure available here, and a lock can be lost while arithmetic cannot.
 */

/** Everything that could owe money today. */
const dueInvestments = async (sequelize) => sequelize.query(
  `SELECT * FROM investments
    WHERE status = 'active'
      AND funded_minor > 0
      AND funded_at IS NOT NULL
    ORDER BY id ASC`,
  { type: QueryTypes.SELECT },
);

/**
 * Whether a periodic release has come round yet.
 *
 * A monthly plan should not pay on day three merely because three days of
 * interest exist — the investor was told monthly. `at_maturity` plans release
 * once, at maturity, and nothing before.
 */
const releaseIsDue = (investment, asAt) => {
  const terms = investment.terms || {};
  if (hasMatured(terms, investment.funded_at, asAt)) return true;
  if (terms.frequency === 'at_maturity' || !terms.frequency) return false;

  /*
   * The next release date, computed from the LAST one that fell due rather than
   * from now — nextPayoutDate always looks forward, so a period that closed
   * while the scheduler was down is caught by asking whether the date it would
   * have produced yesterday has passed.
   */
  const next = nextPayoutDate(terms, { fundedAt: investment.funded_at, asAt: new Date(new Date(asAt).getTime() - 1) });
  return Boolean(next && new Date(next) <= new Date(asAt));
};

/**
 * Sweep once.
 *
 * @returns {{ examined, created, capital, skipped, total_minor }}
 */
const runAccrual = async (models, { asAt = new Date(), logger = console } = {}) => {
  const { sequelize, Investment, InvestmentPayout, InvestmentTransaction } = models;
  const rows = await dueInvestments(sequelize);

  const summary = { examined: rows.length, created: 0, capital: 0, skipped: 0, total_minor: 0 };

  for (const row of rows) {
    const investment = await Investment.findByPk(row.id);
    if (!investment) continue;

    /*
     * Catch up on funding first. A payment approved by finance never tells this
     * service, so an investment can be sitting active-but-unfunded, or funded
     * for less than it now is. Reading it here means the sweep is also the
     * repair.
     */
    await recordFunding(sequelize, investment).catch(() => {});
    await investment.reload();

    const position = positionOf(investment, asAt);

    /*
     * `releasable_minor` is already zero between release dates — it accrues to
     * the last period that closed — so there is no separate "is it due yet"
     * test to keep in step with the arithmetic. One number, one meaning.
     */
    if (position.releasable_minor > 0) {
      await InvestmentPayout.create({
        investment_id: investment.id,
        user_id: investment.user_id,
        kind: 'return',
        amount_minor: position.releasable_minor,
        amount: toMajor(position.releasable_minor),
        status: 'pending',
        payout_date: asAt,
        company_id: investment.company_id ?? null,
        // The inputs, so a disputed figure can be reconstructed from what was
        // actually used rather than from today's configuration.
        computed_from: {
          principal_minor: position.principal_minor,
          earned_minor: position.earned_minor,
          released_to: position.last_release_date,
          already_paid_minor: position.paid_minor,
          days: position.days,
          basis: position.basis,
          terms: position.terms,
          as_at: new Date(asAt).toISOString(),
        },
      });

      /*
       * `return_paid_minor` advances when the payout is CREATED, not when it is
       * paid. It records what has been committed to, and it is what the next
       * run subtracts — advancing it only on payment would have every run until
       * then raise the same payout again.
       */
      await investment.update({
        return_paid_minor: asMinor(investment.return_paid_minor) + position.releasable_minor,
      });

      summary.created += 1;
      summary.total_minor += position.releasable_minor;
    } else {
      summary.skipped += 1;
    }

    // Capital comes back at maturity, as its own payout — distinct from the
    // return, so "how much capital is still out" stays answerable.
    if (position.matured && position.capital_outstanding_minor > 0) {
      await InvestmentPayout.create({
        investment_id: investment.id,
        user_id: investment.user_id,
        kind: 'capital',
        amount_minor: position.capital_outstanding_minor,
        amount: toMajor(position.capital_outstanding_minor),
        status: 'pending',
        payout_date: asAt,
        company_id: investment.company_id ?? null,
        computed_from: { principal_minor: position.principal_minor, as_at: new Date(asAt).toISOString() },
      });

      await investment.update({
        capital_paid_minor: position.principal_minor,
        matured_at: investment.matured_at || position.maturity_date,
      });
      summary.capital += 1;
      summary.total_minor += position.capital_outstanding_minor;
    }

    /*
     * Complete only when BOTH the capital and every accrued return have been
     * accounted for. An investment marked complete with money still owed is
     * one nobody will look at again.
     */
    await investment.reload();
    const settled = positionOf(investment, asAt);
    if (settled.matured && settled.releasable_minor === 0 && settled.capital_outstanding_minor === 0) {
      await investment.update({ status: 'completed' });
    }
  }

  if (summary.created || summary.capital) {
    logger.info?.(`[investments] accrual: ${summary.created} return payout(s), `
      + `${summary.capital} capital return(s), ${toMajor(summary.total_minor)} in total`);
  }

  return summary;
};

/**
 * Armed at boot, nightly.
 *
 * 03:00 rather than 02:00: the finance sweep runs at 02:00 and approves nothing
 * on its own, but it does move payment statuses about — and an accrual that
 * reads funding while that is mid-flight would see a half-written picture.
 * An hour apart costs nothing and removes the question.
 *
 * Failure is logged and swallowed. A run that throws must not take the process
 * down, because the next run will pick up everything the failed one missed —
 * which is the whole point of computing cumulative earnings rather than
 * increments.
 */
const startAccrualJob = (models, { logger = console } = {}) => {
  const cron = require('node-cron');
  const task = cron.schedule('0 3 * * *', () => {
    runAccrual(models, { logger }).catch((error) => {
      logger.error?.(`[investments] accrual run failed: ${error.message}`);
    });
  });
  logger.info?.('[investments] accrual armed — daily at 03:00');
  return task;
};

module.exports = { runAccrual, releaseIsDue, dueInvestments, startAccrualJob };
