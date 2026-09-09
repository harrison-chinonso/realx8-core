/**
 * socialInsightsFetcher.js
 *
 * Per-platform functions that fetch real impression/reach/engagement
 * data for a single published post. Each function returns:
 *   { impressions, reach, engagement_rate }
 * All fields default to 0 on failure so the cron can always update cleanly.
 */

const axios = require('axios');

// ─── Facebook ────────────────────────────────────────────────────────────────
async function fetchFacebookInsights(account, platformPostId) {
  const { page_access_token: token } = account;
  if (!token || !platformPostId) return null;

  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/v18.0/${platformPostId}/insights`,
      {
        params: {
          metric: 'post_impressions,post_reach,post_engaged_users',
          access_token: token,
        },
      },
    );

    const find = (name) => (data.data || []).find((m) => m.name === name)?.values?.[0]?.value || 0;
    const impressions = find('post_impressions');
    const reach = find('post_reach');
    const engaged = find('post_engaged_users');
    const engagement_rate = reach > 0 ? parseFloat(((engaged / reach) * 100).toFixed(2)) : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`Facebook insights error: ${msg}`);
  }
}

// ─── Instagram ───────────────────────────────────────────────────────────────
async function fetchInstagramInsights(account, platformPostId) {
  const { page_access_token: token } = account;
  if (!token || !platformPostId) return null;

  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/v18.0/${platformPostId}/insights`,
      {
        params: {
          metric: 'impressions,reach,engagement',
          access_token: token,
        },
      },
    );

    const find = (name) => (data.data || []).find((m) => m.name === name)?.values?.[0]?.value || 0;
    const impressions = find('impressions');
    const reach = find('reach');
    const engaged = find('engagement');
    const engagement_rate = reach > 0 ? parseFloat(((engaged / reach) * 100).toFixed(2)) : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`Instagram insights error: ${msg}`);
  }
}

// ─── Twitter / X ─────────────────────────────────────────────────────────────
async function fetchTwitterInsights(account, platformPostId) {
  const { twitter_access_token: bearerToken } = account;
  if (!bearerToken || !platformPostId) return null;

  try {
    const { data } = await axios.get(
      `https://api.twitter.com/2/tweets/${platformPostId}`,
      {
        params: { 'tweet.fields': 'public_metrics,non_public_metrics,organic_metrics' },
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    );

    const pub = data.data?.public_metrics || {};
    const org = data.data?.organic_metrics || {};
    const impressions = org.impression_count || pub.impression_count || 0;
    const reach = impressions; // Twitter doesn't expose unique reach via public API
    const total_engagements = (pub.like_count || 0) + (pub.retweet_count || 0) + (pub.reply_count || 0);
    const engagement_rate = impressions > 0
      ? parseFloat(((total_engagements / impressions) * 100).toFixed(2))
      : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.detail || err.message;
    throw new Error(`Twitter insights error: ${msg}`);
  }
}

// ─── LinkedIn ────────────────────────────────────────────────────────────────
async function fetchLinkedInInsights(account, platformPostId) {
  const { linkedin_access_token: token, linkedin_org_id: orgId } = account;
  if (!token || !platformPostId) return null;

  try {
    // UGC Post statistics
    const { data } = await axios.get(
      'https://api.linkedin.com/v2/organizationalEntityShareStatistics',
      {
        params: {
          q: 'organizationalEntity',
          organizationalEntity: `urn:li:organization:${orgId}`,
          'shares[0]': `urn:li:share:${platformPostId}`,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      },
    );

    const stats = data.elements?.[0]?.totalShareStatistics || {};
    const impressions = stats.impressionCount || 0;
    const reach = stats.uniqueImpressionsCount || impressions;
    const clicks = stats.clickCount || 0;
    const likes = stats.likeCount || 0;
    const total_engagements = clicks + likes;
    const engagement_rate = impressions > 0
      ? parseFloat(((total_engagements / impressions) * 100).toFixed(2))
      : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`LinkedIn insights error: ${msg}`);
  }
}

// ─── TikTok ──────────────────────────────────────────────────────────────────
async function fetchTikTokInsights(account, platformPostId) {
  const { tiktok_access_token: token } = account;
  if (!token || !platformPostId) return null;

  try {
    const { data } = await axios.post(
      'https://open.tiktokapis.com/v2/video/query/',
      {
        filters: { video_ids: [platformPostId] },
        fields: ['view_count', 'like_count', 'comment_count', 'share_count'],
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );

    const video = data.data?.videos?.[0] || {};
    const impressions = video.view_count || 0;
    const reach = impressions;
    const total_engagements = (video.like_count || 0) + (video.comment_count || 0) + (video.share_count || 0);
    const engagement_rate = impressions > 0
      ? parseFloat(((total_engagements / impressions) * 100).toFixed(2))
      : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.error?.description || err.message;
    throw new Error(`TikTok insights error: ${msg}`);
  }
}

// ─── YouTube ─────────────────────────────────────────────────────────────────
async function fetchYouTubeInsights(account, platformPostId) {
  const { youtube_access_token: token } = account;
  if (!token || !platformPostId) return null;

  try {
    const { data } = await axios.get(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          part: 'statistics',
          id: platformPostId,
          access_token: token,
        },
      },
    );

    const stats = data.items?.[0]?.statistics || {};
    const impressions = parseInt(stats.viewCount || 0, 10);
    const reach = impressions;
    const total_engagements = parseInt(stats.likeCount || 0, 10) + parseInt(stats.commentCount || 0, 10);
    const engagement_rate = impressions > 0
      ? parseFloat(((total_engagements / impressions) * 100).toFixed(2))
      : 0;

    return { impressions, reach, engagement_rate };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`YouTube insights error: ${msg}`);
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
const FETCHERS = {
  facebook: fetchFacebookInsights,
  instagram: fetchInstagramInsights,
  twitter: fetchTwitterInsights,
  linkedin: fetchLinkedInInsights,
  tiktok: fetchTikTokInsights,
  youtube: fetchYouTubeInsights,
};

/**
 * Fetch insights for a specific platform.
 * Returns { impressions, reach, engagement_rate } or null if unsupported.
 */
async function fetchInsights(platform, account, platformPostId) {
  const fn = FETCHERS[platform?.toLowerCase()];
  if (!fn) return null;
  return fn(account, platformPostId);
}

module.exports = { fetchInsights };
