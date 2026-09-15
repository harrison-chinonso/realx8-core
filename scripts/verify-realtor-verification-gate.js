/**
 * An unverified realtor earns, but cannot be paid and cannot refer.
 *
 * ── The shape of the rule ───────────────────────────────────────────────────
 *
 * Verification gates the doors money and clients come through, and nothing
 * else. Commission still accrues; entitlements are untouched; nothing already
 * earned is forfeited or hidden. What is refused is:
 *
 *   * asking for a payout, by the realtor, either per commission or for their
 *     whole statement;
 *   * being paid, by an administrator raising a debit note against them — and
 *     by the payout run, which raises one down a different code path and is
 *     therefore the door most likely to be left open;
 *   * referring anybody, which for this platform means minting a property
 *     share link, because the code that link carries IS the referral.
 *
 * ── What has no symptom ─────────────────────────────────────────────────────
 *
 * A gate that silently lets somebody through looks exactly like a gate that
 * held. Nothing errors, no row looks wrong, and the only evidence is a payment
 * that should not have gone out or a client credited to a realtor who was never
 * verified. So each gate is checked in BOTH directions — refused while
 * unverified, allowed once approved — because a guard that refuses everybody is
 * just as broken and far easier to notice.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_kyc_gate`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifykycgate';

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

  const { sequelize } = require('../services/user-service/src/models');
  await sequelize.query(`CREATE TABLE realtor_kyc (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    company_id INT UNSIGNED NULL
  )`);
  await sequelize.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, name VARCHAR(120))');
  await sequelize.query("INSERT INTO users (id, name) VALUES (1, 'Grace Nwosu'), (2, 'Chidi Okafor'), (3, 'Ada Obi')");

  const {
    realtorVerification, staffBlockedMessage, realtorBlockedMessage,
    realtorReferralBlockedMessage, resetVerificationCache,
  } = require('../shared/src/realtorVerification');

  console.log('\n── The question itself ──────────────────────────────────────────');
  {
    // 1 has never submitted, 2 is pending, 3 is approved.
    await sequelize.query("INSERT INTO realtor_kyc (user_id, status) VALUES (2, 'pending'), (3, 'approved')");

    const never = await realtorVerification(sequelize, 1);
    check('A realtor who never submitted is not verified',
      never.verified === false && never.status === null, JSON.stringify(never));

    const pending = await realtorVerification(sequelize, 2);
    check('A realtor awaiting review is not verified',
      pending.verified === false && pending.status === 'pending', JSON.stringify(pending));

    const approved = await realtorVerification(sequelize, 3);
    check('An approved realtor is verified', approved.verified === true, JSON.stringify(approved));

    /*
     * A rejection followed by a resubmission leaves two rows. The LATEST is the
     * answer — reading the first would keep somebody blocked forever after one
     * rejection, however many times they corrected it.
     */
    await sequelize.query("INSERT INTO realtor_kyc (user_id, status) VALUES (1, 'rejected'), (1, 'approved')");
    const resubmitted = await realtorVerification(sequelize, 1);
    check('A resubmission after a rejection is read, not the rejection',
      resubmitted.verified === true, JSON.stringify(resubmitted));
  }

  console.log('\n── What each person is told ─────────────────────────────────────');
  {
    const staff = staffBlockedMessage('Grace Nwosu', 'pending');
    check('An administrator is told who, why, and where to fix it',
      staff.includes('Grace Nwosu') && /not been reviewed/.test(staff) && /Realtor Verification/.test(staff),
      staff);

    const submit = realtorBlockedMessage(null);
    const wait = realtorBlockedMessage('pending');
    const fix = realtorBlockedMessage('rejected');
    check('A realtor is told to submit, to wait, or to correct — not the same sentence',
      new Set([submit, wait, fix]).size === 3
        && /Profile → Verification/.test(submit) && /still being reviewed/.test(wait) && /again/.test(fix));

    check('...and is reassured the commission is not lost',
      [submit, wait, fix].every((m) => /accru|safe/i.test(m)));

    check('Referral refusals say something different from payout refusals',
      realtorReferralBlockedMessage('pending') !== wait
        && /share properties or refer/.test(realtorReferralBlockedMessage('pending')),
      realtorReferralBlockedMessage('pending'));
  }

  console.log('\n── A deployment with no verification table ──────────────────────');
  {
    /*
     * The table arrived after the commission engine. On an older database it is
     * missing, and refusing every payout because a migration has not run would
     * be a worse failure than the one this guard prevents.
     */
    resetVerificationCache();
    await sequelize.query('DROP TABLE realtor_kyc');
    const answer = await realtorVerification(sequelize, 1);
    check('Payment proceeds where verification is not in force',
      answer.verified === true && answer.enforced === false, JSON.stringify(answer));
    check('...and says so, so a caller can tell it apart from a real approval',
      answer.enforced === false);
  }

  console.log('\n── Attribution: an unverified realtor refers nobody ─────────────');
  {
    resetVerificationCache();
    await sequelize.query(`CREATE TABLE realtor_kyc (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', company_id INT UNSIGNED NULL
    )`);
    await sequelize.query('DROP TABLE users');
    await sequelize.query(`CREATE TABLE users (
      id INT UNSIGNED PRIMARY KEY, name VARCHAR(120), type VARCHAR(30),
      realtor_code VARCHAR(30), company_id INT UNSIGNED, deleted_at DATETIME NULL
    )`);
    await sequelize.query(`CREATE TABLE companies (
      id INT UNSIGNED PRIMARY KEY, name VARCHAR(120), referral_code VARCHAR(30), status VARCHAR(20)
    )`);
    await sequelize.query("INSERT INTO companies VALUES (1, 'Acme Realty', 'ACME', 'active')");
    await sequelize.query(`INSERT INTO users (id, name, type, realtor_code, company_id) VALUES
      (10, 'Unverified Realtor', 'realtor', 'UNV1', 1),
      (11, 'Verified Realtor', 'realtor', 'VER1', 1)`);
    await sequelize.query("INSERT INTO realtor_kyc (user_id, status) VALUES (10, 'pending'), (11, 'approved')");

    const { resolveSignup } = require('../shared/src/signupAttribution');

    const viaUnverified = await resolveSignup(sequelize, { realtorCode: 'UNV1' });
    check('A buyer following an unverified realtor’s link still reaches the company',
      viaUnverified.ok === true && viaUnverified.company?.id === 1,
      JSON.stringify(viaUnverified.company));
    check('...but the realtor is not credited for them',
      viaUnverified.realtor === null, JSON.stringify(viaUnverified.realtor));

    const viaVerified = await resolveSignup(sequelize, { realtorCode: 'VER1' });
    check('A verified realtor IS credited',
      Number(viaVerified.realtor?.id) === 11, JSON.stringify(viaVerified.realtor));

    const withCompanyCode = await resolveSignup(sequelize, { companyCode: 'ACME', realtorCode: 'UNV1' });
    check('The same holds when a company code is given too',
      withCompanyCode.ok === true && withCompanyCode.realtor === null,
      JSON.stringify(withCompanyCode.realtor));

    const bothVerified = await resolveSignup(sequelize, { companyCode: 'ACME', realtorCode: 'VER1' });
    check('...and a verified one is still credited on that path',
      Number(bothVerified.realtor?.id) === 11, JSON.stringify(bothVerified.realtor));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
