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

module.exports = { verifyToken, requireRoles, optionalAuth };
