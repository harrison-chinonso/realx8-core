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

  /*
   * The handler refuses anyone who is not a super_admin, and it stays that way
   * for now on purpose: settings.security.manage EXISTS in the catalogue and
   * is granted to NOBODY, not even super_admin. Gating on it would lock every
   * account out of the 2FA policy. Grant it first, then move this to a guard.
   */
  'GET /admin/2fa-policy': ['per-row', 'the handler refuses anyone who is not a super_admin'],

  // ── open ─────────────────────────────────────────────────────────────────
  'GET /notifications/push/public-key': ['open', 'the VAPID public key, handed to every subscribing browser'],
  'GET /installment-plans/units/:propertyUnitId/options': ['open', 'a buyer configuring a purchase needs a unit’s prices'],
  'GET /realtor-levels': ['open', 'a realtor must see the ladder to ask to move up it'],
};

/** Guards that count as a permission check. */
const GUARD_NAMES = ['requirePermission', 'permissionOrSelfScoped', 'requireRoles', 'staffOnly',
  'requireSuperiorAdmin', 'canConfigure', 'requireFinanceManager'];

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

  console.log('\n── Every authenticated READ answers for itself ──────────────────');
  {
    const reads = routes.filter((r) => r.authenticated && r.key.startsWith('GET '));
    const unexplained = reads.filter((r) => !r.guarded && !EXEMPT[r.key]);
    check(`All ${reads.length} authenticated GET routes are guarded or written down`,
      unexplained.length === 0,
      unexplained.length
        ? unexplained.slice(0, 60).map((r) => `${r.key}  (${r.service})`).join('\n        ')
        : `${reads.filter((r) => r.guarded).length} guarded, ${reads.length - reads.filter((r) => r.guarded).length} exempt`);
  }

  /**
   * ── The writes are NOT done, and this is where that is recorded ──────────
   *
   * Auditing the reads turned up the same gap on the write side, and some of
   * it is worse: POST /investments/:id/payout and /approve-cashout move money
   * with no permission check at all, and POST /properties, PUT /properties/:id
   * and DELETE /properties/:id let any account with a token rewrite the
   * catalogue.
   *
   * They are not fixed here, deliberately. Each one needs the same tracing the
   * reads got — /investments/subscribe must stay callable by a client, who
   * holds investments.own.view and not investments.manage — and guessing at
   * that would break a customer flow to close a hole a day sooner.
   *
   * So the count is pinned. The number may go DOWN as they are gated, and the
   * check fails if it goes up, which is what stops a new ungated write being
   * added while this is outstanding. Lower BASELINE as they are done; when it
   * reaches zero, fold writes into the check above and delete this one.
   */
  console.log('\n── The writes are a known, measured gap ─────────────────────────');
  {
    /*
     * Measured, not chosen. Some of these are enforced inside their handler —
     * realtor-kyc approval checks isReviewer, level requests check
     * requireCompanyAdmin — so the real gap is smaller than the number. It is
     * pinned as it stands so that it can only shrink.
     */
    const BASELINE = 111;
    const writes = routes.filter((r) => r.authenticated && !r.key.startsWith('GET '));
    const open = writes.filter((r) => !r.guarded && !EXEMPT[r.key]);
    check(`No more than the ${BASELINE} write routes already known to be ungated`,
      open.length <= BASELINE,
      `${open.length} of ${writes.length} authenticated writes carry no permission check`);
    const money = open.filter((r) => /payout|cashout|approve|refund|settle/.test(r.key));
    check('...and the money-moving ones are named, not lost in a total',
      money.length > 0 || open.length === 0,
      money.map((r) => r.key).join(', ') || 'none left');
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
