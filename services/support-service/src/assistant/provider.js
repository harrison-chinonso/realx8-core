const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Assistant configuration.
 *
 * There is no model provider and no API key: answers are composed locally from
 * ./knowledge and the user's own data. What remains is per-company display
 * config, so a tenant can rename the assistant or switch it off.
 */
const settingsFor = async (companyId) => {
  const rows = await sequelize.query(
    `SELECT \`key\`, \`value\`, company_id FROM settings
      WHERE \`group\` = 'assistant'
        AND (company_id IS NULL OR company_id = :companyId)`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const global = {}; const company = {};
  rows.forEach((r) => { (r.company_id == null ? global : company)[r.key] = r.value; });
  return { ...global, ...company };
};

const assistantConfig = async (companyId) => {
  const cfg = await settingsFor(companyId);
  return {
    // On unless a company deliberately turns it off — nothing to set up.
    enabled: String(cfg.assistant_enabled ?? 'on').toLowerCase() !== 'off',
    assistantName: (cfg.assistant_name || 'Janet').trim(),
  };
};

module.exports = { assistantConfig };
