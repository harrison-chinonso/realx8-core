require('dotenv').config({ path: require('path').resolve(__dirname, '../../../cred.env') });
const express = require('express');
const { SERVICES, targetUrl } = require('../../../platform/registry');
const { edgeMiddleware, authGate } = require('../../../platform/edge');
const { createDispatcher } = require('../../../platform/dispatcher');
const { proxyHandler } = require('../../../platform/proxyHandler');
require('events').EventEmitter.defaultMaxListeners = 30;

/**
 * The gateway, for the fully split deployment.
 *
 * This is the same edge and the same routing table Realx8-Core's server.js
 * uses — see ../../../platform/. The only difference is that every prefix here
 * resolves to an HTTP proxy rather than to an in-process app, because in this
 * shape none of the services live in this process.
 *
 * You do not need to run this to deploy Realx8-Core. `node server.js` at the
 * repo root serves the identical API from one process, and can peel individual
 * services off via SERVICES + <NAME>_SERVICE_URL. Reach for the gateway when
 * every service has its own deployment and you want the edge separate too.
 *
 * Point <NAME>_SERVICE_URL at each service; the defaults are the localhost
 * ports each service binds when started with `npm run dev:split`.
 */

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

edgeMiddleware().forEach((middleware) => app.use(middleware));

const health = (req, res) => res.json({
  service: 'api-gateway',
  status: 'ok',
  mode: 'gateway',
  services: Object.fromEntries(SERVICES.map((s) => [s.name, targetUrl(s)])),
});
app.get('/health', health);
app.get('/api/health', health);

app.use(authGate());

// Everything is remote in this shape.
app.use(createDispatcher({ handlerFor: proxyHandler }));

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const isCorsRejection = String(error.message || '').startsWith('CORS:');
  if (!isCorsRejection) console.error(`[gateway] ${req.method} ${req.originalUrl}: ${error.message}`);
  if (res.headersSent) return;
  res.status(isCorsRejection ? 403 : 502).json({ message: error.message || 'Upstream request failed' });
});

const start = () => {
  const server = app.listen(PORT, () => console.log(`API Gateway listening on ${PORT}`));
  ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
    server.close(() => process.exit(0));
  }));
  return server;
};

if (require.main === module) {
  start();
}

module.exports = { app, start };
