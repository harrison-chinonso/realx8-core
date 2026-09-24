const { brandForCompany } = require('./companySettings');
const { esc: escapeHtml } = require('./emailTemplate');
const { sendMail } = require('./mailTransport');
const { buildReceiptHtml, buildReceiptText, receiptNumberOf } = require('./receiptDocument');

/**
 * Email a buyer their receipt, the moment the payment is approved.
 *
 * ── Why this is sent at all ─────────────────────────────────────────────────
 *
 * The receipt already existed; reaching it meant signing in, finding the
 * payment and clicking Print. Approval already sends a notification saying the
 * payment went through, which is the message people actually read — and it did
 * not carry the one document they need to forward to whoever asked them to
 * prove it. The person who paid should not have to come back for it.
 *
 * ── Not a second notification ───────────────────────────────────────────────
 *
 * The "payment approved" notice is a message ABOUT the payment, routed through
 * the dispatcher with the recipient's channel preferences, a title and an
 * action link. This is the DOCUMENT, and it is deliberately sent outside that
 * machinery: it has no in-app equivalent, nothing to link to that the receipt
 * does not already say, and turning off notifications should not silently turn
 * off receipts.
 *
 * ── Where the company's own receipt fits ────────────────────────────────────
 *
 * The company's uploaded receipt outranks the generated one — but that rule
 * bites at DOWNLOAD time, not here. At the moment a payment is approved the
 * thing to do is send something, immediately, and the generated document is
 * always available where an uploaded file may not be. So this always sends the
 * generated one, and where an uploaded receipt already exists it is named
 * underneath as the company's own issued copy.
 *
 * It is linked rather than attached because the file lives in storage behind
 * the access rules it was uploaded under, and fetching it here to re-send it
 * would mean this function making an outbound request to whatever URL a row
 * happens to hold.
 *
 * ── Best effort, always ─────────────────────────────────────────────────────
 *
 * The money is already recorded and committed by the time this runs. It
 * resolves to false rather than throwing for every failure — no address, no
 * SMTP, a refused relay — because none of those are a reason to fail a payment
 * that has already been approved.
 */
const deliverReceipt = async (sequelize, {
  companyId = null,
  to,
  toName = null,
  receipt,
  fmt,
  companyReceiptUrl = null,
} = {}) => {
  if (!to || !receipt) return false;

  try {
    /*
     * The company's own name and logo, never the platform's — a receipt is a
     * claim about who was paid. See brandForCompany.
     */
    const { brand, settings: cfg } = await brandForCompany(sequelize, companyId);
    const host = cfg.mail_host || process.env.SMTP_HOST;
    const user = cfg.mail_username || process.env.SMTP_USER;
    const pass = cfg.mail_password || process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      console.log(`[receipt] SMTP not configured — receipt to ${to} skipped`);
      return false;
    }

    const number = receiptNumberOf(receipt);

    /*
     * The generated document is both the body and an attachment.
     *
     * The body, so it is READ — an email whose content is only in an
     * attachment is an email most people never open. The attachment, so it can
     * be KEPT: forwarded to an employer or a lawyer, or opened and printed to
     * PDF, which is exactly what the Print button in the app does with the
     * same bytes.
     */
    const document = buildReceiptHtml(receipt, { brand, fmt });
    const summary = buildReceiptText(receipt, { brand, fmt });

    const issued = companyReceiptUrl
      ? `${brand.name} has also issued its own receipt for this payment: ${companyReceiptUrl}`
      : null;

    const html = issued
      ? `${document}\n<p style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:13px;`
        + `color:#475569;margin:20px 0 0">${escapeHtml(brand.name)} has also issued its own receipt `
        + `for this payment: <a href="${escapeHtml(companyReceiptUrl)}">${escapeHtml(companyReceiptUrl)}</a></p>`
      : document;

    const text = [
      summary,
      '',
      'Your receipt is attached to this email. Keep it for your records.',
      issued ? `\n${issued}` : null,
    ].filter((entry) => entry !== null).join('\n');

    const attachments = [{
      filename: `receipt-${String(number).replace(/[^A-Za-z0-9._-]/g, '-')}.html`,
      content: document,
      contentType: 'text/html; charset=utf-8',
    }];

    const fromName = brand.fromName;
    const fromAddress = brand.fromAddress;

    const result = await sendMail({
      host,
      port: Number(cfg.mail_port || process.env.SMTP_PORT || 587),
      user,
      pass,
      label: 'receipt',
      message: {
        from: `"${fromName}" <${fromAddress}>`,
        to: toName ? `"${toName}" <${to}>` : to,
        subject: `Your payment receipt — ${number}`,
        text,
        html,
        attachments,
      },
    });

    if (!result.sent) {
      console.log(`[receipt] SMTP not configured — receipt to ${to} skipped`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[receipt] receipt email to ${to} failed:`, error.message);
    return false;
  }
};

module.exports = { deliverReceipt };
