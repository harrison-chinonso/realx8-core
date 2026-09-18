const jwt = require('jsonwebtoken');
const { HTTP_STATUS } = require('../constants');
// The deployment secret, and the refusal to fall back to one in the source
// tree. See shared/src/appSecret.js for what the old fallback cost.
const { appSecret } = require('../appSecret');

const verifyToken = (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, appSecret());
    req.user = {
      ...payload,
      company_id: payload.company_id ?? null,
      isSuperiorAdmin: payload.isSuperiorAdmin === true || payload.type === 'superior_admin',
    };
    next();
  } catch (error) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Invalid or expired token' });
  }
};

const requireRoles = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Unauthenticated' });
  }

  if (req.user.isSuperiorAdmin || req.user.type === 'superior_admin') {
    return next();
  }

  if (!roles.length || roles.includes(req.user.type)) {
    return next();
  }

  return res.status(HTTP_STATUS.FORBIDDEN).json({ message: 'You do not have permission to access this resource' });
};

/**
 * Gates a route on one or more permission names, any of which suffices.
 *
 * Permissions ride in the JWT (see auth-service's createAccessToken), so this
 * costs no query. Same superior-admin bypass as requireRoles: the platform-wide
 * role holds everything by definition, and seedRolesAndPermissions re-grants it
 * the full catalogue on every boot.
 *
 * Prefer this over requireRoles for anything new. A role check hardcodes an
 * answer that belongs to the Roles screen — it cannot be delegated to a custom
 * role, and it silently disagrees with the permission the UI is hiding the
 * button on.
 *
 * NOTE ON DEPLOYMENT: a permission only reaches a user's token when they log
 * in. After adding a permission to a role, sessions already open carry the old
 * set until their token expires, so the grant appears to take an hour. That is
 * the token lifetime, not a failure of this check.
 */
const requirePermission = (...names) => (req, res, next) => {
  if (!req.user) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Unauthenticated' });
  }

  if (req.user.isSuperiorAdmin || req.user.type === 'superior_admin') {
    return next();
  }

  const held = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  // '*' is honoured because the UI's own hasPermission does; a role granted it
  // must not be refused here by a stricter reading.
  if (held.includes('*') || names.some((name) => held.includes(name))) {
    return next();
  }

  return res.status(HTTP_STATUS.FORBIDDEN).json({ message: 'You do not have permission to access this resource' });
};

/**
 * A route that serves BOTH staff and the person the rows are about.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 *
 * /invoices is two screens. An administrator opening it sees every invoice in
 * the company; a buyer opening "My Invoices" hits the same route and is
 * narrowed by invoiceScope to their own. Guarding it with
 * requirePermission('finance.invoices.view') would be correct for the first
 * reader and would lock the second out of their own bills — so these routes
 * stayed open to any authenticated user, which is how they came to have no
 * guard at all.
 *
 * This says: hold the permission, or be somebody the handler narrows to.
 *
 * ── The invariant, and why it matters ──────────────────────────────────────
 *
 * This is ONLY safe on a route whose handler scopes to req.user.id for a
 * client or realtor — invoiceScope, receiptScope, transactionScope and the
 * `mine` handlers. Applied to a route that scopes only by COMPANY, it is not a
 * guard at all: it would wave through exactly the callers requirePermission
 * exists to stop, and it would look like a guard while doing it.
 *
 * So it is deliberately named for what it permits rather than for a route
 * shape, and every use of it should be paired with a reading of the scope
 * function it is relying on. Where you cannot point at that function, use
 * requirePermission.
 */
const SELF_SCOPED_TYPES = ['client', 'realtor'];

const permissionOrSelfScoped = (...names) => (req, res, next) => {
  if (!req.user) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Unauthenticated' });
  }

  if (req.user.isSuperiorAdmin || req.user.type === 'superior_admin') {
    return next();
  }

  const held = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (held.includes('*') || names.some((name) => held.includes(name))) {
    return next();
  }

  /*
   * The ACTING profile, not the account type. Somebody who holds both a staff
   * role and a realtor profile is whichever one they have switched to, and the
   * scope functions downstream read the same field — so the two agree about
   * who this request is, which is the whole point.
   */
  const acting = req.user.effectiveType || req.user.type;
  if (SELF_SCOPED_TYPES.includes(acting)) {
    return next();
  }

  return res.status(HTTP_STATUS.FORBIDDEN).json({ message: 'You do not have permission to access this resource' });
};

// Like verifyToken but never blocks the request — just populates req.user if a valid token is present
const optionalAuth = (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, appSecret());
      req.user = {
        ...payload,
        company_id: payload.company_id ?? null,
        isSuperiorAdmin: payload.isSuperiorAdmin === true || payload.type === 'superior_admin',
      };
    } catch {
      // invalid / expired — treat as unauthenticated, don't block
    }
  }
  next();
};

module.exports = {
  verifyToken, requireRoles, requirePermission, permissionOrSelfScoped, optionalAuth,
};
