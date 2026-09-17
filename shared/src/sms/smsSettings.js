const { QueryTypes } = require('sequelize');
const { q } = require('../dialect');
const { providerFor, PROVIDER_KEYS, DEFAULT_PROVIDER, providerCatalogue } = require('./providers');

/**
 * Which SMS provider a company uses, and on whose account.
 *
 * ── Per company, because the bill is per company ───────────────────────────
 *
 * Every company buys its own SMS units and registers its own sender name. A
 * message from one company's account must not be charged to another's, and a
 * recipient must see the name of the company they actually deal with. So
 * credentials live in `settings` scoped by company, exactly as payment gateway
 * keys do.
 *
 * ── One set of credentials PER PROVIDER, one provider active ───────────────
 *
 * A company can fill in Termii and eBulkSMS and switch between them, which is
 * what makes moving provider a choice rather than a re-keying exercise — and
 * what makes falling back during an outage possible at all. `sms_provider`
 * says which one is live; the rest sit there until they are picked.
 *
 * Keys are `{provider}_{field}`: termii_api_key, sendchamp_sender, and so on.
 * The eBulkSMS keys already followed that shape before the others existed, so
 * nothing written by the previous version has to move.
 */
const GROUP = 'sms';

/** Settings that are about SMS as a whole, not about one provider. */
const KEYS = {
  provider: 'sms_provider',
  enabled: 'sms_enabled',
  dnd: 'sms_dnd_sender',
};

/** The settings key holding one field of one provider's credentials. */
const fieldKey = (providerKey, field) => `${providerKey}_${field}`;

/** Which of a provider's fields must never be read back out to a screen. */
const secretFields = (provider) => provider.FIELDS.filter((f) => f.secret).map((f) => f.key);

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

/** Which provider is live for this company. */
const activeProviderKey = (merged) => {
  const stored = String(merged[KEYS.provider] || '').trim().toLowerCase();
  if (PROVIDER_KEYS.includes(stored)) return stored;
  return String(process.env.SMS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
};

/**
 * The credentials a send should use, and whether it may send at all.
 *
 * Returns { ready, provider, credentials, dnd, source, reason }. `ready` false
 * always carries a `reason` a person can act on, because "SMS did not send"
 * with no explanation is the failure this file exists to avoid.
 */
const smsCredentialsFor = async (sequelize, companyId) => {
  const { own, global, merged } = await smsSettingsFor(sequelize, companyId);
  const providerKey = activeProviderKey(merged);
  const provider = providerFor(providerKey);

  /**
   * The credential fields move together, all or nothing — per provider.
   *
   * A company is on its own account for a provider if it has saved that
   * provider's API key. If it has not, it takes ALL of that provider's fields
   * from the platform, not the merge of the two.
   *
   * The merge is the trap, and it arrives by accident rather than by design: a
   * company that types only a sender name has half-filled a form, and merging
   * field by field would hand it the platform's key with that sender on top.
   * The platform then pays for the message and a sender ID it has never
   * registered goes out on its account — which is how an ID gets blocked for
   * every company sharing it.
   *
   * `enabled` and `dnd` are NOT credentials and do still merge: whether a
   * company wants texts sent, and whether it will pay to reach DND numbers,
   * are its own choices even while it is on the platform's account.
   */
  const keyField = provider.FIELDS.find((f) => f.secret)?.key || 'api_key';
  const usingOwn = Boolean(String(own[fieldKey(provider.key, keyField)] || '').trim());
  const bag = usingOwn ? own : global;

  const credentials = {};
  provider.FIELDS.forEach((field) => {
    const stored = String(bag[fieldKey(provider.key, field.key)] ?? '').trim();
    const fromEnv = String(process.env[`${provider.key.toUpperCase()}_${field.key.toUpperCase()}`] || '').trim();
    credentials[field.key] = stored || fromEnv;
  });

  const source = usingOwn ? 'company'
    : (String(global[fieldKey(provider.key, keyField)] || '').trim() ? 'platform'
      : (credentials[keyField] ? 'environment' : 'none'));

  // Off unless somebody turned it on. Sending a text costs money and reaches
  // somebody's pocket, so a credential being present is not consent.
  const enabled = truthy(merged[KEYS.enabled] ?? process.env.SMS_ENABLED ?? process.env.EBULKSMS_ENABLED);

  const base = { provider: provider.key, providerLabel: provider.label, source, enabled };

  if (!enabled) return { ...base, ready: false, reason: 'SMS is switched off for this company.' };

  const missing = provider.FIELDS
    .filter((field) => field.required && !credentials[field.key])
    .map((field) => field.label);
  if (missing.length) {
    return {
      ...base,
      ready: false,
      reason: `${provider.label} is missing ${missing.join(' and ')}.`,
    };
  }

  return {
    ...base,
    ready: true,
    credentials,
    /**
     * Transactional routing, ON unless a company turns it off.
     *
     * This was an opt-IN, which was right when eBulkSMS was the only provider:
     * there `dndsender` is a premium that costs more per message. With four
     * providers it is wrong, and wrong in the direction that fails silently —
     * for Termii and Sendchamp the DND route IS the transactional route, and
     * the alternative is the promotional one, which does not reach a number on
     * the Do-Not-Disturb register at all. In Nigeria that is most numbers.
     *
     * Everything this application sends is transactional: a payment approved,
     * an inspection confirmed. Defaulting to the promotional route would have
     * looked like it worked and quietly not arrived, which is the worst
     * failure a notification can have. A company that would rather pay less
     * and reach fewer people can still say so.
     */
    dnd: merged[KEYS.dnd] === undefined ? true : truthy(merged[KEYS.dnd]),
  };
};

/**
 * What a settings screen may see: every provider, and no secrets.
 *
 * A secret field is write-only from the outside. Returning it — even to the
 * administrator who typed it — puts a live credential into a browser tab, a
 * screenshot and a support ticket, and there is nothing a screen needs it for
 * beyond showing that one is saved.
 */
const maskedSmsSettings = async (sequelize, companyId) => {
  const { own, merged } = await smsSettingsFor(sequelize, companyId);
  const active = activeProviderKey(merged);

  const providers = providerCatalogue().map((entry) => {
    const provider = providerFor(entry.key);
    const secrets = secretFields(provider);
    const values = {};
    const saved = {};

    provider.FIELDS.forEach((field) => {
      const value = String(merged[fieldKey(entry.key, field.key)] ?? '').trim();
      if (secrets.includes(field.key)) {
        saved[field.key] = Boolean(value);
        // Presence and shape, never the value. Four trailing characters is
        // enough to tell two keys apart without being enough to use one.
        values[`${field.key}_hint`] = value ? `••••${value.slice(-4)}` : null;
      } else {
        values[field.key] = value;
      }
    });

    const keyField = secrets[0] || 'api_key';
    return {
      ...entry,
      values,
      secrets_set: saved,
      configured: provider.FIELDS.filter((f) => f.required).every((f) => (
        secrets.includes(f.key) ? saved[f.key] : values[f.key]
      )),
      // Whether this company is on its own account for this provider, which
      // decides whose units a message spends.
      using_own_credentials: Boolean(String(own[fieldKey(entry.key, keyField)] || '').trim()),
    };
  });

  return {
    provider: active,
    enabled: truthy(merged[KEYS.enabled]),
    dnd: truthy(merged[KEYS.dnd]),
    providers,
  };
};

module.exports = {
  GROUP, KEYS, fieldKey, secretFields,
  smsSettingsFor, smsCredentialsFor, maskedSmsSettings, activeProviderKey,
};
