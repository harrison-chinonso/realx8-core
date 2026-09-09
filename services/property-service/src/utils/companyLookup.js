const { QueryTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * Companies are owned by user-service. This service shares the same database,
 * but deliberately does NOT define a Company model: property-service boots with
 * `sequelize.sync({ alter: true })`, which would try to reshape the companies
 * table to match a definition that isn't ours. Raw reads only.
 */

const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();

/** Maps referral codes -> { id, code, name }. Unknown codes are simply absent. */
const resolveCompanyCodes = async (codes) => {
  const wanted = [...new Set(codes.map(normalizeCode).filter(Boolean))];
  if (!wanted.length) return new Map();

  const rows = await sequelize.query(
    'SELECT id, name, referral_code FROM companies WHERE UPPER(referral_code) IN (:codes)',
    { replacements: { codes: wanted }, type: QueryTypes.SELECT },
  );

  return new Map(rows.map((row) => [normalizeCode(row.referral_code), {
    id: row.id, code: row.referral_code, name: row.name,
  }]));
};

/** Maps company id -> referral code, for stamping codes onto exported rows. */
const companyCodesByPropertyIds = async (companyIds) => {
  const ids = [...new Set(companyIds.filter((id) => Number.isFinite(Number(id))))];
  if (!ids.length) return new Map();

  const rows = await sequelize.query(
    'SELECT id, referral_code FROM companies WHERE id IN (:ids)',
    { replacements: { ids }, type: QueryTypes.SELECT },
  );

  return new Map(rows.map((row) => [Number(row.id), row.referral_code || '']));
};

/** All companies that have a code — used to build the reference sheet in the template. */
const listCompanyCodes = async () => sequelize.query(
  "SELECT name, referral_code, status FROM companies WHERE referral_code IS NOT NULL AND referral_code <> '' ORDER BY name",
  { type: QueryTypes.SELECT },
);

module.exports = { normalizeCode, resolveCompanyCodes, companyCodesByPropertyIds, listCompanyCodes };
