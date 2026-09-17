const { QueryTypes } = require('sequelize');
const { q } = require('../dialect');

/**
 * Whose eBulkSMS account a message is sent on.
 *
 * ── Per company, because the bill is per company ────────────────────────────
 *
 * Every company on this platform buys its own SMS units and sends under its
 * own registered sender name — a message from one company's account must not
 * be charged to another's, and a recipient must see the name of the company
 * they actually deal with. So credentials live in `settings` scoped by
 * company, exactly as payment gateway keys do, and are read the same way:
 * global rows first, the company's own rows over the top.
 *
 * ── The global row is a fallback, not a default anybody is billed by ────────
 *
 * A platform-level credential (company_id IS NULL) exists so a deployment can
 * run with one shared account — useful in development, and for a single-tenant
 * installation where the distinction is meaningless. A company that saves its
 * own overrides it completely: username, key AND sender move together, because
 * a company's sender name on the platform's account would bill the wrong
 * party under the wrong name.
 *
 * ── Environment last ───────────────────────────────────────────────────────
 *
 * EBULKSMS_USERNAME / EBULKSMS_API_KEY / EBULKSMS_SENDER are the bottom of the
 * pile. They exist so a deployment can be configured before anybody has opened
 * a settings screen, and so nothing has to be typed into a database to get a
 * development environment sending.
 */
const GROUP = 'sms';

const KEYS = {
  username: 'ebulksms_username',
  apikey: 'ebulksms_api_key',
  sender: 'ebulksms_sender',
  enabled: 'sms_enabled',
  dnd: 'sms_dnd_sender',
};

/** Which of these must never be read back out to a screen. */
const SECRET_KEYS = [KEYS.apikey];

const truthy = (value) => ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/**
 * The raw settings rows for a company, global underneath its own.
 *
 * Identifiers are quoted per engine: key, value and group are reserved words,
 * MySQL quotes with backticks and Postgres with double quotes, and each
 * rejects the other's.
 */
const smsSettingsFor = async (sequelize, companyId) => {
  const rows = await sequelize.query(
    `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
      WHERE ${q(sequelize, 'group')} = '${GROUP}'
        AND (company_id IS NULL OR company_id = :companyId)`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
  ).catch(() => []);

  const global = {}; const own = {};
  rows.forEach((row) => { (row.company_id == null ? global : own)[row.key] = row.value; });
  return { global, own, merged: { ...global, ...own } };
};

/**
 * The credentials a send should actually use, and whether it may send at all.
 *
 * Returns { ready, username, apikey, sender, dnd, source, reason }. `ready`
 * false always carries a `reason` a person can act on, because "SMS did not
 * send" with no explanation is the failure mode this whole file exists to
 * avoid.
 */
const smsCredentialsFor = async (sequelize, companyId) => {
  const { own, global, merged } = await smsSettingsFor(sequelize, companyId);

  /**
   * The three credential fields move together, all or nothing.
   *
   * A company that has saved its own username is on its own account and takes
   * its own username, key AND sender. One that has not takes all three from
   * the platform — NOT the merge of the two.
   *
   * The merge is the trap, and it arrives by accident rather than by design: a
   * company that types only a sender name has half-filled a form, and merging
   * field by field would hand it the platform's key with that sender on top.
   * The platform then pays for the message and a sender ID it has never
   * registered goes out on its account, which is how an ID gets blocked for
   * every company sharing it.
   *
   * `enabled` and `dnd` below are NOT credentials and do still merge: whether
   * a company wants texts sent, and whether it will pay to reach DND numbers,
   * are its own choices even while it is on the platform's account.
   */
  const usingOwn = Boolean(String(own[KEYS.username] || '').trim());
  const credentials = usingOwn ? own : global;
  const pick = (key) => String(credentials[key] ?? '').trim();

  const username = pick(KEYS.username) || String(process.env.EBULKSMS_USERNAME || '').trim();
  const apikey = pick(KEYS.apikey) || String(process.env.EBULKSMS_API_KEY || '').trim();
  const sender = pick(KEYS.sender) || String(process.env.EBULKSMS_SENDER || '').trim();

  const source = usingOwn ? 'company'
    : (merged[KEYS.username] ? 'platform' : (process.env.EBULKSMS_USERNAME ? 'environment' : 'none'));

  // Off unless somebody turned it on. Sending a text costs money and reaches
  // somebody's pocket, so it is not something a deployment should start doing
  // because a credential happened to be present.
  const enabled = truthy(merged[KEYS.enabled] ?? process.env.EBULKSMS_ENABLED);

  if (!enabled) {
    return { ready: false, reason: 'SMS is switched off for this company.', source, enabled: false };
  }
  if (!username || !apikey) {
    return { ready: false, reason: 'No eBulkSMS credentials are configured.', source, enabled };
  }
  if (!sender) {
    return { ready: false, reason: 'No SMS sender name is configured.', source, enabled };
  }

  return {
    ready: true,
    username,
    apikey,
    sender,
    dnd: truthy(merged[KEYS.dnd]),
    source,
    enabled,
  };
};

/**
 * What a settings screen may see: everything except the key itself.
 *
 * The API key is write-only from the outside. Returning it — even to the
 * administrator who typed it — puts a live credential into a browser tab, a
 * screenshot and a support ticket, and there is nothing a screen needs it for
 * beyond showing that one is saved.
 */
const maskedSmsSettings = async (sequelize, companyId) => {
  const { own, merged } = await smsSettingsFor(sequelize, companyId);
  const value = (key) => String(merged[key] ?? '').trim();
  const key = value(KEYS.apikey);

  return {
    username: value(KEYS.username),
    sender: value(KEYS.sender),
    enabled: truthy(merged[KEYS.enabled]),
    dnd: truthy(merged[KEYS.dnd]),
    // Presence and shape, never the value. Four trailing characters is enough
    // to tell two keys apart without being enough to use one.
    api_key_set: Boolean(key),
    api_key_hint: key ? `••••${key.slice(-4)}` : null,
    // Whether this company is on its own account or the platform's, which
    // decides whose units a message spends.
    using_own_credentials: Boolean(String(own[KEYS.username] || '').trim()),
  };
};

module.exports = { GROUP, KEYS, SECRET_KEYS, smsSettingsFor, smsCredentialsFor, maskedSmsSettings };
