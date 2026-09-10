const jwt = require('jsonwebtoken');
const { HTTP_STATUS } = require('../constants');

const verifyToken = (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: 'Missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key');
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

// Like verifyToken but never blocks the request — just populates req.user if a valid token is present
const optionalAuth = (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key');
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

module.exports = { verifyToken, requireRoles, requirePermission, optionalAuth };
