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
const { multiCompanySignupsEnabled } = require('./shared/src/emailIdentity');

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
/**
 * Whether the schema is ready to be served.
 *
 * False until every service's migrations have finished. The port opens before
 * that happens — see start() for why — so this is what stops a request landing
 * on a half-migrated database in the meantime.
 */
let ready = false;

const health = (req, res) => res.status(ready ? 200 : 503).json({
  service: 'realx8-core',
  status: ready ? 'ok' : 'starting',
  mode: remoteServices.length ? 'partial' : 'single-process',
  services: {
    inProcess: localServices.map((s) => s.name),
    proxied: Object.fromEntries(remoteServices.map((s) => [s.name, targetUrl(s)])),
  },
});
app.get('/health', health);
app.get('/api/health', health);

/**
 * Everything else waits for the migrations.
 *
 * The port is open from the first moment now, so this is the difference
 * between "not listening yet" and "listening, not ready yet" — and the second
 * has to be said out loud rather than served. A request that arrived mid-boot
 * would otherwise read a table a migration is still altering.
 *
 * Retry-After is not decoration: it is the difference between a client backing
 * off and a client hammering a starting instance.
 */
app.use((req, res, next) => {
  if (ready) return next();
  res.set('Retry-After', '15');
  return res.status(503).json({
    message: 'The service is starting up. Please try again in a few seconds.',
    reason: 'starting',
  });
});

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
    /**
     * The port opens FIRST, and the migrations run behind it.
     *
     * They used to run first, and the listen waited on them. On a hosted
     * platform that is a deploy that fails: the host watches for a bound port
     * and kills anything that has not opened one inside its scan window.
     * Measured on Render, user-service alone took 59s to migrate and the whole
     * boot passed two and a half minutes before finance had finished — the
     * port was never opened, and the deploy timed out with the process
     * perfectly healthy and most of the way through its work.
     *
     * Opening first is safe because it is not the same as being ready: /health
     * answers 503 with "starting", and every other route answers 503 with a
     * Retry-After until `ready` flips. So nothing reaches a half-migrated
     * schema, and the platform gets its port immediately.
     */
    const server = app.listen(PORT, () => {
      console.log(`Realx8-Core listening on ${PORT} — migrating before serving`);
      /*
       * Announced, because a suppression nobody can see is a bug report.
       * Without this line "joining a company says it is not switched on" looks
       * like a defect rather than the setting somebody chose on purpose.
       */
      if (!multiCompanySignupsEnabled()) {
        console.log('  MULTI_COMPANY_SIGNUPS=off — an address may hold an account with one '
          + 'company only. Unset it to allow a second.');
      }
      console.log(`  in-process: ${localServices.map((s) => s.name).join(', ')}`);
      if (remoteServices.length) {
        remoteServices.forEach((s) => console.log(`  proxied:    ${s.name} -> ${targetUrl(s)}`));
      }
    });

    // Stop accepting connections before the platform kills the process, so
    // in-flight requests finish instead of being cut off mid-response.
    ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
      console.log(`[shutdown] ${signal} — closing server`);
      server.close(() => process.exit(0));
    }));

    /*
     * Now the schema. Everything below this line needs a migrated database:
     * the cron schedulers read their configuration, and the mail warm-up reads
     * the SMTP settings. Running them from the listen callback would have them
     * query tables a migration was still altering.
     */
    await bootstrapServices(loaded, { logger: console });

    ready = true;
    console.log('Realx8-Core ready — migrations complete, now serving');

    runReadyHooks(loaded, { logger: console });

    /**
     * Find a usable SMTP port now, not when someone needs a password reset.
     *
     * Fire-and-forget: it must not delay anything, and a mail host that cannot
     * be reached is not a reason to fail startup.
     */
    const mailSequelize = require('./services/user-service/src/models').sequelize;
    require('./shared/src/mailTransport').warmMailPort(mailSequelize);
  } catch (error) {
    /*
     * Still fatal. The port being open does not make a failed migration
     * survivable — it makes it a process that answers 503 forever, which is
     * worse than one that exits and lets the platform say the deploy failed.
     */
    console.error(`[boot] failed: ${error.message}\n${error.stack || ''}`);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, start };
