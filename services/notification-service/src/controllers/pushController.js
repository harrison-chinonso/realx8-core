const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { q, insertReturningId } = require('../../../../shared/src/dialect');
const { vapidKeys, pushToUser } = require('../../../../shared/src/webPush');

/**
 * Registering and forgetting a browser.
 *
 * ── Why the browser is identified by its endpoint ───────────────────────────
 *
 * A subscription belongs to a browser on a device, not to a person: somebody
 * with a laptop and a phone has two, and they are not interchangeable. The
 * endpoint is the URL the push service issued for that browser, which makes
 * re-subscribing from the same one an update rather than a second row.
 *
 * Without that, every sign-in would add another subscription and a person would
 * receive one notification per time they had ever logged in.
 */

/** The public half of the VAPID pair, which the browser needs to subscribe. */
const publicKey = asyncHandler(async (req, res) => {
  try {
    const keys = await vapidKeys(sequelize);
    return res.json({ success: true, data: { publicKey: keys.publicKey } });
  } catch (error) {
    /**
     * Reported as unavailable rather than as an error. A deployment where push
     * cannot be set up should leave the browser showing no push controls, not
     * an error somebody has to interpret.
     */
    console.error('[push] could not provide a public key:', error.message);
    return res.json({ success: true, data: { publicKey: null, reason: 'unavailable' } });
  }
});

const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({
      message: 'That is not a usable push subscription — it is missing its endpoint or keys.',
    });
  }

  const replacements = {
    userId: req.user.id,
    companyId: req.user.company_id ?? null,
    endpoint: String(endpoint).slice(0, 1000),
    p256dh: String(keys.p256dh).slice(0, 255),
    auth: String(keys.auth).slice(0, 255),
    // Trimmed hard: it is a label to help somebody recognise their own device,
    // not something to parse.
    userAgent: String(req.headers['user-agent'] || '').slice(0, 255),
  };

  /**
   * An UPSERT by hand, because the two engines spell theirs differently and
   * this is one statement either way.
   *
   * The update path matters more than the insert: a browser re-subscribes on
   * every sign-in, and it may now belong to a DIFFERENT person — a shared
   * machine, or somebody switching accounts. Reassigning the row is what stops
   * the previous user's notifications arriving on it.
   */
  const [existing] = await sequelize.query(
    `SELECT id FROM ${q(sequelize, 'push_subscriptions')} WHERE endpoint = :endpoint LIMIT 1`,
    { replacements: { endpoint: replacements.endpoint }, type: QueryTypes.SELECT },
  );

  if (existing) {
    await sequelize.query(
      `UPDATE ${q(sequelize, 'push_subscriptions')}
          SET user_id = :userId, company_id = :companyId,
              p256dh = :p256dh, auth = :auth, user_agent = :userAgent,
              failure_count = 0, updated_at = NOW()
        WHERE id = :id`,
      { replacements: { ...replacements, id: existing.id }, type: QueryTypes.UPDATE },
    );
    return res.json({ success: true, data: { id: existing.id, updated: true } });
  }

  const id = await insertReturningId(
    sequelize,
    `INSERT INTO ${q(sequelize, 'push_subscriptions')}
       (user_id, company_id, endpoint, p256dh, auth, user_agent, failure_count, created_at, updated_at)
     VALUES (:userId, :companyId, :endpoint, :p256dh, :auth, :userAgent, 0, NOW(), NOW())`,
    { replacements },
  );

  return res.status(201).json({ success: true, data: { id, updated: false } });
});

/**
 * Forget one browser.
 *
 * Scoped to the caller: an endpoint is not a secret worth relying on, and
 * without the scope anybody holding one could unsubscribe somebody else.
 */
const unsubscribe = asyncHandler(async (req, res) => {
  const endpoint = String(req.body?.endpoint || '').slice(0, 1000);
  if (!endpoint) return res.status(400).json({ message: 'Say which subscription to remove.' });

  const [, metadata] = await sequelize.query(
    `DELETE FROM ${q(sequelize, 'push_subscriptions')}
      WHERE endpoint = :endpoint AND user_id = :userId`,
    { replacements: { endpoint, userId: req.user.id }, type: QueryTypes.UPDATE },
  );

  const removed = Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
  return res.json({ success: true, data: { removed } });
});

/** Which of this person's browsers are registered — for the settings screen. */
const listMine = asyncHandler(async (req, res) => {
  const rows = await sequelize.query(
    `SELECT id, user_agent, last_used_at, created_at
       FROM ${q(sequelize, 'push_subscriptions')}
      WHERE user_id = :userId ORDER BY id DESC`,
    { replacements: { userId: req.user.id }, type: QueryTypes.SELECT },
  );
  res.json({ success: true, data: rows });
});

/**
 * Send a test notification to the caller's own browsers.
 *
 * Push is the one channel where "is it working" cannot be answered by looking
 * at a screen in the application — the answer arrives outside it, or does not.
 * Without this, the only way to find out is to wait for something real to
 * happen and notice whether it appeared.
 */
const sendTest = asyncHandler(async (req, res) => {
  const result = await pushToUser(sequelize, {
    userId: req.user.id,
    title: 'Browser notifications are working',
    body: 'This is a test. Real notifications will look like this.',
    url: '/',
    tag: `test:${req.user.id}`,
  });

  if (!result.sent && !result.failed && !result.removed) {
    return res.status(409).json({
      message: 'This browser is not registered for notifications yet. Turn them on first.',
    });
  }

  return res.json({ success: true, data: result });
});

module.exports = { publicKey, subscribe, unsubscribe, listMine, sendTest };
