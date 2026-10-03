const { columnsOf, isPostgres } = require('../../../../shared/src/dialect');

/**
 * notification_templates.body holds a company's whole HTML email design.
 *
 * It was created as TEXT, which on MySQL stops at 64 KB — less than many
 * designs exported from an email builder. Postgres TEXT has no such limit, so
 * there is nothing to do there. Idempotent: it only acts while the column is
 * still plain `text`.
 */
module.exports = async function widenTemplateBody(sequelize) {
  if (isPostgres(sequelize)) return;
  const columns = await columnsOf(sequelize, 'notification_templates');
  if (!columns || String(columns.get('body') || '').toLowerCase() !== 'text') return;
  await sequelize.query('ALTER TABLE `notification_templates` MODIFY `body` LONGTEXT NOT NULL');
};
