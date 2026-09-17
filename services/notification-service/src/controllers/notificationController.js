const asyncHandler = require('../utils/asyncHandler');
const { buildCrudController, buildCompanyScope, withCompanyAudit } = require('../utils/crudFactory');
const { NotificationTemplate, Notification, EmailLog, sequelize } = require('../models');
const { QueryTypes } = require('sequelize');
const { sendMail } = require('../../../../shared/src/mailTransport');
const { getBranding, templates: emailTemplates } = require('../utils/emailTemplates');

const companyScope = (req) => buildCompanyScope(req);

// ── SMTP mailer (reads config from settings DB) ───────────────────────────────
const sendEmailViaSMTP = async ({ to, toName, subject, text, html, companyId = null }) => {
  const brand = await getBranding(companyId);
  const { _smtpHost: host, _smtpPort: port, _smtpUser: user, _smtpPass: pass } = brand;

  if (!host || !user || !pass) {
    console.log(`[notification] SMTP not configured — email to ${to} not sent (no SMTP settings)`);
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    const from = brand.fromName ? `"${brand.fromName}" <${brand.fromAddress}>` : brand.fromAddress;
    /**
     * The shared transport owns the timeouts and the port fallback, so a
     * network that blocks the configured port does not silently stop
     * notifications — see shared/src/mailTransport.js.
     */
    const info = await sendMail({
      host, port: Number(port || 587), user, pass, label: 'notification',
      message: { from, to: toName ? `"${toName}" <${to}>` : to, subject, text, html },
    });
    if (!info.sent) return { sent: false, reason: info.reason };
    console.log(`[notification] Email sent to ${to} via port ${info.port}: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[notification] Failed to send email to ${to}:`, err.message);
    return { sent: false, reason: err.message };
  }
};

// Fetch user rows from the shared DB by IDs
const fetchUsersByIds = async (ids) => {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return sequelize.query(
    `SELECT id, name, email, company_id FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    { replacements: ids, type: QueryTypes.SELECT }
  );
};

/**
 * Narrows a caller-supplied list of user ids to the ones they may notify.
 *
 * These endpoints take user ids straight from the request body. Without this a
 * company admin could post any id and both write an in-app notification to, and
 * EMAIL, a user at another company — the row would be stamped with the sender's
 * company_id while being delivered outside it.
 *
 * A superior admin is exempt: they are platform-wide, and messaging across
 * companies is the job.
 *
 * Ids that do not resolve, or resolve outside the caller's company, are dropped
 * rather than rejected — a bulk send to fifty people should not fail wholesale
 * because one has since been deleted. The response reports the difference so a
 * silent drop is still visible.
 */
const notifiableUserIds = async (req, ids) => {
  const requested = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!requested.length) return { allowed: [], rejected: [] };
  if (req.user?.isSuperiorAdmin) return { allowed: requested, rejected: [] };

  const companyId = req.user?.company_id ?? null;
  const rows = await sequelize.query(
    `SELECT id FROM users
      WHERE id IN (:ids) AND deleted_at IS NULL
        AND company_id ${companyId ? '= :companyId' : 'IS NULL'}`,
    { replacements: { ids: requested, companyId }, type: QueryTypes.SELECT },
  );
  const allowed = rows.map((row) => Number(row.id));
  return { allowed, rejected: requested.filter((id) => !allowed.includes(id)) };
};

const templateCrud = buildCrudController(NotificationTemplate, {
  searchFields: ['name', 'type'],
  defaultWhere: companyScope,
  scopeWhere: companyScope,
  beforeCreate: (req) => withCompanyAudit(req),
});

const listNotifications = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.query.user_id;
  const rows = await Notification.findAll({ where: { user_id: userId, ...companyScope(req) }, order: [['id', 'DESC']] });
  res.json({ data: rows });
});

const markRead = asyncHandler(async (req, res) => {
  // user_id as well as company: a notification is addressed to one person, and
  // company scope alone let anybody in the company mark anybody else's as read
  // — a write on a row that was never theirs, and one the owner would see only
  // as their unread count quietly dropping.
  const notification = await Notification.findOne({
    where: { id: req.params.id, user_id: req.user.id, ...companyScope(req) },
  });
  if (!notification) return res.status(404).json({ message: 'Notification not found' });
  await notification.update({ is_read: true });
  res.json({ data: notification });
});

const markAllRead = asyncHandler(async (req, res) => {
  await Notification.update({ is_read: true }, { where: { user_id: req.user.id, ...companyScope(req) } });
  res.json({ message: 'All notifications marked as read' });
});

const sendNotification = asyncHandler(async (req, res) => {
  // The target is whatever the body named, so it has to be checked against the
  // caller's company before anything is written.
  const { allowed } = await notifiableUserIds(req, [req.body.user_id]);
  if (!allowed.length) {
    return res.status(403).json({
      message: 'You can only notify users in your own company.',
    });
  }
  const notification = await Notification.create(withCompanyAudit(req));
  res.status(201).json({ data: notification });
});

// ── Send a real email (single recipient, also logs to EmailLog) ───────────────
const sendEmail = asyncHandler(async (req, res) => {
  const audit = withCompanyAudit(req, req.body);
  const companyId = audit.company_id ?? null;
  const { to, subject, body: msgBody } = req.body;

  // Send the actual email
  const brand = await getBranding(companyId);
  const { html, text } = emailTemplates.notification(brand, { title: subject, message: msgBody });
  const result = await sendEmailViaSMTP({ to, subject, text, html, companyId });

  // Log it
  const log = await EmailLog.create({
    to,
    subject,
    body: msgBody,
    status: result.sent ? 'sent' : 'failed',
    error: result.sent ? null : result.reason,
    ...(companyId != null ? { company_id: companyId } : {}),
  });

  if (!result.sent) {
    return res.status(502).json({ message: `Email could not be delivered: ${result.reason}`, data: log });
  }
  res.status(201).json({ message: 'Email sent successfully', data: log });
});

// ── Send bulk in-app notifications + email each recipient ─────────────────────
const sendBulk = asyncHandler(async (req, res) => {
  const { user_ids, title, body, type, data } = req.body;
  if (!Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ message: 'user_ids must be a non-empty array' });
  }

  const sent_by = req.user?.id || null;
  const audit = withCompanyAudit(req, req.body);
  const companyId = audit.company_id ?? null;

  // Same check as the single send: ids come from the body, so they are narrowed
  // to the caller's own company before anything is written or emailed.
  const { allowed, rejected } = await notifiableUserIds(req, user_ids);
  if (!allowed.length) {
    return res.status(403).json({
      message: 'None of those users are in your company.',
    });
  }

  // 1. Create in-app notification records
  const records = allowed.map((uid) => ({
    user_id: uid,
    sent_by,
    title,
    body,
    type,
    data: data || null,
    is_read: false,
    ...(companyId != null ? { company_id: companyId } : {}),
  }));
  const notifications = await Notification.bulkCreate(records);

  // 2. Fetch user emails and send actual emails (fire-and-forget, don't block response)
  const emailResults = { sent: 0, failed: 0, errors: [] };
  try {
    // `allowed`, not the raw request list: this is the path that actually sends
    // mail, so an unfiltered list here would email users at other companies
    // even with the in-app rows correctly narrowed.
    const users = await fetchUsersByIds(allowed);
    const brand = await getBranding(companyId);
    const { subject, text, html } = emailTemplates.notification(brand, {
      title,
      message: body,
    });

    await Promise.allSettled(
      users
        .filter((u) => u.email)
        .map(async (u) => {
          const result = await sendEmailViaSMTP({
            to: u.email,
            toName: u.name,
            subject,
            text,
            html,
            companyId: u.company_id ?? companyId,
          });

          // Log each email
          await EmailLog.create({
            to: u.email,
            subject,
            body,
            status: result.sent ? 'sent' : 'failed',
            error: result.sent ? null : result.reason,
            ...(companyId != null ? { company_id: companyId } : {}),
          }).catch(() => {});

          if (result.sent) emailResults.sent++;
          else { emailResults.failed++; emailResults.errors.push(`${u.email}: ${result.reason}`); }
        })
    );
  } catch (err) {
    console.error('[notification] sendBulk email pass failed:', err.message);
  }

  console.log(`[notification] sendBulk: ${notifications.length} in-app | email sent: ${emailResults.sent}, failed: ${emailResults.failed}`);

  res.status(201).json({
    data: notifications,
    count: notifications.length,
    // Reported rather than silently dropped: a caller who asked for fifty
    // recipients and reached forty needs to know which ten were outside their
    // company or no longer exist.
    ...(rejected.length ? { skipped_user_ids: rejected } : {}),
    email: {
      sent: emailResults.sent,
      failed: emailResults.failed,
      ...(emailResults.errors.length ? { errors: emailResults.errors } : {}),
    },
  });
});

const listSent = asyncHandler(async (req, res) => {
  const sent_by = req.user?.id;
  const rows = await Notification.findAll({
    where: { sent_by, ...companyScope(req) },
    attributes: ['id', 'title', 'body', 'type', 'user_id', 'createdAt'],
    order: [['id', 'DESC']],
    limit: 200,
  });
  const grouped = [];
  const seen = new Set();
  rows.forEach((r) => {
    const key = `${r.title}||${r.body}||${r.type}||${r.createdAt}`;
    if (!seen.has(key)) {
      seen.add(key);
      grouped.push({ title: r.title, body: r.body, type: r.type, createdAt: r.createdAt, recipientCount: 0 });
    }
    grouped.find((g) => `${g.title}||${g.body}||${g.type}||${g.createdAt}` === key).recipientCount++;
  });
  res.json({ data: grouped });
});

module.exports = { templateCrud, listNotifications, markRead, markAllRead, sendNotification, sendBulk, listSent, sendEmail };
