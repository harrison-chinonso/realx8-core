const billing = require('../shared/src/billing');
const { isIntegrationPath } = require('./security/integrations');

/**
 * Read-only for a company whose subscription has lapsed (shared/src/billing.js
 * has the rules and the allow-list). Reads always pass; writes pass only if
 * they are on the list — clients buying and uploading proof of payment,
 * realtors recommending, everyone signing in and paying for the subscription.
 *
 * A no-op unless BILLING_ENABLED is on. Fails OPEN: if the billing state
 * cannot be read, the request goes through — a billing fault must never lock a
 * company out of its own data. The state is cached for a minute and evicted on
 * every payment, so a renewal takes effect at once.
 */
let sequelize = null;
const db = () => {
  if (!sequelize) sequelize = require('../services/user-service/src/config/database').sequelize;
  return sequelize;
};

const billingGate = () => async (req, res, next) => {
  if (!billing.isBillingEnabled()) return next();
  const user = req.user;
  if (!user || user.isSuperiorAdmin || user.company_id === null || user.company_id === undefined) return next();
  const path = req.securityPath || req.path;
  if (isIntegrationPath(path)) return next();
  if (billing.allowedWhileLapsed({ method: req.method, path, user })) return next();
  try {
    const state = await billing.billingState(db(), user.company_id);
    if (!state.readOnly) return next();
    return res.status(402).json({ message: billing.LAPSED_MESSAGE, reason: 'billing_inactive' });
  } catch (error) {
    console.error('[billing] gate could not read the state, allowing:', error.message);
    return next();
  }
};

module.exports = { billingGate };
