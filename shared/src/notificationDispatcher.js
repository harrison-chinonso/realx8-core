const { QueryTypes } = require('sequelize');
const { createNotifier } = require('./notifier');
const {
  resolveNotificationConfig, usersWithPermissions, EVENTS_BY_KEY,
} = require('./notificationConfig');

/**
 * Dispatching a configured event to whoever the company said should hear it.
 *
 * Sits on top of notifier.js — which knows how to write the in-app row, send
 * the mail and resolve a client's realtor — and adds the part notifier.js has
 * no opinion about: WHO. Any service can call this with an event key and a
 * subject; the recipients come from configuration, not from the call site.
 *
 * That inversion is the point. Before this, each call site named its own
 * recipients in code, so "also tell the branch manager" was a code change in
 * however many files happened to emit that event. Now it is a checkbox.
 *
 * Every path is BEST EFFORT and never throws, for the same reason notifier.js
 * is not: a notification failure must not roll back the thing it is reporting.
 * Callers dispatch after their transaction has committed.
 */
const createDispatcher = (sequelize) => {
  const { notifyUser, findRealtorForClient } = createNotifier(sequelize);

  /** Name, email and company for one user. */
  const getUser = async (userId) => {
    if (!userId) return null;
    try {
      const rows = await sequelize.query(
        'SELECT id, name, email, company_id, type FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
        { replacements: { id: userId }, type: QueryTypes.SELECT },
      );
      return rows[0] || null;
    } catch (error) {
      console.error('[notify] subject lookup failed:', error.message);
      return null;
    }
  };

  /**
   * Sends one event.
   *
   *   eventKey       a key from the catalogue in notificationEvents.js
   *   subjectUserId  the user the event is about, if any. Notified when the
   *                  config has `subject` on, and used to resolve the realtor.
   *   companyId      scopes the configuration lookup AND the permission
   *                  recipients. Falls back to the subject's company.
   *   title / body   strings, or functions of (role, context). Functions
   *                  because the same event reads differently to the three
   *                  audiences: "your payment was approved" is wrong in a
   *                  colleague's inbox.
   *   context        anything the title/body functions need. The subject row is
   *                  merged in as `context.subject`.
   *
   * `role` is 'subject', 'realtor' or 'permission'.
   *
   * Returns { sent, skipped } and never rejects.
   */
  const dispatch = async ({
    eventKey, subjectUserId = null, companyId = null, context = {},
    title, body, type = null, data = null, actionLabel = null, actionUrl = null,
  }) => {
    try {
      const entry = EVENTS_BY_KEY.get(eventKey);
      if (!entry) {
        // A key not in the catalogue cannot be configured, so it would be
        // undeliverable and invisible. Loud, because it is a programming error.
        console.error(`[notify] unknown event "${eventKey}" — add it to shared/src/notificationEvents.js`);
        return { skipped: 'unknown_event' };
      }

      const subject = await getUser(subjectUserId);
      const scope = companyId ?? subject?.company_id ?? null;

      /**
       * One company per notification, enforced here rather than trusted.
       *
       * Every recipient of an event must belong to the company whose data
       * caused it: the subject, their realtor, and the permission holders. The
       * realtor lookup and the permission query each enforce that themselves,
       * but a caller passing a companyId from one company alongside a subject
       * from another would still produce a notification spanning both — the
       * subject would be told, and so would the OTHER company's permission
       * holders.
       *
       * That cannot come from correct code, so it is refused rather than
       * papered over: sending to the intersection would hide the caller's bug,
       * and sending to the union would leak.
       */
      if (subject && companyId != null && subject.company_id != null
          && Number(subject.company_id) !== Number(companyId)) {
        console.error(`[notify] refusing "${eventKey}": subject ${subject.id} belongs to company `
          + `${subject.company_id} but the event was scoped to company ${companyId}`);
        return { skipped: 'company_mismatch' };
      }

      const config = (await resolveNotificationConfig(sequelize, scope))(eventKey);
      if (!config.enabled) return { skipped: 'disabled' };

      const fullContext = { ...context, subject, event: entry };
      const resolve = (value, role) => (typeof value === 'function' ? value(role, fullContext) : value);

      // Collected first, then deduplicated: a subject who also holds the
      // configured permission would otherwise be notified twice about the same
      // thing, which reads as a bug to them.
      const recipients = new Map();
      const add = (userId, role) => {
        if (!userId) return;
        if (!recipients.has(Number(userId))) recipients.set(Number(userId), role);
      };

      if (config.subject) add(subject?.id ?? subjectUserId, 'subject');

      if (config.realtor && subject) {
        // Resolved through the existing rule, which returns nobody rather than
        // risk telling an unrelated realtor about someone's business. Where no
        // realtor is assigned the recipient is simply omitted — not an error.
        const realtorId = await findRealtorForClient({
          email: subject.email, companyId: scope, userId: subject.id,
        });
        add(realtorId, 'realtor');
      }

      if (config.permissions?.length) {
        /**
         * Company-scoped. With `scope` null this resolves PLATFORM users
         * (company_id IS NULL), which is correct for a platform-level event
         * such as company_created and is why that one passes companyId: null
         * deliberately. A company event whose scope came out null would
         * therefore reach platform staff rather than the company's own — so
         * scope is derived from the subject above rather than left to chance.
         */
        const holders = await usersWithPermissions(sequelize, {
          companyId: scope, permissionNames: config.permissions,
        });
        holders.forEach((id) => add(id, 'permission'));
      }

      if (!recipients.size) return { skipped: 'no_recipients' };

      await Promise.all([...recipients].map(([userId, role]) => notifyUser({
        userId,
        title: resolve(title, role),
        body: resolve(body, role),
        type: type || eventKey,
        data: { event: eventKey, ...(data || {}) },
        companyId: scope,
        actionLabel,
        actionUrl,
        channel: config.channel,
      })));

      return { sent: recipients.size };
    } catch (error) {
      console.error(`[notify] ${eventKey} dispatch failed:`, error.message);
      return { failed: error.message };
    }
  };

  return { dispatch, getUser, findRealtorForClient, notifyUser };
};

module.exports = { createDispatcher };
