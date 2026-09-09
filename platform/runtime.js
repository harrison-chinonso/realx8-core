/**
 * How this process was started.
 *
 * `REALX8_EMBEDDED` is set by server.js before any service is required, so a
 * service can tell whether it is running inside the composed process or on its
 * own. It only ever changes ONE thing: when embedded, a service skips the
 * cors/helmet/morgan middleware it would otherwise install, because the edge in
 * server.js already installed those on the shared request. Two cors layers on
 * one response is not additive — the inner one would silently overwrite the
 * origin the edge negotiated.
 *
 * Everything else about a service — its routes, models, migrations, error
 * handling — is identical in both modes. That is what keeps `node
 * services/auth-service/src/index.js` a working deployment on day one of a split.
 */

const EMBEDDED_FLAG = 'REALX8_EMBEDDED';

const isEmbedded = () => process.env[EMBEDDED_FLAG] === '1';

const markEmbedded = () => { process.env[EMBEDDED_FLAG] = '1'; };

/**
 * Which services this process owns, from the SERVICES env var.
 *
 *   unset / "all"        every service, in-process (the default single deploy)
 *   "auth,user"          only those two run here; every other prefix is
 *                        proxied to <NAME>_SERVICE_URL
 *
 * This is the entire mechanism for splitting later: deploy the same image N
 * times with different SERVICES values and point them at each other.
 */
const enabledServices = (allNames) => {
  const raw = String(process.env.SERVICES || 'all').trim();
  if (!raw || raw.toLowerCase() === 'all') return new Set(allNames);

  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((name) => !allNames.includes(name));
  if (unknown.length) {
    throw new Error(`SERVICES names not in the registry: ${unknown.join(', ')}. `
      + `Known services: ${allNames.join(', ')}`);
  }
  return new Set(wanted);
};

module.exports = { isEmbedded, markEmbedded, enabledServices, EMBEDDED_FLAG };
