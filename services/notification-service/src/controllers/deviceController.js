const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { q, insertReturningId } = require('../../../../shared/src/dialect');

/**
 * Registering and forgetting a phone (Realx8-Mobile) — the native twin of
 * pushController's browser subscriptions, and built the same way: the token
 * is the identity, registering again is an update, and an update moves the
 * row to whoever is signed in now.
 *
 * The app's shell has no session of its own; it hands the token to the
 * signed-in page, which calls these with the page's own bearer token. So a
 * token is only ever stored against the person who is signed in on it.
 */

const PLATFORMS = new Set(['android', 'ios']);
const ENVIRONMENTS = new Set(['development', 'production']);
const label = (value, max) => (value ? String(value).trim().slice(0, max) || null : null);

const register = asyncHandler(async (req, res) => {
  const platform = String(req.body?.platform || '').toLowerCase();
  const token = String(req.body?.token || '').trim();
  if (!PLATFORMS.has(platform) || !token || token.length > 512 || /\s/.test(token)) {
    return res.status(400).json({ message: 'That is not a usable device token.' });
  }
  const environment = String(req.body?.environment || '').toLowerCase();

  const replacements = {
    userId: req.user.id,
    companyId: req.user.company_id ?? null,
    platform,
    token,
    appId: label(req.body?.app_id, 150),
    environment: ENVIRONMENTS.has(environment) ? environment : null,
    deviceName: label(req.body?.device_name, 150),
    appVersion: label(req.body?.app_version, 30),
  };

  const table = q(sequelize, 'device_tokens');
  const [existing] = await sequelize.query(
    `SELECT id FROM ${table} WHERE token = :token LIMIT 1`,
    { replacements: { token }, type: QueryTypes.SELECT },
  );

  if (existing) {
    await sequelize.query(
      `UPDATE ${table}
          SET user_id = :userId, company_id = :companyId, platform = :platform, app_id = :appId,
              environment = :environment, device_name = :deviceName, app_version = :appVersion,
              failure_count = 0, updated_at = NOW()
        WHERE id = :id`,
      { replacements: { ...replacements, id: existing.id }, type: QueryTypes.UPDATE },
    );
    return res.json({ success: true, data: { id: existing.id, updated: true } });
  }

  const id = await insertReturningId(
    sequelize,
    `INSERT INTO ${table}
       (user_id, company_id, platform, token, app_id, environment, device_name, app_version,
        failure_count, created_at, updated_at)
     VALUES (:userId, :companyId, :platform, :token, :appId, :environment, :deviceName, :appVersion,
        0, NOW(), NOW())`,
    { replacements },
  );
  return res.status(201).json({ success: true, data: { id, updated: false } });
});

/**
 * Forget one phone — called by the app on sign-out, so the next person to
 * use it does not receive this one's notifications. Scoped to the caller.
 */
const unregister = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ message: 'Say which device to remove.' });

  const [, metadata] = await sequelize.query(
    `DELETE FROM ${q(sequelize, 'device_tokens')} WHERE token = :token AND user_id = :userId`,
    { replacements: { token, userId: req.user.id }, type: QueryTypes.UPDATE },
  );
  const removed = Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
  return res.json({ success: true, data: { removed } });
});

/** This person's registered phones — for the settings screen. Never the tokens. */
const listMine = asyncHandler(async (req, res) => {
  const rows = await sequelize.query(
    `SELECT id, platform, device_name, app_version, last_used_at, created_at
       FROM ${q(sequelize, 'device_tokens')}
      WHERE user_id = :userId ORDER BY id DESC`,
    { replacements: { userId: req.user.id }, type: QueryTypes.SELECT },
  );
  res.json({ success: true, data: rows });
});

module.exports = { register, unregister, listMine };
