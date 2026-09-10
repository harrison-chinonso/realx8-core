/**
 * Realx8-Core — the whole backend, as one process.
 *
 * Every service in services/ is still a self-contained project: its own
 * routes, models, migrations and `node src/index.js` entrypoint. This file is
 * the only thing that composes them, and it does so WITHOUT the network:
 * a request arrives once, passes the edge once, and is handed to the owning
 * service's express app as a plain function call.
 *
 *   ┌── edge (cors, helmet, rate limit, session check) ──┐
 *   │             dispatcher (registry: prefix -> service)│
 *   └── auth app · user app · property app · ...  ────────┘
 *
 * SPLITTING LATER
 * ---------------
 * Nothing above is monolith-specific. `SERVICES` decides which services this
 * process owns; every prefix it does not own is proxied to `<NAME>_SERVICE_URL`
 * instead, over the same routing table. So scaling out is a deploy-config
 * change, not a rewrite:
 *
 *   one deploy         SERVICES unset            everything in-process
 *   peel one off       SERVICES=all-but-support  + SUPPORT_SERVICE_URL=https://...
 *                      (on the main deploy)
 *                      SERVICES=support          (on the new deploy)
 *   fully split        run services/api-gateway + each service's own entrypoint
 *
 * The URLs Realx8-Ui calls are identical in all three.
 */

// Before anything requires a service: tell them they are being composed, so
// they leave cors/helmet/morgan to the edge below instead of installing a
// second copy on the same response.
require('./platform/runtime').markEmbedded();
require('dotenv').config({ path: require('path').resolve(__dirname, 'cred.env') });

const express = require('express');
const { SERVICES, serviceNames, targetUrl } = require('./platform/registry');
const { enabledServices } = require('./platform/runtime');
const { edgeMiddleware, postAuthMiddleware, authGate } = require('./platform/edge');
const { createDispatcher } = require('./platform/dispatcher');
const { proxyHandler } = require('./platform/proxyHandler');
const { bootstrapServices, runReadyHooks } = require('./platform/boot');

const PORT = Number(process.env.PORT || 3000);

const enabled = enabledServices(serviceNames);
const localServices = SERVICES.filter((service) => enabled.has(service.name));
const remoteServices = SERVICES.filter((service) => !enabled.has(service.name));

if (!localServices.length) {
  throw new Error('SERVICES excluded every service — this process would own no '
    + 'routes. To run a pure gateway, use services/api-gateway instead.');
}

// Requiring a service loads its models but opens no connection and binds no
// port; that all happens in bootstrap(), below.
const loaded = localServices.map((service) => ({
  service,
  module: require(`./services/${service.dir}/src`),
}));
const appsByName = new Map(loaded.map(({ service, module: m }) => [service.name, m.app]));

const app = express();
app.disable('x-powered-by');

// Off by default, matching how the gateway runs today. Turn on (to the number
// of proxies in front of this app) when deploying behind nginx/Railway/a load
// balancer, so rate limiting keys on the real client IP rather than the proxy's.
/**
 * `trust proxy`, from TRUST_PROXY.
 *
 * The boolean words are handled explicitly. Every environment value is a
 * STRING, and "false" is truthy in JavaScript — so TRUST_PROXY=false used to
 * pass the literal text "false" to express, which hands it to proxy-addr,
 * which tries to parse it as an IP and throws on startup. Writing the value
 * you would expect to disable the setting crashed the server.
 */
const trustProxyRaw = String(process.env.TRUST_PROXY ?? '').trim();
if (trustProxyRaw && !['false', 'off', '0', 'no'].includes(trustProxyRaw.toLowerCase())) {
  const hops = Number(trustProxyRaw);
  app.set('trust proxy', ['true', 'on', 'yes'].includes(trustProxyRaw.toLowerCase())
    ? true
    : (Number.isNaN(hops) ? trustProxyRaw : hops));
}

edgeMiddleware().forEach((middleware) => app.use(middleware));

// Health is answered here, not by a service: it reports the composition, which
// is the thing you actually want to see after changing SERVICES.
const health = (req, res) => res.json({
  service: 'realx8-core',
  status: 'ok',
  mode: remoteServices.length ? 'partial' : 'single-process',
  services: {
    inProcess: localServices.map((s) => s.name),
    proxied: Object.fromEntries(remoteServices.map((s) => [s.name, targetUrl(s)])),
  },
});
app.get('/health', health);
app.get('/api/health', health);

app.use(authGate());
// Device fingerprinting and the layered rate limiter, which need to know who
// is calling — so they run after the session check, never before it.
postAuthMiddleware().forEach((middleware) => app.use(middleware));

// One routing table, two kinds of destination.
app.use(createDispatcher({
  handlerFor: (service) => (enabled.has(service.name)
    ? appsByName.get(service.name)
    : proxyHandler(service)),
}));

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Each service app already has its own error handler, so anything reaching here
// failed at the edge (a rejected origin, an unreachable proxy target).
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const isCorsRejection = String(error.message || '').startsWith('CORS:');
  const status = isCorsRejection ? 403 : 502;
  if (!isCorsRejection) console.error(`[edge] ${req.method} ${req.originalUrl}: ${error.message}`);
  if (res.headersSent) return;
  res.status(status).json({ message: error.message || 'Upstream request failed' });
});

const start = async () => {
  try {
    await bootstrapServices(loaded, { logger: console });

    const server = app.listen(PORT, () => {
      console.log(`Realx8-Core listening on ${PORT}`);
      console.log(`  in-process: ${localServices.map((s) => s.name).join(', ')}`);
      if (remoteServices.length) {
        remoteServices.forEach((s) => console.log(`  proxied:    ${s.name} -> ${targetUrl(s)}`));
      }
      runReadyHooks(loaded, { logger: console });
    });

    // Stop accepting connections before the platform kills the process, so
    // in-flight requests finish instead of being cut off mid-response.
    ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
      console.log(`[shutdown] ${signal} — closing server`);
      server.close(() => process.exit(0));
    }));
  } catch (error) {
    console.error(`[boot] failed: ${error.message}\n${error.stack || ''}`);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, start };
