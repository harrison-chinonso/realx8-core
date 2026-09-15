const { QueryTypes } = require('sequelize');
const webpush = require('web-push');
const { q, quoteIdent } = require('./dialect');

/**
 * Sending a notification to somebody's browser.
 *
 * ── What VAPID is for, and why the keys are generated once ──────────────────
 *
 * A push service will not relay a message from an unidentified sender. VAPID is
 * the application's own key pair: the public half is handed to the browser when
 * it subscribes and is baked into the subscription, and the private half signs
 * every send.
 *
 * That binding is why the keys must be STABLE. Regenerating them invalidates
 * every subscription ever issued — silently, because the browser goes on
 * believing it is subscribed and the push service simply stops accepting the
 * sends. So they are generated once, kept in settings beside the Google
 * credentials, and never rotated casually.
 *
 * ── Push is never allowed to break a notification ───────────────────────────
 *
 * Every failure here is caught. A push service being down, a browser that
 * revoked permission, a subscription that expired — none of it should stop the
 * in-app row being written or the email going out, because those are the
 * routes the person will actually check.
 */

const VAPID_PUBLIC = 'vapid_public_key';
const VAPID_PRIVATE = 'vapid_private_key';
const VAPID_SUBJECT = 'vapid_subject';

/**
 * Reading and writing a platform setting.
 *
 * ── Both column names are reserved words ────────────────────────────────────
 *
 * The table's columns are `key` and `group`, and both are reserved on at least
 * one engine — an unquoted `WHERE key = …` is a syntax error on MySQL and
 * `group` is one everywhere. quoteIdent spells them for whichever engine is
 * connected, which is why they are not written inline.
 */
const ident = (sequelize, name) => quoteIdent(sequelize, name);

const getSetting = async (sequelize, key) => {
  const rows = await sequelize.query(
    `SELECT ${ident(sequelize, 'value')} FROM ${ident(sequelize, 'settings')}
      WHERE ${ident(sequelize, 'key')} = :key AND ${ident(sequelize, 'group')} = 'system'
      LIMIT 1`,
    { replacements: { key }, type: QueryTypes.SELECT },
  ).catch(() => []);
  const value = rows[0]?.value;
  return value === undefined || value === null || value === '' ? null : String(value);
};

const putSetting = async (sequelize, key, value) => {
  const [existing] = await sequelize.query(
    `SELECT id FROM ${ident(sequelize, 'settings')}
      WHERE ${ident(sequelize, 'key')} = :key AND ${ident(sequelize, 'group')} = 'system' LIMIT 1`,
    { replacements: { key }, type: QueryTypes.SELECT },
  ).catch(() => []);

  if (existing) {
    await sequelize.query(
      `UPDATE ${ident(sequelize, 'settings')} SET ${ident(sequelize, 'value')} = :value WHERE id = :id`,
      { replacements: { value, id: existing.id }, type: QueryTypes.UPDATE },
    );
    return;
  }

  await sequelize.query(
    `INSERT INTO ${ident(sequelize, 'settings')}
       (${ident(sequelize, 'key')}, ${ident(sequelize, 'value')}, ${ident(sequelize, 'group')}, company_id, created_at)
     VALUES (:key, :value, 'system', NULL, NOW())`,
    { replacements: { key, value }, type: QueryTypes.INSERT },
  );
};

/**
 * The key pair, generating it on first use.
 *
 * Cached per process after the first read: this is consulted on every push, and
 * it is a settings row that changes approximately never.
 */
let cached = null;

const vapidKeys = async (sequelize, { force = false } = {}) => {
  if (cached && !force) return cached;

  let publicKey = await getSetting(sequelize, VAPID_PUBLIC);
  let privateKey = await getSetting(sequelize, VAPID_PRIVATE);

  if (!publicKey || !privateKey) {
    /**
     * Generated here rather than asked of an administrator. They are not a
     * credential anybody obtains from anywhere — they are simply a key pair
     * this installation owns — and requiring a manual step would leave push
     * quietly switched off on every deployment nobody remembered to configure.
     */
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    await putSetting(sequelize, VAPID_PUBLIC, publicKey);
    await putSetting(sequelize, VAPID_PRIVATE, privateKey);
    console.log('[push] VAPID keys generated — browser notifications are available');
  }

  /**
   * The subject identifies the sender to the push service, and must be a
   * mailto: or https: URL. A wrong one is rejected by some services and
   * ignored by others, so it is defaulted rather than left unset.
   */
  const subject = await getSetting(sequelize, VAPID_SUBJECT)
    || process.env.PUBLIC_URL
    || 'mailto:admin@localhost';

  cached = { publicKey, privateKey, subject: /^(mailto:|https:)/.test(subject) ? subject : `mailto:${subject}` };
  return cached;
};

/** Every browser this person has registered. */
const subscriptionsFor = async (sequelize, userId) => sequelize.query(
  `SELECT id, endpoint, p256dh, auth FROM ${q(sequelize, 'push_subscriptions')}
    WHERE user_id = :userId`,
  { replacements: { userId }, type: QueryTypes.SELECT },
).catch(() => []);

/**
 * Send one notification to every browser a person has registered.
 *
 * @returns {Promise<{ sent, failed, removed }>} — never rejects.
 */
const pushToUser = async (sequelize, { userId, title, body, url = null, tag = null, data = {} }) => {
  const result = { sent: 0, failed: 0, removed: 0 };

  const subscriptions = await subscriptionsFor(sequelize, userId);
  if (!subscriptions.length) return result;

  let keys;
  try {
    keys = await vapidKeys(sequelize);
  } catch (error) {
    console.error('[push] VAPID keys unavailable:', error.message);
    return result;
  }
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);

  /**
   * The body is trimmed here rather than by the browser.
   *
   * Push services cap the payload — 4KB is the common limit — and a send that
   * exceeds it is rejected outright rather than truncated. Losing the
   * notification entirely because somebody wrote a long message is a worse
   * outcome than showing the first two lines of it.
   */
  const payload = JSON.stringify({
    title: String(title || 'Notification').slice(0, 120),
    body: String(body || '').split('\n').slice(0, 3).join(' ').slice(0, 300),
    url,
    // Lets the browser REPLACE an earlier notification about the same thing
    // rather than stacking three copies of "payment approved".
    tag: tag || undefined,
    data,
  });

  await Promise.all(subscriptions.map(async (row) => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        { TTL: 60 * 60 * 24 },
      );
      result.sent += 1;
      await sequelize.query(
        `UPDATE ${q(sequelize, 'push_subscriptions')}
            SET last_used_at = NOW(), failure_count = 0, updated_at = NOW()
          WHERE id = :id`,
        { replacements: { id: row.id }, type: QueryTypes.UPDATE },
      ).catch(() => {});
    } catch (error) {
      const status = error?.statusCode;

      /**
       * 404 and 410 mean the push service has DISCARDED this subscription —
       * the browser was uninstalled, permission revoked, the data cleared. It
       * will never work again, so the row is deleted rather than retried on
       * every notification forever.
       */
      if (status === 404 || status === 410) {
        result.removed += 1;
        await sequelize.query(
          `DELETE FROM ${q(sequelize, 'push_subscriptions')} WHERE id = :id`,
          { replacements: { id: row.id }, type: QueryTypes.UPDATE },
        ).catch(() => {});
        return;
      }

      /**
       * Anything else is probably temporary — the service is down, rate
       * limiting, a network blip. Counted, so a subscription that fails
       * persistently can be cleaned up later, but kept.
       */
      result.failed += 1;
      await sequelize.query(
        `UPDATE ${q(sequelize, 'push_subscriptions')}
            SET failure_count = failure_count + 1, updated_at = NOW()
          WHERE id = :id`,
        { replacements: { id: row.id }, type: QueryTypes.UPDATE },
      ).catch(() => {});
    }
  }));

  return result;
};

module.exports = {
  vapidKeys, pushToUser, subscriptionsFor,
  VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT,
};
