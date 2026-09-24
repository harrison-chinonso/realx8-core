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

module.exports = { mergedSettings, MAIL_GROUPS };
