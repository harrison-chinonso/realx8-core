/**
 * Why Google sign-in is refused — without printing any secret.
 *
 * "Access blocked: This app's request is invalid" is Google declining to start
 * the flow, and it says nothing about which of several causes applied. This
 * checks each one and reports the SHAPE of a credential, never its value, so
 * it is safe to run on a production shell and paste the output.
 *
 *   node scripts/diagnose-google-oauth.js
 *
 * Works on MySQL and Postgres.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { Sequelize, QueryTypes } = require('sequelize');

const CLIENT_ID_PATTERN = /\.apps\.googleusercontent\.com$/;
const SECRET_PATTERN = /^GOCSPX-/;

const describe = (value) => {
  if (!value) return { kind: 'missing', text: 'not set' };
  const text = String(value).trim();
  if (CLIENT_ID_PATTERN.test(text)) return { kind: 'client_id', text: `a CLIENT ID (…${text.slice(-28)})` };
  if (SECRET_PATTERN.test(text)) return { kind: 'secret', text: `a CLIENT SECRET (GOCSPX-…, ${text.length} chars)` };
  return { kind: 'unknown', text: `an unrecognised value (${text.length} chars)` };
};

const problems = [];
const notes = [];

(async () => {
  // Reuse whatever the app is configured with, whichever engine that is.
  const dialect = (process.env.DB_DIALECT || (process.env.DATABASE_URL ? 'postgres' : 'mysql'));
  let sequelize;
  if (process.env.DATABASE_URL) {
    sequelize = new Sequelize(process.env.DATABASE_URL, { dialect: 'postgres', logging: false });
  } else {
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
      host: process.env.DB_HOST, port: process.env.DB_PORT || (dialect === 'postgres' ? 5432 : 3306),
      dialect, logging: false,
    });
  }

  const { q } = require('../shared/src/dialect');
  let stored = {};
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'key')}, ${q(sequelize, 'value')} FROM settings
        WHERE ${q(sequelize, 'key')} IN ('google_client_id','google_client_secret','google_callback_url')
          AND company_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (error) {
    notes.push(`Could not read the settings table (${error.message.split('\n')[0]}). Env values would be used.`);
  }

  /**
   * The settings table WINS over the environment.
   *
   * This is the detail that makes the failure confusing: correcting an
   * environment variable on the host changes nothing while a row exists in the
   * database, so the deployment looks like it is ignoring its own config.
   */
  const effective = {
    clientID: stored.google_client_id || process.env.GOOGLE_CLIENT_ID,
    clientSecret: stored.google_client_secret || process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: stored.google_callback_url || process.env.GOOGLE_CALLBACK_URL,
  };
  const source = (key, envName) => (stored[key] ? 'settings table' : (process.env[envName] ? 'environment' : 'nowhere'));

  console.log('\n── What the application will actually use ───────────────────────');
  const id = describe(effective.clientID);
  const secret = describe(effective.clientSecret);
  console.log(`  client id      ${id.text}   [from ${source('google_client_id', 'GOOGLE_CLIENT_ID')}]`);
  console.log(`  client secret  ${secret.text}   [from ${source('google_client_secret', 'GOOGLE_CLIENT_SECRET')}]`);
  console.log(`  callback url   ${effective.callbackURL || 'not set'}   [from ${source('google_callback_url', 'GOOGLE_CALLBACK_URL')}]`);

  // ── The other thing that produces "Invalid or expired token" ────────────
  try {
    const rows = await sequelize.query(
      `SELECT ${q(sequelize, 'value')} FROM settings
        WHERE ${q(sequelize, 'key')} = 'jwt_secret' AND company_id IS NULL LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    const stored = rows[0]?.value;
    const configured = process.env.JWT_SECRET;
    console.log('\n── JWT secret ──────────────────────────────────────────────────');
    console.log(`  JWT_SECRET in environment : ${configured ? `set (${configured.length} chars)` : 'NOT SET'}`);
    console.log(`  jwt_secret in settings    : ${stored ? `set (${stored.length} chars)` : 'no row'}`);
    if (configured && stored && configured !== stored) {
      console.log('  -> They DIFFER. The environment wins, which is correct — but the settings row');
      console.log('     is stale and worth removing. Before this was fixed, signing used the row');
      console.log('     and verification used the environment, so signing in succeeded and every');
      console.log('     API call returned "Invalid or expired token".');
    } else if (!configured && stored) {
      console.log('  -> Only the database has it. It is adopted at boot so tokens verify, but set');
      console.log('     JWT_SECRET in the environment: a secret kept only in the database travels');
      console.log('     with every dump and restore of that database.');
    } else if (!configured && !stored) {
      console.log('  -> Neither is set, so the built-in default is in use. Fine locally, not in production.');
    } else {
      console.log('  -> Consistent.');
    }
  } catch {
    // Settings unreadable; the Google findings below are still worth printing.
  }

  console.log('\n── Findings ────────────────────────────────────────────────────');

  if (id.kind === 'secret' && secret.kind === 'client_id') {
    problems.push('The client id and client secret are SWAPPED. A Google client id ends '
      + '".apps.googleusercontent.com" and a secret starts "GOCSPX-". Swap them back.');
  } else {
    if (id.kind !== 'client_id') {
      problems.push(`The client id does not look like one — it is ${id.text}. `
        + 'A Google client id ends ".apps.googleusercontent.com".');
    }
    if (secret.kind !== 'secret') {
      problems.push(`The client secret does not look like one — it is ${secret.text}. `
        + 'A Google client secret starts "GOCSPX-".');
    }
  }

  const callback = String(effective.callbackURL || '');
  if (!callback) {
    problems.push('No callback URL is set, so the default localhost one is used — Google will reject it in production.');
  } else if (/localhost|127\.0\.0\.1/.test(callback) && process.env.NODE_ENV === 'production') {
    problems.push(`The callback URL is ${callback} on a production deployment. `
      + 'This is what a database restored from a development dump looks like: the settings row '
      + 'overrides the environment variable, so fixing the env var alone changes nothing.');
  } else if (!/^https:/.test(callback) && !/localhost|127\.0\.0\.1/.test(callback)) {
    problems.push(`The callback URL is not HTTPS (${callback}). Google requires HTTPS for non-localhost.`);
  }

  const frontend = process.env.FRONTEND_URL || '';
  if (frontend.endsWith('/')) {
    notes.push(`FRONTEND_URL ends with a slash (${frontend}). Anything joining a path onto it `
      + 'produces a double slash, which some redirect allow-lists treat as a different URL.');
  }

  if (!problems.length) {
    console.log('  Nothing wrong with the credentials themselves.');
    console.log('  If Google still refuses, the remaining cause is on Google\'s side: the exact');
    console.log('  callback URL below must be listed under "Authorised redirect URIs" for this');
    console.log('  OAuth client, character for character, including scheme and any trailing path.');
    console.log(`\n     ${callback}\n`);
  } else {
    problems.forEach((problem, i) => console.log(`  ${i + 1}. ${problem}\n`));
    console.log('  After fixing, restart the service: the credentials are read once at boot.\n');
  }

  if (notes.length) {
    console.log('── Worth knowing ───────────────────────────────────────────────');
    notes.forEach((note) => console.log(`  - ${note}`));
    console.log('');
  }

  await sequelize.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ABORTED:', e.message); process.exit(1); });
