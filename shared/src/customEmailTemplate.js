/**
 * A company's own HTML email design.
 *
 * Optional: a company that has not uploaded one sends in the default design,
 * and one that has picks it per message on the Send tab. The design is the
 * whole email; placeholders mark where the message and its details go.
 *
 *   {{title}}          the message title (also the subject)
 *   {{message}}        the message itself — required, or the email says nothing
 *   {{name}}           the recipient's full name
 *   {{first_name}}     the recipient's first name
 *   {{company_name}}   the sender's name as branded
 *   {{logo_url}}       the brand logo's address (empty when there is none)
 *   {{primary_color}}  the brand colour, e.g. #2563eb
 *   {{support_email}}  the brand's contact address
 *   {{year}}           the current year
 *
 * Every value is HTML-escaped on the way in: a client called <b>Ada</b> gets
 * her name printed, not bold. {{message}} keeps its line breaks.
 */

/** Large enough for any real email design, small enough not to be a file store. */
const MAX_TEMPLATE_BYTES = 512 * 1024;

const PLACEHOLDERS = ['title', 'message', 'name', 'first_name', 'company_name', 'logo_url', 'primary_color', 'support_email', 'year'];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const placeholderRe = (key) => new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');

const invalid = (message) => Object.assign(new Error(message), { status: 422 });

/**
 * Cleans an uploaded design and checks it can carry a message.
 *
 * Scripts, inline event handlers and javascript: links are removed rather than
 * rejected: mail clients ignore them anyway, and a designer's export often
 * includes some. They are removed because the design is also previewed inside
 * this application.
 */
const prepareTemplateHtml = (html) => {
  const source = String(html ?? '');
  if (!source.trim()) throw invalid('The email design is empty.');
  if (Buffer.byteLength(source, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw invalid(`The email design is larger than ${MAX_TEMPLATE_BYTES / 1024} KB. Host its images elsewhere and link to them.`);
  }
  const cleaned = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  if (!placeholderRe('message').test(cleaned)) {
    throw invalid('The email design must contain {{message}} where the message should appear.');
  }
  return cleaned;
};

/** Fills a design for one recipient. */
const renderCustomEmail = (html, { title, message, name, brand = {} }) => {
  const messageHtml = String(message ?? '')
    .split(/\n{2,}/)
    .map((para) => esc(para).replace(/\n/g, '<br/>'))
    .join('<br/><br/>');
  const values = {
    title: esc(title),
    message: messageHtml,
    name: esc(name),
    first_name: esc(String(name ?? '').trim().split(/\s+/)[0] || ''),
    company_name: esc(brand.name),
    logo_url: esc(brand.logo || ''),
    primary_color: esc(brand.primaryColor || '#2563eb'),
    support_email: esc(brand.supportEmail || ''),
    year: esc(brand.year || new Date().getFullYear()),
  };
  return PLACEHOLDERS.reduce((out, key) => out.replace(placeholderRe(key), () => values[key]), String(html ?? ''));
};

module.exports = { prepareTemplateHtml, renderCustomEmail, PLACEHOLDERS, MAX_TEMPLATE_BYTES };
