/**
 * The assistant's knowledge, as data.
 *
 * Plain text in the repo, versioned beside the code it describes — so when a
 * screen moves, the answer moves with it in the same commit. Nothing here is
 * learned or inferred; every sentence is one somebody wrote deliberately.
 *
 * `match` entries are lowercase phrases. Scoring rewards longer phrases, so
 * "proof of payment" beats a bare "payment".
 */

/** Who an article is for. Anything else is filtered out before matching. */
const ANY = ['client', 'realtor', 'admin', 'super_admin', 'superior_admin'];

const ARTICLES = [
  {
    id: 'buy-property',
    audience: ANY,
    match: ['how do i buy', 'how to buy', 'buy a property', 'purchase a property', 'make a purchase',
      'how do i purchase', 'buy land', 'buy a house', 'start a purchase',
      // Looser forms people actually type, including light pidgin word order.
      'buy house', 'buy property', 'want to buy', 'take buy', 'i go buy', 'how i go buy'],
    answer: ({ appName }) => `Here is how buying works in ${appName}:

1. Open **Listed Properties** from the menu.
2. Pick a property and tap **View details**.
3. Tap **Purchase Now**, then choose the unit configuration, how many units, and whether you are paying outright or by instalment.
4. An invoice is created and you land on it straight away.

You then pay against that invoice and upload your proof of payment.`,
  },
  {
    id: 'pay-invoice',
    audience: ANY,
    match: ['how do i pay', 'how to pay', 'make payment', 'pay my invoice', 'pay invoice',
      'payment method', 'how can i pay', 'bank details', 'account number to pay', 'where do i pay'],
    answer: () => `Open the invoice, then tap **Make Payment**. You will see:

- **Bank Deposit** — the company account to transfer to.
- **Online Payment** — only if your company has a gateway set up.

After paying, upload your proof of payment on the same screen. The invoice moves to *payment under review* until an administrator confirms it — money is only credited once they approve it.`,
    // Follow the article with the caller's real options when they have an invoice.
    enrich: 'payment_options',
  },
  {
    id: 'proof-of-payment',
    audience: ANY,
    match: ['proof of payment', 'upload receipt', 'upload proof', 'payment under review',
      'i have paid', 'i already paid', 'sent the money', 'made the transfer', 'why is my payment not showing'],
    answer: () => `Once you upload proof of payment the invoice sits at *payment under review*. Nothing is credited until an administrator checks it, so the balance will not move immediately.

If it was declined you will get a reason, and you can upload fresh proof against the same invoice.`,
    enrich: 'invoices',
  },
  {
    id: 'instalments',
    audience: ANY,
    match: ['instalment', 'installment', 'payment plan', 'spread the payment', 'pay in bits',
      'part payment', 'monthly payment', 'can i pay small small', 'pay gradually'],
    answer: () => `You can pay an invoice in parts. Each approved payment reduces the **outstanding balance** — the invoice total itself never changes.

Tell me the amount and how many months you are thinking of and I will work out the monthly figure. For example: *"7 million over 24 months"*.`,
  },
  {
    id: 'outstanding-balance',
    audience: ANY,
    match: ['what do i owe', 'my balance', 'outstanding', 'how much do i owe', 'my invoices',
      'do i owe', 'my bill', 'unpaid invoice', 'invoice status'],
    answer: null,          // answered entirely from the user's own data
    enrich: 'invoices',
  },
  {
    id: 'find-property',
    audience: ANY,
    match: ['what can i afford', 'show me properties', 'properties under', 'my budget',
      'available properties', 'what is available', 'land for sale', 'houses available', 'looking for a property'],
    answer: null,
    enrich: 'properties',
  },
  {
    id: 'inspection-realtor',
    // Admins schedule too — they pick which realtor takes it.
    audience: ['realtor', 'admin', 'super_admin', 'superior_admin'],
    match: ['book an inspection', 'schedule an inspection', 'arrange a viewing', 'inspection',
      'viewing', 'site visit', 'take a client to see'],
    answer: ({ role }) => {
      const staff = ['admin', 'super_admin', 'superior_admin'].includes(role);
      return `1. Open **Property Inspection**.
2. Tap **Schedule Inspection**, pick the property and the lead${staff ? ', choose the realtor who will take it' : ''}, then the date, time and how many people are attending.
3. ${staff ? 'Approve it from the same screen once you are happy with it.' : 'An administrator approves it before it is confirmed.'}

${staff ? 'Realtors can only pick leads of their own; you can pick any lead in the company.' : 'If the lead does not exist yet, create it from the same screen first.'}`;
    },
  },
  {
    id: 'inspection-client',
    audience: ['client'],
    match: ['book an inspection', 'schedule an inspection', 'arrange a viewing', 'inspection',
      'viewing', 'site visit', 'can i see the property', 'visit the property'],
    answer: () => `Viewings are arranged by a realtor rather than booked directly, so tell me which property you would like to see and roughly when, and I will log the request for you. A realtor will then confirm a slot.`,
    enrich: 'inspection_request_hint',
  },
  {
    id: 'verification',
    audience: ['realtor'],
    match: ['verification', 'kyc', 'verify my account', 'upload id', 'proof of address', 'get verified'],
    answer: () => `Go to **My Profile → Verification**. You will need:

1. A means of identification — the document plus its ID number.
2. A proof of address — the document plus your residential address.

Both the ID number and the address are required. An administrator reviews it, and you will be notified either way. If it is declined you will see the reason and can resubmit.`,
  },
  {
    id: 'verification-review',
    audience: ['admin', 'super_admin', 'superior_admin'],
    match: ['verification', 'kyc', 'approve verification', 'review verification',
      'verify a realtor', 'realtor verification', 'get verified'],
    answer: () => `Realtor verifications come to you under **User Management → Realtor Verifications**.

Each submission shows the means of identification and the proof of address. Open the documents, then approve or decline — a decline needs a reason, which the realtor sees so they can resubmit.

A realtor's status also shows on the Realtors list and anywhere their details appear.`,
  },
  {
    id: 'level-upgrade',
    audience: ['realtor'],
    match: ['level', 'upgrade my level', 'realtor level', 'move up', 'promotion', 'commission rate'],
    answer: () => `Your level is on your dashboard — tap it to open **My Profile → Level Upgrade**. There you can see the ladder and request a move up. An administrator reviews every request.

New realtors start on the entry level.`,
  },
  {
    id: 'referrals',
    audience: ['realtor'],
    match: ['referral', 'my downline', 'refer someone', 'referral link', 'my clients', 'commission from'],
    answer: () => `**My Referrals** shows everyone you brought in, as a list or a tree, and carries your referral link — anyone signing up through it becomes your downline.

On each referral you can open **Business Analysis**, **Commissions & Purchases** to see what they bought and what it earned you, and **Payment Analysis**.`,
  },
  {
    id: 'documents',
    audience: ANY,
    match: ['certificate of occupancy', 'c of o', 'governor consent', "governor's consent",
      'deed of assignment', 'survey plan', 'excision', 'gazette', 'title document', 'what document'],
    answer: null,          // resolved to the specific document asked about
    enrich: 'documents',
  },
  {
    id: 'password',
    audience: ANY,
    match: ['change my password', 'reset password', 'forgot password', 'new password', 'security'],
    answer: () => `Go to **My Profile → Security** to set a new password.

If you are locked out, use **Forgot password** on the sign-in screen — a code is emailed to you.`,
  },
  {
    id: 'switch-profile',
    audience: ANY,
    match: ['switch profile', 'client account', 'realtor account', 'second profile', 'become a realtor', 'both accounts'],
    answer: () => `The button at the top right of the header switches you between your realtor and client profiles without signing in again. If you only hold one, the same button offers to create the other.`,
  },
];

/** Nigerian title documents, explained plainly. Never legal advice. */
const DOCUMENTS = {
  'certificate of occupancy': "The state government's grant of a 99-year right to occupy the land. It is the strongest common title, and the one most buyers look for.",
  'governor consent': 'The governor approving a transfer of land that already has a Certificate of Occupancy. Without it, a resale can later be challenged.',
  'deed of assignment': "The document transferring the seller's interest to you. It is the evidence that the transaction itself happened.",
  'survey plan': 'The exact coordinates and boundaries of the land. It confirms what is being sold, and whether the plot sits under a government acquisition.',
  excision: 'Government releasing land back to the community from an acquisition. Land without excision may still be under government claim.',
  gazette: 'The official published record that an excision happened. It is the proof the excision exists.',
};

const DOCUMENT_ALIASES = {
  'c of o': 'certificate of occupancy',
  'cofo': 'certificate of occupancy',
  'c/o': 'certificate of occupancy',
  "governor's consent": 'governor consent',
  'governors consent': 'governor consent',
  'deed': 'deed of assignment',
  'survey': 'survey plan',
};

module.exports = { ARTICLES, DOCUMENTS, DOCUMENT_ALIASES };
