const multer = require('multer');
const path = require('path');
const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const { MediaPost, SocialAccount, User } = require('../models');
const { publishPost: dispatchPublish } = require('../utils/socialPublisher');
const { uploadToCloudinary } = require('../utils/cloudinaryService');
const { sequelize } = require('../config/database');

// Use memory storage so we can pipe the buffer straight to Cloudinary
// (no temp file left on disk after upload)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/quicktime','video/x-msvideo'];
    cb(null, allowed.includes(file.mimetype));
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

const VALID_TYPES = ['social', 'blog'];
const VALID_STATUSES = ['draft', 'review', 'approved', 'scheduled', 'published'];
const CHANNEL_ALIASES = {
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  x: 'twitter',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
  youtube: 'youtube',
};

const getInclude = () => [
  { model: User, as: 'author', attributes: ['id', 'name', 'email', 'type'] },
  { model: User, as: 'reviewer', attributes: ['id', 'name', 'email', 'type'] },
];

const cleanString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseJsonArray = (value) => {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const normalizeChannels = (channels) => {
  const rawChannels = Array.isArray(channels)
    ? channels
    : typeof channels === 'string' && channels.trim()
      ? channels.includes('[') ? parseJsonArray(channels) : channels.split(',')
      : [];

  return [...new Set(rawChannels
    .map((channel) => String(channel).trim().toLowerCase())
    .map((channel) => CHANNEL_ALIASES[channel] || channel)
    .filter(Boolean))];
};

const normalizeMediaFiles = (mediaFiles) => {
  const files = Array.isArray(mediaFiles) ? mediaFiles : parseJsonArray(mediaFiles);
  return files
    .filter((file) => file && typeof file === 'object')
    .map((file) => ({
      url: cleanString(file.url),
      type: file.type === 'video' ? 'video' : 'image',
      name: cleanString(file.name) || 'media-file',
      size: Number(file.size || 0) || 0,
    }))
    .filter((file) => file.url);
};

const normalizeType = (value, fallback = 'social') => (VALID_TYPES.includes(value) ? value : fallback);
const normalizeStatus = (value, fallback = 'draft') => (VALID_STATUSES.includes(value) ? value : fallback);

const buildPayload = (body, options = {}) => {
  const payload = {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) payload.title = cleanString(body.title);
  if (Object.prototype.hasOwnProperty.call(body, 'type')) payload.type = normalizeType(body.type, options.type || 'social');
  if (Object.prototype.hasOwnProperty.call(body, 'content')) payload.content = cleanString(body.content);
  if (Object.prototype.hasOwnProperty.call(body, 'caption')) payload.caption = cleanString(body.caption);
  if (Object.prototype.hasOwnProperty.call(body, 'excerpt')) payload.excerpt = cleanString(body.excerpt);
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) payload.tags = cleanString(body.tags);
  if (Object.prototype.hasOwnProperty.call(body, 'category')) payload.category = cleanString(body.category);
  if (Object.prototype.hasOwnProperty.call(body, 'channels')) payload.channels = normalizeChannels(body.channels);
  if (Object.prototype.hasOwnProperty.call(body, 'media_files')) payload.media_files = normalizeMediaFiles(body.media_files);
  if (Object.prototype.hasOwnProperty.call(body, 'rejection_reason')) payload.rejection_reason = cleanString(body.rejection_reason);
  if (Object.prototype.hasOwnProperty.call(body, 'scheduled_at')) payload.scheduled_at = normalizeDate(body.scheduled_at);
  if (Object.prototype.hasOwnProperty.call(body, 'status')) payload.status = normalizeStatus(body.status, options.defaultStatus || 'draft');
  if (Object.prototype.hasOwnProperty.call(body, 'reach')) payload.reach = Number(body.reach || 0);
  if (Object.prototype.hasOwnProperty.call(body, 'impressions')) payload.impressions = Number(body.impressions || 0);
  if (Object.prototype.hasOwnProperty.call(body, 'engagement_rate')) payload.engagement_rate = Number(body.engagement_rate || 0);
  if (Object.prototype.hasOwnProperty.call(body, 'leads_generated')) payload.leads_generated = Number(body.leads_generated || 0);

  if (payload.status === 'published') {
    payload.published_at = normalizeDate(body.published_at) || new Date();
  } else if (Object.prototype.hasOwnProperty.call(body, 'published_at')) {
    payload.published_at = normalizeDate(body.published_at);
  }

  if (options.type) {
    payload.type = options.type;
  }

  return payload;
};

const uploadMediaFiles = [
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    const uploaded = await Promise.all(req.files.map(async (file) => {
      // Convert buffer to base64 data URI for Cloudinary upload
      const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      try {
        const result = await uploadToCloudinary(dataUri, { folder: 'realto/media' }, sequelize);
        return {
          url:           result.url,
          public_id:     result.public_id,
          type:          file.mimetype.startsWith('video') ? 'video' : 'image',
          name:          file.originalname,
          size:          file.size,
          width:         result.width,
          height:        result.height,
          resource_type: result.resource_type,
        };
      } catch (err) {
        // If Cloudinary not configured, fall back to a local URL note
        return {
          url:  null,
          type: file.mimetype.startsWith('video') ? 'video' : 'image',
          name: file.originalname,
          size: file.size,
          error: err.message,
        };
      }
    }));

    const failed = uploaded.filter(f => f.error);
    if (failed.length === uploaded.length) {
      return res.status(500).json({ message: failed[0].error });
    }

    res.json({ files: uploaded.filter(f => !f.error) });
  }),
];

const listPosts = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.type) where.type = normalizeType(req.query.type);
  if (req.query.status && VALID_STATUSES.includes(req.query.status)) where.status = req.query.status;

  const rows = await MediaPost.findAll({
    where,
    include: getInclude(),
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    limit: Math.min(Math.max(Number(req.query.limit || 100), 1), 500),
  });

  res.json({ data: rows });
});

const createPost = asyncHandler(async (req, res) => {
  const payload = buildPayload(req.body, { defaultStatus: 'draft' });
  payload.title = payload.title || cleanString(req.body.title);
  payload.type = normalizeType(req.body.type, 'social');
  payload.status = payload.status || 'draft';
  payload.created_by = req.user?.id || null;

  if (!payload.title) {
    return res.status(400).json({ message: 'Title is required' });
  }

  if (payload.type === 'social' && payload.status === 'published' && !payload.published_at) {
    payload.published_at = new Date();
  }

  const row = await MediaPost.create(payload);
  const created = await MediaPost.findByPk(row.id, { include: getInclude() });
  res.status(201).json({ data: created });
});

const updatePost = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  const payload = buildPayload(req.body, { type: row.type, defaultStatus: row.status });

  if (Object.prototype.hasOwnProperty.call(payload, 'title') && !payload.title) {
    return res.status(400).json({ message: 'Title is required' });
  }

  if (payload.status === 'scheduled' && !payload.scheduled_at && !row.scheduled_at) {
    return res.status(400).json({ message: 'scheduled_at is required when scheduling a post' });
  }

  if (payload.status === 'published' && !payload.published_at) {
    payload.published_at = new Date();
  }

  await row.update(payload);
  const updated = await MediaPost.findByPk(row.id, { include: getInclude() });
  res.json({ data: updated });
});

const removePost = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  await row.destroy();
  res.json({ message: 'Media post deleted successfully' });
});

const submitPost = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  if (row.status !== 'draft') {
    return res.status(400).json({ message: 'Only draft posts can be submitted for review' });
  }

  await row.update({ status: 'review', rejection_reason: null });
  const updated = await MediaPost.findByPk(row.id, { include: getInclude() });
  res.json({ data: updated });
});

const approvePost = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  if (row.status !== 'review') {
    return res.status(400).json({ message: 'Only posts in review can be approved' });
  }

  const scheduledAt = normalizeDate(req.body.scheduled_at);
  await row.update({
    status: scheduledAt ? 'scheduled' : 'approved',
    scheduled_at: scheduledAt,
    reviewed_by: req.user?.id || null,
    rejection_reason: null,
  });

  const updated = await MediaPost.findByPk(row.id, { include: getInclude() });
  res.json({ data: updated });
});

const rejectPost = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  if (row.status !== 'review') {
    return res.status(400).json({ message: 'Only posts in review can be rejected' });
  }

  await row.update({
    status: 'draft',
    rejection_reason: cleanString(req.body.rejection_reason),
    reviewed_by: req.user?.id || null,
  });

  const updated = await MediaPost.findByPk(row.id, { include: getInclude() });
  res.json({ data: updated });
});

const publishPost = asyncHandler(async (req, res) => {
  const post = await MediaPost.findByPk(req.params.id);
  if (!post) return res.status(404).json({ message: 'Post not found' });
  if (!['approved', 'scheduled'].includes(post.status)) {
    return res.status(400).json({ message: 'Post must be approved before publishing' });
  }

  const channels = Array.isArray(post.channels) ? post.channels : [];
  const results = [];
  const errors = [];
  const platformPostIds = {};

  await Promise.allSettled(
    channels.map(async (channelName) => {
      const account = await SocialAccount.findOne({ where: { platform: channelName, is_connected: true } });
      if (!account) {
        errors.push({ platform: channelName, error: 'Account not connected' });
        return;
      }
      try {
        const result = await dispatchPublish(account, post);
        results.push(result);
        await account.update({ last_publish_at: new Date(), last_publish_error: null });
        // Store the platform-specific post ID so the impressions cron can query it later
        if (result?.id) {
          platformPostIds[channelName.toLowerCase()] = String(result.id);
        }
      } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.response?.data?.message || error.message;
        errors.push({ platform: channelName, error: errMsg });
        await account.update({ last_publish_error: errMsg });
      }
    }),
  );

  const existingIds = post.platform_post_ids || {};
  await post.update({
    status: 'published',
    published_at: new Date(),
    platform_post_ids: { ...existingIds, ...platformPostIds },
  });

  res.json({
    message: errors.length === 0
      ? 'Post published successfully to all channels'
      : `Published with ${errors.length} error(s)`,
    published: results,
    errors,
  });
});

const listBlog = asyncHandler(async (req, res) => {
  req.query.type = 'blog';
  return listPosts(req, res);
});

const createBlog = asyncHandler(async (req, res) => {
  req.body.type = 'blog';
  if (!req.body.status) req.body.status = 'draft';
  return createPost(req, res);
});

const updateBlog = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row || row.type !== 'blog') {
    return res.status(404).json({ message: 'Blog article not found' });
  }

  req.body.type = 'blog';
  return updatePost(req, res);
});

const removeBlog = asyncHandler(async (req, res) => {
  const row = await MediaPost.findByPk(req.params.id);
  if (!row || row.type !== 'blog') {
    return res.status(404).json({ message: 'Blog article not found' });
  }

  await row.destroy();
  res.json({ message: 'Blog article deleted successfully' });
});

module.exports = {
  uploadMediaFiles,
  listPosts,
  createPost,
  updatePost,
  removePost,
  submitPost,
  approvePost,
  rejectPost,
  publishPost,
  listBlog,
  createBlog,
  updateBlog,
  removeBlog,
};
