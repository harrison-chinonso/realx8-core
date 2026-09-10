const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { Company, User, Role, Permission, Setting, sequelize } = require('../models');
const { getBranding, templates } = require('../utils/emailTemplates');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const notifyDispatcher = createDispatcher(require('../config/database').sequelize);

const REFERRAL_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars

const REFERRAL_CODE_LENGTH = 5;

const generateReferralCode = async () => {
  const gen = () =>
    Array.from(crypto.randomBytes(REFERRAL_CODE_LENGTH))
      .map((b) => REFERRAL_CHARSET[b % REFERRAL_CHARSET.length])
      .join('');

  for (let i = 0; i < 20; i++) {
    const code = gen();
    const exists = await Company.findOne({ where: { referral_code: code } });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique referral code');
};

const SUPERIOR_ONLY_PERMISSIONS = [
  'companies.view',
  'companies.create',
  'companies.manage',
  'companies.delete',
  'platform.dashboard.view',
  'platform.users.view',
  'platform.settings.manage',
];

const isSuperiorAdmin = (req) => req.user?.isSuperiorAdmin === true || req.user?.type === 'superior_admin';

const sanitizeUser = (user) => {
  const json = user.toJSON ? user.toJSON() : { ...user };
  delete json.password;
  return json;
};

const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()_+-=';
  return Array.from(crypto.randomBytes(12)).map((byte) => chars[byte % chars.length]).join('').slice(0, 12);
};

const sendCredentialsEmail = async ({ company, user, password }) => {
  try {
    // Load branding — company-level overrides platform defaults
    const brand = await getBranding(company.id);

    const { subject, text, html } = templates.adminCredentials(brand, {
      companyName: company.name,
      adminName: user.name,
      email: user.email,
      password,
      loginUrl: process.env.FRONTEND_URL || null,
    });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: brand._smtpHost,
      port: Number(brand._smtpPort || 587),
      secure: Number(brand._smtpPort) === 465,
      auth: { user: brand._smtpUser, pass: brand._smtpPass },
      // nodemailer defaults are 2min connect / 30s greeting / 10min socket, so a
      // mail server that never answers wedges the request for minutes. Same caps
      // as auth-service, which fails fast instead.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
    const from = brand.fromName ? `"${brand.fromName}" <${brand.fromAddress}>` : brand.fromAddress;
    await transporter.sendMail({ from, to: user.email, subject, text, html });
    return;
  } catch (err) {
    console.error('[user-service] sendCredentialsEmail failed:', err.message);
  }

  console.log('\n================ COMPANY ADMIN CREDENTIALS ================');
  console.log(`Company: ${company.name} (#${company.id})`);
  console.log(`Admin: ${user.email}`);
  console.log(`Temporary Password: ${password}`);
  console.log('SMTP not configured. Share these credentials securely.');
  console.log('===========================================================\n');
};

const getAssignablePermissions = async () => Permission.findAll({
  where: {
    name: { [Op.notIn]: SUPERIOR_ONLY_PERMISSIONS },
  },
});

const listCompanies = asyncHandler(async (_req, res) => {
  const companies = await Company.findAll({ order: [['id', 'DESC']] });
  res.json({ data: companies });
});

const getCompany = asyncHandler(async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }
  res.json({ data: company });
});

const generateSlug = async (name) => {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Ensure uniqueness
  let slug = base;
  let suffix = 0;
  while (await Company.findOne({ where: { slug } })) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
};

const createCompany = asyncHandler(async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const {
      name,
      email,
      phone,
      address,
      logo_url,
      status,
      plan,
      admin_first_name,
      admin_last_name,
      admin_email,
      // legacy aliases kept for backwards compat
      contactName,
      adminEmail,
    } = req.body;

    const slug = await generateSlug(name);
    const resolvedContactName = [admin_first_name, admin_last_name].filter(Boolean).join(' ') || contactName || 'Admin';
    const resolvedAdminEmail = admin_email || adminEmail;

    const referral_code = await generateReferralCode();

    const company = await Company.create({
      name,
      slug,
      email,
      phone,
      address,
      logo_url,
      status: status || 'active',
      plan: plan || 'standard',
      referral_code,
    }, { transaction });

    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const user = await User.create({
      name: resolvedContactName,
      email: resolvedAdminEmail,
      password: hashedPassword,
      type: 'super_admin',
      company_id: company.id,
      is_active: true,
    }, { transaction });

    const [superAdminRole] = await Role.findOrCreate({
      where: { name: 'super_admin' },
      defaults: {
        name: 'super_admin',
        display_name: 'Super Admin',
        description: 'Company-wide administrative access',
        guard_name: 'api',
        company_id: company.id,
      },
      transaction,
    });

    await user.addRole(superAdminRole, { transaction });

    const permissions = await getAssignablePermissions();
    await superAdminRole.setPermissions(permissions, { transaction });

    await transaction.commit();

    /**
     * A platform-level event: company_id is null on it, so it reaches holders
     * of companies.view among the PLATFORM users rather than inside the new
     * company, which has no staff yet.
     */
    notifyDispatcher.dispatch({
      eventKey: 'company_created',
      companyId: null,
      title: () => 'New company created',
      body: () => `"${company.name}" has been added to the platform.`,
      data: { company_id: company.id },
    }).catch(() => {});
    await sendCredentialsEmail({ company, user, password: plainPassword });

    res.status(201).json({
      data: {
        company,
        user: sanitizeUser(user),
      },
    });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
});

const checkReferralCode = asyncHandler(async (req, res) => {
  const { code, exclude_id } = req.query;
  if (!code) return res.status(400).json({ message: 'code is required' });

  const normalized = String(code).trim().toUpperCase();
  const where = { referral_code: normalized };
  if (exclude_id) where.id = { [Op.ne]: Number(exclude_id) };

  const exists = await Company.findOne({ where });
  res.json({ available: !exists, code: normalized });
});

const updateCompany = asyncHandler(async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }

  await company.update(req.body);
  res.json({ data: company });
});

const deleteCompany = asyncHandler(async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }

  await company.update({ status: 'suspended' });
  res.json({ message: 'Company suspended successfully', data: company });
});

const listCompanyUsers = asyncHandler(async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }

  const users = await User.findAll({
    where: { company_id: company.id, deleted_at: null },
    attributes: { exclude: ['password', 'two_factor_secret'] },
    order: [['id', 'DESC']],
  });

  res.json({ data: users });
});

const getCompanyStats = asyncHandler(async (req, res) => {
  const company = await Company.findByPk(req.params.id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }

  const [totalUsers, activeUsers, adminUsers, settingsCount] = await Promise.all([
    User.count({ where: { company_id: company.id, deleted_at: null } }),
    User.count({ where: { company_id: company.id, deleted_at: null, is_active: true } }),
    User.count({ where: { company_id: company.id, deleted_at: null, type: 'super_admin' } }),
    Setting.count({ where: { company_id: company.id } }),
  ]);

  res.json({
    data: {
      companyId: company.id,
      totalUsers,
      activeUsers,
      adminUsers,
      settingsCount,
      status: company.status,
      plan: company.plan,
    },
  });
});

const getPlatformOverview = asyncHandler(async (_req, res) => {
  const [totalCompanies, activeCompanies, suspendedCompanies, totalUsers] = await Promise.all([
    Company.count(),
    Company.count({ where: { status: 'active' } }),
    Company.count({ where: { status: 'suspended' } }),
    User.count({ where: { deleted_at: null } }),
  ]);

  res.json({
    data: {
      totalCompanies,
      activeCompanies,
      suspendedCompanies,
      totalUsers,
      revenue: 0,
    },
  });
});

const getMyCompany = asyncHandler(async (req, res) => {
  if (!req.user?.company_id) {
    return res.json({ data: null });
  }

  const company = await Company.findByPk(req.user.company_id);
  if (!company) {
    return res.status(404).json({ message: 'Company not found' });
  }

  res.json({ data: company });
});

module.exports = {
  isSuperiorAdmin,
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  listCompanyUsers,
  getCompanyStats,
  getPlatformOverview,
  getMyCompany,
  checkReferralCode,
};
