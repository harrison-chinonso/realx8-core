/**
 * cloudinaryService.js
 *
 * Cloudinary upload utility. Credentials are loaded from the `settings` table
 * (group = 'system') with fallback to environment variables.
 *
 * Required DB keys: cloudinary_cloud_name, cloudinary_api_key, cloudinary_api_secret
 */

const cloudinary = require('cloudinary').v2;
const { QueryTypes } = require('sequelize');
const { q } = require('../../../../shared/src/dialect');

/**
 * ── Credentials are resolved per company ─────────────────────────────────────
 *
 * This used to select every `system` cloudinary row in the table with no
 * company filter at all, then fold them into one map where the last row won.
 * Two things followed from that, and only the second was reported:
 *
 *   a company that had never configured Cloudinary could end up uploading with
 *   ANOTHER company's credentials, because that company's row happened to be
 *   read last — a cross-tenant leak of a paid account
 *
 *   a company that had saved BLANK values shadowed the platform-wide ones with
 *   empty strings, producing "Cloudinary credentials not configured" on a
 *   deployment that had perfectly good global credentials
 *
 * The rule is now the documented one, the same as SMTP: the company's own value
 * where it is set, the platform-wide value otherwise, and the environment last.
 * A blank counts as NOT SET at every tier, which is what makes the second case
 * fall through to the global instead of dying on an empty string.
 */
const CREDS_TTL = 5 * 60 * 1000;
const KEYS = ['cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret'];

/** Cached per company, because the answer differs per company. */
const cache = new Map();

/** A setting that is present but empty is not a credential. */
const present = (value) => typeof value === 'string' && value.trim() !== '';

const loadCreds = async (sequelize, companyId) => {
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')}, company_id FROM ${q(sequelize, 'settings')}
        WHERE ${q(sequelize, 'group')} = 'system' AND ${q(sequelize, 'key')} IN (:keys)
          AND (company_id IS NULL ${companyId == null ? '' : 'OR company_id = :companyId'})`,
      {
        replacements: { keys: KEYS, ...(companyId == null ? {} : { companyId }) },
        type: QueryTypes.SELECT,
      },
    );

    // Platform first, the company's own values layered on top — and only where
    // they actually carry something.
    const platform = {};
    const own = {};
    rows.forEach((row) => {
      if (!present(row.value)) return;
      if (row.company_id === null || row.company_id === undefined) platform[row.key] = row.value;
      else if (companyId != null && Number(row.company_id) === Number(companyId)) own[row.key] = row.value;
    });
    return { ...platform, ...own };
  } catch {
    return {};
  }
};

const getCreds = async (sequelize, companyId) => {
  const scope = companyId == null ? 'platform' : String(companyId);
  const hit = cache.get(scope);
  if (hit && Date.now() - hit.at < CREDS_TTL) return hit.creds;

  const settings = await loadCreds(sequelize, companyId);
  const creds = {
    cloud_name: settings.cloudinary_cloud_name || process.env.CLOUDINARY_CLOUD_NAME,
    api_key: settings.cloudinary_api_key || process.env.CLOUDINARY_API_KEY,
    api_secret: settings.cloudinary_api_secret || process.env.CLOUDINARY_API_SECRET,
  };
  cache.set(scope, { creds, at: Date.now() });
  return creds;
};

/**
 * Force immediate cache flush after credentials are saved.
 *
 * Clears every scope rather than one: a platform-level save changes the
 * effective credentials of every company that inherits them, and the caller
 * does not always know which tier was written.
 */
const invalidateCredsCache = () => { cache.clear(); };

/**
 * Upload a file buffer or local path to Cloudinary.
 * @param {string} source   - local file path or data URI
 * @param {object} opts     - Cloudinary upload options (folder, resource_type, etc.)
 * @param {object} sequelize - Sequelize instance for DB credential lookup
 * @returns {object}        - { url, public_id, resource_type, width, height }
 */
const uploadToCloudinary = async (source, opts = {}, sequelize, companyId = null) => {
  const creds = await getCreds(sequelize, companyId);

  if (!creds.cloud_name || !creds.api_key || !creds.api_secret) {
    throw new Error(
      'Cloudinary credentials not configured. Add them in Settings → System Config, '
      + 'or set platform-wide credentials that every company inherits.',
    );
  }

  cloudinary.config(creds);

  /**
   * Documents go up as `raw`; everything else is auto-detected.
   *
   * `auto` classifies a PDF as an IMAGE, which puts it behind Cloudinary's
   * "Allow delivery of PDF and ZIP files" account setting — off by default.
   * The upload succeeds, the URL is stored, and every fetch of it returns 401.
   * Nothing in the app notices, because nothing re-reads what it uploaded: the
   * first person to find out is the buyer clicking a receipt that does not
   * open.
   *
   * Measured on this account: the same 615-byte PDF returns 401 under
   * `image/upload` and 200 with its bytes intact under `raw/upload`. Images are
   * unaffected and stay on `auto`, because they need Cloudinary's
   * transformations and are delivered fine.
   *
   * This fixes PDFs uploaded from now on. Ones already stored under
   * `image/upload` keep their existing URLs and stay unreachable until the
   * account setting is enabled — that part cannot be fixed from here.
   */
  const isDocument = /^data:application\/pdf/i.test(String(source))
    || /\.pdf(\?|$)/i.test(String(source));

  const result = await cloudinary.uploader.upload(source, {
    resource_type: isDocument ? 'raw' : 'auto', // 'auto' handles images AND videos
    folder: opts.folder || 'realto',
    ...opts,
  });

  return {
    url:           result.secure_url,
    public_id:     result.public_id,
    resource_type: result.resource_type,
    format:        result.format,
    width:         result.width,
    height:        result.height,
    bytes:         result.bytes,
    duration:      result.duration || null, // for videos
  };
};

/**
 * Delete an asset from Cloudinary by public_id.
 *
 * `resourceType` has to match what it was uploaded as — a raw asset deleted as
 * an image silently does nothing. Callers holding only a URL can read it off
 * the path, which contains `/raw/upload/` or `/image/upload/`.
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image', sequelize) => {
  const creds = await getCreds(sequelize);
  if (!creds.cloud_name) return;
  cloudinary.config(creds);
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

module.exports = {
  uploadToCloudinary,
  deleteFromCloudinary,
  invalidateCredsCache,
  /**
   * Exported for verification: which credentials a given company resolves to is
   * the whole behaviour here, and the alternative — asserting it through
   * uploadToCloudinary — would mean talking to Cloudinary to test a lookup.
   */
  resolveCredentials: getCreds,
};
