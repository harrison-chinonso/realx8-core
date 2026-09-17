/**
 * One ladder at a time, and what happens when a company makes it theirs.
 *
 * ── What this proves ───────────────────────────────────────────────────────
 *
 *   * a company with no rungs of its own climbs the platform's four;
 *   * saving the ladder COPIES the rungs it kept into that company, and from
 *     then on the platform's are invisible to it;
 *   * every reference moves with the copy — realtors, pending upgrade
 *     requests, commission rules, and the per-level rates buried inside a
 *     commission plan's JSON, which is the one that silently pays the wrong
 *     rate if it is missed;
 *   * other companies are untouched and stay on the platform ladder;
 *   * renaming, repricing, reordering, adding and removing all happen in one
 *     save, and the ladder either becomes what was sent or does not change;
 *   * a rung a realtor is standing on cannot be removed;
 *   * a superior admin editing the platform ladder edits it in place, copying
 *     nothing;
 *   * a new realtor starts on the bottom rung of the ladder in force, not on
 *     whichever row the database returned first.
 *
 * Driven through the real controller against a throwaway database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

const mysql = require('mysql2/promise');

const REAL_DB = process.env.DB_NAME || 'realto';
const DB = `${REAL_DB}_verify_ladder`;
if (DB === REAL_DB) { console.error('Refusing to run against the configured database.'); process.exit(1); }
process.env.DB_NAME = DB;
process.env.CACHE_PREFIX = 'verifyladder';

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

  const userModels = require('../services/user-service/src/models');
  const { sequelize, Company, User, RealtorLevel, RealtorLevelRequest } = userModels;
  await sequelize.sync({ force: true });
  await require('../services/user-service/src/migrations/addRealtorChargeFees')(sequelize);

  // The two finance tables a fork has to repoint, with only the columns it
  // touches. Built by hand rather than synced: finance's models would pull in
  // the whole service for two UPDATE statements.
  await sequelize.query(`CREATE TABLE commission_rules (
    id INT AUTO_INCREMENT PRIMARY KEY, realtor_level_id INT NULL, company_id INT NULL)`);
  await sequelize.query(`CREATE TABLE commission_plan_versions (
    id INT AUTO_INCREMENT PRIMARY KEY, plan_id INT, company_id INT NULL, config TEXT NULL)`);

  const levels = require('../services/user-service/src/controllers/realtorLevelController');
  const { defaultRealtorLevelId, ladderOwnerFor } = require('../shared/src/realtorLevel');

  const run = (handler, req) => new Promise((resolve) => {
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(body) { resolve({ code, body }); return res; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ code: 500, body: { error: err } })))
      .catch((err) => resolve({ code: 500, body: { error: err } }));
  });

  await Company.create({ id: 1, name: 'Acme Homes', slug: 'acme', email: 'a@example.test' });
  await Company.create({ id: 2, name: 'Beta Realty', slug: 'beta', email: 'b@example.test' });

  // The platform ladder, seeded by the real migration.
  await require('../services/user-service/src/migrations/globalizeRealtorLevels')(sequelize);

  const acme = { id: 100, company_id: 1, type: 'admin', isSuperiorAdmin: false };
  const beta = { id: 200, company_id: 2, type: 'admin', isSuperiorAdmin: false };
  const platform = { id: 1, company_id: null, type: 'super_admin', isSuperiorAdmin: true };

  console.log('\n── Everyone starts on the ladder the platform ships ─────────────');
  let shipped = [];
  {
    const out = await run(levels.listLevels, { user: acme, query: {} });
    shipped = out.body?.data || [];
    check('Four rungs, in order',
      shipped.map((l) => l.name).join(' → ') === 'Basic → Professional → Premium → Ambassador',
      shipped.map((l) => l.name).join(' → '));
    check('...all free to climb',
      shipped.every((l) => Number(l.levelup_fee_minor) === 0), 'every fee is zero');
    check('...owned by nobody', shipped.every((l) => l.company_id == null), 'company_id is null throughout');
    /*
     * The field the page needs and could not previously infer: the rungs look
     * identical whether they are yours or the platform's, and without this the
     * page disabled every control and read as though the levels were gone.
     */
    check('...but the company is told it may edit them',
      out.body?.editable === true && out.body?.source === 'platform',
      `editable ${out.body?.editable}, source ${out.body?.source}`);
  }

  console.log('\n── What is pointing at those rungs ──────────────────────────────');
  const professional = shipped.find((l) => l.name === 'Professional');
  const premium = shipped.find((l) => l.name === 'Premium');
  let realtor;
  {
    realtor = await User.create({
      name: 'Ada Obi', email: 'ada@example.test', password: 'x', type: 'realtor',
      company_id: 1, realtor_level_id: professional.id,
    });
    // Beta's realtor is on the same platform rung, and must stay there.
    await User.create({
      name: 'Bode Ade', email: 'bode@example.test', password: 'x', type: 'realtor',
      company_id: 2, realtor_level_id: professional.id,
    });
    await RealtorLevelRequest.create({
      user_id: realtor.id, company_id: 1, status: 'pending',
      current_level_id: professional.id, current_level_name: 'Professional',
      requested_level_id: premium.id, requested_level_name: 'Premium',
    });
    await sequelize.query(
      'INSERT INTO commission_rules (realtor_level_id, company_id) VALUES (:level, 1)',
      { replacements: { level: premium.id } },
    );
    await sequelize.query(
      'INSERT INTO commission_plan_versions (plan_id, company_id, config) VALUES (1, 1, :config)',
      {
        replacements: {
          config: JSON.stringify({
            rules: [{
              type: 'direct_sale', value_type: 'percentage',
              level_rates: [
                { level_id: professional.id, value: 3 },
                { level_id: premium.id, value: 5 },
              ],
            }],
          }),
        },
      },
    );
    check('A realtor, a pending request, a rule and a plan all name them', true,
      `Professional #${professional.id}, Premium #${premium.id}`);
  }

  console.log('\n── Acme makes the ladder theirs ─────────────────────────────────');
  let acmeLadder = [];
  {
    const out = await run(levels.saveLadder, {
      user: acme,
      body: {
        levels: [
          // Kept as shipped.
          { id: shipped[0].id, name: 'Basic' },
          // Renamed and priced — the edit that triggers the whole thing.
          { id: professional.id, name: 'Associate', commission_percentage: 3, levelup_fee_minor: 500000 },
          { id: premium.id, name: 'Premium', commission_percentage: 5, levelup_fee_minor: 1500000 },
          // Ambassador dropped; a brand-new rung added above.
          { name: 'Partner', commission_percentage: 8, levelup_fee_minor: 5000000 },
        ],
      },
    });
    acmeLadder = out.body?.data || [];

    check('The save is accepted', out.code === 200, `HTTP ${out.code}`);
    check('...and says the rungs were adopted',
      out.body?.adopted === 3 && out.body?.source === 'company',
      `adopted ${out.body?.adopted}, source ${out.body?.source}`);
    check('The ladder is what was sent, in the order it was sent',
      acmeLadder.map((l) => l.name).join(' → ') === 'Basic → Associate → Premium → Partner',
      acmeLadder.map((l) => l.name).join(' → '));
    check('...numbered by their place in it, nothing carried over',
      acmeLadder.map((l) => l.position).join(',') === '10,20,30,40',
      acmeLadder.map((l) => l.position).join(','));
    check('...and every rung belongs to Acme now',
      acmeLadder.every((l) => Number(l.company_id) === 1), 'company_id 1 throughout');
    check('The prices they set are on them',
      Number(acmeLadder[1].levelup_fee_minor) === 500000
        && Number(acmeLadder[3].levelup_fee_minor) === 5000000,
      `${acmeLadder[1].levelup_fee_minor}, ${acmeLadder[3].levelup_fee_minor}`);
  }

  console.log('\n── The platform ladder is untouched, and Beta is still on it ────');
  {
    const stillThere = await RealtorLevel.findAll({ where: { company_id: null }, order: [['position', 'ASC']] });
    check('All four shipped rungs survive',
      stillThere.map((l) => l.name).join(' → ') === 'Basic → Professional → Premium → Ambassador',
      stillThere.map((l) => l.name).join(' → '));

    const out = await run(levels.listLevels, { user: beta, query: {} });
    check("...and Beta sees them, not Acme's",
      (out.body?.data || []).every((l) => l.company_id == null) && out.body?.source === 'platform',
      `${out.body?.data?.length} rung(s), source ${out.body?.source}`);

    const bode = await User.findOne({ where: { email: 'bode@example.test' } });
    /*
     * The failure an unscoped UPDATE would produce: Beta's realtor dragged
     * onto a rung belonging to a company they have never heard of.
     */
    check("Beta's realtor did not move",
      Number(bode.realtor_level_id) === Number(professional.id),
      `still on #${bode.realtor_level_id}`);
  }

  console.log('\n── Everything that named the old rungs now names the new ────────');
  {
    const associate = acmeLadder.find((l) => l.name === 'Associate');
    const newPremium = acmeLadder.find((l) => l.name === 'Premium');

    await realtor.reload();
    check('The realtor is on the copy, keeping their standing',
      Number(realtor.realtor_level_id) === Number(associate.id),
      `#${realtor.realtor_level_id} (Associate), was #${professional.id}`);

    const request = await RealtorLevelRequest.findOne({ where: { user_id: realtor.id } });
    check('Their pending upgrade points at the copy',
      Number(request.requested_level_id) === Number(newPremium.id)
        && Number(request.current_level_id) === Number(associate.id),
      `current #${request.current_level_id}, requested #${request.requested_level_id}`);
    check('...and shows the new name, not the old one',
      request.current_level_name === 'Associate', request.current_level_name);

    const [rule] = await sequelize.query('SELECT realtor_level_id FROM commission_rules',
      { type: sequelize.QueryTypes.SELECT });
    check('The commission rule follows',
      Number(rule.realtor_level_id) === Number(newPremium.id), `#${rule.realtor_level_id}`);

    /*
     * The one that costs money and announces nothing. A plan whose level_rates
     * name rungs the company has left matches no realtor, so everybody
     * silently falls back to the flat rate on the next sale.
     */
    const [version] = await sequelize.query('SELECT config FROM commission_plan_versions',
      { type: sequelize.QueryTypes.SELECT });
    const rates = JSON.parse(version.config).rules[0].level_rates;
    check('The per-level rates inside the plan follow too',
      Number(rates[0].level_id) === Number(associate.id)
        && Number(rates[1].level_id) === Number(newPremium.id),
      JSON.stringify(rates));
  }

  console.log('\n── A rung somebody is standing on cannot be pulled away ─────────');
  {
    const associate = acmeLadder.find((l) => l.name === 'Associate');
    const out = await run(levels.saveLadder, {
      user: acme,
      body: { levels: acmeLadder.filter((l) => l.id !== associate.id).map((l) => ({ id: l.id, name: l.name })) },
    });
    check('The save is refused', out.code === 409, `HTTP ${out.code}`);
    check('...naming the level and who is on it',
      /Associate/.test(out.body?.message || '') && /1 on/.test(out.body?.message || ''),
      out.body?.message);

    const after = await RealtorLevel.findAll({ where: { company_id: 1 } });
    check('...and nothing changed', after.length === 4, `${after.length} rungs`);
  }

  console.log('\n── The rest of a save is refused as a whole, too ────────────────');
  {
    const before = (await RealtorLevel.findAll({ where: { company_id: 1 }, order: [['position', 'ASC']] }))
      .map((l) => l.name).join(' → ');

    const unnamed = await run(levels.saveLadder, {
      user: acme, body: { levels: [{ name: 'Only' }, { name: '' }] },
    });
    check('A level with no name is refused, saying which',
      unnamed.code === 400 && /Level 2/.test(unnamed.body?.message || ''), unnamed.body?.message);

    const twice = await run(levels.saveLadder, {
      user: acme, body: { levels: [{ name: 'Gold' }, { name: 'gold' }] },
    });
    check('Two rungs with the same name are refused',
      twice.code === 409 && /Gold/i.test(twice.body?.message || ''), twice.body?.message);

    const empty = await run(levels.saveLadder, { user: acme, body: { levels: [] } });
    check('An empty ladder is refused', empty.code === 400, empty.body?.message);

    const foreign = await run(levels.saveLadder, {
      user: beta, body: { levels: [{ id: acmeLadder[0].id, name: 'Stolen' }] },
    });
    check("...as is editing another company's rung", foreign.code === 404, foreign.body?.message);

    const after = (await RealtorLevel.findAll({ where: { company_id: 1 }, order: [['position', 'ASC']] }))
      .map((l) => l.name).join(' → ');
    check('None of those left a mark', after === before, after);
  }

  console.log('\n── A superior admin edits the platform ladder in place ──────────');
  {
    const shippedNow = await RealtorLevel.findAll({ where: { company_id: null }, order: [['position', 'ASC']] });
    const out = await run(levels.saveLadder, {
      user: platform,
      body: {
        levels: [
          { id: shippedNow[0].id, name: 'Starter' },
          ...shippedNow.slice(1).map((l) => ({ id: l.id, name: l.name })),
        ],
      },
    });
    check('The save is accepted', out.code === 200, `HTTP ${out.code}`);
    /*
     * Nothing is copied: a platform admin already owns these rungs, so the
     * same handler that forks for a company edits in place for them.
     */
    check('...nothing was copied', out.body?.adopted === 0, `adopted ${out.body?.adopted}`);
    const count = await RealtorLevel.count({ where: { company_id: null } });
    check('...and the platform still has exactly four rungs', count === 4, `${count} rungs`);

    const beta2 = await run(levels.listLevels, { user: beta, query: {} });
    check('Beta, still on the platform ladder, sees the rename',
      (beta2.body?.data || [])[0]?.name === 'Starter', (beta2.body?.data || [])[0]?.name);

    const acme2 = await run(levels.listLevels, { user: acme, query: {} });
    check('Acme, who left, does not',
      (acme2.body?.data || [])[0]?.name === 'Basic', (acme2.body?.data || [])[0]?.name);
  }

  console.log('\n── A new realtor lands on the bottom rung of the right ladder ───');
  {
    check('Acme is on its own ladder', await ladderOwnerFor(sequelize, 1) === 1, 'owner 1');
    check('Beta is on the platform one', await ladderOwnerFor(sequelize, 2) === null, 'owner null');

    const acmeBottom = await RealtorLevel.findOne({ where: { company_id: 1 }, order: [['position', 'ASC']] });
    const betaBottom = await RealtorLevel.findOne({ where: { company_id: null }, order: [['position', 'ASC']] });

    /*
     * The bug the single-ladder rule removes. Under the old union both rungs
     * were position 10, so which one a new realtor landed on came down to row
     * order — and Acme's signups could start on the platform's Basic, a rung
     * their company had left behind.
     */
    check("Acme's next realtor starts on Acme's bottom rung",
      await defaultRealtorLevelId(sequelize, 1) === acmeBottom.id,
      `#${await defaultRealtorLevelId(sequelize, 1)} vs Acme's #${acmeBottom.id}`);
    check("Beta's starts on the platform's",
      await defaultRealtorLevelId(sequelize, 2) === betaBottom.id,
      `#${await defaultRealtorLevelId(sequelize, 2)} vs the platform's #${betaBottom.id}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sequelize.close();
  await admin.query(`DROP DATABASE \`${DB}\``);
  await admin.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
