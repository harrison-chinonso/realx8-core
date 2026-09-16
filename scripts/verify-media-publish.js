/**
 * Publishing a media post, and what happens when a channel cannot take it.
 *
 * ── The failure this locks out ──────────────────────────────────────────────
 *
 * A post sent to YouTube came back "Published with 1 error(s)" — shown in the
 * same green as a success — and was recorded as published while sitting on no
 * channel at all. socialPublisher has no YouTube implementation; the controller
 * marked the post published regardless, announced it to the company as live,
 * and left nothing to retry, because its status said the work was done.
 *
 * Driven through the real controller against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_media_publish`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifymediapub';

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

(async () => {
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\``);

  /*
   * The publisher is stubbed BEFORE the controller is required, because the
   * controller destructures publishPost at require time. Everything else —
   * scoping, the status transition, the reply — is the real thing.
   */
  const publisher = require('../services/user-service/src/utils/socialPublisher');
  const realPublish = publisher.publishPost;
  publisher.publishPost = async (account, post) => realPublish(account, post);

  const models = require('../services/user-service/src/models');
  const { sequelize, MediaPost, SocialAccount } = models;
  await sequelize.sync({ force: true });

  // Both foreign keys are real: a post needs an author, an author needs a
  // company. Created through the models so their own defaults apply.
  const { Company, User } = models;
  await Company.create({ id: 1, name: 'Verify Co', slug: 'verify-co', email: 'verify@example.test' });
  await User.create({
    id: 1, name: 'Publisher', email: 'publisher@example.test',
    password: 'x', type: 'admin', company_id: 1,
  });

  const controller = require('../services/user-service/src/controllers/mediaController');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  const user = { id: 1, company_id: 1, type: 'admin' };
  const makePost = (channels) => MediaPost.create({
    title: 'Launch announcement', body: 'Hello', type: 'social',
    status: 'approved', channels, company_id: 1, created_by: 1,
  });

  console.log('\n── A channel nothing can post to ────────────────────────────────');
  {
    await SocialAccount.create({ platform: 'youtube', is_connected: true, company_id: 1, youtube_access_token: 'x' });
    const post = await makePost(['youtube']);
    const out = await run(controller.publishPost, { user, params: { id: String(post.id) } });
    await post.reload();

    check('The request is refused rather than reported as a success',
      out.code === 422, `HTTP ${out.code} — ${out.body?.message}`);
    check('...the post is NOT recorded as published',
      post.status === 'approved' && post.published_at == null,
      `status ${post.status}, published_at ${post.published_at}`);
    check('...and the reply names the channel and the reason',
      /youtube/i.test(out.body?.message || '') && /analytics/i.test(out.body?.message || ''),
      out.body?.message);
  }

  console.log('\n── A channel with no account connected ──────────────────────────');
  {
    const post = await makePost(['linkedin']);
    const out = await run(controller.publishPost, { user, params: { id: String(post.id) } });
    await post.reload();
    check('Refused, and the post stays where it was',
      out.code === 422 && post.status === 'approved',
      `HTTP ${out.code}, status ${post.status} — ${out.body?.message}`);
  }

  console.log('\n── One channel works, another does not ──────────────────────────');
  {
    publisher.publishPost = async (account) => {
      if (account.platform === 'facebook') return { platform: 'facebook', id: 'fb-123' };
      return realPublish(account, {});
    };
    delete require.cache[require.resolve('../services/user-service/src/controllers/mediaController')];
    const fresh = require('../services/user-service/src/controllers/mediaController');

    await SocialAccount.create({ platform: 'facebook', is_connected: true, company_id: 1, facebook_access_token: 'x' });
    const post = await makePost(['facebook', 'youtube']);
    const out = await run(fresh.publishPost, { user, params: { id: String(post.id) } });
    await post.reload();

    check('It IS published — one channel genuinely took it',
      out.code === 200 && post.status === 'published', `HTTP ${out.code}, status ${post.status}`);
    check('...the reply says where it went and where it did not',
      /facebook/i.test(out.body?.message || '') && /youtube/i.test(out.body?.message || ''),
      out.body?.message);
    check('...and the caller can still see the failure',
      Array.isArray(out.body?.errors) && out.body.errors.length === 1,
      JSON.stringify(out.body?.errors));
    check('...with the platform id of the one that worked recorded',
      post.platform_post_ids?.facebook === 'fb-123', JSON.stringify(post.platform_post_ids));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
