const { QueryTypes } = require('sequelize');
const { brandFrom, renderNotificationEmail } = require('./emailTemplate');

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
    `SELECT \`key\`, \`value\`, company_id FROM settings
      WHERE \`group\` IN ('general', 'appearance', 'email')
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
    const nodemailer = require('nodemailer');
    // Without explicit timeouts nodemailer waits 2min to connect and 10min on a
    // stalled socket. Nothing here awaits the send, but an unreachable SMTP host
    // would otherwise pin a connection for ten minutes per notification.
    const transporter = nodemailer.createTransport({
      host, port, secure: port === 465, auth: { user, pass },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    });
    const fromName = cfg.mail_from_name || cfg.app_name || 'Realto';
    const fromAddress = cfg.mail_from_address || 'noreply@realto.app';
    const { text, html } = renderNotificationEmail(brandFrom(cfg), {
      title: subject, body, actionLabel, actionUrl,
    });
    await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      subject,
      text,
      html,
    });
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
 */
const notifyUser = async ({ userId, title, body, type, data = null, companyId = null, actionLabel = null, actionUrl = null }) => {
  const result = { inApp: false, email: false };
  try {
    const user = await getUser(userId);
    if (!user) return result;

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

    if (user.email) {
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
 * Resolves the realtor responsible for a client.
 *
 * Prefers users.realtor_id — the first-class link. Falls back to the CRM lead
 * (a lead matching the client's email, assigned to a realtor) for accounts that
 * predate the column, and only when exactly ONE lead matches: an ambiguous
 * result notifies nobody rather than risk disclosing a client's purchase to an
 * unrelated realtor.
 */
const findRealtorForClient = async ({ email, companyId, userId = null }) => {
  if (!email && !userId) return null;
  try {
    const direct = await sequelize.query(
      `SELECT u.realtor_id
         FROM users u
         JOIN users r ON r.id = u.realtor_id AND r.type = 'realtor' AND r.deleted_at IS NULL
        WHERE u.deleted_at IS NULL AND u.realtor_id IS NOT NULL
          AND ${userId ? 'u.id = :userId' : 'LOWER(TRIM(u.email)) = LOWER(TRIM(:email))'}
        LIMIT 1`,
      { replacements: { email: email ?? null, userId }, type: QueryTypes.SELECT },
    );
    if (direct.length) return direct[0].realtor_id;
    if (!email) return null;

    const rows = await sequelize.query(
      `SELECT DISTINCT l.assigned_to AS realtor_id
         FROM leads l
         JOIN users u ON u.id = l.assigned_to AND u.type = 'realtor' AND u.deleted_at IS NULL
        WHERE LOWER(TRIM(l.email)) = LOWER(TRIM(:email))
          AND l.assigned_to IS NOT NULL
          ${companyId ? 'AND l.company_id = :companyId' : ''}
        LIMIT 2`,
      { replacements: { email, companyId }, type: QueryTypes.SELECT },
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
