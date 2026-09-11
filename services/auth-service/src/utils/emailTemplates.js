'use strict';

const { QueryTypes } = require('sequelize');
const { q } = require('../../../../shared/src/dialect');

// ── Branding loader ───────────────────────────────────────────────────────────
// Loads platform branding with optional company-level override.
const getBranding = async (companyId = null) => {
  try {
    const { sequelize } = require('../config/database');

    const conditions = companyId
      ? `${q(sequelize, 'group')} IN ('general', 'appearance', 'email') AND (company_id IS NULL OR company_id = ${Number(companyId)})`
      : `${q(sequelize, 'group')} IN ('general', 'appearance', 'email') AND company_id IS NULL`;

    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM settings WHERE ${conditions}`,
      { type: QueryTypes.SELECT }
    );

    // Merge: global first, company overrides on top
    const global = {};
    const company = {};
    rows.forEach((r) => {
      if (r.company_id === null || r.company_id === undefined) {
        global[r.key] = r.value;
      } else {
        company[r.key] = r.value;
      }
    });
    const cfg = { ...global, ...company };

    return {
      name:           cfg.app_name || cfg.site_name || 'Realto',
      logo:           cfg.app_logo || null,
      primaryColor:   cfg.primary_color || '#2563eb',
      secondaryColor: cfg.secondary_color || '#1e3a8a',
      fromName:       cfg.mail_from_name || cfg.app_name || cfg.site_name || 'Realto',
      fromAddress:    cfg.mail_from_address || 'noreply@realto.app',
      supportEmail:   cfg.site_email || null,
      year:           new Date().getFullYear(),
      // SMTP transport fields (used by services that manage their own transporter)
      _smtpHost:      cfg.mail_host || process.env.SMTP_HOST,
      _smtpPort:      cfg.mail_port || process.env.SMTP_PORT || 587,
      _smtpUser:      cfg.mail_username || process.env.SMTP_USER,
      _smtpPass:      cfg.mail_password || process.env.SMTP_PASS,
    };
  } catch {
    return {
      name: 'Realto', logo: null, primaryColor: '#2563eb', secondaryColor: '#1e3a8a',
      fromName: 'Realto', fromAddress: 'noreply@realto.app', supportEmail: null,
      year: new Date().getFullYear(),
    };
  }
};

// ── Base layout wrapper ───────────────────────────────────────────────────────
const layout = (brand, bodyContent) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${brand.name}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

          <!-- Header -->
          <tr>
            <td align="center" style="background-color:${brand.primaryColor};border-radius:12px 12px 0 0;padding:28px 32px;">
              ${brand.logo
                ? `<img src="${brand.logo}" alt="${brand.name}" style="max-height:48px;max-width:180px;object-fit:contain;" />`
                : `<span style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${brand.name}</span>`
              }
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:40px 40px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px 32px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                &copy; ${brand.year} ${brand.name}. All rights reserved.
                ${brand.supportEmail
                  ? `<br/>Questions? <a href="mailto:${brand.supportEmail}" style="color:${brand.primaryColor};text-decoration:none;">${brand.supportEmail}</a>`
                  : ''}
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:#d1d5db;">
                This is an automated message. Please do not reply directly to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// ── Shared styles ─────────────────────────────────────────────────────────────
const h1 = (brand, text) =>
  `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">${text}</h1>`;

const p = (text, style = '') =>
  `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;${style}">${text}</p>`;

const button = (brand, href, text) =>
  `<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td align="center" style="background-color:${brand.primaryColor};border-radius:8px;">
        <a href="${href}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${text}</a>
      </td>
    </tr>
  </table>`;

const divider = () =>
  `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />`;

const otpBox = (brand, otp) =>
  `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;">
    <tr>
      <td align="center" style="background-color:#f9fafb;border:2px dashed ${brand.primaryColor};border-radius:10px;padding:20px;">
        <span style="font-size:36px;font-weight:800;letter-spacing:14px;color:${brand.primaryColor};font-family:monospace;">${otp}</span>
      </td>
    </tr>
  </table>`;

const infoRow = (label, value, brand) =>
  `<tr>
    <td style="padding:8px 12px;font-size:13px;color:#6b7280;border-bottom:1px solid #f3f4f6;width:40%;">${label}</td>
    <td style="padding:8px 12px;font-size:13px;color:#111827;font-weight:600;border-bottom:1px solid #f3f4f6;">${value}</td>
  </tr>`;

// ── Templates ─────────────────────────────────────────────────────────────────

/**
 * Password reset OTP email.
 */
const passwordResetOtp = (brand, { otp, expiryMinutes = 10 }) => ({
  subject: `Your ${brand.name} password reset code`,
  text: `Your ${brand.name} password reset code is: ${otp}\n\nThis code expires in ${expiryMinutes} minutes.\n\nIf you did not request a password reset, you can safely ignore this email.`,
  html: layout(brand, `
    ${h1(brand, 'Reset your password')}
    ${p('We received a request to reset the password for your account. Use the code below to proceed:')}
    ${otpBox(brand, otp)}
    ${p(`<span style="color:#6b7280;font-size:13px;">&#9203; This code expires in <strong>${expiryMinutes} minutes</strong>.</span>`)}
    ${divider()}
    ${p('If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.', 'color:#9ca3af;font-size:13px;')}
  `),
});

/**
 * Welcome email sent after successful registration.
 */
const welcomeEmail = (brand, { name, email, loginUrl = null }) => ({
  subject: `Welcome to ${brand.name}!`,
  text: `Hi ${name},\n\nWelcome to ${brand.name}! Your account has been created with email: ${email}.\n\nYou can now sign in and get started.\n\n— The ${brand.name} Team`,
  html: layout(brand, `
    ${h1(brand, `Welcome to ${brand.name}! 🎉`)}
    ${p(`Hi <strong>${name}</strong>,`)}
    ${p(`Your account has been successfully created. Here's what you need to know to get started:`)}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tbody>
        ${infoRow('Email', email, brand)}
        ${infoRow('Platform', brand.name, brand)}
      </tbody>
    </table>
    ${loginUrl ? button(brand, loginUrl, 'Sign In to Your Account') : ''}
    ${divider()}
    ${p('If you have any questions, feel free to reach out to our support team.', 'color:#9ca3af;font-size:13px;')}
  `),
});

/**
 * Company admin credentials email (sent when a new company is created).
 */
const adminCredentials = (brand, { companyName, adminName, email, password, loginUrl = null }) => ({
  subject: `Your ${companyName} admin account on ${brand.name}`,
  text: `Hi ${adminName},\n\nYour company ${companyName} has been set up on ${brand.name}.\n\nLogin email: ${email}\nTemporary password: ${password}\n\nPlease sign in and change your password immediately.\n\n— The ${brand.name} Team`,
  html: layout(brand, `
    ${h1(brand, 'Your admin account is ready')}
    ${p(`Hi <strong>${adminName}</strong>,`)}
    ${p(`Your company <strong>${companyName}</strong> has been successfully set up on <strong>${brand.name}</strong>. Below are your login credentials:`)}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tbody>
        ${infoRow('Company', companyName, brand)}
        ${infoRow('Login Email', email, brand)}
        ${infoRow('Temporary Password', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px;">${password}</span>`, brand)}
      </tbody>
    </table>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">
      <tr>
        <td style="background-color:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#92400e;">
            &#9888;&#65039; <strong>Important:</strong> Please sign in and change your password immediately. Do not share these credentials with anyone.
          </p>
        </td>
      </tr>
    </table>
    ${loginUrl ? button(brand, loginUrl, 'Sign In Now') : ''}
    ${divider()}
    ${p('If you did not expect this email, please contact support immediately.', 'color:#9ca3af;font-size:13px;')}
  `),
});

/**
 * 2FA enabled notification.
 */
const twoFactorEnabled = (brand, { name }) => ({
  subject: `Two-factor authentication enabled — ${brand.name}`,
  text: `Hi ${name},\n\nTwo-factor authentication has been successfully enabled on your ${brand.name} account. You will now be required to enter a verification code each time you sign in.\n\nIf you did not make this change, please contact support immediately.\n\n— The ${brand.name} Team`,
  html: layout(brand, `
    ${h1(brand, 'Two-factor authentication enabled')}
    ${p(`Hi <strong>${name}</strong>,`)}
    ${p('Two-factor authentication (2FA) has been successfully enabled on your account. Your account is now more secure.')}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">
      <tr>
        <td style="background-color:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:14px 18px;">
          <p style="margin:0;font-size:14px;color:#065f46;">
            &#9989; <strong>2FA is now active.</strong> You'll need your authenticator app each time you sign in.
          </p>
        </td>
      </tr>
    </table>
    ${divider()}
    ${p('If you did not make this change, please contact support immediately and change your password.', 'color:#ef4444;font-size:13px;font-weight:600;')}
  `),
});

/**
 * 2FA disabled notification.
 */
const twoFactorDisabled = (brand, { name }) => ({
  subject: `Two-factor authentication disabled — ${brand.name}`,
  text: `Hi ${name},\n\nTwo-factor authentication has been disabled on your ${brand.name} account. You can now sign in with just your email and password.\n\nIf you did not make this change, please secure your account immediately.\n\n— The ${brand.name} Team`,
  html: layout(brand, `
    ${h1(brand, 'Two-factor authentication disabled')}
    ${p(`Hi <strong>${name}</strong>,`)}
    ${p('Two-factor authentication (2FA) has been disabled on your account. You can now sign in with just your email and password.')}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">
      <tr>
        <td style="background-color:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#9a3412;">
            &#9888;&#65039; <strong>Security notice:</strong> If you did not make this change, your account may be compromised. Please change your password immediately.
          </p>
        </td>
      </tr>
    </table>
    ${divider()}
    ${p('You can re-enable 2FA at any time from your Security settings.', 'color:#9ca3af;font-size:13px;')}
  `),
});

/**
 * Generic notification email.
 */
const notification = (brand, { title, message, actionLabel = null, actionUrl = null }) => ({
  subject: `${title} — ${brand.name}`,
  text: `${title}\n\n${message}${actionLabel && actionUrl ? `\n\n${actionLabel}: ${actionUrl}` : ''}\n\n— The ${brand.name} Team`,
  html: layout(brand, `
    ${h1(brand, title)}
    ${p(message)}
    ${actionLabel && actionUrl ? button(brand, actionUrl, actionLabel) : ''}
  `),
});

module.exports = {
  getBranding,
  templates: {
    passwordResetOtp,
    welcomeEmail,
    adminCredentials,
    twoFactorEnabled,
    twoFactorDisabled,
    notification,
  },
};
