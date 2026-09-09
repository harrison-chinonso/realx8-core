/**
 * Branded HTML wrapper for notification emails sent by the shared notifier.
 *
 * The transactional templates (welcome, OTP, 2FA) live in each service's
 * utils/emailTemplates.js. Those are owned by services that already have a
 * models/ connection; shared/ has neither, so it carries just the one layout it
 * needs here. Keep the markup in step with each service's emailTemplates.js —
 * a reader should not be able to tell which module produced a given email.
 */

/** Maps merged settings rows onto the same brand shape getBranding() returns. */
const brandFrom = (cfg = {}) => ({
  name:           cfg.app_name || cfg.site_name || 'Realto',
  logo:           cfg.app_logo || null,
  primaryColor:   cfg.primary_color || '#2563eb',
  supportEmail:   cfg.site_email || null,
  year:           new Date().getFullYear(),
});

// Emails are assembled as HTML strings, so anything originating from user input
// (a realtor's name, an admin's review note) must be escaped or a stray angle
// bracket silently breaks the layout.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const layout = (brand, bodyContent) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(brand.name)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="background-color:${esc(brand.primaryColor)};border-radius:12px 12px 0 0;padding:28px 32px;">
              ${brand.logo
                ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}" style="max-height:48px;max-width:180px;object-fit:contain;" />`
                : `<span style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${esc(brand.name)}</span>`}
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;padding:40px 40px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td align="center" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px 32px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                &copy; ${brand.year} ${esc(brand.name)}. All rights reserved.
                ${brand.supportEmail
                  ? `<br/>Questions? <a href="mailto:${esc(brand.supportEmail)}" style="color:${esc(brand.primaryColor)};text-decoration:none;">${esc(brand.supportEmail)}</a>`
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
</html>`;

/**
 * Renders one notification as { text, html }. `body` may contain \n\n paragraph
 * breaks; the plain-text part is kept because some clients never render HTML.
 */
const renderNotificationEmail = (brand, { title, body, actionLabel = null, actionUrl = null }) => {
  const paragraphs = String(body || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((para) => `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">${esc(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  const cta = actionLabel && actionUrl
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
        <tr>
          <td align="center" style="background-color:${esc(brand.primaryColor)};border-radius:8px;">
            <a href="${esc(actionUrl)}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(actionLabel)}</a>
          </td>
        </tr>
      </table>`
    : '';

  return {
    text: `${title}\n\n${body}${actionLabel && actionUrl ? `\n\n${actionLabel}: ${actionUrl}` : ''}`,
    html: layout(brand, `
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">${esc(title)}</h1>
      ${paragraphs}
      ${cta}
    `),
  };
};

module.exports = { brandFrom, renderNotificationEmail, esc };