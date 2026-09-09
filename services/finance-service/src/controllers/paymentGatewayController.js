const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { byKey, paymentSettingsFor, checkCredentials } = require('../utils/paymentGateways');

/**
 * Payment gateway credential checks — the "Test" button in Settings →
 * Payment Gateways.
 *
 * WHAT THESE DO: take the secret key saved for the caller's company (falling
 * back to the platform-wide one, the same override rule as SMTP), ask the
 * gateway whether it is valid, and report the answer. Read-only at the gateway:
 * nothing is charged, created or captured.
 *
 * WHAT THESE DO NOT DO: initiate or verify an actual payment. Nothing in the
 * product charges a card through a gateway today — invoices are settled by bank
 * transfer with a receipt upload (see getPaymentOptions / submitInvoiceReceipt),
 * and the `stripe`/`paystack`/`flutterwave` options on "Record Payment" are
 * labels on a manually entered payment, not charges. A request that looks like a
 * real charge therefore gets an explicit 501 rather than a response that
 * pretends money moved.
 *
 * The route names (`/intent`, `/verify`) are the ones the web app already calls.
 */

/** Never let a key, or any slice of one, into a response body or a log. */
const NOT_IMPLEMENTED = 'Gateway charging is not implemented. Invoices are settled by '
  + 'bank transfer with a receipt upload. This endpoint only verifies saved gateway '
  + 'credentials — send { "test": true }.';

const credentialCheck = (gatewayKey) => asyncHandler(async (req, res) => {
  // The only supported payload. Anything else is a charge attempt.
  if (req.body?.test !== true) {
    return res.status(501).json({ message: NOT_IMPLEMENTED });
  }

  const gateway = byKey.get(gatewayKey);
  // Superior admins have no company, so they test the platform-wide keys —
  // which is also the scope their Settings page edits.
  const companyId = req.user?.company_id ?? null;
  const cfg = await paymentSettingsFor(sequelize, companyId);

  const secret = String(cfg[gateway.secretKey] || '').trim();
  const publicKey = String(cfg[gateway.publicKey] || '').trim();

  if (!secret) {
    return res.status(400).json({
      message: `No ${gateway.label} secret key is saved. Add one in Payment Gateways and save before testing.`,
    });
  }

  const result = await checkCredentials(gatewayKey, secret);

  // A valid secret alone does not make the gateway usable: the buyer-facing
  // flow only offers a gateway when BOTH keys are present, so say so here
  // rather than let "valid" imply "ready".
  const message = result.ok && !publicKey
    ? `${result.message} The public key is still blank, so ${gateway.label} will not be offered to buyers until it is set.`
    : result.message;

  return res.status(result.status).json({ message });
});

module.exports = {
  // Paths the web app calls. All three are the same credential check; the
  // differing verbs are historical.
  stripeIntent: credentialCheck('stripe'),
  paystackVerify: credentialCheck('paystack'),
  flutterwaveVerify: credentialCheck('flutterwave'),
};
