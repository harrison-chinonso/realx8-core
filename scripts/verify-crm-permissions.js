/**
 * Every CRM route asks for a permission, and the right one.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * The CRM service had `verifyToken` and nothing else. Company scoping in the
 * controllers kept one tenant out of another's data, and that was mistaken for
 * authorisation — but scoping answers "whose rows", not "may you". Measured
 * against the running API, a CLIENT account holding five permissions, none of
 * them crm.*, called GET /leads and got the company's lead list back with
 * names, email addresses and phone numbers. The menu hides CRM from a client
 * entirely, which is the trap: the navigation looked like a boundary and was
 * only ever a convenience.
 *
 * ── Why it walks the router rather than calling handlers ───────────────────
 *
 * The defect was never in a handler. It was a missing line in a routes file,
 * and the only way to catch that class of bug is to read what the router
 * actually mounted. So this walks the real Express stack, finds the guard on
 * each layer, and asserts against a table written out by hand — which means
 * adding a route without a guard fails here, and adding one with the WRONG
 * guard fails too.
 *
 * It then drives requirePermission with each role's real permission set, so
 * the table is checked against what the catalogue actually grants rather than
 * against what somebody assumed it grants.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/**
 * What each route must require. Written out rather than derived, so that a
 * route quietly losing its guard cannot also quietly update its expectation.
 */
const EXPECTED = {
  'GET /crm/analytics': 'crm.analytics.view',
  'GET /analytics/agent-performance': 'crm.analytics.view',

  'GET /pipelines': 'crm.leads.view',
  'POST /pipelines': 'crm.pipelines.manage',
  'GET /pipelines/:id': 'crm.leads.view',
  'PUT /pipelines/:id': 'crm.pipelines.manage',
  'DELETE /pipelines/:id': 'crm.pipelines.manage',

  'GET /stages': 'crm.leads.view',
  'POST /stages': 'crm.pipelines.manage',
  'GET /stages/:id': 'crm.leads.view',
  'PUT /stages/:id': 'crm.pipelines.manage',
  'DELETE /stages/:id': 'crm.pipelines.manage',

  'GET /sources': 'crm.leads.view',
  'POST /sources': 'crm.pipelines.manage',
  'GET /sources/:id': 'crm.leads.view',
  'PUT /sources/:id': 'crm.pipelines.manage',
  'DELETE /sources/:id': 'crm.pipelines.manage',

  'GET /labels': 'crm.leads.view',
  'POST /labels': 'crm.pipelines.manage',
  'GET /labels/:id': 'crm.leads.view',
  'PUT /labels/:id': 'crm.pipelines.manage',
  'DELETE /labels/:id': 'crm.pipelines.manage',

  'GET /lead-stages': 'crm.leads.view',
  'POST /lead-stages': 'crm.pipelines.manage',
  'DELETE /lead-stages/:id': 'crm.pipelines.manage',

  'GET /task-stages': 'crm.tasks.view',
  'POST /task-stages': 'crm.tasks.manage',

  'GET /leads': 'crm.leads.view',
  'POST /leads/from-chatbot': 'crm.leads.create',
  'POST /leads': 'crm.leads.create',
  'GET /leads/:id/score-details': 'crm.leads.view',
  'GET /leads/:id/follow-up-suggestion': 'crm.leads.view',
  'POST /leads/:id/auto-assign': 'crm.leads.manage',
  'GET /leads/:id/activities': 'crm.leads.view',
  'GET /leads/:id': 'crm.leads.view',
  'PUT /leads/:id': 'crm.leads.manage',
  'DELETE /leads/:id': 'crm.leads.manage',

  'GET /objections': 'crm.objections.view',
  'POST /objections': 'crm.objections.manage',
  'DELETE /objections/:id': 'crm.objections.manage',

  'GET /deals': 'crm.deals.view',
  'POST /deals': 'crm.deals.manage',
  'GET /deals/:id': 'crm.deals.view',
  'PUT /deals/:id': 'crm.deals.manage',
  'DELETE /deals/:id': 'crm.deals.manage',
  'GET /deals/:id/tasks': 'crm.deals.view',

  'GET /tasks': 'crm.tasks.view',
  'POST /tasks': 'crm.tasks.manage',
  'GET /tasks/:id': 'crm.tasks.view',
  'PUT /tasks/:id': 'crm.tasks.manage',
  'DELETE /tasks/:id': 'crm.tasks.manage',

  'GET /activities': 'crm.leads.view',
  'POST /activities': 'crm.leads.create',
};

(async () => {
  const router = require('../services/crm-service/src/routes');
  const { requirePermission } = require('../shared/src/middleware/auth');

  /*
   * Which permission a mounted layer requires, discovered by RUNNING its
   * middleware rather than by reading the source. A guard that is present but
   * miswired — the wrong name, or a function that lets everything through —
   * reads identically in the source and differently here.
   */
  const permissionOf = (layer) => {
    const stack = layer.route?.stack || [];
    for (const entry of stack) {
      if (entry.name !== 'requirePermission' && !String(entry.handle).includes('permission')) continue;
      const held = [];
      const req = { user: { id: 1, type: 'admin', permissions: held } };
      let refused = false;
      const res = { status() { refused = true; return res; }, json() { return res; } };
      // Binary search is overkill: ask the guard about each known permission.
      for (const name of new Set(Object.values(EXPECTED))) {
        held.length = 0; held.push(name); refused = false;
        entry.handle(req, res, () => {});
        if (!refused) return name;
      }
      return '(a guard that accepted nothing known)';
    }
    return null;
  };

  const mounted = new Map();
  router.stack.filter((l) => l.route).forEach((layer) => {
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    mounted.set(`${method} ${layer.route.path}`, permissionOf(layer));
  });

  console.log('\n── Every route is guarded ───────────────────────────────────────');
  {
    const ungated = [...mounted].filter(([, perm]) => !perm).map(([key]) => key);
    check(`All ${mounted.size} CRM routes require a permission`, ungated.length === 0,
      ungated.length ? ungated.join(', ') : `${mounted.size} routes`);
  }

  console.log('\n── And each one requires the RIGHT permission ───────────────────');
  {
    const wrong = [];
    for (const [key, expected] of Object.entries(EXPECTED)) {
      if (!mounted.has(key)) { wrong.push(`${key} is not mounted at all`); continue; }
      const actual = mounted.get(key);
      if (actual !== expected) wrong.push(`${key} wants ${actual}, expected ${expected}`);
    }
    check('Every route matches the table', wrong.length === 0, wrong.slice(0, 6).join('\n        '));

    const unexpected = [...mounted.keys()].filter((key) => !(key in EXPECTED));
    /*
     * A new route with no entry here is a failure, not a pass. The whole point
     * is that adding a CRM endpoint forces somebody to state its permission.
     */
    check('No route is missing from the table', unexpected.length === 0, unexpected.join(', '));
  }

  console.log('\n── What each role can actually reach ────────────────────────────');
  {
    // The catalogue's real grants, read from the migration rather than retyped.
    const source = require('fs').readFileSync(
      path.join(__dirname, '..', 'services/user-service/src/migrations/permissionCatalog.js'), 'utf8',
    );
    const permsFor = (role) => {
      const at = source.indexOf(`\n  ${role}: [`);
      if (at === -1) return [];
      const end = source.indexOf('\n  ],', at);
      return [...source.slice(at, end).matchAll(/'([a-z.-]+)'/g)].map((m) => m[1]);
    };

    const reaches = (permissions, key) => {
      const needed = mounted.get(key);
      if (!needed) return true;
      let refused = false;
      const res = { status() { refused = true; return res; }, json() { return res; } };
      requirePermission(needed)({ user: { id: 1, type: 'admin', permissions } }, res, () => {});
      return !refused;
    };

    const client = permsFor('client');
    check('A client holds no crm permission at all',
      !client.some((p) => p.startsWith('crm.')), client.join(', '));
    /*
     * The measured defect, now asserted. This exact call returned the company's
     * lead list — names, emails and phone numbers — to an account whose menu
     * does not show CRM at all.
     */
    check('...so GET /leads is refused to them', !reaches(client, 'GET /leads'), 'was 200 with the company lead list');
    check('...and so is POST /leads', !reaches(client, 'POST /leads'));
    check('...and GET /deals', !reaches(client, 'GET /deals'));
    check('...and GET /tasks', !reaches(client, 'GET /tasks'));

    const realtor = permsFor('realtor');
    check('A realtor may still read leads', reaches(realtor, 'GET /leads'), realtor.filter((p) => p.startsWith('crm.')).join(', '));
    check('...and create one', reaches(realtor, 'POST /leads'));
    /*
     * Deliberate, and now actually enforced: the catalogue gives a realtor
     * view and create but not manage. This is the one behaviour change a
     * realtor will notice, which is why the buttons are hidden to match.
     */
    check('...but not edit or delete one',
      !reaches(realtor, 'PUT /leads/:id') && !reaches(realtor, 'DELETE /leads/:id'),
      'the page hides Edit and Delete for them to match');
    check('...and their board still loads its pipelines and stages',
      reaches(realtor, 'GET /pipelines') && reaches(realtor, 'GET /stages')
        && reaches(realtor, 'GET /sources') && reaches(realtor, 'GET /labels'),
      'gating these on crm.pipelines.manage would have emptied their board');
    check('...though they cannot reconfigure them',
      !reaches(realtor, 'POST /pipelines') && !reaches(realtor, 'DELETE /stages/:id'));
    check('Their task board works end to end',
      reaches(realtor, 'GET /tasks') && reaches(realtor, 'POST /tasks') && reaches(realtor, 'PUT /tasks/:id'));

    const admin = permsFor('admin');
    check('An admin reaches every CRM route',
      [...mounted.keys()].every((key) => reaches(admin, key)),
      [...mounted.keys()].filter((key) => !reaches(admin, key)).join(', ') || 'all 53');

    const employee = permsFor('employee');
    check('An employee reads leads and deals but cannot change a lead',
      reaches(employee, 'GET /leads') && reaches(employee, 'GET /deals')
        && !reaches(employee, 'PUT /leads/:id') && !reaches(employee, 'POST /leads'),
      employee.filter((p) => p.startsWith('crm.')).join(', '));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
