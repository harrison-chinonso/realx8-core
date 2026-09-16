const axios = require('axios');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
  || process.env.APP_URL
  || process.env.FRONTEND_URL
  || process.env.API_BASE_URL
  || process.env.USER_SERVICE_PUBLIC_URL
  || process.env.USER_SERVICE_URL
  || '';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveMediaUrl = (url) => {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!PUBLIC_BASE_URL) return url;
  return new URL(url, PUBLIC_BASE_URL).toString();
};

async function publishToFacebook(account, post) {
  const { page_id: pageId, page_access_token: pageAccessToken } = account;
  if (!pageId || !pageAccessToken) throw new Error('Facebook credentials missing');

  const images = (post.media_files || []).filter((file) => file.type === 'image');
  const videos = (post.media_files || []).filter((file) => file.type === 'video');
  const message = post.caption || post.content || post.title;

  if (videos.length > 0) {
    const resp = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/videos`, {
      description: message,
      file_url: resolveMediaUrl(videos[0].url),
      access_token: pageAccessToken,
    });
    return { platform: 'facebook', id: resp.data.id };
  }

  if (images.length === 1) {
    const resp = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
      caption: message,
      url: resolveMediaUrl(images[0].url),
      access_token: pageAccessToken,
    });
    return { platform: 'facebook', id: resp.data.id };
  }

  if (images.length > 1) {
    const photoIds = await Promise.all(images.map(async (img) => {
      const response = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
        url: resolveMediaUrl(img.url),
        published: false,
        access_token: pageAccessToken,
      });
      return { media_fbid: response.data.id };
    }));

    const resp = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      message,
      attached_media: photoIds,
      access_token: pageAccessToken,
    });
    return { platform: 'facebook', id: resp.data.id };
  }

  const resp = await axios.post(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
    message,
    access_token: pageAccessToken,
  });
  return { platform: 'facebook', id: resp.data.id };
}

async function publishToInstagram(account, post) {
  const { instagram_account_id: instagramAccountId, page_access_token: pageAccessToken } = account;
  if (!instagramAccountId || !pageAccessToken) throw new Error('Instagram credentials missing');

  const images = (post.media_files || []).filter((file) => file.type === 'image');
  const videos = (post.media_files || []).filter((file) => file.type === 'video');
  const caption = post.caption || post.content || post.title;

  if (videos.length > 0) {
    const containerResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media`, {
      media_type: 'REELS',
      video_url: resolveMediaUrl(videos[0].url),
      caption,
      access_token: pageAccessToken,
    });
    await delay(5000);
    const publishResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media_publish`, {
      creation_id: containerResp.data.id,
      access_token: pageAccessToken,
    });
    return { platform: 'instagram', id: publishResp.data.id };
  }

  if (images.length === 1) {
    const containerResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media`, {
      image_url: resolveMediaUrl(images[0].url),
      caption,
      access_token: pageAccessToken,
    });
    const publishResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media_publish`, {
      creation_id: containerResp.data.id,
      access_token: pageAccessToken,
    });
    return { platform: 'instagram', id: publishResp.data.id };
  }

  if (images.length > 1) {
    const itemIds = await Promise.all(images.map(async (img) => {
      const response = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media`, {
        image_url: resolveMediaUrl(img.url),
        is_carousel_item: true,
        access_token: pageAccessToken,
      });
      return response.data.id;
    }));

    const carouselResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media`, {
      media_type: 'CAROUSEL',
      children: itemIds.join(','),
      caption,
      access_token: pageAccessToken,
    });
    const publishResp = await axios.post(`https://graph.facebook.com/v18.0/${instagramAccountId}/media_publish`, {
      creation_id: carouselResp.data.id,
      access_token: pageAccessToken,
    });
    return { platform: 'instagram', id: publishResp.data.id };
  }

  throw new Error('Instagram requires at least one image or video');
}

async function publishToTwitter(account, post) {
  const {
    twitter_api_key: twitterApiKey,
    twitter_api_secret: twitterApiSecret,
    twitter_access_token: twitterAccessToken,
    twitter_access_secret: twitterAccessSecret,
  } = account;

  if (!twitterApiKey || !twitterApiSecret || !twitterAccessToken || !twitterAccessSecret) {
    throw new Error('Twitter credentials missing');
  }

  const text = (post.caption || post.content || post.title || '').slice(0, 280);
  const resp = await axios.post('https://api.twitter.com/2/tweets', { text }, {
    headers: {
      Authorization: `Bearer ${twitterAccessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return { platform: 'twitter', id: resp.data.data?.id };
}

async function publishToLinkedIn(account, post) {
  const { linkedin_access_token: linkedinAccessToken, linkedin_org_id: linkedinOrgId } = account;
  if (!linkedinAccessToken || !linkedinOrgId) throw new Error('LinkedIn credentials missing');

  const images = (post.media_files || []).filter((file) => file.type === 'image');
  const text = post.caption || post.content || post.title;

  const body = {
    author: `urn:li:organization:${linkedinOrgId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: images.length > 0 ? 'IMAGE' : 'NONE',
        ...(images.length > 0 && {
          media: images.slice(0, 1).map((img) => ({
            status: 'READY',
            originalUrl: resolveMediaUrl(img.url),
          })),
        }),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const resp = await axios.post('https://api.linkedin.com/v2/ugcPosts', body, {
    headers: {
      Authorization: `Bearer ${linkedinAccessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  return { platform: 'linkedin', id: resp.headers['x-restli-id'] };
}

async function publishPost(account, post) {
  const platformFns = {
    facebook: publishToFacebook,
    instagram: publishToInstagram,
    twitter: publishToTwitter,
    linkedin: publishToLinkedIn,
  };

  const fn = platformFns[account.platform];
  /*
   * YouTube and TikTok can be CONNECTED — impressionsSyncJob and
   * socialInsightsFetcher both read from them — but nothing here can post to
   * them, and a text-and-image post is not a thing either platform accepts.
   * Say so in the terms a person can act on rather than "not yet supported",
   * which reads like a temporary outage.
   */
  if (!fn) {
    throw new Error(
      `${account.platform} cannot be posted to from here — it is connected for analytics only`,
    );
  }
  return fn(account, post);
}

module.exports = { publishPost };
