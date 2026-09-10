const { securityConfig } = require('./config');
const { clientIp } = require('./clientIp');

/**
 * Deciding whether a request came from a browser or a tool.
 *
 * Every check answers the same question from a different angle, because any one
 * of them alone is trivially defeated: a tool can change its User-Agent, so
 * strict mode also wants the header set a browser actually sends; a tool can
 * add those headers, so the tool-specific ones are checked too.
 *
 * WHAT THIS IS NOT: authentication. A determined caller who mimics a browser
 * exactly will pass, and that is inherent — everything here is client-supplied.
 * It raises the cost of casual scripting and stops the obvious cases. Real
 * authorisation remains the JWT and the permission checks behind it.
 */

/** A recognised browser. Deliberately narrow — strict mode leans on it. */
const BROWSER_PATTERN = /(mozilla\/5\.0|applewebkit|chrome\/|safari\/|firefox\/|edg\/|opr\/|trident\/)/i;

/** Anything that looks like a library or a scanner, as a last-resort catch. */
const TOOL_PATTERN = /(bot|crawler|spider|scraper|http[-_]?client|urllib|libcurl|winhttp|powershell|invoke-restmethod)/i;

const allowed = (reason) => ({ blocked: false, reason });
const blocked = (reason) => ({ blocked: true, reason });

const detectAutomatedTool = (req) => {
  const config = securityConfig().automatedTools;
  if (!config.enabled) return allowed('detection disabled');

  const ip = clientIp(req);
  if (config.whitelistIps.includes(ip)) return allowed(`ip allow-listed: ${ip}`);

  const userAgent = req.headers['user-agent'];

  // 1. Headers only a tool sends. Presence alone is decisive — a browser has
  //    no reason to carry Postman-Token.
  for (const header of config.toolHeaders) {
    if (req.headers[header]) return blocked(`tool header present: ${header}`);
  }

  // 2. The User-Agent.
  if (!userAgent || !String(userAgent).trim()) return blocked('missing User-Agent');
  const agent = String(userAgent).toLowerCase();
  const named = config.toolAgents.find((tool) => agent.includes(tool));
  if (named) return blocked(`User-Agent names a known tool: ${named}`);
  if (TOOL_PATTERN.test(agent)) return blocked('User-Agent matches a tool pattern');

  // 3. Several proxy-ish headers at once. One is normal behind a CDN; a
  //    handful together is a signature of traffic being relayed through tooling.
  const proxyHeaders = config.suspiciousHeaders.filter((header) => req.headers[header]);
  if (proxyHeaders.length > 2) {
    return blocked(`multiple proxy headers: ${proxyHeaders.join(', ')}`);
  }

  // 4. X-Requested-With, if sent, should be what a browser sends.
  const requestedWith = req.headers['x-requested-with'];
  if (requestedWith && String(requestedWith) !== 'XMLHttpRequest') {
    return blocked(`unexpected X-Requested-With: ${requestedWith}`);
  }

  /**
   * 5. Strict mode: it has to look like a browser, not merely not-a-known-tool.
   *
   * This is the check that catches a tool which has simply set a plausible
   * User-Agent, because the header set is harder to fake by accident than the
   * one string everyone knows to change.
   */
  if (config.strict) {
    if (!BROWSER_PATTERN.test(agent)) return blocked('User-Agent is not a recognised browser');
    if (!req.headers.accept) return blocked('missing Accept header');
    if (!req.headers['accept-language']) return blocked('missing Accept-Language header');
    if (!req.headers['accept-encoding']) return blocked('missing Accept-Encoding header');
  }

  return allowed('looks like a browser');
};

module.exports = { detectAutomatedTool, BROWSER_PATTERN, TOOL_PATTERN };
