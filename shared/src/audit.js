const { QueryTypes } = require('sequelize');
const { describeRequest, stripApiPrefix } = require('./auditCatalog');

/**
 * The audit trail: who did what, when, and to which company.
 *
 * ── Why this is middleware and not a call at each site ──────────────────────
 *
 * There are roughly three hundred state-changing routes across nine services.
 * An audit trail assembled by remembering to call a logger at each of them is
 * complete on the day it is written and incomplete by the end of the month, and
 * the gap is invisible: the log still fills up, so nobody discovers the missing
 * category until they go looking for the one event that mattered. Sitting in
 * the request pipeline, this records a route added tomorrow by nobody having
 * done anything.
 *
 * What it costs is precision. The middleware knows the route, the actor and
 * what was asked for; it does not know that "status: 3" meant "suspended".
 * `req.audit()` exists for controllers that want to say so — see below — and
 * enriches a row rather than creating one, so using it is never load-bearing.
 *
 * ── Append-only ─────────────────────────────────────────────────────────────
 *
 * Nothing in this module updates or deletes a row, no route exposes either, and
 * the table carries database triggers that refuse both. An audit trail that the
 * application can quietly rewrite is a log, not an audit.
 *
 * ── Never in the caller's way ───────────────────────────────────────────────
 *
 * The write happens after the response has been sent, and every failure path
 * swallows. A request must not fail, and must not become slower, because the
 * recording of it did.
 */

const SKIPPED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes that change state but are not anybody's administrative activity.
 *
 * Each is here for one of two reasons: it is machinery (a token refresh, a
 * config reload), or it is per-user noise that would bury the events somebody
 * is actually looking for (marking a notification read, a chat message). None
 * of them is a decision an administrator took about the business.
 *
 * Matched as prefixes of the normalised path.
 */
const SKIPPED_PATHS = [
  '/auth/refresh',
  '/auth/session-key',
  '/auth/reload-config',
  '/auth/2fa/verify',          // a step of signing in; auth.login records the outcome
  '/notifications/read-all',
  '/assistant/',
  '/share/token',              // minting a share link happens on page load
  '/media/upload',             // the post that uses the file is recorded instead
  '/leads/from-chatbot',       // no actor: the chatbot is not a person
];

/** `/notifications/12/read` — per-user noise, but only the `read` form of it. */
const SKIPPED_PATTERNS = [/^\/notifications\/\d+\/read$/];

/**
 * Keys whose VALUES must never reach the audit table.
 *
 * Matched as substrings, so a field added later that follows the same naming is
 * covered without an edit here. This is the same reasoning listQuery.js applies
 * to filterable columns, and for a sharper reason: this table is readable by
 * every company administrator who holds `audit.view`, so a password in a
 * request body would be handing them one.
 */
const REDACTED_KEYS = [
  'password', 'passcode', 'secret', 'token', 'otp', 'pin', 'cvv', 'card',
  'authorization', 'signature', 'api_key', 'apikey', 'private_key', 'salt',
  'account_number', 'session_key',
];

const isRedacted = (key) => {
  const name = String(key).toLowerCase();
  return REDACTED_KEYS.some((fragment) => name.includes(fragment));
};

/** Longest single value kept, and the largest metadata blob written. */
const MAX_VALUE_LENGTH = 500;
const MAX_METADATA_BYTES = 8000;
const MAX_DEPTH = 4;

/**
 * A request body as it may be stored: redacted, shallow, and bounded.
 *
 * Bounded matters as much as redacted. A bulk import posts a spreadsheet, and a
 * row per import holding the whole sheet turns the audit table into the largest
 * one in the database within a week — at which point somebody truncates it,
 * which is the only outcome worse than not having it.
 */
const sanitise = (value, depth = 0) => {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) return '[nested]';

  if (Array.isArray(value)) {
    const kept = value.slice(0, 20).map((entry) => sanitise(entry, depth + 1));
    return value.length > 20 ? [...kept, `[+${value.length - 20} more]`] : kept;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out = {};
    Object.entries(value).slice(0, 50).forEach(([key, entry]) => {
      out[key] = isRedacted(key) ? '[redacted]' : sanitise(entry, depth + 1);
    });
    return out;
  }

  if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
    return `${value.slice(0, MAX_VALUE_LENGTH)}…`;
  }
  return value;
};

const serialiseMetadata = (metadata) => {
  if (!metadata || !Object.keys(metadata).length) return null;
  const json = JSON.stringify(metadata);
  if (json.length <= MAX_METADATA_BYTES) return json;
  return JSON.stringify({
    truncated: true,
    note: `The recorded detail was ${json.length} characters and has been omitted.`,
  });
};

/** The first of these the payload offers — what a human would call the record. */
const LABEL_KEYS = ['name', 'title', 'invoice_id', 'reference', 'code', 'subject', 'email'];

const labelFrom = (...sources) => {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of LABEL_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 190);
      if (typeof value === 'number') return String(value);
    }
  }
  return null;
};

const numberOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * One recorder per service, bound to that service's own connection.
 *
 * `audit_logs` is created and owned by user-service; the other services write
 * to it directly, for the reason invoiceGateway.js gives about `invoices` —
 * they all share one database, and the alternative is an audit trail that only
 * covers one ninth of the application.
 */
const createAuditor = (sequelize) => {
  /**
   * Whether the table is there yet.
   *
   * Checked once and remembered. A service can start before user-service has
   * finished creating the table (they race in the split deployment), and the
   * answer must not be an exception on every request until something restarts.
   */
  let tableReady = null;

  const ensureTable = async () => {
    if (tableReady !== null) return tableReady;
    try {
      await sequelize.query('SELECT 1 FROM audit_logs LIMIT 1', { type: QueryTypes.SELECT });
      tableReady = true;
    } catch {
      tableReady = false;
    }
    return tableReady;
  };

  const write = async (row) => {
    if (!(await ensureTable())) return false;
    try {
      await sequelize.query(
        `INSERT INTO audit_logs (
           company_id, actor_id, actor_name, actor_email, actor_type,
           actor_company_id, actor_is_platform, action, action_label, module,
           entity_type, entity_id, entity_label, method, path, status_code,
           ip, user_agent, metadata, created_at
         ) VALUES (
           :company_id, :actor_id, :actor_name, :actor_email, :actor_type,
           :actor_company_id, :actor_is_platform, :action, :action_label, :module,
           :entity_type, :entity_id, :entity_label, :method, :path, :status_code,
           :ip, :user_agent, :metadata, NOW()
         )`,
        { replacements: row, type: QueryTypes.INSERT },
      );
      return true;
    } catch (error) {
      // Never rethrown. A failure to record must not become a failure to serve,
      // and the request it describes has already been answered.
      console.error(`[audit] could not record ${row.action}: ${error.message}`);
      return false;
    }
  };

  /**
   * Record an event directly.
   *
   * For the things that are not a request by an authenticated user — signing
   * in, completing a password reset — where the controller is the only place
   * that knows who the actor turned out to be.
   */
  const record = async (event = {}) => write({
    company_id: numberOrNull(event.company_id),
    actor_id: numberOrNull(event.actor_id),
    actor_name: event.actor_name || null,
    actor_email: event.actor_email || null,
    actor_type: event.actor_type || null,
    actor_company_id: numberOrNull(event.actor_company_id ?? event.company_id),
    actor_is_platform: event.actor_is_platform === true,
    action: event.action || 'unknown',
    action_label: event.action_label || null,
    module: event.module || String(event.action || '').split('.')[0] || null,
    entity_type: event.entity_type || null,
    entity_id: event.entity_id ? String(event.entity_id).slice(0, 64) : null,
    entity_label: event.entity_label || null,
    method: event.method || null,
    path: event.path ? String(event.path).slice(0, 255) : null,
    status_code: numberOrNull(event.status_code),
    ip: event.ip ? String(event.ip).slice(0, 64) : null,
    user_agent: event.user_agent ? String(event.user_agent).slice(0, 255) : null,
    metadata: serialiseMetadata(event.metadata),
  });

  const shouldSkip = (method, path) => SKIPPED_METHODS.has(method)
    || SKIPPED_PATHS.some((prefix) => path.startsWith(prefix))
    || SKIPPED_PATTERNS.some((pattern) => pattern.test(path));

  /**
   * The middleware. Mount it after the body parser and before the routes.
   */
  const auditMiddleware = () => (req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    /**
     * The route, not the URL the browser typed.
     *
     * The UI calls `/api/users/5` and a service's own router knows it as
     * `/users/5`; the edge strips the prefix between the two. The skip list and
     * everything downstream are written against the route, so the prefix comes
     * off here — once, before either uses it. Left on, every entry in
     * SKIPPED_PATHS silently failed to match, which is how a token refresh
     * ended up in the trail.
     *
     * The normalised form is also what gets STORED, so two entries for the same
     * route compare equal whether the caller used the prefix or not.
     */
    const path = stripApiPrefix((req.originalUrl || req.url || '').split('?')[0]);

    if (shouldSkip(method, path)) return next();

    /**
     * The body is copied NOW, before any handler gets to it.
     *
     * Controllers routinely delete keys off req.body, normalise them, or
     * replace the object wholesale. Read at response time it would describe
     * what the handler ended up with, not what was asked for — and "what was
     * asked for" is the half an audit trail exists to preserve.
     */
    const requested = sanitise(req.body);

    /**
     * What the response said, kept only so the row can name the record that was
     * created. A POST has no id in its path; the id it returns is the only
     * place the new record is identified.
     */
    let responseData = null;
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      try {
        responseData = payload && typeof payload === 'object' ? (payload.data ?? payload) : null;
      } catch { /* a payload we cannot inspect is simply not inspected */ }
      return originalJson(payload);
    };

    /**
     * Detail a controller wants on the row, merged in when it is written.
     *
     * Enrichment only. A controller that never calls this still produces a
     * complete row, which is what keeps the trail from depending on anybody
     * remembering.
     */
    req.audit = (detail = {}) => {
      req._auditDetail = { ...(req._auditDetail || {}), ...detail };
      if (detail.metadata) {
        req._auditDetail.metadata = {
          ...(req._auditDetail.metadata || {}),
          ...detail.metadata,
        };
      }
    };

    res.on('finish', () => {
      /**
       * Only what actually happened.
       *
       * A refused or failed request changed nothing, and recording it as
       * activity would mean an administrator reading the trail cannot tell an
       * action from an attempt. Refusals are a security concern rather than an
       * audit one, and the security filters already count them.
       */
      if (res.statusCode >= 400) return;

      const actor = req.user;
      const detail = req._auditDetail || {};
      // No actor, nothing to attribute. The public property page and the share
      // resolver both land here, and neither is anybody's activity.
      if (!actor?.id && !detail.actor_id) return;

      const described = describeRequest(method, path);
      if (!described) return;

      const companyId = detail.company_id
        ?? numberOrNull(responseData?.company_id)
        ?? numberOrNull(req.body?.company_id)
        ?? numberOrNull(req.query?.company_id)
        ?? numberOrNull(actor?.company_id);

      const metadata = {
        ...(requested && Object.keys(requested).length ? { requested } : {}),
        ...(detail.metadata || {}),
      };

      // Deliberately not awaited: the response has already been sent, and the
      // client must not wait on the bookkeeping.
      record({
        company_id: companyId,
        actor_id: detail.actor_id ?? actor?.id,
        actor_name: detail.actor_name ?? actor?.name ?? null,
        actor_email: detail.actor_email ?? actor?.email ?? null,
        actor_type: detail.actor_type ?? actor?.effectiveType ?? actor?.type ?? null,
        actor_company_id: actor?.company_id ?? null,
        actor_is_platform: actor?.isSuperiorAdmin === true || actor?.type === 'superior_admin',
        action: detail.action ?? described.action,
        action_label: detail.action_label ?? described.label,
        module: detail.module ?? described.module,
        entity_type: detail.entity_type ?? described.entity_type,
        entity_id: detail.entity_id ?? described.entity_id ?? responseData?.id ?? null,
        entity_label: detail.entity_label ?? labelFrom(responseData, req.body),
        method,
        path,
        status_code: res.statusCode,
        ip: req.clientIp || req.ip || null,
        user_agent: req.headers?.['user-agent'] || null,
        metadata,
      }).catch(() => {});
    });

    return next();
  };

  return { auditMiddleware, record, sanitise };
};

module.exports = { createAuditor, sanitise, REDACTED_KEYS, SKIPPED_PATHS };
