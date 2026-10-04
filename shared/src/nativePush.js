const http2 = require('http2');
const jwt = require('jsonwebtoken');
const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * Notifications to the native app (Realx8-Mobile) — the phone counterpart of
 * webPush.js, sent straight to Google and Apple rather than through a relay,
 * so a notification's contents pass through nobody else.
 *
 *   android → FCM HTTP v1      FCM_SERVICE_ACCOUNT (the service-account JSON,
 *                              raw or base64)
 *   ios     → APNs (HTTP/2)    APNS_KEY (the .p8, raw or base64), APNS_KEY_ID,
 *                              APNS_TEAM_ID; APNS_TOPIC for rows with no app_id
 *
 * A platform with no credentials is skipped, not an error: a deployment can
 * run Android before its Apple key exists. Like pushToUser this never rejects
 * — push is the channel that interrupts, and its failure must not stop the
 * in-app row or the email beside it.
 */

const decode = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('{') || value.startsWith('-----')) return value;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
};

/* ── FCM ──────────────────────────────────────────────────────────────────── */

let fcmAccount;
const fcmCredentials = () => {
  if (fcmAccount !== undefined) return fcmAccount;
  try {
    const parsed = JSON.parse(decode(process.env.FCM_SERVICE_ACCOUNT) || 'null');
    fcmAccount = parsed?.client_email && parsed?.private_key && parsed?.project_id ? parsed : null;
  } catch (error) {
    console.error('[push] FCM_SERVICE_ACCOUNT is not valid JSON:', error.message);
    fcmAccount = null;
  }
  return fcmAccount;
};

/**
 * An OAuth access token for FCM, from the service account (the two-legged
 * JWT-bearer grant). Good for an hour; reused until five minutes before.
 */
let fcmToken = null;
const fcmAccessToken = async (account) => {
  if (fcmToken && fcmToken.expiresAt > Date.now() + 5 * 60 * 1000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt.sign({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }, account.private_key, { algorithm: 'RS256' });

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`FCM auth failed (${response.status})`);
  fcmToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return fcmToken.value;
};

/** 'sent' | 'gone' (token is dead — delete it) | 'failed' (try again next time). */
const sendFcm = async (account, row, message) => {
  const accessToken = await fcmAccessToken(account);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: row.token,
        notification: { title: message.title, body: message.body },
        // FCM data values must all be strings.
        data: Object.fromEntries(Object.entries(message.data).map(([k, v]) => [k, String(v)])),
        android: {
          priority: 'high',
          notification: { ...(message.tag ? { tag: message.tag } : {}), channel_id: 'default' },
        },
      },
    }),
  });
  if (response.ok) return 'sent';
  const body = await response.json().catch(() => ({}));
  const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode || body?.error?.status;
  // UNREGISTERED: the app was uninstalled or the token rotated. INVALID_ARGUMENT
  // on a send whose only variable is the token means the token is malformed.
  // Said, not just counted: "sent" with nothing arriving is otherwise undiagnosable.
  console.warn(`[push] FCM refused a send (${response.status} ${code || 'no code'}): ${body?.error?.message || ''}`.trim());
  if (response.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return 'gone';
  if (response.status === 401) fcmToken = null;
  return 'failed';
};

/* ── APNs ─────────────────────────────────────────────────────────────────── */

const apnsCredentials = () => {
  const key = decode(process.env.APNS_KEY);
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  return key && keyId && teamId ? { key, keyId, teamId } : null;
};

/**
 * The provider token. Apple rejects one older than an hour and throttles one
 * refreshed more often than every twenty minutes, so it is kept for fifty.
 */
let apnsJwt = null;
const apnsProviderToken = ({ key, keyId, teamId }) => {
  if (apnsJwt && apnsJwt.expiresAt > Date.now()) return apnsJwt.value;
  const value = jwt.sign({ iss: teamId, iat: Math.floor(Date.now() / 1000) }, key, {
    algorithm: 'ES256', header: { alg: 'ES256', kid: keyId },
  });
  apnsJwt = { value, expiresAt: Date.now() + 50 * 60 * 1000 };
  return value;
};

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};

const sendApns = (credentials, row, message) => new Promise((resolve) => {
  const topic = row.app_id || process.env.APNS_TOPIC;
  if (!topic) {
    console.error('[push] APNs: no app_id on the device and no APNS_TOPIC');
    resolve('failed');
    return;
  }
  const host = APNS_HOSTS[row.environment === 'development' ? 'development' : 'production'];
  const client = http2.connect(host);
  client.on('error', () => resolve('failed'));

  const request = client.request({
    ':method': 'POST',
    ':path': `/3/device/${row.token}`,
    authorization: `bearer ${apnsProviderToken(credentials)}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
    // Replaces an earlier notification about the same thing; APNs caps it at 64 bytes.
    ...(message.tag ? { 'apns-collapse-id': Buffer.from(message.tag).subarray(0, 64).toString() } : {}),
  });

  let status = 0;
  let raw = '';
  request.setEncoding('utf8');
  request.on('response', (headers) => { status = Number(headers[':status']); });
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    client.close();
    if (status === 200) return resolve('sent');
    let reason = '';
    try { reason = JSON.parse(raw).reason || ''; } catch { /* empty body */ }
    // 410: the token is no longer active. BadDeviceToken / DeviceTokenNotForTopic: it never will be.
    console.warn(`[push] APNs refused a send (${status} ${reason || 'no reason'})`);
    if (status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason)) return resolve('gone');
    if (reason === 'ExpiredProviderToken') apnsJwt = null;
    return resolve('failed');
  });
  request.on('error', () => { client.close(); resolve('failed'); });
  request.setTimeout(10_000, () => { request.close(); client.close(); resolve('failed'); });
  request.end(JSON.stringify({
    aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
    ...message.data,
  }));
});

/* ── Fan-out ──────────────────────────────────────────────────────────────── */

const devicesFor = async (sequelize, userId) => sequelize.query(
  `SELECT d.id, d.platform, d.token, d.app_id, d.environment, c.name AS company_name
     FROM ${q(sequelize, 'device_tokens')} d
     LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.user_id = :userId`,
  { replacements: { userId }, type: QueryTypes.SELECT },
).catch(() => []);

/**
 * The apps that are Realx8 itself rather than one company's own build.
 * Comma-separated bundle ids; defaults to the store app.
 */
const genericAppIds = () => String(process.env.MOBILE_GENERIC_APP_IDS || 'com.realx8.app')
  .split(',').map((id) => id.trim()).filter(Boolean);

/**
 * Whose notification this is, said where the person will see it.
 *
 * A company's own app already carries its name: the phone prints the app's
 * name — "Explorer Homes" — at the top of every notification. The Realx8 app
 * prints "Realx8", which serves every company, so there the company goes into
 * the title. Kept to 120 characters as before, and never doubled when the
 * title already starts with it.
 */
const titleFor = (row, title) => {
  const company = String(row.company_name || '').trim();
  if (!company || !genericAppIds().includes(row.app_id || '')) return title;
  if (title.toLowerCase().startsWith(company.toLowerCase())) return title;
  return `${company} · ${title}`.slice(0, 120);
};

/**
 * Send one notification to every phone a person has registered.
 * Same arguments and the same { sent, failed, removed } answer as pushToUser.
 */
const pushToDevices = async (sequelize, { userId, title, body, url = null, tag = null, data = {} }) => {
  const result = { sent: 0, failed: 0, removed: 0, skipped: 0 };
  const devices = await devicesFor(sequelize, userId);
  if (!devices.length) return result;

  const fcm = fcmCredentials();
  const apns = apnsCredentials();
  // Trimmed as for web push: a payload over the cap is refused, not truncated.
  const message = {
    title: String(title || 'Notification').slice(0, 120),
    body: String(body || '').split('\n').slice(0, 3).join(' ').slice(0, 300),
    tag: tag || null,
    data: { ...(url ? { url } : {}), ...(data && typeof data === 'object' ? data : {}) },
  };

  await Promise.all(devices.map(async (row) => {
    let outcome;
    // Per phone: the same news, under the name of the company it is about.
    const branded = {
      ...message,
      title: titleFor(row, message.title),
      data: { ...message.data, ...(row.company_name ? { company_name: row.company_name } : {}) },
    };
    try {
      if (row.platform === 'android' && fcm) outcome = await sendFcm(fcm, row, branded);
      else if (row.platform === 'ios' && apns) outcome = await sendApns(apns, row, branded);
      else {
        // That platform has no credentials on this deployment: counted and said, never silent.
        result.skipped += 1;
        warnUnconfigured(row.platform);
        return;
      }
    } catch (error) {
      console.error(`[push] ${row.platform} send failed:`, error.message);
      outcome = 'failed';
    }

    const table = q(sequelize, 'device_tokens');
    if (outcome === 'sent') {
      result.sent += 1;
      await sequelize.query(
        `UPDATE ${table} SET last_used_at = NOW(), failure_count = 0, updated_at = NOW() WHERE id = :id`,
        { replacements: { id: row.id }, type: QueryTypes.UPDATE },
      ).catch(() => {});
    } else if (outcome === 'gone') {
      result.removed += 1;
      await sequelize.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id: row.id }, type: QueryTypes.UPDATE })
        .catch(() => {});
    } else {
      result.failed += 1;
      await sequelize.query(
        `UPDATE ${table} SET failure_count = failure_count + 1, updated_at = NOW() WHERE id = :id`,
        { replacements: { id: row.id }, type: QueryTypes.UPDATE },
      ).catch(() => {});
    }
  }));

  return result;
};

/** Once per platform per process: a phone was skipped because its push service is not configured. */
const warned = new Set();
const warnUnconfigured = (platform) => {
  if (warned.has(platform)) return;
  warned.add(platform);
  console.warn(platform === 'android'
    ? '[push] Android phone skipped: FCM_SERVICE_ACCOUNT is not set (or not valid JSON).'
    : '[push] iPhone skipped: APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID are not set.');
};

/** Which platforms this deployment can send to — for the config printout and the test endpoint. */
const nativePushStatus = () => ({ android: Boolean(fcmCredentials()), ios: Boolean(apnsCredentials()) });

module.exports = { pushToDevices, devicesFor, nativePushStatus, titleFor };
