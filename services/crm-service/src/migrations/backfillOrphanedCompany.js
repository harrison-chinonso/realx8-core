const { backfillCompany } = require('../../../../shared/src/backfillCompany');

/**
 * Attaches CRM records that lost their company.
 *
 * ── Only the transactional tables ───────────────────────────────────────────
 *
 * Leads, deals and tasks — never pipelines, stages, sources or labels. Those
 * carry company_id NULL ON PURPOSE: they are the platform's shared defaults,
 * and attaching them to one tenant would take them away from every other. The
 * controllers read them through a scope that matches the company OR the
 * platform, which is the right fix for shared data; this is the right fix for
 * data that should have had an owner all along.
 */
module.exports = async (sequelize) => {
  const results = [];

  /**
   * The assignee before the creator — the same order withAssigneeCompany
   * already uses when a lead is created, so a repaired row lands where a new
   * one would have.
   */
  results.push(await backfillCompany(sequelize, {
    table: 'leads',
    sources: [
      { join: 'users', on: 'assigned_to', column: 'company_id', label: 'its assignee' },
      { join: 'users', on: 'created_by', column: 'company_id', label: 'its creator' },
    ],
  }));

  results.push(await backfillCompany(sequelize, {
    table: 'deals',
    sources: [
      { join: 'leads', on: 'lead_id', column: 'company_id', label: 'its lead' },
      { join: 'users', on: 'assigned_to', column: 'company_id', label: 'its assignee' },
    ],
  }));

  results.push(await backfillCompany(sequelize, {
    table: 'tasks',
    sources: [
      { join: 'users', on: 'assigned_to', column: 'company_id', label: 'its assignee' },
      { join: 'leads', on: 'lead_id', column: 'company_id', label: 'its lead' },
    ],
  }));

  const fixed = results.reduce((total, row) => total + (row.fixed || 0), 0);
  if (fixed) console.log(`[crm] ${fixed} orphaned row(s) attached to a company`);
  return results;
};
