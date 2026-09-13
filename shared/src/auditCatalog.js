/**
 * What an audited request is CALLED.
 *
 * ── Why this is a scheme and not a table of three hundred routes ────────────
 *
 * A hand-maintained map of every route to an action name has one failure mode,
 * and it is the one an audit trail cannot have: a route added later is not in
 * it, so the action is recorded under some default like "unknown" — or not
 * recorded at all — and nobody notices, because the log still looks full. The
 * gap only becomes visible when somebody goes looking for the one event that
 * mattered.
 *
 * So the name is DERIVED from the route, by a rule every route already obeys:
 * this codebase names paths after resources and puts the verb last
 * (`/properties/:id/approve`, `/commissions/:id/pay`, `/receipts/:id/reject`).
 * A route added tomorrow that follows the same convention gets a sensible name
 * with no edit here. LABELS below only makes names prettier on screen; nothing
 * depends on an entry existing in it.
 */

/**
 * Path segments that are already a verb.
 *
 * When the last segment is one of these the action is named after it —
 * `properties.approve`, not `properties.approve.create`. Everything else is a
 * resource, and the HTTP method supplies the verb.
 *
 * Being absent from this list is not a bug; it produces `x.y.create` instead of
 * `x.y`, which is still correct and still unique. The list exists to make the
 * common administrative actions read well.
 */
const VERB_SEGMENTS = new Set([
  'approve', 'reject', 'cancel', 'submit', 'publish', 'send', 'send-bulk',
  'pay', 'mark-paid', 'verify', 'verify-setup', 'confirm', 'complete',
  'activate', 'enroll', 'checkout', 'read', 'read-all', 'reorder', 'test',
  'request-revision', 'request-payout', 'request-cashout', 'approve-cashout',
  'reject-cashout', 'waive-fee', 'assign-role', 'auto-assign', 'calculate',
  'bulk-import', 'disable', 'setup', 'login', 'logout', 'register', 'refresh',
  'switch-role', 'shareable', 'payout', 'checkout', 'share-link', 'public-link',
  'forced-setup', 'forced-verify', 'reset-password', 'forgot-password',
  'verify-reset-otp',
]);

const METHOD_VERB = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/** `/api/users/5` and `/users/5` are the same route; the frontend uses the former. */
const stripApiPrefix = (path) => (path.startsWith('/api/') ? path.slice(4) : path);

/**
 * Is this segment an identifier rather than a name?
 *
 * Numeric ids, uuids and the opaque tokens and codes that appear in link paths.
 * They are stripped from the action name — `users.update` must be one action,
 * not one per user — and the first of them is kept as the entity id.
 */
const isIdentifierSegment = (segment) => /^\d+$/.test(segment)
  || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
  || /^[0-9a-f]{24,}$/i.test(segment);

/**
 * Singular form of a resource segment, for the entity type.
 *
 * Deliberately crude — this labels a row, it does not drive behaviour, and the
 * handful of English plurals it gets wrong are legible anyway.
 */
const singular = (word) => {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
};

/**
 * Human labels for the actions worth reading twice.
 *
 * Only a presentation aid. An action with no entry here is title-cased from its
 * own name, which is why adding a route never requires touching this file.
 */
const LABELS = {
  'auth.register': 'Created an account',
  'auth.login': 'Signed in',
  'auth.passcode.create': 'Set a sign-in passcode',
  'auth.passcode.delete': 'Removed their sign-in passcode',
  'auth.profiles.enable.create': 'Enabled a second profile',
  'auth.logout': 'Signed out',
  'auth.reset-password': 'Completed a password reset',
  'auth.forgot-password': 'Requested a password reset',
  'auth.2fa.disable': 'Disabled two-factor authentication',
  'auth.2fa.setup': 'Enabled two-factor authentication',
  'auth.admin.2fa-policy.create': "Changed the company's two-factor policy",
  'auth.switch-role': 'Switched profile',
  'users.create': 'Created a user',
  'users.update': 'Updated a user',
  'users.delete': 'Deleted a user',
  'users.roles.update': "Changed a user's roles",
  'users.assign-role': 'Assigned a role to a user',
  'users.roles.delete': 'Removed a role from a user',
  'roles.create': 'Created a role',
  'roles.update': 'Updated a role',
  'roles.delete': 'Deleted a role',
  'roles.permissions.update': "Changed a role's permissions",
  'permissions.create': 'Created a permission',
  'permissions.update': 'Updated a permission',
  'permissions.delete': 'Deleted a permission',
  'companies.create': 'Created a company',
  'companies.update': 'Updated a company',
  'companies.delete': 'Deleted a company',
  'settings.create': 'Changed a setting',
  'settings.bulk.create': 'Changed several settings',
  'settings.system.create': 'Changed system configuration',
  'settings.upload-logo.create': 'Changed the logo',
  'properties.create': 'Created a property',
  'properties.update': 'Updated a property',
  'properties.delete': 'Deleted a property',
  'properties.approve': 'Approved a property',
  'properties.reject': 'Rejected a property',
  'properties.request-revision': 'Requested revisions to a property',
  'properties.public-link': 'Issued a public link for a property',
  'properties.public-link.delete': 'Revoked a property’s public link',
  'properties.units.create': 'Added a unit configuration',
  'properties.units.update': 'Changed a unit configuration',
  'properties.units.delete': 'Removed a unit configuration',
  'properties.bulk-import': 'Bulk-imported properties',
  'invoices.create': 'Created an invoice',
  'invoices.update': 'Updated an invoice',
  'invoices.delete': 'Deleted an invoice',
  'invoices.cancel': 'Cancelled an invoice',
  'invoices.mark-paid': 'Marked an invoice paid',
  'invoices.quantity.update': "Changed an invoice's quantity",
  'receipts.verify': 'Verified a payment receipt',
  'receipts.reject': 'Rejected a payment receipt',
  'receipts.cancel': 'Cancelled a receipt',
  'payment-schedules.waive-fee': 'Waived a fee',
  'commissions.approve': 'Approved a commission',
  'commissions.pay': 'Paid a commission',
  'transactions.create': 'Recorded a transaction',
  'transactions.update': 'Updated a transaction',
  'transactions.delete': 'Deleted a transaction',
  'bank-accounts.create': 'Added a bank account',
  'bank-accounts.update': 'Updated a bank account',
  'bank-accounts.delete': 'Removed a bank account',
  'installment-plans.create': 'Created an installment plan',
  'installment-plans.update': 'Updated an installment plan',
  'installment-plans.delete': 'Deleted an installment plan',
  'investments.approve-cashout': 'Approved a cash-out',
  'investments.reject-cashout': 'Rejected a cash-out',
  'investments.activate': 'Activated an investment',
  'realtor-kyc.approve': 'Approved a realtor verification',
  'realtor-kyc.reject': 'Rejected a realtor verification',
  'realtor-levels.requests.approve': 'Approved a level upgrade',
  'realtor-levels.requests.reject': 'Rejected a level upgrade',
  'media.posts.approve': 'Approved a media post',
  'media.posts.reject': 'Rejected a media post',
  'media.posts.publish': 'Published a media post',
  'notifications.send': 'Sent a notification',
  'notifications.send-bulk': 'Sent a bulk notification',
  'referral.setting.create': 'Changed referral settings',
};

/**
 * The action, module and entity behind one request.
 *
 * Returns null for a path with no resource in it at all, which is the caller's
 * signal that there is nothing here worth recording.
 */
const describeRequest = (method, rawPath) => {
  const path = stripApiPrefix(String(rawPath || '').split('?')[0]);
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) return null;

  const resources = [];
  let entityId = null;
  segments.forEach((segment) => {
    if (isIdentifierSegment(segment)) {
      if (entityId === null) entityId = segment;
      return;
    }
    resources.push(segment);
  });
  if (!resources.length) return null;

  const [module, ...tail] = resources;
  const methodVerb = METHOD_VERB[String(method).toUpperCase()] || String(method).toLowerCase();
  const lastIsVerb = tail.length > 0 && VERB_SEGMENTS.has(tail[tail.length - 1]);

  /**
   * A trailing verb names the action on its own, EXCEPT when the method
   * contradicts it: `DELETE /properties/:id/public-link` is a revocation, not
   * an issue, and both would otherwise be called `properties.public-link`.
   */
  const parts = [module, ...tail];
  if (!lastIsVerb || methodVerb === 'delete') parts.push(methodVerb);

  const action = parts.join('.');
  return {
    action,
    module,
    entity_type: singular(tail.length && !lastIsVerb ? tail[tail.length - 1] : module),
    entity_id: entityId,
    label: LABELS[action] || null,
  };
};

module.exports = { describeRequest, LABELS, VERB_SEGMENTS, isIdentifierSegment, stripApiPrefix };
