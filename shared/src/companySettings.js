const { QueryTypes } = require('sequelize');
const { q } = require('./dialect');

/**
 * A company's effective settings, for services that send mail.
 *
 * ── Why this is not the settings controller's job ───────────────────────────
 *
 * user-service owns the Setting model and the cached, permission-checked read
 * that the settings screens use. Nothing here is a screen: these are background
 * senders in other services that need to know the company's name, logo, colour
 * and SMTP credentials in order to put an email together, and they have their
 * own database connection and no business reaching into another service's
 * controller for it.
 *
 * The merge rule is the same one the controller applies and has to stay that
 * way, or an email would be branded differently from the application it came
 * from: platform rows first, the company's own rows layered on top.
 *
 * Extracted from the notifier, which had the only copy. A second sender that
 * needed the same three groups — the receipt mailer — would otherwise have
 * written a second query, and two queries that answer "what is this company
 * called" drift apart by degrees rather than all at once.
 */
const MAIL_GROUPS = ['general', 'appearance', 'email'];

const mergedSettings = async (sequelize, companyId, groups = MAIL_GROUPS) => {
  const rows = await sequelize.query(
    `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
      WHERE ${q(sequelize, 'group')} IN (:groups)
        AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
    { replacements: { groups, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const global = {};
  const company = {};
  rows.forEach((row) => { (row.company_id == null ? global : company)[row.key] = row.value; });
  return { ...global, ...company };
};

/**
 * The same rows, but with the two tiers kept apart.
 *
 * mergedSettings answers "what is in force", which is right for anything with
 * one answer — an SMTP host, a currency. It is the WRONG shape for branding,
 * because the merge makes a value the platform supplied indistinguishable from
 * one the company chose, and those two mean different things on a document that
 * goes to a customer. See brandForCompany.
 */
const scopedSettings = async (sequelize, companyId, groups = MAIL_GROUPS) => {
  const rows = await sequelize.query(
    `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
      WHERE ${q(sequelize, 'group')} IN (:groups)
        AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
    { replacements: { groups, companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const global = {};
  const own = {};
  rows.forEach((row) => { (row.company_id == null ? global : own)[row.key] = row.value; });
  return { own, global, merged: { ...global, ...own } };
};

/** The company's own record, for the name and logo it was set up with. */
const companyRecord = async (sequelize, companyId) => {
  if (companyId == null) return null;
  const [row] = await sequelize.query(
    'SELECT id, name, logo_url, email FROM companies WHERE id = :id LIMIT 1',
    { replacements: { id: companyId }, type: QueryTypes.SELECT },
  ).catch(() => []);
  return row || null;
};

/**
 * Who a document or an email says it is FROM.
 *
 * ── The bug this exists to end ──────────────────────────────────────────────
 *
 * Branding used to be read off the merged settings, and the merge hands a
 * company the platform's values for anything it has not set. A company that
 * never opened the Appearance screen therefore issued receipts carrying the
 * PLATFORM's name and the PLATFORM's logo — a customer of that company received
 * proof of payment from a brand they had never dealt with, and there was
 * nothing on the document connecting it to the company they had actually paid.
 *
 * ── What falls back, and what does not ──────────────────────────────────────
 *
 * A NAME and a LOGO are identity, so they never fall back to the platform for a
 * company: the company's own setting, then the company's own record, and a
 * company always has a name because it cannot be created without one. The logo
 * stops there — no logo at all is honest, whereas the platform's mark beside
 * another company's name actively misinforms.
 *
 * COLOURS do fall back, because they are a theme rather than a claim about who
 * sent something. So does the SMTP configuration: a company with no mail server
 * of its own is meant to send through the platform's, and always has.
 *
 * Platform-scope callers (companyId null) get exactly what they always got —
 * `own` is empty, there is no company record, and every rule falls through to
 * the platform rows.
 */
const brandForCompany = async (sequelize, companyId, groups = MAIL_GROUPS) => {
  const scoped = await scopedSettings(sequelize, companyId, groups);
  const { global, merged } = scoped;
  const company = await companyRecord(sequelize, companyId);

  /**
   * At platform scope the platform's rows ARE its own.
   *
   * `scopedSettings` sorts rows by whether they carry a company id, which is
   * the right split for a tenant and the wrong one for the platform: asking for
   * the platform's settings returns only company-less rows, so `own` comes back
   * empty and every "never inherit" rule below strips the platform of its own
   * name and logo. It cost the platform its mark on its own receipts until a
   * test asked for them.
   */
  const own = companyId == null ? global : scoped.own;

  const name = own.app_name || own.site_name
    || company?.name
    || global.app_name || global.site_name || 'Realto';

  const brand = {
    name,
    // Deliberately not `global.app_logo` — see above.
    logo: own.app_logo || company?.logo_url || null,
    primaryColor: merged.primary_color || '#2563eb',
    secondaryColor: merged.secondary_color || '#1e3a8a',
    fromName: own.mail_from_name || name,
    fromAddress: merged.mail_from_address || 'noreply@realto.app',
    supportEmail: own.site_email || company?.email || global.site_email || null,
    year: new Date().getFullYear(),
    /*
     * Transport, carried alongside so a caller that manages its own
     * nodemailer instance does not have to read the same rows twice. Prefixed
     * because they are not branding and nothing should render them.
     */
    _smtpHost: merged.mail_host || process.env.SMTP_HOST,
    _smtpPort: merged.mail_port || process.env.SMTP_PORT || 587,
    _smtpUser: merged.mail_username || process.env.SMTP_USER,
    _smtpPass: merged.mail_password || process.env.SMTP_PASS,
  };

  return { brand, settings: merged };
};

/** What brandForCompany answers when the database cannot be read at all. */
const fallbackBrand = () => ({
  name: 'Realto', logo: null, primaryColor: '#2563eb', secondaryColor: '#1e3a8a',
  fromName: 'Realto', fromAddress: 'noreply@realto.app', supportEmail: null,
  year: new Date().getFullYear(),
});

module.exports = {
  mergedSettings, scopedSettings, brandForCompany, fallbackBrand, MAIL_GROUPS,
};
