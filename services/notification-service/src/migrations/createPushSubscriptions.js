const {
  isPostgres, tableExists, quoteIdent, indexExists, isDuplicateIndexError,
} = require('../../../../shared/src/dialect');

/**
 * Where a browser's permission to be notified is kept.
 *
 * ── One row per BROWSER, not per person ─────────────────────────────────────
 *
 * A push subscription is granted by a browser on a device, so somebody with a
 * laptop and a phone has two, and they are not interchangeable — sending to one
 * does not reach the other. Storing a single subscription per user would mean
 * whichever device subscribed last silently stole the notifications from every
 * other, which is indistinguishable from push not working.
 *
 * The endpoint is the identity. It is a URL the push service issues, unique to
 * that browser and that subscription, and it is what makes re-subscribing from
 * the same browser an update rather than a duplicate.
 *
 * ── The keys are the browser's, not ours ────────────────────────────────────
 *
 * `p256dh` and `auth` come from the browser and are what the payload is
 * encrypted to (RFC 8291). Nobody else — including the push service relaying
 * the message — can read a notification's contents without them. That is worth
 * knowing when deciding what to put in one: the transport is private, but a
 * notification still surfaces on a lock screen.
 */

const id = (pg) => (pg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
const fk = (pg) => (pg ? 'INTEGER' : 'INT UNSIGNED');
const ts = (pg) => (pg ? 'TIMESTAMP WITH TIME ZONE' : 'DATETIME');
const suffix = (pg) => (pg ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

module.exports = async (sequelize) => {
  const pg = isPostgres(sequelize);

  if (!(await tableExists(sequelize, 'push_subscriptions'))) {
    await sequelize.query(
      `CREATE TABLE ${quoteIdent(sequelize, 'push_subscriptions')} (
        id ${id(pg)},
        user_id ${fk(pg)} NOT NULL,
        company_id ${fk(pg)} NULL,
        /*
         * The push service's URL for this browser. Long — Apple's run past 500
         * characters — and it is the natural key, so it is indexed rather than
         * scanned.
         */
        endpoint VARCHAR(1000) NOT NULL,
        p256dh VARCHAR(255) NOT NULL,
        auth VARCHAR(255) NOT NULL,
        /* So a person can tell which of their devices a row is. */
        user_agent VARCHAR(255) NULL,
        /*
         * Consecutive failures. A push service that answers 404 or 410 has
         * discarded the subscription and the row is deleted outright; this
         * counts the softer failures, so a browser that has been offline for a
         * month is not mistaken for one that has gone for good.
         */
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at ${ts(pg)} NULL,
        created_at ${ts(pg)} NOT NULL,
        updated_at ${ts(pg)} NULL
      )${suffix(pg)}`,
    );
  }

  /**
   * Unique on a PREFIX of the endpoint on MySQL, which cannot index 1000
   * characters of utf8mb4 in one key. 255 is comfortably past the point where
   * two endpoints from the same push service differ.
   */
  const uniqueName = 'ux_push_subscriptions_endpoint';
  if (!(await indexExists(sequelize, 'push_subscriptions', uniqueName))) {
    const expression = pg
      ? `${quoteIdent(sequelize, 'endpoint')}`
      : `${quoteIdent(sequelize, 'endpoint')}(255)`;
    await sequelize.query(
      `CREATE UNIQUE INDEX ${quoteIdent(sequelize, uniqueName)} `
      + `ON ${quoteIdent(sequelize, 'push_subscriptions')} (${expression})`,
    ).catch((error) => {
      if (!isDuplicateIndexError(error)) throw error;
    });
  }

  const byUser = 'ix_push_subscriptions_user';
  if (!(await indexExists(sequelize, 'push_subscriptions', byUser))) {
    await sequelize.query(
      `CREATE INDEX ${quoteIdent(sequelize, byUser)} `
      + `ON ${quoteIdent(sequelize, 'push_subscriptions')} (${quoteIdent(sequelize, 'user_id')})`,
    ).catch((error) => {
      if (!isDuplicateIndexError(error)) throw error;
    });
  }
};
