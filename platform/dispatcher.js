/**
 * Sends a request to the service that owns its URL prefix.
 *
 * The dispatcher is deliberately indifferent to WHERE that service is. It
 * resolves a prefix to a service via the registry, normalises the URL, and
 * hands the request to whatever handler was supplied for that service —
 * an in-process express app, or an HTTP proxy to another deployment. Swapping
 * one for the other is the whole of "splitting a service out", and nothing
 * about routing, auth or the URL the client sees changes when you do.
 *
 * The normalised URL is `req.url` minus a leading `/api`, which is exactly the
 * path services/api-gateway forwards today (it mounts each prefix at both
 * `/x` and `/api/x` and rewrites back to `/x`). Keeping that identical is what
 * lets a service be moved between shapes without touching its routes.
 */

const { byPrefix } = require('./registry');

/** '/api/users/5?q=1' -> '/users/5?q=1'   '/users/5' -> '/users/5' */
const normalizeUrl = (url) => (url.startsWith('/api/') ? url.slice(4) : url);

/** The owning prefix of a path: its first segment. '/users/5' -> '/users' */
const prefixOf = (url) => {
  const pathname = url.split('?')[0];
  const firstSegment = pathname.split('/')[1] || '';
  return `/${firstSegment}`;
};

/**
 * @param {(service) => Function} handlerFor  built once per service, lazily,
 *        so a proxy is never created for a service running in this process and
 *        an in-process app is never required for one that isn't.
 */
const createDispatcher = ({ handlerFor }) => {
  const handlers = new Map();

  const handlerOf = (service) => {
    if (!handlers.has(service.name)) handlers.set(service.name, handlerFor(service));
    return handlers.get(service.name);
  };

  return function dispatch(req, res, next) {
    const normalizedUrl = normalizeUrl(req.url);
    const service = byPrefix.get(prefixOf(normalizedUrl));
    // Unknown prefix: fall through to the 404 handler rather than guess.
    if (!service) return next();

    req.url = normalizedUrl;
    return handlerOf(service)(req, res, next);
  };
};

module.exports = { createDispatcher, normalizeUrl, prefixOf };
