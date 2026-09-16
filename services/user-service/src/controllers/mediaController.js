const multer = require('multer');
const path = require('path');
const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const { MediaPost, SocialAccount, User } = require('../models');

/**
 * Announces a media post moving through its approval flow.
 *
 * All four states were silent: an author had no way of knowing their post
 * had been approved or rejected, and nobody was told one was waiting for
 * review. The author is the subject; the reviewer group is whoever holds
 * media.approve.
 */
const announcePost = (post, req, { eventKey, title, subjectLine, othersLine }) => notify.dispatch({
  eventKey,
  subjectUserId: post.created_by ?? null,
  // Was always undefined: media_posts had no company_id at all until now.
  companyId: post.company_id ?? null,
  context: { post },
  title: () => title,
  body: (role, ctx) => (role === 'subject'
    ? subjectLine(post)
    : othersLine(post, ctx.subject?.name || 'A team member')),
  data: { media_post_id: post.id },
  actionLabel: 'View post',
  actionUrl: appUrl('media/posts', req),
}).catch(() => {});
const { publishPost: dispatchPublish } = require('../utils/socialPublisher');
const { uploadToCloudinary } = require('../utils/cloudinaryService');
const { sequelize } = require('../config/database');
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { appUrl } = require('../../../../shared/src/appOrigin');
// Recipients come from configuration, not from these call sites.
const notify = createDispatcher(sequelize);

/**
 * What may be uploaded here.
 *
 * This endpoint is not only for social and blog media. Three other screens post
 * to it — proof of payment on an invoice, KYC documents, and property documents
 * — and two of those offer `application/pdf` in their file picker. PDF was not
 * on this list, so choosing one produced an upload that appeared to do nothing:
 * the file never attached and the submit button stayed disabled.
 *
 * HEIC and HEIF are here because they are what an iPhone camera produces, and
 * photographing a receipt is the most obvious way to supply proof of payment.
 */
const ALLOWED_MIME = [
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/heic', 'image/heif',
  // Documents — proof of payment, KYC, property paperwork
  'application/pdf',
  // Video
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
];

// Use memory storage so we can pipe the buffer straight to Cloudinary
// (no temp file left on disk after upload)
const upload = multer({
  storage: multer.memoryStorage(),
  /**
   * A refused file is an ERROR, not a silent omission.
   *
   * `cb(null, false)` tells multer to drop the file without complaint, so an
   * unsupported type arrived at the handler as an empty `req.files` and came
   * back as "No files uploaded" — which reads, to someone who definitely chose
   * a file, like the upload button is broken. Passing an error instead means
   * the response names the type that was refused.
   */
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    const error = new Error(
      `${file.originalname || 'That file'} cannot be uploaded`
      + `${file.mimetype ? ` (${file.mimetype})` : ''}. `
      + 'Accepted types are JPG, PNG, GIF, WebP, HEIC, PDF and MP4.',
    );
    error.status = 400;
    return cb(error);
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

/** What kind of thing was uploaded, for callers that group by it. */
const mediaKind = (mimetype) => {
  if (String(mimetype).startsWith('video')) return 'video';
  if (mimetype === 'application/pdf') return 'document';
  return 'image';
};

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
        // Scoped to the caller's company, so a company uploads with its own
        // credentials where it has them and the platform's otherwise.
        const result = await uploadToCloudinary(
          dataUri, { folder: 'realto/media' }, sequelize, req.user?.company_id ?? null,
        );
        return {
          url:           result.url,
          public_id:     result.public_id,
          type:          mediaKind(file.mimetype),
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
          type: mediaKind(file.mimetype),
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


/**
 * A platform admin has no company of their own and may act across all of them.
 *
 * Tested on both the flag and the type, which is the form companyController and
 * userController use. `buildCompanyScope` reads only the flag, and a token
 * carrying just the type would silently be treated as an ordinary user.
 */
const isPlatformAdmin = (req) => req.user?.isSuperiorAdmin === true
  || req.user?.type === 'superior_admin';

/**
 * The company filter for every read and every write in this file.
 *
 * ── Why it is applied to the id-addressed routes too ────────────────────────
 *
 * Scoping only the listing would hide other companies' posts without denying
 * them: every one of these routes took an id straight to findByPk, so a caller
 * who knew or guessed a number could read, edit, approve, publish or DELETE
 * another company's work. Hiding the ids makes that harder to stumble into and
 * no harder to do deliberately.
 *
 * Merged into the WHERE rather than checked after loading, so a post belonging
 * to someone else is indistinguishable from one that does not exist — the
 * caller gets the same 404 either way and learns nothing about what other
 * companies have.
 *
 * A platform admin passing ?company_id= is scoped to that company; passing
 * nothing sees everything, including posts no company owns.
 */
const scopeFor = (req) => {
  if (isPlatformAdmin(req)) {
    const requested = req.query?.company_id ?? req.body?.company_id;
    return requested ? { company_id: Number(requested) } : {};
  }
  return { company_id: req.user?.company_id ?? null };
};

/** One post, or nothing, within the caller's company. */
const findScoped = (req, extra = {}) => MediaPost.findOne({
  where: { id: req.params.id, ...scopeFor(req), ...extra },
});

const listPosts = asyncHandler(async (req, res) => {
  const where = { ...scopeFor(req) };
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
  /**
   * From the SESSION, never from the body — otherwise a caller could file a
   * post into another company by sending its id. A platform admin, who has no
   * company of their own, may nominate one.
   */
  payload.company_id = isPlatformAdmin(req)
    ? (req.body?.company_id ? Number(req.body.company_id) : null)
    : (req.user?.company_id ?? null);

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
  const row = await findScoped(req);
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
  const row = await findScoped(req);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  await row.destroy();
  res.json({ message: 'Media post deleted successfully' });
});

const submitPost = asyncHandler(async (req, res) => {
  const row = await findScoped(req);
  if (!row) {
    return res.status(404).json({ message: 'Media post not found' });
  }

  if (row.status !== 'draft') {
    return res.status(400).json({ message: 'Only draft posts can be submitted for review' });
  }

  await row.update({ status: 'review', rejection_reason: null });
  const updated = await MediaPost.findByPk(row.id, { include: getInclude() });

  announcePost(row, req, {
    eventKey: 'media_post_submitted',
    title: 'Media post submitted for approval',
    subjectLine: (post) => `Your post "${post.title || post.id}" has been submitted for approval.`,
    othersLine: (post, who) => `${who} submitted "${post.title || post.id}" for approval.`,
  });
  res.json({ data: updated });
});

const approvePost = asyncHandler(async (req, res) => {
  const row = await findScoped(req);
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

  announcePost(row, req, {
    eventKey: 'media_post_approved',
    title: 'Media post approved',
    subjectLine: (post) => `Your post "${post.title || post.id}" has been approved.`,
    othersLine: (post, who) => `${who}'s post "${post.title || post.id}" was approved.`,
  });
  res.json({ data: updated });
});

const rejectPost = asyncHandler(async (req, res) => {
  const row = await findScoped(req);
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

  announcePost(row, req, {
    eventKey: 'media_post_rejected',
    title: 'Media post rejected',
    subjectLine: (post) => `Your post "${post.title || post.id}" was not approved.`,
    othersLine: (post, who) => `${who}'s post "${post.title || post.id}" was rejected.`,
  });
  res.json({ data: updated });
});

const publishPost = asyncHandler(async (req, res) => {
  // Scoped like the rest. This is the one that pushes to the company's real
  // social accounts, so an unscoped id here publishes one company's content
  // through another company's channels.
  const post = await findScoped(req);
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

  /**
   * A post is only PUBLISHED if it reached somewhere.
   *
   * This used to mark it published and announce it as live whatever happened —
   * so a post that reached no channel at all was recorded as published, was
   * announced to the company as live, and the only hint was a "Published with
   * 1 error(s)" notice the screen showed in the same green as a success. The
   * post then sat in the list as published, on no channel, with nothing to
   * retry because its status said the work was done.
   *
   * Reaching SOME channels is still published — those posts are genuinely live
   * — but the reply names the ones that failed rather than counting them.
   */
  const delivered = results.length > 0;

  if (delivered) {
    const existingIds = post.platform_post_ids || {};
    await post.update({
      status: 'published',
      published_at: new Date(),
      platform_post_ids: { ...existingIds, ...platformPostIds },
    });

    announcePost(post, req, {
      eventKey: 'media_post_published',
      title: 'Media post published',
      subjectLine: (post) => `Your post "${post.title || post.id}" is now live.`,
      othersLine: (post, who) => `${who}'s post "${post.title || post.id}" has been published.`,
    });
  }

  const failed = errors.map((e) => `${e.platform} (${e.error})`).join(', ');

  if (!delivered) {
    /*
     * 422, not 200. The screen reads a 2xx `message` as a success notice, which
     * is how "Published with 1 error(s)" came to be shown in green next to a
     * post that had gone nowhere. A failure has to arrive as a failure.
     */
    return res.status(422).json({
      message: errors.length
        ? `Not published. ${failed}`
        : 'Not published: no channels were selected.',
      published: [],
      errors,
    });
  }

  return res.json({
    message: errors.length === 0
      ? 'Post published successfully to all channels'
      : `Published to ${results.map((r) => r.platform).join(', ')}. Did not publish to ${failed}`,
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
  const row = await findScoped(req);
  if (!row || row.type !== 'blog') {
    return res.status(404).json({ message: 'Blog article not found' });
  }

  req.body.type = 'blog';
  return updatePost(req, res);
});

const removeBlog = asyncHandler(async (req, res) => {
  const row = await findScoped(req);
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
