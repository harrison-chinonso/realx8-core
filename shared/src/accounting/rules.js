const { asMinor } = require('../money');
const { ROLE } = require('./chart');

/**
 * What each business event becomes, as journal lines (ACC-3).
 *
 * ── Pure, and that is the whole design (ACC-3.7) ────────────────────────────
 *
 * Nothing in this file reads a database, writes a ledger, or knows what time
 * it is. Every rule is a function from a plain description of an event to an
 * array of lines, in the style of shared/src/commission/ — which is how the
 * commission engine's arithmetic came to be provable without a database, and
 * why every worked example in its FRD is a literal call.
 *
 * That matters more here than it does there. A wrong posting rule produces
 * books that BALANCE and are false, which is worse than books that visibly
 * fail — and as book of record there is no incumbent running alongside to
 * catch it. Rules that can be asserted line by line, in isolation, with no
 * fixtures, are the only version of this that can be reviewed by an
 * accountant rather than by a programmer reading SQL.
 *
 * ── The one invariant every rule here owes ──────────────────────────────────
 *
 * Debits equal credits. `post()` refuses an entry that does not balance, but
 * discovering that at the door means the business event has already happened
 * and the journal for it cannot be written. So each rule balances by
 * construction: the residual leg is always DERIVED from the others rather
 * than calculated independently and hoped to agree.
 *
 * Revision 2 of the PRD contained a rule for the credit note that did not
 * balance, written out longhand. That is exactly the failure this shape
 * prevents.
 */

/** A debit line. */
const dr = (role, amountMinor, extra = {}) => ({
  role, debit_minor: asMinor(amountMinor), credit_minor: 0, ...extra,
});

/** A credit line. */
const cr = (role, amountMinor, extra = {}) => ({
  role, debit_minor: 0, credit_minor: asMinor(amountMinor), ...extra,
});

/** Lines with nothing on them are not lines. Dropped so a zero VAT leg vanishes. */
const real = (lines) => lines.filter((line) => line.debit_minor > 0 || line.credit_minor > 0);

/**
 * When a property sale becomes revenue.
 *
 * ── Why the default is not "when we invoice it" ─────────────────────────────
 *
 * For an off-plan unit the invoice and the handover are years apart, and IFRS
 * 15 asks when CONTROL passes rather than when the paperwork was raised.
 * Recognising at invoice would report a completed sale on a hole in the
 * ground. The PRD settles the default as handover; the policy is per property
 * because the same developer sells off-plan units, completed units and bare
 * land on different terms.
 *
 * Until ACC-8 builds the handover event, `ON_HANDOVER` means the credit goes
 * to contract liability and stays there. That is the conservative answer and
 * the correct one — what it is NOT is a reason to recognise early, which
 * would be choosing the convenient answer over the true one.
 */
const RECOGNITION = {
  ON_INVOICE: 'ON_INVOICE',
  ON_HANDOVER: 'ON_HANDOVER',
};

/**
 * ACC-3.1 — a property sale invoice is raised.
 *
 * @param {object} event
 *   grossMinor    what the invoice says, before discount
 *   discountMinor a reduction granted at the point of sale
 *   vatMinor      output tax on the net
 *   recognition   RECOGNITION.*, from the property's policy
 *   dimensions    { property_id, unit_id, branch_id, party_id, party_type }
 *
 * Dr Accounts receivable        the gross the buyer must send
 * Dr Discounts given            the reduction, as contra-income
 *   Cr Revenue / contract liability
 *   Cr VAT output
 *
 * ── Why the discount is its own debit rather than a smaller credit ──────────
 *
 * Netting it off makes discounting invisible: a company that discounted a
 * quarter of its book would show lower revenue and no reason for it. As a
 * contra-income account it is a line somebody can look at, and the gross
 * revenue figure still reconciles to the price list.
 */
const invoiceRaised = ({
  grossMinor, discountMinor = 0, vatMinor = 0,
  recognition = RECOGNITION.ON_HANDOVER, dimensions = {},
}) => {
  const gross = asMinor(grossMinor);
  const discount = Math.min(Math.max(asMinor(discountMinor), 0), gross);
  const vat = Math.max(asMinor(vatMinor), 0);

  // What the buyer must actually send.
  const receivable = gross - discount + vat;
  /*
   * Revenue is credited at the FULL price and the discount debited back out
   * of it, which is what makes the reduction visible. Netting it off would
   * show a company that discounted a quarter of its book as simply having
   * earned less, with nothing saying why.
   *
   * The entry balances by construction: (gross − discount + vat) + discount
   * on the debit side against gross + vat on the credit side.
   */
  const incomeRole = recognition === RECOGNITION.ON_INVOICE
    ? ROLE.REVENUE_UNIT_SALES
    : ROLE.CONTRACT_LIABILITY;

  return real([
    dr(ROLE.ACCOUNTS_RECEIVABLE, receivable, dimensions),
    dr(ROLE.REVENUE_DISCOUNTS, discount, dimensions),
    cr(incomeRole, gross, dimensions),
    cr(ROLE.VAT_OUTPUT, vat, dimensions),
  ]);
};

/**
 * ACC-3.1b — a service-fee invoice is raised.
 *
 * Always point in time. A verification fee has no handover and nothing to
 * defer: the service is the review, and the company is owed for it the moment
 * the realtor asks.
 */
const feeInvoiceRaised = ({ grossMinor, vatMinor = 0, dimensions = {} }) => {
  const gross = asMinor(grossMinor);
  const vat = Math.max(asMinor(vatMinor), 0);
  return real([
    dr(ROLE.ACCOUNTS_RECEIVABLE, gross + vat, dimensions),
    cr(ROLE.REVENUE_FEES, gross, dimensions),
    cr(ROLE.VAT_OUTPUT, vat, dimensions),
  ]);
};

/**
 * ACC-3.2 — a payment is approved.
 *
 * Dr Bank / Cr Accounts receivable. The fee and principal split that
 * payment_allocations carries is NOT two income lines here: a default fee was
 * already recognised as income when it was charged, so crediting it again on
 * receipt would count it twice. Both legs are the receivable being settled.
 */
const paymentApproved = ({ amountMinor, dimensions = {} }) => real([
  dr(ROLE.BANK, amountMinor, dimensions),
  cr(ROLE.ACCOUNTS_RECEIVABLE, amountMinor, dimensions),
]);

/**
 * ACC-3.3 — money arrives beyond what was owed.
 *
 * Dr Bank / Cr Customer credit balances. A liability, not income and not a
 * negative receivable: the company is holding somebody else's money, and it
 * owes either the goods or the money back.
 */
const overpaymentHeld = ({ surplusMinor, dimensions = {} }) => real([
  dr(ROLE.BANK, surplusMinor, dimensions),
  cr(ROLE.CUSTOMER_CREDIT_BALANCES, surplusMinor, dimensions),
]);

/**
 * ACC-3.4 — a customer credit note is approved.
 *
 * Dr Revenue (the net coming back out)
 * Dr VAT output (the tax on it, reversed)
 *   Cr Accounts receivable (the gross the buyer no longer owes)
 *
 * The gross is the residual of the two debits, which is what stops the
 * arithmetic drifting — revision 2 of the PRD wrote this rule longhand and it
 * did not balance.
 */
const creditNoteApproved = ({ netMinor, vatMinor = 0, dimensions = {} }) => {
  const net = asMinor(netMinor);
  const vat = Math.max(asMinor(vatMinor), 0);
  return real([
    dr(ROLE.REVENUE_UNIT_SALES, net, dimensions),
    dr(ROLE.VAT_OUTPUT, vat, dimensions),
    cr(ROLE.ACCOUNTS_RECEIVABLE, net + vat, dimensions),
  ]);
};

/**
 * ACC-3.4 — a refund is paid.
 *
 * Dr Customer credit balances / Cr Bank. The liability raised by
 * `overpaymentHeld` is discharged; no revenue is involved in either direction,
 * because the sale never grew and never shrank.
 */
const refundPaid = ({ amountMinor, dimensions = {} }) => real([
  dr(ROLE.CUSTOMER_CREDIT_BALANCES, amountMinor, dimensions),
  cr(ROLE.BANK, amountMinor, dimensions),
]);

/**
 * ACC-3.5 — a commission ledger entry.
 *
 * The nine mappings already exist in shared/src/commissionAnalytics.js, where
 * they have been producing a balanced GL EXPORT since before there was a
 * ledger to post to. They are read from there rather than copied, so the
 * export and the postings cannot drift — the export was right first, and
 * being right twice in two places is a temporary condition.
 */
const commissionEntry = ({ entryType, amountMinor, dimensions = {} }) => {
  // eslint-disable-next-line global-require
  const { ACCOUNTS } = require('../commissionAnalytics');
  const mapping = ACCOUNTS[entryType];
  if (!mapping) return [];
  return real([
    dr(mapping.debit, amountMinor, dimensions),
    cr(mapping.credit, amountMinor, dimensions),
  ]);
};

/**
 * ACC-3.6 — a bill is approved.
 *
 * Dr Expense (or development WIP, when the cost capitalises — ACC-10)
 * Dr VAT input, which is recoverable
 *   Cr Accounts payable, at what the vendor is owed
 *   Cr Withholding payable, at what is kept back to remit
 *
 * ── Withholding is a credit, not a smaller expense ────────────────────────
 *
 * The company owes the vendor the full net; it simply pays part of it to the
 * tax authority instead. Netting it off the expense would understate the cost
 * AND lose the liability — and the liability is the whole point, because
 * somebody has to remit it and be able to show what it was withheld from.
 *
 * `expenseRole` is a parameter rather than a constant so ACC-10 can send the
 * same rule to development WIP for a capitalisable cost. One rule, two
 * destinations, decided by the expense type rather than by a second rule
 * nobody would remember to keep in step.
 */
const billApproved = ({
  netMinor, taxMinor = 0, withholdingMinor = 0,
  expenseRole = ROLE.COST_OF_SALES, dimensions = {},
}) => {
  const net = asMinor(netMinor);
  const tax = Math.max(asMinor(taxMinor), 0);
  const withheld = Math.min(Math.max(asMinor(withholdingMinor), 0), net);
  // Payable is the residual, so the entry balances by construction.
  const payable = net + tax - withheld;

  return real([
    dr(expenseRole, net, dimensions),
    dr(ROLE.VAT_INPUT, tax, dimensions),
    cr(ROLE.ACCOUNTS_PAYABLE, payable, dimensions),
    cr(ROLE.WITHHOLDING_PAYABLE, withheld, dimensions),
  ]);
};

/**
 * ACC-3.6 — a bill is paid.
 *
 * Dr Accounts payable / Cr Bank, at the NET of withholding — which is what
 * actually leaves. The withholding stays on the books as a liability until it
 * is remitted, which is a different payment to a different party.
 */
const billPaid = ({ amountMinor, dimensions = {} }) => real([
  dr(ROLE.ACCOUNTS_PAYABLE, amountMinor, dimensions),
  cr(ROLE.BANK, amountMinor, dimensions),
]);

/**
 * ACC-4.2b — a vendor credits something back.
 *
 * The mirror of the customer credit note, and it reverses the bill's legs:
 * the payable comes down, the expense comes back out, and the input tax that
 * was claimed is given up.
 */
const supplierCreditNote = ({
  netMinor, taxMinor = 0, expenseRole = ROLE.COST_OF_SALES, dimensions = {},
}) => {
  const net = asMinor(netMinor);
  const tax = Math.max(asMinor(taxMinor), 0);
  return real([
    dr(ROLE.ACCOUNTS_PAYABLE, net + tax, dimensions),
    cr(expenseRole, net, dimensions),
    cr(ROLE.VAT_INPUT, tax, dimensions),
  ]);
};

/** Every rule, by the source name the journal will carry. */
const RULES = {
  invoice: invoiceRaised,
  fee_invoice: feeInvoiceRaised,
  invoice_payment: paymentApproved,
  overpayment: overpaymentHeld,
  credit_note: creditNoteApproved,
  refund: refundPaid,
  commission_ledger: commissionEntry,
  bill: billApproved,
  bill_payment: billPaid,
  supplier_credit_note: supplierCreditNote,
};

/** Debits less credits. Zero on every rule, and asserted to be. */
const imbalanceOf = (lines = []) => lines.reduce(
  (total, line) => total + asMinor(line.debit_minor) - asMinor(line.credit_minor), 0,
);

module.exports = {
  RECOGNITION,
  RULES,
  invoiceRaised,
  feeInvoiceRaised,
  paymentApproved,
  overpaymentHeld,
  creditNoteApproved,
  refundPaid,
  commissionEntry,
  billApproved,
  billPaid,
  supplierCreditNote,
  imbalanceOf,
  dr,
  cr,
};
