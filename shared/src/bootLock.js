const { isPostgres } = require('./dialect');

/**
 * One process runs the schema migrations at a time.
 *
 * ── The problem this exists for ─────────────────────────────────────────────
 *
 * platform/boot.js orders the nine services' DDL carefully, and says why: they
 * share one database, several touch tables another service owns, and run
 * concurrently those statements race. That ordering only holds WITHIN a
 * process. Nothing stopped two processes booting at once — nodemon restarting
 * while a boot is still in flight, a rolling deploy, or the split shape where
 * all nine are separate deployments starting together.
 *
 * When that happens the failures are non-deterministic and look like different
 * bugs each time:
 *
 *     Deadlock found when trying to get lock          (two ALTERs, same table)
 *     Can't DROP 'properties_ibfk_1'                  (the other boot dropped it)
 *     relation "ux_..._reference" already exists      (the other boot made it)
 *
 * None reproduce on a quiet machine, which is the worst property a boot failure
 * can have: it fails in front of somebody, and every attempt to reproduce it
 * succeeds.
 *
 * ── Why an advisory lock, and not a table ───────────────────────────────────
 *
 * A lock row in a table has to be released, and a process killed mid-boot never
 * releases it — so the next deploy hangs on a lock owned by nobody, and someone
 * has to clear it by hand at exactly the wrong moment. Both engines have locks
 * tied to the CONNECTION instead: when the process dies the connection drops
 * and the lock is gone. There is nothing to clean up.
 *
 * ── Why failing to take the lock is not fatal ───────────────────────────────
 *
 * A database that will not grant the lock (permissions, a connection limit, an
 * engine that has neither primitive) should not mean the application cannot
 * start. Every migration in this codebase is already written to be idempotent —
 * the lock removes a race, it is not what makes them safe. So a failure to
 * acquire is logged loudly and the boot proceeds, which is the behaviour that
 * degrades rather than breaks.
 */

/** Both names refer to the same lock; the engines take different key types. */
const LOCK_NAME = 'realx8:boot:migrations';
/** An arbitrary but STABLE 32-bit key. Changing it would split the lock in two. */
const LOCK_KEY = 1919251256;

/**
 * How long to wait for the other boot to finish.
 *
 * Generous, because the thing being waited on is a full migration run over a
 * populated database — on the order of ten seconds here, and longer on a large
 * one. Too short and the lock silently stops doing its job under exactly the
 * load it was added for.
 */
const DEFAULT_TIMEOUT_SECONDS = 180;

const withBootLock = async (sequelize, run, options = {}) => {
  const { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, logger = console } = options;
  const pg = isPostgres(sequelize);

  /**
   * The lock must live on ONE connection, and Sequelize hands out whichever
   * connection is free per query. A transaction pins one for its lifetime, so
   * it is used here purely as a handle — it holds no row locks and writes
   * nothing.
   */
  let transaction = null;
  let held = false;

  try {
    transaction = await sequelize.transaction();

    if (pg) {
      /**
       * The transaction-scoped variant, so the lock is released by COMMIT or
       * ROLLBACK whatever happens — including a throw that skips the release.
       */
      await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
        replacements: { key: LOCK_KEY },
        transaction,
      });
      held = true;
    } else {
      const [row] = await sequelize.query('SELECT GET_LOCK(:name, :timeout) AS acquired', {
        replacements: { name: LOCK_NAME, timeout: timeoutSeconds },
        type: sequelize.QueryTypes?.SELECT || 'SELECT',
        transaction,
      });
      // 1 acquired, 0 timed out, NULL an error. Only 1 means we hold it.
      held = Number(row?.acquired ?? row?.[0]?.acquired) === 1;
      if (!held) {
        logger.warn(`[boot] waited ${timeoutSeconds}s for another instance to finish migrating `
          + 'and gave up. Continuing — the migrations are idempotent, but concurrent DDL '
          + 'can still fail on this boot.');
      }
    }
  } catch (error) {
    logger.warn(`[boot] could not take the migration lock (${error.message}). `
      + 'Continuing without it.');
    if (transaction) {
      await transaction.rollback().catch(() => {});
      transaction = null;
    }
  }

  try {
    return await run();
  } finally {
    if (transaction) {
      try {
        // MySQL's named lock is not transactional, so it is released by name.
        // Postgres's xact lock goes with the commit below.
        if (!pg && held) {
          await sequelize.query('SELECT RELEASE_LOCK(:name) AS released', {
            replacements: { name: LOCK_NAME },
            transaction,
          });
        }
        await transaction.commit();
      } catch (error) {
        logger.warn(`[boot] releasing the migration lock failed (${error.message}). `
          + 'It will lapse when this connection closes.');
        await transaction.rollback().catch(() => {});
      }
    }
  }
};

module.exports = { withBootLock, LOCK_NAME, LOCK_KEY };
