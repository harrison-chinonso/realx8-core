const { QueryTypes } = require('sequelize');
const { q } = require('../../shared/src/dialect');
const { brandFrom, renderNotificationEmail } = require('./emailTemplate');
const { sendMail } = require('./mailTransport');

/**
 * Realtor notifications (in-app + email), shared by property-service and
 * finance-service.
 *
 * Writes the in-app row directly and sends mail with the same SMTP settings
 * notification-service reads. Every path is BEST EFFORT and never throws: a
 * notification failure must not roll back a purchase, payment or inspection.
 *
 * Call createNotifier(sequelize) with the host service's connection.
 */
const createNotifier = (sequelize) => {

const settingsFor = async (companyId) => {
  const rows = await sequelize.query(
    `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings
      WHERE ${q(sequelize, 'group')} IN ('general', 'appearance', 'email')
        AND (company_id IS NULL ${companyId ? 'OR company_id = :companyId' : ''})`,
    { replacements: { companyId }, type: QueryTypes.SELECT },
  );
  // Company values override global ones.
  const global = {}; const company = {};
  rows.forEach((r) => { (r.company_id == null ? global : company)[r.key] = r.value; });
  return { ...global, ...company };
};

const sendEmail = async ({ to, toName, subject, body, actionLabel, actionUrl, companyId }) => {
  try {
    const cfg = await settingsFor(companyId);
    const host = cfg.mail_host || process.env.SMTP_HOST;
    const user = cfg.mail_username || process.env.SMTP_USER;
    const pass = cfg.mail_password || process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      console.log(`[notify] SMTP not configured — email to ${to} skipped`);
      return false;
    }
    const port = Number(cfg.mail_port || process.env.SMTP_PORT || 587);
    const fromName = cfg.mail_from_name || cfg.app_name || 'Realto';
    const fromAddress = cfg.mail_from_address || 'noreply@realto.app';
    const { text, html } = renderNotificationEmail(brandFrom(cfg), {
      title: subject, body, actionLabel, actionUrl,
    });
    /**
     * Sent through the shared transport, which falls back to another port when
     * the configured one is blocked by the network — see mailTransport.js. The
     * timeouts that used to be set here live there now, so all four senders in
     * this codebase cannot drift apart.
     */
    const result = await sendMail({
      host, port, user, pass, label: 'notify',
      message: {
        from: `"${fromName}" <${fromAddress}>`,
        to: toName ? `"${toName}" <${to}>` : to,
        subject,
        text,
        html,
      },
    });
    if (!result.sent) {
      console.log(`[notify] SMTP not configured — email to ${to} skipped`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[notify] email to ${to} failed:`, error.message);
    return false;
  }
};

/** Looks up a user's name/email without defining a User model (sync would reshape it). */
const getUser = async (userId) => {
  if (!userId) return null;
  const rows = await sequelize.query(
    'SELECT id, name, email, company_id FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
    { replacements: { id: userId }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
};

/**
 * Sends an in-app notification and an email to one user.
 * Returns { inApp, email } booleans; never throws.
 *
 * `channel` selects the delivery routes: 'in_app', 'email' or 'both'. It exists
 * so a configured event can be delivered as the administrator chose — a
 * schedule reminder every month is welcome in the bell and unwelcome in an
 * inbox. Defaults to 'both', which is what every caller did before it existed.
 */
const notifyUser = async ({ userId, title, body, type, data = null, companyId = null, actionLabel = null, actionUrl = null, channel = 'both' }) => {
  const result = { inApp: false, email: false };
  try {
    const user = await getUser(userId);
    if (!user) return result;

    if (channel === 'email') {
      // Email only: skip the in-app row entirely rather than writing one
      // nobody asked for.
      result.email = user.email ? await sendEmail({
        to: user.email, toName: user.name, subject: title, body,
        actionLabel, actionUrl,
        companyId: companyId ?? user.company_id ?? null,
      }) : false;
      return result;
    }

    await sequelize.query(
      `INSERT INTO notifications (user_id, sent_by, title, body, type, is_read, data, company_id, created_at)
       VALUES (:userId, NULL, :title, :body, :type, 0, :data, :companyId, NOW())`,
      {
        replacements: {
          userId, title, body, type,
          data: data ? JSON.stringify(data) : null,
          companyId: companyId ?? user.company_id ?? null,
        },
        type: QueryTypes.INSERT,
      },
    );
    result.inApp = true;

    if (user.email && channel !== 'in_app') {
      result.email = await sendEmail({
        to: user.email, toName: user.name, subject: title, body,
        actionLabel, actionUrl,
        companyId: companyId ?? user.company_id ?? null,
      });
    }
  } catch (error) {
    console.error('[notify] failed:', error.message);
  }
  return result;
};

/**
 * Resolves the realtor responsible for a client — WITHIN THEIR OWN COMPANY.
 *
 * Prefers users.realtor_id, the first-class link. Falls back to the CRM lead (a
 * lead matching the client's email, assigned to a realtor) for accounts that
 * predate the column, and only when exactly ONE lead matches: an ambiguous
 * result notifies nobody rather than risk disclosing a client's purchase to an
 * unrelated realtor.
 *
 * EVERY path is constrained to a single company, and that is the whole point of
 * the rewrite. The previous version had two ways to cross the boundary:
 *
 *   The direct lookup joined the realtor on `r.id = u.realtor_id` with no
 *   condition on r.company_id. A realtor_id pointing at another company — a
 *   stale link after someone moved, or a bad import — notified a realtor at a
 *   different company about this company's client.
 *
 *   The lead fallback applied its company filter only when a companyId was
 *   passed, so a call without one matched leads across every company on the
 *   platform, and it never checked the realtor's company at all.
 *
 * So the client is resolved first, and their company — not the caller's
 * argument — is what bounds the search. A caller that passes a mismatched
 * companyId gets nobody rather than somebody from the wrong company.
 */
const findRealtorForClient = async ({ email, companyId, userId = null }) => {
  if (!email && !userId) return null;
  try {
    // 1. The client, scoped by company where one was supplied. Resolving them
    //    first means the company constraint below comes from the client's own
    //    row and cannot be widened by a caller passing null.
    const clients = await sequelize.query(
      `SELECT id, email, company_id, realtor_id
         FROM users
        WHERE deleted_at IS NULL
          AND ${userId ? 'id = :userId' : 'LOWER(TRIM(email)) = LOWER(TRIM(:email))'}
          ${companyId ? 'AND company_id = :companyId' : ''}
        LIMIT 1`,
      { replacements: { email: email ?? null, userId, companyId }, type: QueryTypes.SELECT },
    );
    const client = clients[0];
    if (!client) return null;

    // The company the answer must stay inside. The client's own value wins over
    // the argument, so a caller cannot broaden the search by omitting it.
    const scope = client.company_id ?? companyId ?? null;

    // 2. The first-class link, with the realtor required to be in that company.
    if (client.realtor_id) {
      const direct = await sequelize.query(
        `SELECT id FROM users
          WHERE id = :realtorId
            AND type = 'realtor'
            AND deleted_at IS NULL
            AND company_id ${scope ? '= :scope' : 'IS NULL'}
          LIMIT 1`,
        { replacements: { realtorId: client.realtor_id, scope }, type: QueryTypes.SELECT },
      );
      if (direct.length) return direct[0].id;
      // A realtor_id pointing outside the company is a data problem, not a
      // recipient. Logged rather than followed.
      console.warn(`[notify] user ${client.id} is linked to realtor ${client.realtor_id} `
        + 'in a different company — ignoring the link');
    }

    // 3. The lead fallback. Both the lead AND the realtor are pinned to the
    //    client's company, unconditionally.
    if (!client.email) return null;
    const rows = await sequelize.query(
      `SELECT DISTINCT l.assigned_to AS realtor_id
         FROM leads l
         JOIN users u ON u.id = l.assigned_to
                     AND u.type = 'realtor'
                     AND u.deleted_at IS NULL
                     AND u.company_id ${scope ? '= :scope' : 'IS NULL'}
        WHERE LOWER(TRIM(l.email)) = LOWER(TRIM(:email))
          AND l.assigned_to IS NOT NULL
          AND l.company_id ${scope ? '= :scope' : 'IS NULL'}
        LIMIT 2`,
      { replacements: { email: client.email, scope }, type: QueryTypes.SELECT },
    );
    return rows.length === 1 ? rows[0].realtor_id : null;
  } catch (error) {
    console.error('[notify] realtor lookup failed:', error.message);
    return null;
  }
};

  return { notifyUser, findRealtorForClient };
};

module.exports = { createNotifier };
