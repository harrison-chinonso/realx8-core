const { Op } = require('sequelize');

/**
 * Search, filter, sort and export for every list endpoint in the application.
 *
 * Each service had its own copy of a list handler that understood one thing:
 * `search`, matched with LIKE against two or three fields somebody had named by
 * hand. There was no way to filter by status, no way to bound a date range, no
 * way to sort by anything but id, and no way to read more than one page — so an
 * "export" could only ever contain the ten rows that happened to be on screen.
 *
 * This is the one place all four now live, so a table gains them by being a
 * table rather than by someone remembering to wire them up.
 *
 * ── Why the allow-list is derived from the model ─────────────────────────────
 *
 * Filterable columns are read from the model's own attributes rather than
 * configured per endpoint. Configuring them would have meant editing 39 call
 * sites to get the feature at all, and every table added later would arrive
 * without it — the failure mode being a filter that silently does nothing.
 *
 * The model already knows its columns, so the allow-list cannot drift from the
 * schema. What it must NOT do is expose columns that are not the caller's
 * business, which is what SENSITIVE below is for.
 *
 * ── Why an unknown field is an error and not an ignored one ──────────────────
 *
 * Silently dropping `filter[stauts]=draft` returns every row, formatted exactly
 * like a filtered answer. Somebody exports that as "draft notes", files it, and
 * nothing anywhere says the filter was never applied. A 400 naming the unknown
 * field is a moment's annoyance; the alternative is a wrong report that looks
 * right, so unknown filter and sort fields are refused.
 */

/**
 * Columns no filter, search or sort may ever touch.
 *
 * Matched as substrings of the column name, so a table added later that follows
 * the same naming gets the same protection without an edit here.
 *
 * These are not merely "private". Filtering is an ORACLE: `filter[password]
 * [like]=$2b$10$A%` answers a question about a hash one character at a time,
 * and `sort=password` leaks their order. A column that can never be filtered
 * cannot be interrogated that way.
 */
const SENSITIVE = [
  'password', 'passcode_hash', 'secret', 'token', 'salt',
  'private_key', 'api_key', 'signature',
];

const isSensitive = (column) => {
  const name = String(column).toLowerCase();
  return SENSITIVE.some((fragment) => name.includes(fragment));
};

/** The largest export we will assemble in one response. */
const EXPORT_LIMIT = 10000;

/** The largest ordinary page. Unchanged from the per-service handlers. */
const MAX_PAGE_SIZE = 100;

const attributesOf = (Model) => (typeof Model.getAttributes === 'function'
  ? Model.getAttributes()
  : Model.rawAttributes || {});

/** Every column of the model a caller is allowed to name. */
const filterableColumns = (Model) => Object.keys(attributesOf(Model)).filter((c) => !isSensitive(c));

/**
 * The columns of this model that must never be SENT, as opposed to never being
 * queried.
 *
 * Two different holes, one list. Refusing to filter on `password` stops the
 * column being interrogated; it does nothing about a list endpoint that
 * serialises the row wholesale and puts the hash in the response body. The
 * second is the worse of the two and was the older bug: nothing excluded these
 * attributes, so a plain GET of a user list returned every bcrypt hash to
 * anyone who could log in.
 */
const sensitiveColumns = (Model) => Object.keys(attributesOf(Model)).filter(isSensitive);

const typeKeyOf = (attribute) => String(attribute?.type?.key || '').toUpperCase();

const TEXTUAL = new Set(['STRING', 'TEXT', 'CHAR', 'CITEXT', 'ENUM', 'UUID']);
const NUMERIC = new Set(['INTEGER', 'BIGINT', 'FLOAT', 'REAL', 'DOUBLE', 'DECIMAL', 'SMALLINT', 'TINYINT', 'MEDIUMINT']);
const TEMPORAL = new Set(['DATE', 'DATEONLY', 'TIME']);

/**
 * Columns a bare `search=` sweeps.
 *
 * Text only, and only when the endpoint has not named its own. LIKE against a
 * number or a date makes MySQL cast every row before comparing, which cannot
 * use an index — the cost of a "search everything" default is a full scan of
 * the columns where it could never have matched anything useful anyway.
 */
const defaultSearchFields = (Model) => Object.entries(attributesOf(Model))
  .filter(([column, attribute]) => !isSensitive(column) && TEXTUAL.has(typeKeyOf(attribute)))
  .map(([column]) => column);

/** The operators a caller may name, and the Sequelize symbol each becomes. */
const OPERATORS = {
  eq: Op.eq,
  ne: Op.ne,
  gt: Op.gt,
  gte: Op.gte,
  lt: Op.lt,
  lte: Op.lte,
  like: Op.like,
  in: Op.in,
  notIn: Op.notIn,
  between: Op.between,
};

/** Operators whose value is a comma-separated list rather than one scalar. */
const LIST_OPERATORS = new Set(['in', 'notIn', 'between']);

class ListQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.name = 'ListQueryError';
  }
}

/**
 * A query-string value as the column's own type.
 *
 * Everything arrives as a string. Comparing the string "10" against an INTEGER
 * column works in MySQL by coercion, but a DATE compared as a string does not
 * behave the way anyone expects, and an unparseable date silently matches
 * nothing — which looks like "no results" rather than "bad input".
 */
const coerce = (raw, attribute, column) => {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  const key = typeKeyOf(attribute);

  if (value === '' || value.toLowerCase() === 'null') return null;

  if (NUMERIC.has(key)) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new ListQueryError(`Filter on "${column}" expects a number, received "${value}".`);
    }
    return number;
  }

  if (TEMPORAL.has(key)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ListQueryError(`Filter on "${column}" expects a date, received "${value}".`);
    }
    return date;
  }

  if (key === 'BOOLEAN') {
    if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
    throw new ListQueryError(`Filter on "${column}" expects true or false, received "${value}".`);
  }

  return value;
};

/**
 * One column's clause, from whatever shape the query string produced.
 *
 *   filter[status]=draft                  -> a scalar
 *   filter[status]=draft,sent             -> IN, because a list is what a
 *                                            multi-select control sends
 *   filter[amount][gte]=1000              -> an operator object
 *   filter[created_at][between]=a,b       -> a range
 */
const clauseFor = (column, raw, attribute) => {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const clause = {};
    Object.entries(raw).forEach(([operator, operand]) => {
      if (!OPERATORS[operator]) {
        throw new ListQueryError(
          `Unknown filter operator "${operator}" on "${column}". `
          + `Use one of: ${Object.keys(OPERATORS).join(', ')}.`,
        );
      }
      if (LIST_OPERATORS.has(operator)) {
        const parts = String(operand).split(',').map((part) => part.trim()).filter(Boolean);
        if (operator === 'between' && parts.length !== 2) {
          throw new ListQueryError(`Filter "between" on "${column}" needs two comma-separated bounds.`);
        }
        clause[OPERATORS[operator]] = parts.map((part) => coerce(part, attribute, column));
      } else if (operator === 'like') {
        // The caller supplies the term; the wildcards are ours, so a value
        // containing % cannot turn one column's filter into a scan.
        clause[Op.like] = `%${String(operand).replace(/[%_]/g, '\\$&')}%`;
      } else {
        clause[OPERATORS[operator]] = coerce(operand, attribute, column);
      }
    });
    return clause;
  }

  // A bare list is an IN: `filter[status]=draft,sent` is what a multi-select
  // sends, and reading it as the literal string "draft,sent" would match nothing.
  const value = String(raw);
  if (value.includes(',')) {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    return { [Op.in]: parts.map((part) => coerce(part, attribute, column)) };
  }

  const single = coerce(value, attribute, column);
  return single === null ? { [Op.is]: null } : { [Op.eq]: single };
};

/**
 * The WHERE the caller asked for — their filters and their search, and nothing
 * else.
 *
 * Deliberately does NOT include the company scope. See buildListQuery.
 */
const buildUserWhere = (Model, req, config = {}) => {
  const attributes = attributesOf(Model);
  const allowed = new Set(filterableColumns(Model));
  const clauses = [];

  // ── Filters ────────────────────────────────────────────────────────────────
  const filters = req.query.filter;
  if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
    Object.entries(filters).forEach(([column, raw]) => {
      if (!allowed.has(column)) {
        throw new ListQueryError(
          `Cannot filter on "${column}" — it is not a column of this table.`,
        );
      }
      /**
       * company_id is not the caller's to choose.
       *
       * The scope is applied separately and always wins, so naming it here
       * could not cross a tenant boundary even if it were allowed. It is
       * refused anyway rather than quietly ignored: a caller who wrote it
       * believes it is doing something, and for a platform admin — the one
       * caller who CAN legitimately choose — `?company_id=` is the parameter
       * that works.
       */
      if (column === 'company_id') {
        throw new ListQueryError(
          'Filtering by company_id is not permitted. Use the company_id query parameter.',
        );
      }
      clauses.push({ [column]: clauseFor(column, raw, attributes[column]) });
    });
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const search = String(req.query.search ?? '').trim();
  if (search) {
    const fields = (config.searchFields?.length ? config.searchFields : defaultSearchFields(Model))
      .filter((field) => allowed.has(field));
    if (fields.length) {
      const term = `%${search.replace(/[%_]/g, '\\$&')}%`;
      clauses.push({ [Op.or]: fields.map((field) => ({ [field]: { [Op.like]: term } })) });
    }
  }

  return clauses;
};

/**
 * ORDER BY, from `sort=-created_at,name`.
 *
 * A leading minus is descending, which is the convention the UI's table headers
 * already produce.
 */
const buildOrder = (Model, req, config = {}) => {
  const raw = String(req.query.sort ?? '').trim();
  if (!raw) return config.order || [['id', 'DESC']];

  const allowed = new Set(filterableColumns(Model));
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const descending = part.startsWith('-');
    const column = descending ? part.slice(1) : part;
    if (!allowed.has(column)) {
      throw new ListQueryError(`Cannot sort by "${column}" — it is not a column of this table.`);
    }
    return [column, descending ? 'DESC' : 'ASC'];
  });
};

/**
 * Page, or the whole filtered set for an export.
 *
 * An export is capped rather than unbounded: assembling an unbounded result
 * means holding every matching row in memory and is a denial of service anyone
 * with a login could trigger. When the cap bites the response SAYS so, because
 * a report silently missing its tail is worse than one that reports being
 * truncated.
 */
const buildWindow = (req) => {
  const exporting = ['true', '1', 'yes'].includes(String(req.query.export ?? '').toLowerCase())
    || String(req.query.limit ?? '').toLowerCase() === 'all';

  if (exporting) return { exporting, page: 1, limit: EXPORT_LIMIT, offset: 0 };

  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), MAX_PAGE_SIZE);
  return { exporting, page, limit, offset: (page - 1) * limit };
};

/**
 * Everything a list handler needs, from the request.
 *
 * ── The scope is combined with Op.and, never merged ──────────────────────────
 *
 * The old handlers built one flat object by spreading the company scope, then
 * the search, then the endpoint's own clause. Spreading means the LAST writer
 * of a key wins, so a user-supplied clause naming the same column as the scope
 * would have replaced it. Op.and cannot be overwritten by a later key: every
 * clause has to hold, so the tenant scope survives whatever the caller sends.
 */
const buildListQuery = (Model, req, config = {}) => {
  const userClauses = buildUserWhere(Model, req, config);
  const scopeClauses = [
    config.defaultWhere ? config.defaultWhere(req) : null,
    config.whereBuilder ? config.whereBuilder(req) : null,
  ].filter((clause) => clause && Object.keys(clause).length);

  const all = [...userClauses, ...scopeClauses];
  const where = all.length ? { [Op.and]: all } : {};

  return { where, order: buildOrder(Model, req, config), ...buildWindow(req) };
};

module.exports = {
  buildListQuery,
  buildUserWhere,
  buildOrder,
  buildWindow,
  filterableColumns,
  sensitiveColumns,
  defaultSearchFields,
  isSensitive,
  ListQueryError,
  EXPORT_LIMIT,
  MAX_PAGE_SIZE,
  SENSITIVE,
  OPERATORS,
};
