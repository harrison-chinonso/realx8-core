/**
 * Every authenticated route is guarded, or is written down as an exception.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * The CRM service shipped with `verifyToken` and nothing else, and it was not
 * alone: 127 of 195 GET routes across the nine services had no permission
 * check. Company scoping in the controllers kept one tenant out of another's
 * data, and that was mistaken for authorisation — but scoping answers "whose
 * rows", not "may you". A client account read the company's lead list, every
 * support ticket in the company, and any colleague's record by id.
 *
 * Gating them once fixes today. This is what stops it coming back: a route
 * added tomorrow with no guard fails here, and the only way to pass is to put
 * it in EXEMPT with a reason somebody had to type.
 *
 * ── Why an exemption list rather than "guard everything" ───────────────────
 *
 * Some routes genuinely should not take a permission, and pretending otherwise
 * would be worse than the gap. Three kinds:
 *
 *   own        the handler filters on req.user.id, so there is no wider form
 *              of the route to expose — /my-notes, /commissions/mine;
 *   per-row    access is decided per record by a rule no permission name can
 *              express, such as resolveViewableUser's "your own, or your
 *              company's, or your downline's";
 *   open       deliberately available to any signed-in account, like the VAPID
 *              public key or the level ladder a realtor must read to ask to
 *              move up it.
 *
 * Writing the kind down forces the question to be answered rather than
 * shrugged at, and makes a wrong answer reviewable.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'cred.env') });

let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/**
 * Routes that carry no permission guard, and why.
 *
 * Keyed by "METHOD /path". The value is [kind, reason] — see the three kinds
 * above. Anything here is asserted to STILL be ungated, so removing a guard
 * from a gated route does not quietly pass by being added to this list, and
 * adding a guard to an exempt one makes the list stale and says so.
 */
const EXEMPT = {
  // ── own ──────────────────────────────────────────────────────────────────
  'GET /my-notes': ['own', 'listMine filters on client_id = req.user.id'],
  'GET /commissions/mine': ['own', 'scoped to req.user.id'],
  'GET /commission-statements/mine': ['own', 'scoped to req.user.id'],
  'GET /my-properties': ['own', 'defaults to req.user.id'],
  'GET /assistant/status': ['own', 'assistant handlers filter on user_id = req.user.id'],
  'GET /assistant/conversations': ['own', 'user_id = req.user.id'],
  'GET /assistant/conversations/:id': ['own', 'user_id = req.user.id'],
  'GET /dashboard/summary': ['own', "branches on the caller's own profile and id"],
  'GET /dashboard/referrals': ['own', 'downlineTreeOf(req.user.id)'],
  'GET /dashboard/my-clients': ['own', 'realtorId = req.user.id'],
  'GET /realtor-kyc/me': ['own', 'the caller’s own submission'],

  // ── per-row ──────────────────────────────────────────────────────────────
  'GET /payment-analysis/:userId': ['per-row', 'resolveViewableUser'],
  'GET /my-properties/:userId': ['per-row', 'resolveViewableUser'],
  'GET /dashboard/summary/:id': ['per-row', 'resolveViewableUser'],
  'GET /dashboard/referrals/:id/earnings': ['per-row', 'resolveViewableUser'],
  'GET /realtor-kyc': ['per-row', 'listKyc refuses anyone who is not a company reviewer'],
  'GET /realtor-levels/requests': ['per-row', 'a realtor is narrowed to their own requests'],

  // ── own: auth-service acts on the caller's own account throughout ────────
  'GET /me': ['own', 'the caller’s own user record'],
  'GET /session-key': ['own', 'the caller’s own session key'],
  'GET /passcode': ['own', 'the caller’s own passcode status'],
  'POST /passcode': ['own', 'sets the caller’s own passcode'],
  'DELETE /passcode': ['own', 'removes the caller’s own passcode'],
  'POST /2fa/setup': ['own', 'the caller’s own second factor'],
  'POST /2fa/verify-setup': ['own', 'the caller’s own second factor'],
  'POST /2fa/disable': ['own', 'the caller’s own second factor'],
  'POST /switch-role': ['own', 'switches the caller’s own active profile'],
  'POST /profiles/enable': ['own', 'enables a profile on the caller’s own account'],
  'GET /companies': ['own', 'lists the companies the caller’s own email holds accounts with'],
  'POST /switch-company': ['own', 'moves the caller into their own account at another company'],
  'POST /companies/join': ['own', 'opens an account for the caller with a company whose code they hold'],

  // ── own: writes the caller performs on their own records ─────────────────
  'POST /commission-statements/mine/request-payout': ['own', 'the realtor comes from the token, not the body'],
  'POST /commissions/:id/request-payout': ['per-row', 'refuses unless the commission is the caller’s own'],
  'POST /assistant/chat': ['own', 'the assistant answers about the caller’s own records'],
  'DELETE /assistant/conversations/:id': ['own', 'user_id = req.user.id'],
  'POST /realtor-kyc': ['own', 'a realtor submits their own verification'],
  'POST /realtor-levels/requests': ['own', 'a realtor asks to move up themselves'],
  'POST /share/token': ['own', 'minted from the caller’s identity; nothing is read from the body'],

  // ── per-row: the handler decides, and can express more than a permission ──
  'POST /realtor-kyc/:id/approve': ['per-row', 'listKyc’s isReviewer check — a company administrator'],
  'POST /realtor-kyc/:id/reject': ['per-row', 'isReviewer, as above'],
  'POST /realtor-levels/requests/:id/approve': ['per-row', 'requireCompanyAdmin in the handler'],
  'POST /realtor-levels/requests/:id/reject': ['per-row', 'requireCompanyAdmin in the handler'],
  'PUT /realtor-levels': ['per-row', 'requireManage, plus ownership of the ladder being saved'],
  'PUT /realtors/:userId/level': ['per-row', 'requireCompanyAdmin, and the realtor must be in their company'],

  // ── open ─────────────────────────────────────────────────────────────────
  'GET /notifications/push/public-key': ['open', 'the VAPID public key, handed to every subscribing browser'],
  'GET /installment-plans/units/:propertyUnitId/options': ['open', 'a buyer configuring a purchase needs a unit’s prices'],
  'GET /realtor-levels': ['open', 'a realtor must see the ladder to ask to move up it'],
};

/** Guards that count as a permission check. */
const GUARD_NAMES = ['requirePermission', 'permissionOrSelfScoped', 'requireRoles', 'staffOnly',
  'requireSuperiorAdmin', 'canConfigure', 'requireFinanceManager', 'adminOnly'];

const SERVICES = ['auth-service', 'crm-service', 'finance-service', 'investment-service',
  'notification-service', 'property-service', 'support-service', 'user-service'];

(async () => {
  /*
   * Read the route FILES rather than mounting the routers.
   *
   * Mounting pulls in every controller, model and database connection in nine
   * services — this has to run without a database, because a check that only
   * works when the infrastructure is up is a check people stop running. The
   * question here is textual anyway: does this line name a guard.
   */
  /*
   * Sub-routers that never mention verifyToken because their PARENT applies
   * it — read out of each service's index.js rather than listed here, so a
   * router that stops being mounted with auth is noticed instead of assumed.
   */
  const mountedWithAuth = new Set();
  for (const service of SERVICES) {
    const index = path.join(__dirname, '..', 'services', service, 'src', 'routes', 'index.js');
    if (!fs.existsSync(index)) continue;
    for (const m of fs.readFileSync(index, 'utf8').matchAll(/router\.use\([^)]*verifyToken[^)]*require\('\.\/([a-zA-Z]+)'\)/g)) {
      mountedWithAuth.add(`${m[1]}.js`);
    }
    for (const m of fs.readFileSync(index, 'utf8').matchAll(/router\.use\([^,]+,\s*verifyToken,\s*([a-zA-Z]+)\)/g)) {
      mountedWithAuth.add(`${m[1].replace(/Routes$/, 'Routes')}.js`);
    }
  }

  const routes = [];
  for (const service of SERVICES) {
    const dir = path.join(__dirname, '..', 'services', service, 'src', 'routes');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const full = path.join(dir, file);
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      // Where authentication starts. Routes above it are public by design —
      // branding before sign-in, the OAuth callback, a shared property link.
      const useAt = lines.findIndex((l) => /router\.use\(verifyToken\)/.test(l));
      /*
       * Three ways a route comes to be authenticated, and the detector has to
       * know all three or it mislabels whole files:
       *
       *   router.use(verifyToken)   everything below that line;
       *   mounted with it           index.js does router.use('/', verifyToken, …)
       *                             — the file itself never mentions it;
       *   named on the line         auth-service applies it per route, because
       *                             the file also serves login and the OAuth
       *                             callback, which cannot require a token.
       */
      const mounted = mountedWithAuth.has(file);
      lines.forEach((line, i) => {
        const m = line.match(/^router\.(get|post|put|patch|delete)\('([^']+)'(.*)$/);
        if (!m) return;
        const [, method, route, rest] = m;
        const authenticated = mounted || rest.includes('verifyToken') || (useAt !== -1 && i > useAt);
        // A guard on the same line, or inside the inline handler that follows
        // it — companyRoutes' GET / dispatches on the mount path and calls
        // requireSuperiorAdmin itself.
        const body = rest + lines.slice(i + 1, i + 6).join('\n');
        routes.push({
          service, file, key: `${method.toUpperCase()} ${route}`,
          authenticated,
          guarded: GUARD_NAMES.some((g) => rest.includes(g))
            || (rest.trim().endsWith('(req, res, next) => {') && GUARD_NAMES.some((g) => body.includes(g))),
        });
      });
    }
  }

  console.log('\n── Every authenticated route answers for itself ─────────────────');
  {
    const authed = routes.filter((r) => r.authenticated);
    const unexplained = authed.filter((r) => !r.guarded && !EXEMPT[r.key]);
    check(`All ${authed.length} authenticated routes are guarded or written down`,
      unexplained.length === 0,
      unexplained.length
        ? unexplained.slice(0, 60).map((r) => `${r.key}  (${r.service})`).join('\n        ')
        : `${authed.filter((r) => r.guarded).length} guarded, ${authed.length - authed.filter((r) => r.guarded).length} exempt`);

    const writes = authed.filter((r) => !r.key.startsWith('GET '));
    check('...including every write',
      writes.every((r) => r.guarded || EXEMPT[r.key]),
      `${writes.filter((r) => r.guarded).length} of ${writes.length} writes guarded, the rest written down`);
  }

  /**
   * The writes that move money or grant access, named individually.
   *
   * These are the ones that were worst: POST /investments/:id/payout and
   * /approve-cashout released money to an investor, and
   * POST /users/:id/assign-role decides who somebody IS in this system — all
   * reachable, before this, by any account holding a valid token and nothing
   * else. Listed by name rather than counted, so that losing a guard on one of
   * them fails with the route in the message instead of a total going down by
   * one.
   */
  console.log('\n── The writes that move money or grant access ───────────────────');
  {
    const CRITICAL = {
      'POST /investments/:id/payout': 'investments.manage',
      'POST /investments/:id/payouts': 'investments.manage',
      'POST /investments/:id/approve-cashout': 'investments.manage',
      'POST /investments/:id/reject-cashout': 'investments.manage',
      'POST /investments/run-accrual': 'investments.manage',
      'POST /users/:id/assign-role': 'roles.manage',
      'PUT /users/:id': 'users.manage',
      'DELETE /properties/:id': 'properties.manage',
      'PUT /properties/:id': 'properties.manage',
      'POST /properties/:id/approve': 'properties.approve',
      'POST /notifications/send-bulk': 'notifications.send',
      'POST /reload-config': 'platform.settings.manage',
      // Moved off a handler role check once the permission was actually
      // granted to somebody — see grantSecuritySettings.
      'GET /admin/2fa-policy': 'settings.security.manage',
      'POST /admin/2fa-policy': 'settings.security.manage',
    };
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const wrong = Object.entries(CRITICAL)
      .filter(([key]) => !byKey.get(key)?.guarded)
      .map(([key]) => key);
    check(`All ${Object.keys(CRITICAL).length} of them are guarded`, wrong.length === 0, wrong.join(', '));

    const sources = Object.entries(CRITICAL).filter(([key, perm]) => {
      const r = byKey.get(key);
      if (!r) return true;
      const file = fs.readFileSync(
        path.join(__dirname, '..', 'services', r.service, 'src', 'routes', r.file), 'utf8',
      );
      /*
       * Method AND path. Matching on the path alone finds the GET that shares
       * it — router.get('/users/:id', requirePermission('users.view')) sits
       * above the PUT — and then reports the read's permission as the write's,
       * which is a false failure at best and a false PASS at worst.
       */
      const [method, route] = key.split(' ');
      const prefix = `router.${method.toLowerCase()}('${route}'`;
      const line = file.split('\n').find((l) => l.startsWith(prefix));
      return !line || !line.includes(perm);
    }).map(([key, perm]) => `${key} should require ${perm}`);
    check('...each by the permission it ought to', sources.length === 0, sources.join('\n        '));
  }

  console.log('\n── The exemption list is honest ─────────────────────────────────');
  {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    /*
     * An exemption for a route that IS guarded is stale, and a stale list is
     * how a real gap eventually hides in one: the next reader trusts it.
     */
    const stale = Object.keys(EXEMPT).filter((key) => byKey.get(key)?.guarded);
    check('No exemption covers a route that is actually guarded', stale.length === 0, stale.join(', '));

    const gone = Object.keys(EXEMPT).filter((key) => !byKey.has(key));
    check('No exemption names a route that no longer exists', gone.length === 0, gone.join(', '));

    const kinds = new Set(Object.values(EXEMPT).map(([kind]) => kind));
    check('Every exemption states one of the three kinds',
      [...kinds].every((k) => ['own', 'per-row', 'open'].includes(k)), [...kinds].join(', '));
    check('...and gives a reason',
      Object.values(EXEMPT).every(([, why]) => why && why.length > 10), '');
  }

  console.log('\n── Nothing regressed, service by service ────────────────────────');
  {
    /*
     * A floor per service, so a whole file losing its guards is caught even if
     * the totals above are still satisfied by exemptions elsewhere.
     */
    const FLOORS = {
      'crm-service': 53,
      'finance-service': 60,
      'investment-service': 14,
      'property-service': 40,
      'support-service': 8,
      'notification-service': 9,
      'user-service': 25,
    };
    for (const [service, floor] of Object.entries(FLOORS)) {
      const guarded = routes.filter((r) => r.service === service && r.guarded).length;
      check(`${service} keeps at least ${floor} guarded routes`, guarded >= floor, `${guarded} guarded`);
    }
  }

  console.log('\n── The GET surface, before and after ────────────────────────────');
  {
    const gets = routes.filter((r) => r.authenticated && r.key.startsWith('GET '));
    const open = gets.filter((r) => !r.guarded);
    check('Authenticated GETs without a guard are only the written-down ones',
      open.every((r) => EXEMPT[r.key]), open.filter((r) => !EXEMPT[r.key]).map((r) => r.key).join(', '));
    console.log(`\n        ${gets.length} authenticated GET routes: `
      + `${gets.filter((r) => r.guarded).length} guarded, ${open.length} exempt.`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
