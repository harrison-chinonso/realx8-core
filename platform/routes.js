#!/usr/bin/env node
/**
 * Prints the routing table: which service owns which URL prefix, where each
 * service resolves to, and whether it runs in this process.
 *
 * `npm run routes` — use it after changing SERVICES to confirm the composition
 * is what you meant before you deploy it.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../cred.env') });

const { SERVICES, serviceNames, targetUrl } = require('./registry');
const { enabledServices } = require('./runtime');

const enabled = enabledServices(serviceNames);
const totalPrefixes = SERVICES.reduce((n, s) => n + s.prefixes.length, 0);

console.log(`SERVICES=${process.env.SERVICES || 'all'}  `
  + `(${enabled.size}/${SERVICES.length} services in-process, ${totalPrefixes} prefixes)\n`);

SERVICES.forEach((service) => {
  const here = enabled.has(service.name);
  const where = here ? 'in-process' : `proxy -> ${targetUrl(service)}`;
  console.log(`${here ? '*' : ' '} ${service.name.padEnd(13)} ${where}`);
  console.log(`  ${service.prefixes.join('  ')}\n`);
});

console.log('Every prefix is also served under /api<prefix>, which is what Realx8-Ui calls.');
