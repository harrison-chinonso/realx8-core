const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../../shared/src/accounting/rules');
const { ROLE } = require('../../shared/src/accounting/chart');

/**
 * What each business event becomes, as journal lines (ACC-3).
 *
 * ── Why these are the tests that matter most ────────────────────────────────
 *
 * A wrong posting rule produces books that BALANCE and are false, which is
 * worse than books that visibly fail — and as book of record there is no
 * incumbent system running alongside to catch it. The rules are pure functions
 * precisely so they can be asserted line by line, with no database and no
 * fixtures, which is the only form an accountant can review.
 *
 * Every test below therefore names the ACCOUNT and the AMOUNT, never just that
 * the entry balances. Balancing is necessary and proves nothing on its own:
 * the inverted credit and debit notes ACC-0 had to fix balanced perfectly.
 */

/** The amount on one side of one role, or undefined where the role is absent. */
const at = (lines, role) => lines.find((line) => line.role === role);
const dr = (lines, role) => at(lines, role)?.debit_minor;
const cr = (lines, role) => at(lines, role)?.credit_minor;

const balances = (lines) => assert.equal(rules.imbalanceOf(lines), 0);

test('every rule balances by construction', () => {
  balances(rules.invoiceRaised({ grossMinor: 5000000000, discountMinor: 250000000, vatMinor: 356250000 }));
  balances(rules.feeInvoiceRaised({ netMinor: 5000000, vatMinor: 375000 }));
  balances(rules.paymentApproved({ amountMinor: 1234567 }));
  balances(rules.overpaymentHeld({ surplusMinor: 50000 }));
  balances(rules.creditNoteApproved({ netMinor: 1000000, vatMinor: 75000 }));
  balances(rules.refundPaid({ amountMinor: 900000 }));
  balances(rules.billApproved({ netMinor: 12000000000, taxMinor: 900000000, withholdingMinor: 600000000 }));
  balances(rules.billPaid({ amountMinor: 12300000000 }));
  balances(rules.supplierCreditNote({ netMinor: 500000, taxMinor: 37500 }));
  balances(rules.handoverRecognised({ revenueMinor: 5000000000, costMinor: 4800000000 }));
  balances(rules.costCatchUp({ amountMinor: 1200000000 }));
  balances(rules.inventoryWriteDown({ amountMinor: 500000000 }));
});

test('a sale deferred to handover credits contract liability, not revenue', () => {
  const lines = rules.invoiceRaised({
    grossMinor: 5000000000,
    vatMinor: 375000000,
    recognition: rules.RECOGNITION.ON_HANDOVER,
  });

  assert.equal(dr(lines, ROLE.ACCOUNTS_RECEIVABLE), 5375000000);
  assert.equal(cr(lines, ROLE.CONTRACT_LIABILITY), 5000000000);
  assert.equal(cr(lines, ROLE.VAT_OUTPUT), 375000000);
  // Recognising here would report a completed sale on a hole in the ground.
  assert.equal(at(lines, ROLE.REVENUE_UNIT_SALES), undefined);
});

test('a sale recognised on invoice credits revenue instead', () => {
  const lines = rules.invoiceRaised({
    grossMinor: 5000000000,
    vatMinor: 375000000,
    recognition: rules.RECOGNITION.ON_INVOICE,
  });

  assert.equal(cr(lines, ROLE.REVENUE_UNIT_SALES), 5000000000);
  assert.equal(at(lines, ROLE.CONTRACT_LIABILITY), undefined);
});

test('a discount is its own debit, so discounting stays visible', () => {
  const lines = rules.invoiceRaised({
    grossMinor: 5000000000, discountMinor: 250000000, vatMinor: 356250000,
  });

  // Revenue is credited at the FULL price...
  assert.equal(cr(lines, ROLE.CONTRACT_LIABILITY), 5000000000);
  // ...and the reduction debited back out of it as contra-income.
  assert.equal(dr(lines, ROLE.REVENUE_DISCOUNTS), 250000000);
  // The buyer sends the discounted price plus tax.
  assert.equal(dr(lines, ROLE.ACCOUNTS_RECEIVABLE), 5106250000);
});

test('a discount cannot exceed the price', () => {
  const lines = rules.invoiceRaised({ grossMinor: 1000000, discountMinor: 9999999 });
  assert.equal(dr(lines, ROLE.REVENUE_DISCOUNTS), 1000000);
  assert.equal(dr(lines, ROLE.ACCOUNTS_RECEIVABLE), undefined); // nothing left to collect
  balances(lines);
});

test('withholding is a liability to remit, not a smaller cost', () => {
  const lines = rules.billApproved({
    netMinor: 12000000000, taxMinor: 900000000, withholdingMinor: 600000000,
  });

  // The company owes the vendor the full net and pays part of it to the
  // revenue service. Netting it off would understate the cost AND lose the
  // obligation.
  assert.equal(dr(lines, ROLE.COST_OF_SALES), 12000000000);
  assert.equal(cr(lines, ROLE.ACCOUNTS_PAYABLE), 12300000000);
  assert.equal(cr(lines, ROLE.WITHHOLDING_PAYABLE), 600000000);
  assert.equal(dr(lines, ROLE.VAT_INPUT), 900000000);
});

test('a capitalisable bill goes to work in progress rather than the P&L', () => {
  const lines = rules.billApproved({
    netMinor: 12000000000, expenseRole: ROLE.DEVELOPMENT_WIP,
  });
  assert.equal(dr(lines, ROLE.DEVELOPMENT_WIP), 12000000000);
  assert.equal(at(lines, ROLE.COST_OF_SALES), undefined);
});

test('a bill coded to one account addresses it by id, not by role', () => {
  /*
   * Most expense accounts have no role — nothing needs to find "marketing" by
   * name. Passing the CODE where a role is expected is how marketing spend
   * ended up in suspense the first time this shipped.
   */
  const lines = rules.billApproved({ netMinor: 800000000, expenseAccountId: 4242 });
  const expense = lines.find((line) => line.debit_minor === 800000000);
  assert.equal(expense.account_id, 4242);
});

test('handover moves revenue and its cost in ONE entry', () => {
  const lines = rules.handoverRecognised({ revenueMinor: 5000000000, costMinor: 3100000000 });

  assert.equal(dr(lines, ROLE.CONTRACT_LIABILITY), 5000000000);
  assert.equal(cr(lines, ROLE.REVENUE_UNIT_SALES), 5000000000);
  assert.equal(dr(lines, ROLE.COST_OF_SALES), 3100000000);
  assert.equal(cr(lines, ROLE.DEVELOPMENT_WIP), 3100000000);
});

test('handover does NOT touch output tax a second time', () => {
  const lines = rules.handoverRecognised({ revenueMinor: 5000000000, costMinor: 3100000000 });
  // The tax followed the tax point when the invoice was raised. Charging it
  // again is the commonest failure of this design elsewhere.
  assert.equal(at(lines, ROLE.VAT_OUTPUT), undefined);
});

test('a handover with no capitalised cost posts the revenue alone', () => {
  // Bare land bought years ago and never developed has no WIP behind it.
  const lines = rules.handoverRecognised({ revenueMinor: 2000000000, costMinor: 0 });
  assert.equal(lines.length, 2);
  balances(lines);
});

test('a cost catch-up reverses its sides when the pool shrank', () => {
  const up = rules.costCatchUp({ amountMinor: 1200000000 });
  assert.equal(dr(up, ROLE.COST_OF_SALES), 1200000000);

  const down = rules.costCatchUp({ amountMinor: -1200000000 });
  assert.equal(cr(down, ROLE.COST_OF_SALES), 1200000000);
  assert.equal(dr(down, ROLE.DEVELOPMENT_WIP), 1200000000);
});

test('a write-down is its own expense, not cost of units sold', () => {
  const lines = rules.inventoryWriteDown({ amountMinor: 500000000 });
  // A bad project and an expensive one must not read the same, and IAS 2 asks
  // for the amount written down in a period to be disclosed.
  assert.equal(dr(lines, ROLE.INVENTORY_WRITE_DOWN), 500000000);
  assert.equal(cr(lines, ROLE.DEVELOPMENT_WIP), 500000000);
});

test('a write-down reverses when the circumstances no longer apply', () => {
  const lines = rules.inventoryWriteDown({ amountMinor: -500000000 });
  assert.equal(dr(lines, ROLE.DEVELOPMENT_WIP), 500000000);
  assert.equal(cr(lines, ROLE.INVENTORY_WRITE_DOWN), 500000000);
});

test('an overpayment is money held for the buyer, not a negative receivable', () => {
  const lines = rules.overpaymentHeld({ surplusMinor: 50000 });
  // The bank has the money and the company owes it back. A negative
  // receivable would net it off against what the buyer still owes on
  // something else, which is not what happened.
  assert.equal(dr(lines, ROLE.BANK), 50000);
  assert.equal(cr(lines, ROLE.CUSTOMER_CREDIT_BALANCES), 50000);
});

test('a refund discharges what was held, and takes it out of the bank', () => {
  const lines = rules.refundPaid({ amountMinor: 50000 });
  assert.equal(dr(lines, ROLE.CUSTOMER_CREDIT_BALANCES), 50000);
  assert.equal(cr(lines, ROLE.BANK), 50000);
});

test('a customer credit note reduces revenue and the tax with it', () => {
  const lines = rules.creditNoteApproved({ netMinor: 1000000, vatMinor: 75000 });
  // Sage's meaning, not the inverted one ACC-0 had to fix: it reduces what
  // the customer owes.
  assert.equal(cr(lines, ROLE.ACCOUNTS_RECEIVABLE), 1075000);
  assert.equal(dr(lines, ROLE.VAT_OUTPUT), 75000);
});

test('lines with nothing on them are dropped', () => {
  const lines = rules.invoiceRaised({ grossMinor: 1000000, vatMinor: 0, discountMinor: 0 });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.debit_minor > 0 || line.credit_minor > 0));
});

test('every rule in the catalogue is a function', () => {
  Object.entries(rules.RULES).forEach(([name, rule]) => {
    assert.equal(typeof rule, 'function', `${name} is not callable`);
  });
});
