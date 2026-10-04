const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { companyByCode } = require('../../../../shared/src/companyLookup');
const { loadSettingsGroup } = require('../../../../shared/src/appearanceSettings');
const { buildAppConfig } = require('../../../../shared/src/appConfig');

/**
 * Public: a company code → everything Realx8-Mobile needs to boot as that
 * company (see shared/src/appConfig.js for what may and may not be in it).
 *
 * Here, under /public, rather than beside /share/company/:code in
 * user-service, because /public/** is on the edge's NON_UI_PATHS list: a
 * native HTTP client is not a browser running Realx8-Ui and would be refused
 * by the tool filter and the frontend-header check anywhere else.
 *
 * Unknown and suspended companies get the same 404 (companyByCode returns
 * null for both), so the endpoint cannot be used to learn which codes exist
 * but are switched off.
 *
 * The ETag is the config's own content hash, compared here rather than left
 * to Express's req.fresh, which does not answer it in this stack; a matching
 * If-None-Match gets 304, so a phone's background refresh costs no body.
 */
const getAppConfig = asyncHandler(async (req, res) => {
  const company = await companyByCode(sequelize, req.params.code);
  if (!company) return res.status(404).json({ message: 'No company uses that code.' });

  const [appearance, support, mobile, platformMobile] = await Promise.all([
    loadSettingsGroup(sequelize, 'appearance', company.id),
    loadSettingsGroup(sequelize, 'support', company.id),
    loadSettingsGroup(sequelize, 'mobile', company.id),
    loadSettingsGroup(sequelize, 'mobile', null),
  ]);

  const config = buildAppConfig({ company, appearance, support, mobile, platformMobile });

  const etag = `"${config.configVersion}"`;
  res.set('Cache-Control', 'public, max-age=60');
  res.set('ETag', etag);
  const sent = String(req.get('If-None-Match') || '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
  if (sent.includes(etag)) return res.status(304).end();
  return res.json({ data: config });
});

module.exports = { getAppConfig };
