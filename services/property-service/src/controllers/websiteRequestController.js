const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, WebsiteRequest } = require('../models');
const { likeOperator } = require('../../../../shared/src/dialect');
const { brandForCompany } = require('../../../../shared/src/companySettings');
const { loadSettingsGroup } = require('../../../../shared/src/appearanceSettings');
const { renderNotificationEmail } = require('../../../../shared/src/emailTemplate');
const { sendMail } = require('../../../../shared/src/mailTransport');

/**
 * Requests from the public website (realx8.net): onboarding requests from the
 * form, and onboarding requests or enquiries the website assistant raises on
 * someone's behalf. Platform admins follow them up in the app.
 */

const KINDS = ['onboarding', 'enquiry'];
const SOURCES = ['form', 'assistant'];
const STATUSES = ['new', 'contacted', 'onboarded', 'closed'];
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const clean = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};
const cleanBlock = (value, max) => {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, max) : null;
};
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.clientIp || req.ip || null;

const referenceFor = (row) => `RX-${new Date(row.createdAt || Date.now()).getFullYear()}-${String(row.id).padStart(4, '0')}`;

/** Where new requests are announced: the platform's support inbox. */
const teamInbox = async (brand) => {
  const support = await loadSettingsGroup(sequelize, 'support', null).catch(() => ({}));
  return String(support.support_email || brand.supportEmail || process.env.SUPER_ADMIN_EMAIL || '').trim() || null;
};

const mail = async (brand, message) => {
  const { _smtpHost: host, _smtpPort: port, _smtpUser: user, _smtpPass: pass } = brand;
  const from = brand.fromName ? `"${brand.fromName}" <${brand.fromAddress}>` : brand.fromAddress;
  return sendMail({ host, port: Number(port || 587), user, pass, label: 'website', message: { from, ...message } })
    .catch((error) => ({ sent: false, reason: error.message }));
};

/**
 * Tells the team, and gives the person a copy with their reference. Neither
 * blocks the reply: the request is stored either way, and the admin page is
 * the record, not the inbox.
 */
const announce = async (row) => {
  const { brand } = await brandForCompany(sequelize, null);
  const lines = [
    `Reference: ${row.reference}`,
    `Type: ${row.kind === 'enquiry' ? 'Enquiry' : 'Onboarding request'} (from the website ${row.source === 'assistant' ? 'assistant' : 'form'})`,
    row.company_name && `Company: ${row.company_name}`,
    `Name: ${row.contact_name}`,
    `Email: ${row.email}`,
    row.phone && `Phone: ${row.phone}`,
    row.business_type && `Business: ${row.business_type}`,
    row.realtor_count && `Realtors: ${row.realtor_count}`,
    row.interests && `Interested in: ${row.interests}`,
  ].filter(Boolean).join('\n');
  const adminUrl = `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/superior/website-requests`;

  const inbox = await teamInbox(brand);
  if (inbox) {
    const email = renderNotificationEmail(brand, {
      title: `New ${row.kind === 'enquiry' ? 'enquiry' : 'onboarding request'}: ${row.company_name || row.contact_name}`,
      body: `${lines}${row.message ? `\n\n${row.message}` : ''}`,
      actionLabel: process.env.FRONTEND_URL ? 'Open website requests' : null,
      actionUrl: process.env.FRONTEND_URL ? adminUrl : null,
    });
    await mail(brand, { to: inbox, replyTo: row.email, subject: `[${row.reference}] New website ${row.kind}`, ...email });
  }

  const ack = renderNotificationEmail(brand, {
    title: 'We have your request',
    body: `Hello ${row.contact_name},\n\nThank you for contacting ${brand.name}. Your reference is ${row.reference}. Our team will get back to you shortly.\n\n${lines}`,
  });
  await mail(brand, { to: row.email, subject: `Your request ${row.reference}`, ...ack });
};

/** POST /public/website/requests — from the website form or its assistant. */
const submit = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // A field people never see. Bots fill every field; a filled one is a bot.
  // Answered like a success so it learns nothing.
  if (String(body.website || '').trim()) {
    return res.status(201).json({ data: { reference: null } });
  }

  const kind = KINDS.includes(body.kind) ? body.kind : 'onboarding';
  const source = SOURCES.includes(body.source) ? body.source : 'form';
  const record = {
    kind,
    source,
    company_name: clean(body.company_name, 160),
    contact_name: clean(body.contact_name, 120),
    email: clean(body.email, 160)?.toLowerCase() || null,
    phone: clean(body.phone, 40),
    business_type: clean(body.business_type, 60),
    realtor_count: clean(body.realtor_count, 40),
    interests: Array.isArray(body.interests)
      ? body.interests.map((i) => clean(i, 60)).filter(Boolean).slice(0, 15).join(', ').slice(0, 500) || null
      : clean(body.interests, 500),
    message: cleanBlock(body.message, 4000),
    ip_address: clean(clientIp(req), 64),
    user_agent: clean(req.headers['user-agent'], 255),
  };

  const problems = [];
  if (!record.contact_name) problems.push('your name');
  if (!record.email || !EMAIL_RE.test(record.email)) problems.push('a valid email address');
  if (kind === 'onboarding' && !record.company_name) problems.push('your company name');
  if (kind === 'onboarding' && !record.phone) problems.push('a phone number');
  if (kind === 'enquiry' && !record.message) problems.push('your question');
  if (problems.length) {
    return res.status(422).json({ message: `Please add ${problems.join(', ')}.` });
  }

  const row = await WebsiteRequest.create(record);
  await row.update({ reference: referenceFor(row) });

  announce(row).catch((error) => console.error('[website] request emails failed:', error.message));

  return res.status(201).json({ data: { reference: row.reference } });
});

/** Platform administrators only. */
const requireSuperiorAdmin = (req, res, next) => (req.user?.isSuperiorAdmin
  ? next()
  : res.status(403).json({ message: 'Only platform administrators can see website requests.' }));

/** GET /website-requests?status=&kind=&search=&page=&limit= */
const list = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const where = {};
  if (STATUSES.includes(req.query.status)) where.status = req.query.status;
  if (KINDS.includes(req.query.kind)) where.kind = req.query.kind;
  const search = clean(req.query.search, 100);
  if (search) {
    const like = likeOperator(sequelize);
    where[Op.or] = ['company_name', 'contact_name', 'email', 'reference', 'phone']
      .map((field) => ({ [field]: { [like]: `%${search}%` } }));
  }
  const { rows, count } = await WebsiteRequest.findAndCountAll({
    where, order: [['id', 'DESC']], limit, offset: (page - 1) * limit,
    attributes: { exclude: ['user_agent'] },
  });
  const counts = await WebsiteRequest.count({ where: { status: 'new' } });
  res.json({
    data: rows,
    pagination: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
    new_count: counts,
  });
});

/** PATCH /website-requests/:id — status and notes. */
const update = asyncHandler(async (req, res) => {
  const row = await WebsiteRequest.findByPk(req.params.id);
  if (!row) return res.status(404).json({ message: 'Request not found.' });
  const patch = {};
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(422).json({ message: `Status must be one of: ${STATUSES.join(', ')}.` });
    patch.status = req.body.status;
  }
  if (req.body.admin_notes !== undefined) patch.admin_notes = cleanBlock(req.body.admin_notes, 4000);
  patch.handled_by = req.user?.id ?? null;
  await row.update(patch);
  res.json({ data: row });
});

module.exports = { submit, list, update, requireSuperiorAdmin, STATUSES };
