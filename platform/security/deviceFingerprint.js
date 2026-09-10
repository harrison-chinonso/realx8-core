const crypto = require('crypto');
const { securityConfig } = require('./config');
const { clientIp, maskIp } = require('./clientIp');
const { store } = require('./store');

/**
 * Recognising the browser a request came from, across requests.
 *
 * The fingerprint is a hash of the headers a browser sends consistently plus a
 * MASKED IP — three octets, not four, so a user moving within a network keeps
 * their device identity and the stored value is not a precise location record.
 *
 * WHAT IT IS FOR, precisely: an audit trail of which devices an account uses,
 * and a cap on how many. It is NOT a second factor. Every input is a header the
 * caller controls, so anyone who can replay a token can replay the headers with
 * it — treating a matching fingerprint as proof of identity would be a mistake.
 */

const DEVICE_PREFIX = 'device:';
const USER_DEVICES_PREFIX = 'user-devices:';
const DEVICE_SESSION_PREFIX = 'device-session:';
const NINETY_DAYS = 90 * 24 * 60 * 60;

/**
 * The headers that go into the hash.
 *
 * Chosen for stability: a browser sends these identically on every request,
 * while Sec-Fetch-* and Referer vary by navigation and would give a different
 * fingerprint per page — which would defeat the whole point.
 */
const FINGERPRINT_HEADERS = ['user-agent', 'accept-language', 'accept-encoding'];

const generateFingerprint = (req) => {
  const config = securityConfig().devices;
  if (!config.enabled) return 'disabled';

  const parts = FINGERPRINT_HEADERS.map((header) => String(req.headers[header] ?? ''));
  parts.push(maskIp(clientIp(req)));

  return crypto.createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 32);
};

const getDevice = (fingerprint) => store.get(`${DEVICE_PREFIX}${fingerprint}`);

const saveDevice = (fingerprint, device) => store.set(`${DEVICE_PREFIX}${fingerprint}`, device, NINETY_DAYS);

const userDevices = (userId) => store.get(`${USER_DEVICES_PREFIX}${userId}`) || [];

const rememberUserDevice = (userId, fingerprint) => {
  const devices = userDevices(userId);
  if (!devices.includes(fingerprint)) {
    devices.push(fingerprint);
    store.set(`${USER_DEVICES_PREFIX}${userId}`, devices, NINETY_DAYS);
  }
};

/**
 * Records the device against the user, returning how it should be treated.
 *
 * `trusted` means proceed; `requiresApproval` means proceed but say so on the
 * response, because this system has no approval screen and blocking would lock
 * a user out of a new browser with no way back in.
 */
const registerDevice = (userId, fingerprint, req) => {
  const config = securityConfig().devices;
  if (!config.enabled) return { trusted: true, requiresApproval: false, reason: 'disabled' };

  const existing = getDevice(fingerprint);
  if (existing && String(existing.userId) === String(userId)) {
    saveDevice(fingerprint, { ...existing, lastSeen: new Date().toISOString() });
    return { trusted: existing.trusted !== false, requiresApproval: false, reason: 'known device' };
  }

  const devices = userDevices(userId);
  if (devices.length >= config.maxDevicesPerUser) {
    // Not blocked: the cap is a signal worth surfacing, and enforcing it as a
    // refusal would lock somebody out of their account for owning phones.
    return {
      trusted: config.trustNewDevices,
      requiresApproval: true,
      reason: `device cap reached (${config.maxDevicesPerUser})`,
    };
  }

  saveDevice(fingerprint, {
    fingerprint,
    userId,
    userAgent: req.headers['user-agent'] || null,
    ip: maskIp(clientIp(req)),
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    trusted: config.trustNewDevices,
  });
  rememberUserDevice(userId, fingerprint);
  store.set(`${DEVICE_SESSION_PREFIX}${fingerprint}`, String(userId), config.sessionTimeoutSeconds);

  return {
    trusted: config.trustNewDevices,
    requiresApproval: !config.trustNewDevices,
    reason: config.trustNewDevices ? 'new device trusted' : 'new device awaiting approval',
  };
};

/** Is there a live session binding this fingerprint to this user? */
const isValidDeviceSession = (userId, fingerprint) => {
  const config = securityConfig().devices;
  if (!config.enabled) return true;

  const key = `${DEVICE_SESSION_PREFIX}${fingerprint}`;
  const sessionUserId = store.get(key);
  if (!sessionUserId || String(sessionUserId) !== String(userId)) return false;

  // Sliding expiry: an active session should not end mid-use.
  store.set(key, sessionUserId, config.sessionTimeoutSeconds);
  return true;
};

const listUserDevices = (userId) => userDevices(userId).map(getDevice).filter(Boolean);

module.exports = {
  generateFingerprint, registerDevice, isValidDeviceSession,
  getDevice, listUserDevices, FINGERPRINT_HEADERS,
};
