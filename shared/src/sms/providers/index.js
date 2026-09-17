const ebulksms = require('./ebulksms');
const termii = require('./termii');
const sendchamp = require('./sendchamp');
const smartsms = require('./smartsms');

/**
 * The SMS providers a company may choose between.
 *
 * ── Why a registry rather than a branch ────────────────────────────────────
 *
 * Each provider declares its own credential FIELDS, and the settings screen
 * renders whatever it declares. That is what stops the UI accumulating a
 * switch statement: Termii needs a base URL because it assigns one per
 * account, Sendchamp needs a route, only eBulkSMS has a username, and none of
 * that is the screen's business to know.
 *
 * Every provider exposes the same two functions with the same shapes:
 *
 *   sendSms({ apikey, username?, sender, to, body, dnd, baseUrl?, ... })
 *     → { ok, status, message, sent, cost, recipients, skipped, retryable? }
 *   checkCredentials({ apikey, username?, baseUrl? })
 *     → { ok, message, units? }
 *
 * Neither ever throws. An SMS is a notification, and a notification failure
 * must not roll back the thing it reports.
 *
 * Order matters only for the picker: eBulkSMS is first because it was here
 * first, and a company that has already configured it should not have to
 * scroll past three newcomers to find it.
 */
const PROVIDERS = [ebulksms, termii, sendchamp, smartsms];

const BY_KEY = new Map(PROVIDERS.map((provider) => [provider.key, provider]));

const DEFAULT_PROVIDER = ebulksms.key;

/**
 * A provider by key, or the default.
 *
 * Falls back rather than throwing: a stored key written by a newer version of
 * the platform, or a typo in a settings row, should degrade to a provider that
 * exists rather than take down every notification in the company.
 */
const providerFor = (key) => BY_KEY.get(String(key || '').trim().toLowerCase()) || BY_KEY.get(DEFAULT_PROVIDER);

/** What a settings screen needs to draw the picker and the right fields. */
const providerCatalogue = () => PROVIDERS.map((provider) => ({
  key: provider.key,
  label: provider.label,
  docs: provider.docs,
  fields: provider.FIELDS,
  message_max: provider.MESSAGE_MAX,
}));

module.exports = {
  PROVIDERS, PROVIDER_KEYS: PROVIDERS.map((p) => p.key), DEFAULT_PROVIDER,
  providerFor, providerCatalogue,
};
