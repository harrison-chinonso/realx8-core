/**
 * The compulsory-receipt rule, against a real database.
 *
 * The rule itself is one boolean, and a boolean is not what goes wrong. What
 * goes wrong is the resolution around it: which company's setting is read, what
 * a blank value means, what an unrecognised value means, and whether a lookup
 * that fails blocks every approval on the platform. Each of those is a
 * different way for a company to find it cannot approve payments, so each is
 * asserted here against the REAL settings table and the REAL resolver.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const { QueryTypes } = require('sequelize');
const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_receipt_policy`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }

process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyreceiptpolicy';

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

  const { sequelize } = require('../services/finance-service/src/config/database');
  const userModels = require('../services/user-service/src/models');
  await userModels.Setting.sync({ force: true });

  const {
    requiresCompanyReceipt, parseToggle, SETTINGS_GROUP, SETTING_KEY,
  } = require('../shared/src/receiptPolicy');

  const set = async (companyId, value) => {
    await sequelize.query(
      `DELETE FROM settings WHERE \`group\` = :group AND \`key\` = :key
        AND (company_id ${companyId === null ? 'IS NULL' : '= :companyId'})`,
      { replacements: { group: SETTINGS_GROUP, key: SETTING_KEY, companyId }, type: QueryTypes.DELETE },
    );
    if (value === undefined) return;
    await sequelize.query(
      `INSERT INTO settings (\`key\`, \`value\`, \`group\`, company_id, created_at)
       VALUES (:key, :value, :group, :companyId, NOW())`,
      {
        replacements: { key: SETTING_KEY, value, group: SETTINGS_GROUP, companyId },
        type: QueryTypes.INSERT,
      },
    );
  };

  console.log('\n── The default, which is what every company gets today ─────────');
  {
    /**
     * The one that matters most on the day this ships. Making it compulsory for
     * everybody would stop every admin on every company approving anything,
     * including the companies that issue no receipt at all.
     */
    check('A company that has never been asked does not require a receipt',
      (await requiresCompanyReceipt(sequelize, 1)) === false,
      'nobody\'s approval flow changes until they choose it');

    check('...and neither does a caller with no company at all',
      (await requiresCompanyReceipt(sequelize, null)) === false);
  }

  console.log('\n── Switching it on ─────────────────────────────────────────────');
  {
    await set(1, 'on');
    check('A company that switches it on requires one',
      (await requiresCompanyReceipt(sequelize, 1)) === true);

    check('...and it applies to that company only',
      (await requiresCompanyReceipt(sequelize, 2)) === false,
      'company 2 never asked for it');

    await set(1, 'off');
    check('Switching it back off takes effect',
      (await requiresCompanyReceipt(sequelize, 1)) === false);
  }

  console.log('\n── Precedence and blanks ───────────────────────────────────────');
  {
    await set(null, 'on');      // the platform-wide default
    await set(1, undefined);    // company 1 says nothing
    check('A company with no row of its own inherits the platform setting',
      (await requiresCompanyReceipt(sequelize, 1)) === true);

    await set(1, 'off');
    check('...and its own row overrides the platform one',
      (await requiresCompanyReceipt(sequelize, 1)) === false,
      'a company must be able to opt out of a platform default');

    /**
     * Blank means "inherit", by the convention the settings screen documents.
     * Reading it as "off" would make a company that cleared the box silently
     * diverge from the platform default they meant to fall back to.
     */
    await set(1, '');
    check('A blank company value inherits rather than meaning off',
      (await requiresCompanyReceipt(sequelize, 1)) === true);

    await set(null, undefined);
    await set(1, '');
    check('...and with nothing above it, a blank is the default',
      (await requiresCompanyReceipt(sequelize, 1)) === false);
  }

  console.log('\n── Values nobody recognises ────────────────────────────────────');
  {
    check('Only an explicit affirmative is read as on',
      parseToggle('on') === true && parseToggle('true') === true
        && parseToggle('YES') === true && parseToggle('1') === true);
    check('...and an explicit negative as off',
      parseToggle('off') === false && parseToggle('no') === false && parseToggle('0') === false);
    check('...while anything else means "not set", not "on"',
      parseToggle('maybe') === null && parseToggle('') === null && parseToggle(null) === null,
      'switching enforcement on because somebody typed something odd would block '
      + 'approvals for a reason nobody could find');

    await set(1, 'banana');
    check('An unrecognised stored value falls through to the default',
      (await requiresCompanyReceipt(sequelize, 1)) === false);
  }

  console.log('\n── When the lookup itself fails ────────────────────────────────');
  {
    /**
     * The conservative direction here is to LET THE APPROVAL THROUGH. The
     * alternative is that a database hiccup stops a company approving any
     * payment at all — a far worse failure than one payment approved without
     * its receipt attached.
     */
    await sequelize.query('DROP TABLE settings');
    check('A broken settings table does not block every approval on the platform',
      (await requiresCompanyReceipt(sequelize, 1)) === false,
      'failing closed here would take payments down for a reporting-grade fault');
  }

  console.log('\n── Results ─────────────────────────────────────────────────────\n');
  console.log(`  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} checks passed.\x1b[0m`);

  await sequelize.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  console.log(`\n  Scratch database ${DB} dropped.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\x1b[31mThe verification itself failed:\x1b[0m', error);
  process.exit(1);
});
