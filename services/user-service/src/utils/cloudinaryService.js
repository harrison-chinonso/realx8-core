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

// ── Credential cache (TTL = 5 min, same as JWT config cache) ─────────────────
let _creds = null;
let _credsLoadedAt = 0;
const CREDS_TTL = 5 * 60 * 1000;

const loadCreds = async (sequelize) => {
  try {
    const rows = await sequelize.query(
      "SELECT `key`, `value` FROM `settings` WHERE `group` = 'system' AND `key` IN ('cloudinary_cloud_name','cloudinary_api_key','cloudinary_api_secret')",
      { type: QueryTypes.SELECT }
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    _creds = map;
    _credsLoadedAt = Date.now();
  } catch {
    _creds = {};
    _credsLoadedAt = Date.now();
  }
};

const getCreds = async (sequelize) => {
  if (!_creds || Date.now() - _credsLoadedAt > CREDS_TTL) {
    await loadCreds(sequelize);
  }
  return {
    cloud_name: _creds.cloudinary_cloud_name || process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    _creds.cloudinary_api_key    || process.env.CLOUDINARY_API_KEY,
    api_secret: _creds.cloudinary_api_secret || process.env.CLOUDINARY_API_SECRET,
  };
};

/** Force immediate cache flush (called after saving credentials in settings) */
const invalidateCredsCache = () => { _creds = null; };

/**
 * Upload a file buffer or local path to Cloudinary.
 * @param {string} source   - local file path or data URI
 * @param {object} opts     - Cloudinary upload options (folder, resource_type, etc.)
 * @param {object} sequelize - Sequelize instance for DB credential lookup
 * @returns {object}        - { url, public_id, resource_type, width, height }
 */
const uploadToCloudinary = async (source, opts = {}, sequelize) => {
  const creds = await getCreds(sequelize);

  if (!creds.cloud_name || !creds.api_key || !creds.api_secret) {
    throw new Error('Cloudinary credentials not configured. Add them in Settings → System Config.');
  }

  cloudinary.config(creds);

  const result = await cloudinary.uploader.upload(source, {
    resource_type: 'auto', // handles images AND videos
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
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image', sequelize) => {
  const creds = await getCreds(sequelize);
  if (!creds.cloud_name) return;
  cloudinary.config(creds);
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

module.exports = { uploadToCloudinary, deleteFromCloudinary, invalidateCredsCache };
