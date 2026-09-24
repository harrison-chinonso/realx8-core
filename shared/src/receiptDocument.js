/**
 * The receipt document — one generator, for the browser and for the email.
 *
 * ── Why this moved to the server ────────────────────────────────────────────
 *
 * The web app used to draw this itself, which was fine while the only way to
 * get a receipt was to click Print. Sending the same receipt by email meant a
 * second generator, in a second language, in a second repository — and a buyer
 * whose emailed receipt and downloaded receipt disagree about the balance, the
 * unit or the wording has two documents for one payment and no way to tell
 * which is the real one. That is the confusion the whole receipt design has
 * been arranged to avoid.
 *
 * So the document is built HERE, once. The browser fetches it from
 * GET /receipts/:id/document and prints what it is given; the mailer sends the
 * same string. Neither can drift from the other, because neither has its own
 * copy to drift with.
 *
 * ── Why the markup is what it is ────────────────────────────────────────────
 *
 * It is a printable page first and an email second, in that order, because the
 * printed copy is the one a buyer files. Where the two disagree — flex
 * alignment in the header and the totals, which older desktop mail clients lay
 * out as stacked blocks — the print layout wins and the email degrades to the
 * same information in a plainer arrangement. Losing a right-alignment is a
 * cosmetic difference; maintaining two documents is a factual one.
 */

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatDate = (value) => (value ? new Date(value).toLocaleString() : '');

/** The number shown on the document, and the one the file is named after. */
const receiptNumberOf = (receipt) => receipt?.receipt_number || receipt?.number || `RCPT-${receipt?.id}`;

/**
 * @param {object} receipt   the receipt row enriched with its print data
 * @param {object} options   { brand: { name, logo, primaryColor }, fmt }
 *                           `fmt` formats an amount in the company's currency.
 */
const buildReceiptHtml = (receipt, { brand = {}, fmt } = {}) => {
  const receiptNumber = receiptNumberOf(receipt);
  const company = escapeHtml(brand.name || 'Receipt');
  const logo = brand.logo ? escapeHtml(brand.logo) : null;
  const accent = escapeHtml(brand.primaryColor || '#0f172a');
  const money = (value) => escapeHtml(fmt ? fmt(Number(value) || 0) : String(value));

  /**
   * Rows are built from what this receipt actually has.
   *
   * A printed receipt full of dashes reads as a broken document rather than a
   * complete one that happens to carry no note, and a buyer handed it cannot
   * tell which. Empty fields are left out instead.
   */
  const line = (label, value) => (value || value === 0
    ? `<tr><td class="label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`
    : '');

  /**
   * The unit line reads as one sentence — "2 × 3-Bedroom Terrace" — rather than
   * as two fields a reader has to join up themselves. Quantity is stated only
   * when it is more than one, because "1 ×" is noise.
   */
  const quantity = Number(receipt.quantity) || 0;
  const unit = [
    quantity > 1 ? `${quantity} ×` : null,
    receipt.unit_label,
  ].filter(Boolean).join(' ');

  const balance = receipt.outstanding_balance;
  const hasBalance = balance !== null && balance !== undefined;

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Receipt ${escapeHtml(receiptNumber)}</title>
        <style>
          @page { margin: 18mm; }
          body { font-family: -apple-system, Segoe UI, Arial, sans-serif; color: #0f172a; margin: 0; }
          .head { display: flex; align-items: center; gap: 16px;
                  border-bottom: 3px solid ${accent}; padding-bottom: 16px; margin-bottom: 28px; }
          .head img { max-height: 56px; max-width: 200px; object-fit: contain; }
          .company { font-size: 20px; font-weight: 700; color: ${accent}; }
          .title { margin-left: auto; text-align: right; }
          .title .word { font-size: 24px; font-weight: 700; letter-spacing: 0.08em;
                         text-transform: uppercase; color: ${accent}; }
          .title .num { font-size: 12px; color: #64748b; margin-top: 2px; }
          h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
               color: #94a3b8; margin: 26px 0 6px; font-weight: 600; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 9px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; vertical-align: top; }
          td.label { color: #64748b; width: 190px; }
          .total { margin-top: 28px; padding: 18px 20px; border-radius: 10px;
                   background: ${accent}; color: #fff; display: flex; justify-content: space-between;
                   align-items: center; }
          .total .amt { font-size: 24px; font-weight: 700; }
          .balance { margin-top: 10px; padding: 14px 20px; border-radius: 10px;
                     border: 1px solid #e2e8f0; display: flex; justify-content: space-between;
                     align-items: center; font-size: 14px; }
          .balance .amt { font-weight: 700; }
          .settled { color: #15803d; font-weight: 600; }
          .foot { margin-top: 32px; font-size: 11px; color: #94a3b8; line-height: 1.6; }
          @media print { .foot { position: fixed; bottom: 0; } }
        </style>
      </head>
      <body>
        <div class="head">
          ${logo ? `<img src="${logo}" alt="${company}" />` : ''}
          <div class="company">${company}</div>
          <div class="title">
            <div class="word">Receipt</div>
            <div class="num">${escapeHtml(receiptNumber)}</div>
          </div>
        </div>

        <table>
          ${line('Date', formatDate(receipt.date || receipt.verified_at || receipt.created_at || receipt.createdAt))}
          ${line('Received from', receipt.client_name || receipt.client?.name)}
          ${line('Invoice', receipt.invoice_reference || receipt.invoice_id)}
          ${line('Payment method', receipt.payment_method)}
          ${line('Reference', receipt.reference)}
          ${line('Note', receipt.notes)}
        </table>

        ${receipt.property_name || unit ? `
          <h2>What this is for</h2>
          <table>
            ${line('Property', receipt.property_name)}
            ${line('Address', receipt.property_address)}
            ${line('Unit', unit)}
            ${receipt.unit_price ? line('Unit price', fmt ? fmt(Number(receipt.unit_price)) : receipt.unit_price) : ''}
          </table>` : ''}

        <div class="total">
          <span>Amount paid</span>
          <span class="amt">${money(receipt.amount)}</span>
        </div>

        ${hasBalance ? `
          <div class="balance">
            <span>Balance outstanding on this invoice</span>
            <span class="amt ${Number(balance) <= 0 ? 'settled' : ''}">
              ${Number(balance) <= 0 ? 'Paid in full' : money(balance)}
            </span>
          </div>` : ''}

        <div class="foot">
          ${company} &middot; Receipt ${escapeHtml(receiptNumber)}<br />
          ${hasBalance && Number(balance) > 0
            ? 'The balance shown is as at the date of this receipt.<br />'
            : ''}
          Generated by ${company}. Keep this for your records.
        </div>
      </body>
    </html>
  `;
};

/**
 * The same receipt as plain text, for mail clients that never render HTML.
 *
 * Deliberately a summary rather than a transcription: a text part that tries to
 * redraw the document ends up as a column of labels nobody reads, whereas the
 * three facts a buyer checks on their phone — what was paid, against what, and
 * what is left — fit in a glance.
 *
 * It stops there and says nothing about where the document is, because that
 * differs: the caller appends either "attached" or the link to the company's
 * own file, and only the caller knows which of the two it is sending.
 */
const buildReceiptText = (receipt, { brand = {}, fmt } = {}) => {
  const money = (value) => (fmt ? fmt(Number(value) || 0) : String(value));
  const balance = receipt.outstanding_balance;
  return [
    `${brand.name || 'Receipt'} — Receipt ${receiptNumberOf(receipt)}`,
    '',
    `Amount paid: ${money(receipt.amount)}`,
    receipt.invoice_reference ? `Invoice: ${receipt.invoice_reference}` : null,
    receipt.property_name ? `Property: ${receipt.property_name}` : null,
    receipt.payment_method ? `Payment method: ${receipt.payment_method}` : null,
    receipt.reference ? `Reference: ${receipt.reference}` : null,
    balance === null || balance === undefined
      ? null
      : (Number(balance) <= 0
        ? 'This invoice is now paid in full.'
        : `Balance outstanding on this invoice: ${money(balance)}`),
  ].filter((entry) => entry !== null).join('\n');
};

module.exports = { buildReceiptHtml, buildReceiptText, receiptNumberOf };
