const { QueryTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * Users are owned by user-service. As with companies, this service must NOT
 * define a User model: property-service boots with `sequelize.sync({ alter: true })`,
 * which would try to reshape the users table. Raw reads only.
 */

/** Resolves a realtor's display name to a user id within one company. */
const findRealtorIdByName = async (name, companyId) => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return null;

  const rows = await sequelize.query(
    `SELECT id FROM users
      WHERE type = 'realtor' AND TRIM(LOWER(name)) = TRIM(LOWER(:name))
        ${companyId ? 'AND company_id = :companyId' : ''}
      LIMIT 2`,
    { replacements: { name: trimmed, companyId }, type: QueryTypes.SELECT },
  );

  // Ambiguous names must not silently bind an inspection to the wrong realtor.
  return rows.length === 1 ? rows[0].id : null;
};

module.exports = { findRealtorIdByName };

/**
 * The clients "belonging to" a realtor.
 *
 * There is no first-class client→realtor column in this system, so ownership is
 * derived from CRM leads assigned to the realtor, matched to user accounts by
 * email. Same rule the notifier uses, kept consistent deliberately.
 */
const listRealtorClients = async (realtorId, companyId) => {
  if (!realtorId) return [];
  return sequelize.query(
    `SELECT id, name, email, phone FROM users
      WHERE realtor_id = :realtorId AND type = 'client' AND deleted_at IS NULL
        ${companyId ? 'AND company_id = :companyId' : ''}
      ORDER BY name`,
    { replacements: { realtorId, companyId }, type: QueryTypes.SELECT },
  );
};

/**
 * Leads a user may attach to an inspection: everything in the company for staff,
 * and only leads they created or were assigned for a realtor.
 */
const listSelectableLeads = async ({ realtorId = null, companyId }) => sequelize.query(
  `SELECT id, name, email, phone, status, assigned_to, created_by
     FROM leads
    WHERE 1 = 1
      ${companyId ? 'AND company_id = :companyId' : ''}
      ${realtorId ? 'AND (assigned_to = :realtorId OR created_by = :realtorId)' : ''}
    ORDER BY name`,
  { replacements: { realtorId, companyId }, type: QueryTypes.SELECT },
);

/** One lead, scoped the same way — used to validate an inspection's lead. */
const getSelectableLead = async ({ leadId, realtorId = null, companyId }) => {
  const rows = await sequelize.query(
    `SELECT id, name, email, phone FROM leads
      WHERE id = :leadId
        ${companyId ? 'AND company_id = :companyId' : ''}
        ${realtorId ? 'AND (assigned_to = :realtorId OR created_by = :realtorId)' : ''}
      LIMIT 1`,
    { replacements: { leadId, realtorId, companyId }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
};

module.exports.listSelectableLeads = listSelectableLeads;
module.exports.getSelectableLead = getSelectableLead;

module.exports.listRealtorClients = listRealtorClients;
