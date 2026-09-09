const axios = require('axios');
const { SocialAccount } = require('../models');
const asyncHandler = require('../utils/asyncHandler');

const PLATFORMS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'youtube'];
const MASK = '••••••••';
const SECRET_FIELDS = [
  'page_access_token',
  'twitter_api_key',
  'twitter_api_secret',
  'twitter_access_token',
  'twitter_access_secret',
  'linkedin_access_token',
  'tiktok_access_token',
  'youtube_access_token',
  'youtube_refresh_token',
];

const maskAccount = (account) => ({
  id: account.id,
  platform: account.platform,
  is_connected: account.is_connected,
  display_name: account.display_name,
  page_id: account.page_id,
  instagram_account_id: account.instagram_account_id,
  linkedin_org_id: account.linkedin_org_id,
  tiktok_open_id: account.tiktok_open_id,
  youtube_channel_id: account.youtube_channel_id,
  page_access_token: account.page_access_token ? MASK : '',
  twitter_api_key: account.twitter_api_key ? MASK : '',
  twitter_api_secret: account.twitter_api_secret ? MASK : '',
  twitter_access_token: account.twitter_access_token ? MASK : '',
  twitter_access_secret: account.twitter_access_secret ? MASK : '',
  linkedin_access_token: account.linkedin_access_token ? MASK : '',
  tiktok_access_token: account.tiktok_access_token ? MASK : '',
  youtube_access_token: account.youtube_access_token ? MASK : '',
  youtube_refresh_token: account.youtube_refresh_token ? MASK : '',
  last_publish_at: account.last_publish_at,
  last_publish_error: account.last_publish_error,
});

const buildUpdatePayload = (body = {}) => {
  const payload = {};

  Object.entries(body).forEach(([key, value]) => {
    if (value === undefined) return;

    if (SECRET_FIELDS.includes(key)) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed && trimmed !== MASK) payload[key] = trimmed;
      }
      return;
    }

    if (typeof value === 'string') {
      payload[key] = value.trim() || null;
      return;
    }

    payload[key] = value;
  });

  return payload;
};

const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await SocialAccount.findAll();
  const accountMap = {};
  accounts.forEach((account) => {
    accountMap[account.platform] = maskAccount(account);
  });

  const result = PLATFORMS.map((platform) => accountMap[platform] || { platform, is_connected: false });
  res.json({ data: result });
});

const upsertAccount = asyncHandler(async (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ message: 'Invalid platform' });
  }

  const [account] = await SocialAccount.findOrCreate({ where: { platform } });
  const payload = buildUpdatePayload(req.body);
  await account.update({ ...payload, is_connected: true });

  res.json({ message: 'Account saved', data: maskAccount(account) });
});

const disconnectAccount = asyncHandler(async (req, res) => {
  const { platform } = req.params;
  const account = await SocialAccount.findOne({ where: { platform } });
  if (account) await account.update({ is_connected: false });
  res.json({ message: 'Disconnected' });
});

const testConnection = asyncHandler(async (req, res) => {
  const { platform } = req.params;
  const account = await SocialAccount.findOne({ where: { platform } });
  if (!account || !account.is_connected) {
    return res.status(400).json({ success: false, message: 'Account not configured' });
  }

  try {
    if (platform === 'facebook' && account.page_access_token && account.page_id) {
      const resp = await axios.get(`https://graph.facebook.com/v18.0/${account.page_id}?fields=name&access_token=${account.page_access_token}`);
      return res.json({ success: true, name: resp.data.name });
    }

    if (platform === 'instagram' && account.page_access_token && account.instagram_account_id) {
      const resp = await axios.get(`https://graph.facebook.com/v18.0/${account.instagram_account_id}?fields=username&access_token=${account.page_access_token}`);
      return res.json({ success: true, name: resp.data.username });
    }

    if (platform === 'linkedin' && account.linkedin_access_token && account.linkedin_org_id) {
      const resp = await axios.get(`https://api.linkedin.com/v2/organizations/${account.linkedin_org_id}`, {
        headers: { Authorization: `Bearer ${account.linkedin_access_token}` },
      });
      return res.json({ success: true, name: resp.data.localizedName });
    }

    if (platform === 'twitter' && account.twitter_api_key) {
      return res.json({ success: true, message: 'Twitter credentials saved (verify by posting)' });
    }

    return res.json({ success: true, message: 'Credentials saved' });
  } catch (error) {
    return res.json({
      success: false,
      message: error.response?.data?.error?.message || error.response?.data?.message || error.message,
    });
  }
});

module.exports = { listAccounts, upsertAccount, disconnectAccount, testConnection };
