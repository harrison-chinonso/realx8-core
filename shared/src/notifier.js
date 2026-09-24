const { QueryTypes } = require('sequelize');
const { parseChannels } = require('./notificationEvents');
const { pushToUser } = require('./webPush');
const { renderNotificationEmail } = require('./emailTemplate');
const { sendMail } = require('./mailTransport');
const { sendCompanySms } = require('./sms');
const { brandForCompany } = require('./companySettings');

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


const sendEmail = async ({ to, toName, subject, body, actionLabel, actionUrl, companyId }) => {
  try {
    /*
     * Company first, platform only where the company has nothing of its own —
     * and never for the name or the logo. A notice about a company's invoice
     * arriving under the platform's brand is the same fault as a receipt doing
     * it. See brandForCompany.
     */
    const { brand, settings: cfg } = await brandForCompany(sequelize, companyId);
    const host = cfg.mail_host || process.env.SMTP_HOST;
    const user = cfg.mail_username || process.env.SMTP_USER;
    const pass = cfg.mail_password || process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      console.log(`[notify] SMTP not configured — email to ${to} skipped`);
      return false;
    }
    const port = Number(cfg.mail_port || process.env.SMTP_PORT || 587);
    const fromName = brand.fromName;
    const fromAddress = brand.fromAddress;
    const { text, html } = renderNotificationEmail(brand, {
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
    'SELECT id, name, email, phone, company_id FROM users WHERE id = :id AND deleted_at IS NULL LIMIT 1',
    { replacements: { id: userId }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
};

/**
 * Sends an in-app notification, an email, a push and an SMS to one user.
 * Returns { inApp, email, push, sms } — never throws.
 *
 * `channel` selects the delivery routes, and is parsed as a SET: 'both',
 * 'email,push', 'all', and the older single values all mean something. It
 * exists so a configured event is delivered as the administrator chose — a
 * schedule reminder every month is welcome in the bell and unwelcome in an
 * inbox, and a payment approval is worth interrupting somebody for.
 */
const notifyUser = async ({ userId, title, body, type, data = null, companyId = null, actionLabel = null, actionUrl = null, channel = 'both' }) => {
  const result = { inApp: false, email: false, push: null, sms: null };
  try {
    const user = await getUser(userId);
    if (!user) return result;

    const routes = parseChannels(channel);
    const scope = companyId ?? user.company_id ?? null;

    if (routes.has('in_app')) {
      await sequelize.query(
        `INSERT INTO notifications (user_id, sent_by, title, body, type, is_read, data, company_id, created_at)
         VALUES (:userId, NULL, :title, :body, :type, 0, :data, :companyId, NOW())`,
        {
          replacements: {
            userId, title, body, type,
            data: data ? JSON.stringify(data) : null,
            companyId: scope,
          },
          type: QueryTypes.INSERT,
        },
      );
      result.inApp = true;
    }

    if (routes.has('email') && user.email) {
      result.email = await sendEmail({
        to: user.email, toName: user.name, subject: title, body,
        actionLabel, actionUrl,
        companyId: scope,
      });
    }

    if (routes.has('push')) {
      /**
       * Last, and its failure is only recorded.
       *
       * A push service being unreachable must not stop the in-app row or the
       * email — those are the routes somebody will actually go and check. Push
       * is the one that interrupts them, which makes it the most useful when it
       * works and the least important when it does not.
       */
      result.push = await pushToUser(sequelize, {
        userId,
        title,
        body,
        url: actionUrl || null,
        /*
         * Tagged by event and subject, so a browser REPLACES an earlier
         * notification about the same thing rather than stacking three copies
         * of "payment approved" on the lock screen.
         */
        tag: type ? `${type}:${userId}` : undefined,
        data: data || {},
      }).catch((error) => {
        console.error('[push] send failed:', error.message);
        return null;
      });
    }

    if (routes.has('sms') && user.phone) {
      /**
       * Last, and the only route that spends money.
       *
       * ── Why the text is rebuilt rather than reused ────────────────────────
       *
       * `title` and `body` are written for an inbox and an in-app row, where
       * length is free. A text is 160 characters a page and billed by the
       * page, so passing the email body through verbatim would quietly charge
       * a company four times over for one notification. The title leads,
       * because it is the part that says what happened; the body gets what is
       * left. sendCompanySms truncates at the provider's four-page ceiling as
       * a backstop.
       *
       * ── Why no action link ────────────────────────────────────────────────
       *
       * actionUrl points into the application behind a sign-in. In a text it
       * costs most of a page and lands somebody on a login screen with no idea
       * what they were meant to do. The in-app row and the email both carry it
       * properly, and those are the routes that can.
       *
       * ── Why a missing phone number is silence, not an error ───────────────
       *
       * Most users have no phone on file. An event configured to include SMS
       * would otherwise log a failure for every one of them, which is how a
       * log stops being read.
       */
      const line = [title, body].filter(Boolean).join(': ');
      result.sms = await sendCompanySms(sequelize, {
        companyId: scope,
        to: user.phone,
        body: line,
        reference: type ? `${type}-${userId}` : undefined,
      }).catch((error) => {
        // Belt and braces: sendCompanySms already promises not to throw.
        console.error('[notify] sms failed:', error.message);
        return { ok: false, skipped: false, reason: error.message };
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
