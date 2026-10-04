const { appleAppSiteAssociation, androidAssetLinks } = require('../../../../shared/src/appLinks');

/**
 * Served at the web host's /.well-known/ (forwarded here by Realx8-Ui's
 * vercel.json): the files that let company links open the mobile app.
 * See shared/src/appLinks.js for what they contain and where it comes from.
 *
 * Plain JSON with no redirects — iOS refuses the association file otherwise —
 * and a 404 while unconfigured, so a platform caches "no app" rather than a
 * file naming nothing.
 */
const send = (res, body) => {
  if (!body) return res.status(404).json({ message: 'App links are not configured.' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/json');
  return res.send(JSON.stringify(body));
};

const appleAssociation = (req, res) => send(res, appleAppSiteAssociation());
const assetLinks = (req, res) => send(res, androidAssetLinks());

module.exports = { appleAssociation, assetLinks };
