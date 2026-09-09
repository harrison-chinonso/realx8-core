/**
 * An HTTP proxy to a service that lives in another deployment.
 *
 * Used for any prefix this process does not own — i.e. every prefix when you
 * run services/api-gateway on its own, and only the split-out ones when you
 * run server.js with a partial SERVICES list.
 *
 * No pathRewrite: the dispatcher has already normalised req.url to the path the
 * target expects, so the proxy forwards it unchanged.
 */

const { createProxyMiddleware } = require('http-proxy-middleware');
const { LONG_RUNNING_PREFIXES, targetUrl } = require('./registry');

const NORMAL_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 30000);
const LONG_TIMEOUT_MS = Number(process.env.PROXY_LONG_TIMEOUT_MS || 180000);

const proxyHandler = (service) => {
  // The assistant streams its reply and may run several tool rounds first, so it
  // needs longer than a normal request — 30s would cut an answer mid-sentence.
  const longRunning = service.prefixes.some((p) => LONG_RUNNING_PREFIXES.includes(p));

  return createProxyMiddleware({
    target: targetUrl(service),
    changeOrigin: true,
    proxyTimeout: longRunning ? LONG_TIMEOUT_MS : NORMAL_TIMEOUT_MS,
    ...(longRunning ? { timeout: LONG_TIMEOUT_MS } : {}),
  });
};

module.exports = { proxyHandler };
