/**
 * impressionsSyncJob.js
 *
 * Cron job that syncs social media impressions/reach/engagement back
 * into the media_posts table.
 *
 * ONLY runs when ALL three conditions are met:
 *  1. A social account is profiled (is_connected = true + has credentials)
 *  2. A post was published to that platform (platform_post_ids contains that platform)
 *  3. Impressions are expected (post.status = 'published', published_at set)
 *
 * Schedule: every 6 hours (configurable via IMPRESSIONS_SYNC_CRON env var).
 * Each eligible post's metrics are summed across all its platforms.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');
const { MediaPost, SocialAccount } = require('../models');
const { fetchInsights } = require('./socialInsightsFetcher');
const logger = require('../config/logger');

const SCHEDULE = process.env.IMPRESSIONS_SYNC_CRON || '0 */6 * * *'; // every 6 h

async function syncImpressions() {
  logger.info('[impressionsSync] Starting impressions sync...');

  // ── Step 1: Load all connected & credentialed social accounts ───────────
  const allAccounts = await SocialAccount.findAll({
    where: { is_connected: true },
  });

  // Filter to accounts that actually have the required credentials
  const accountsByPlatform = {};
  for (const account of allAccounts) {
    if (isPlatformReady(account)) {
      accountsByPlatform[account.platform] = account;
    }
  }

  const readyPlatforms = Object.keys(accountsByPlatform);
  if (readyPlatforms.length === 0) {
    logger.info('[impressionsSync] No connected social accounts with credentials. Skipping.');
    return;
  }

  logger.info(`[impressionsSync] Ready platforms: ${readyPlatforms.join(', ')}`);

  // ── Step 2: Find eligible posts ──────────────────────────────────────────
  // Eligible = published + has platform_post_ids JSON with at least one platform
  // that is in our ready platforms list
  const posts = await MediaPost.findAll({
    where: {
      status: 'published',
      published_at: { [Op.ne]: null },
      // Exclude posts synced in the last 5 hours to avoid over-fetching
      [Op.or]: [
        { impressions_synced_at: null },
        { impressions_synced_at: { [Op.lt]: new Date(Date.now() - 5 * 60 * 60 * 1000) } },
      ],
    },
  });

  // Filter to only posts that have platform_post_ids for at least one ready platform
  const eligiblePosts = posts.filter((post) => {
    const ids = post.platform_post_ids || {};
    return Object.keys(ids).some((platform) => readyPlatforms.includes(platform) && ids[platform]);
  });

  if (eligiblePosts.length === 0) {
    logger.info('[impressionsSync] No eligible posts to sync. Skipping.');
    return;
  }

  logger.info(`[impressionsSync] Syncing ${eligiblePosts.length} post(s)...`);

  let synced = 0;
  let failed = 0;

  for (const post of eligiblePosts) {
    const platformIds = post.platform_post_ids || {};
    let totalImpressions = 0;
    let totalReach = 0;
    let engagementRateSum = 0;
    let platformCount = 0;

    for (const [platform, postId] of Object.entries(platformIds)) {
      const account = accountsByPlatform[platform];
      if (!account || !postId) continue;

      try {
        const result = await fetchInsights(platform, account, postId);
        if (result) {
          totalImpressions += result.impressions || 0;
          totalReach += result.reach || 0;
          engagementRateSum += result.engagement_rate || 0;
          platformCount++;
        }
      } catch (err) {
        logger.warn(`[impressionsSync] Post ${post.id} / ${platform}: ${err.message}`);
        failed++;
      }
    }

    if (platformCount > 0) {
      const avgEngagementRate = parseFloat((engagementRateSum / platformCount).toFixed(2));
      await post.update({
        impressions: totalImpressions,
        reach: totalReach,
        engagement_rate: avgEngagementRate,
        impressions_synced_at: new Date(),
      });
      synced++;
    }
  }

  logger.info(`[impressionsSync] Done. Synced: ${synced}, errors: ${failed}.`);
}

/**
 * Returns true if the account has the credentials needed to call its platform API.
 */
function isPlatformReady(account) {
  switch (account.platform) {
    case 'facebook':
      return !!(account.page_id && account.page_access_token);
    case 'instagram':
      return !!(account.instagram_account_id && account.page_access_token);
    case 'twitter':
      return !!(account.twitter_access_token);
    case 'linkedin':
      return !!(account.linkedin_access_token && account.linkedin_org_id);
    case 'tiktok':
      return !!(account.tiktok_access_token);
    case 'youtube':
      return !!(account.youtube_access_token);
    default:
      return false;
  }
}

/**
 * Starts the cron job. Call once from app startup.
 */
function startImpressionsSyncJob() {
  if (!cron.validate(SCHEDULE)) {
    logger.error(`[impressionsSync] Invalid cron schedule: "${SCHEDULE}". Job not started.`);
    return;
  }

  logger.info(`[impressionsSync] Scheduling impressions sync (${SCHEDULE})`);

  cron.schedule(SCHEDULE, async () => {
    try {
      await syncImpressions();
    } catch (err) {
      logger.error(`[impressionsSync] Unhandled error: ${err.message}`);
    }
  });
}

module.exports = { startImpressionsSyncJob, syncImpressions };
