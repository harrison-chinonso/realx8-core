/**
 * Finds errors that are caught INSIDE an open transaction and survived.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * MySQL lets a transaction carry on after one of its statements fails.
 * Postgres does not: any failed statement aborts the whole transaction, and
 * every statement after it is refused with "current transaction is aborted,
 * commands ignored until end of transaction block". So code that catches a
 * failure on purpose — a duplicate idempotency key meaning "already done", a
 * missing optional table meaning "use the default" — works in development and
 * sinks the whole operation in production, with an error that names an
 * innocent later statement. Recording a commission payment failed exactly
 * this way (see shared/src/commissionStore.js, markPayoutPaid).
 *
 * The fix is always the same: run the statement whose failure is tolerated
 * inside withSavepoint() from shared/src/dialect, which rolls back only that
 * statement on both engines. This lint makes the pattern impossible to add
 * without noticing.
 *
 * ── What it flags ───────────────────────────────────────────────────────────
 *
 * A database call that is given a `transaction` option, where a failure of
 * that call is caught by a handler that can complete WITHOUT rethrowing —
 *
 *   query(…, { transaction }).catch(() => …)          a .catch that swallows
 *   try { await query(…, { transaction }) } catch {…}  a catch that can return
 *
 * — unless the call runs inside a withSavepoint() callback that the handler
 * sits outside of. A try/catch wrapped around a whole sequelize.transaction()
 * is not flagged: by the time it catches, that transaction is over.
 *
 * A finding that is genuinely safe (the transaction is never a Postgres one,
 * or nothing runs on it afterwards) is acknowledged with a comment containing
 * `tx-safe:` and the reason, on the line of the catch or the line above it.
 *
 * Run: npm run lint:tx      (exit 1 when anything is found)
 */
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'shared', 'platform'];

const walkFiles = (dir, files = []) => {
  if (!fs.existsSync(dir)) return files;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  });
  return files;
};

const parse = (source) => {
  const options = { ecmaVersion: 'latest', loc: true, range: true, comment: true };
  try {
    return espree.parse(source, { ...options, sourceType: 'script' });
  } catch {
    return espree.parse(source, { ...options, sourceType: 'module' });
  }
};

const isFunction = (node) => node && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration)$/.test(node.type);

const calleeName = (call) => {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
};

/** A call whose options object carries `transaction` (shorthand or not), other than `transaction: null`. */
const passesTransaction = (call) => call.arguments.some((arg) => arg.type === 'ObjectExpression'
  && arg.properties.some((prop) => prop.type === 'Property'
    && !prop.computed
    && ((prop.key.type === 'Identifier' && prop.key.name === 'transaction')
      || (prop.key.type === 'Literal' && prop.key.value === 'transaction'))
    && !(prop.value.type === 'Literal' && prop.value.value === null)));

/**
 * A handler that rolls the transaction back has ended it, so nothing after it
 * can be poisoned — `catch (error) { await transaction.rollback(); … }` around a
 * manually opened transaction is the correct shape, not a swallow.
 */
const rollsBack = (node) => {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'CallExpression' && calleeName(node) === 'rollback') return true;
  return Object.keys(node).some((key) => {
    if (key === 'parent' || key === 'loc' || key === 'range') return false;
    const value = node[key];
    if (Array.isArray(value)) return value.some(rollsBack);
    return value && typeof value.type === 'string' ? rollsBack(value) : false;
  });
};

/**
 * Callbacks that put their own boundary around the statements inside them:
 * a savepoint (withSavepoint) or a whole transaction (sequelize.transaction).
 * A failure inside either is handled by that boundary, so the search does not
 * descend into their function arguments.
 */
const BOUNDARY_CALLS = new Set(['withSavepoint', 'transaction']);

/** Every transaction-bearing call reachable inside `node` without crossing a boundary. */
const transactionCallsIn = (node, found = []) => {
  if (!node || typeof node.type !== 'string') return found;
  /*
   * A nested try whose catch rolls the transaction back owns the failures of
   * its block; an outer catch never sees that transaction in a poisoned state.
   */
  if (node.type === 'TryStatement' && node.handler && rollsBack(node.handler.body)) {
    transactionCallsIn(node.handler, found);
    if (node.finalizer) transactionCallsIn(node.finalizer, found);
    return found;
  }
  if (node.type === 'CallExpression') {
    if (passesTransaction(node)) found.push(node);
    if (BOUNDARY_CALLS.has(calleeName(node))) {
      // The callee chain and non-function arguments are still this scope's.
      transactionCallsIn(node.callee, found);
      node.arguments.filter((arg) => !isFunction(arg)).forEach((arg) => transactionCallsIn(arg, found));
      return found;
    }
  }
  Object.keys(node).forEach((key) => {
    if (key === 'parent' || key === 'loc' || key === 'range') return;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => transactionCallsIn(child, found));
    else if (value && typeof value.type === 'string') transactionCallsIn(value, found);
  });
  return found;
};

/**
 * Whether a handler can finish without throwing — i.e. it SWALLOWS at least
 * some failures. Only "the last statement is a throw and nothing returns
 * early" counts as always rethrowing; anything conditional is a swallow,
 * because a conditional rethrow (`if (!duplicate) throw error`) is exactly the
 * shape that tolerates a failure on purpose.
 */
const containsReturn = (node) => {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'ReturnStatement') return true;
  if (isFunction(node)) return false; // a nested function's return is its own
  return Object.keys(node).some((key) => {
    if (key === 'parent' || key === 'loc' || key === 'range') return false;
    const value = node[key];
    if (Array.isArray(value)) return value.some(containsReturn);
    return value && typeof value.type === 'string' ? containsReturn(value) : false;
  });
};

const alwaysThrows = (body) => {
  if (!body) return false;
  if (body.type === 'ThrowStatement') return true;
  if (body.type !== 'BlockStatement') return false; // an arrow's expression body returns a value
  const last = body.body[body.body.length - 1];
  return Boolean(last && last.type === 'ThrowStatement') && !containsReturn({ type: 'Block', body: body.body.slice(0, -1) });
};

const acknowledged = (lines, line) => [line, line - 1, line - 2]
  .some((n) => n >= 1 && /tx-safe:/.test(lines[n - 1] || ''));

/** Find every swallow-around-a-transaction in one file's AST. */
const findingsFor = (source, file) => {
  let ast;
  try { ast = parse(source); } catch (error) {
    return [{ file, line: 0, kind: 'parse-error', detail: error.message }];
  }
  const lines = source.split('\n');
  const findings = [];

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;

    // promise.catch(handler)
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && !node.callee.computed && node.callee.property.name === 'catch') {
      const handler = node.arguments[0];
      const swallows = !handler || !isFunction(handler) || (!alwaysThrows(handler.body) && !rollsBack(handler.body));
      if (swallows) {
        transactionCallsIn(node.callee.object).forEach((call) => {
          const line = node.callee.property.loc.start.line;
          if (!acknowledged(lines, line)) {
            findings.push({ file, line, kind: '.catch swallows', call: calleeName(call), callLine: call.loc.start.line });
          }
        });
      }
    }

    // try { … } catch { … }
    if (node.type === 'TryStatement' && node.handler && !alwaysThrows(node.handler.body) && !rollsBack(node.handler.body)) {
      transactionCallsIn(node.block).forEach((call) => {
        const line = node.handler.loc.start.line;
        if (!acknowledged(lines, line)) {
          findings.push({ file, line, kind: 'try/catch swallows', call: calleeName(call), callLine: call.loc.start.line });
        }
      });
    }

    Object.keys(node).forEach((key) => {
      if (key === 'parent' || key === 'loc' || key === 'range') return;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    });
  };
  visit(ast);

  // One finding per (handler, call) pair is plenty; collapse repeats.
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.callLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const scan = (roots = SCAN_DIRS.map((dir) => path.join(ROOT, dir))) => roots
  .flatMap((root) => walkFiles(root))
  .flatMap((file) => findingsFor(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)));

if (require.main === module) {
  const findings = scan();
  if (!findings.length) {
    console.log('No errors caught and survived inside an open transaction.');
    process.exit(0);
  }
  console.log(`${findings.length} place(s) catch a failure inside an open transaction and carry on.\n`
    + 'On Postgres that aborts the transaction. Run the tolerated statement inside\n'
    + "withSavepoint() from shared/src/dialect, or mark it `// tx-safe: <reason>`.\n");
  findings.forEach((f) => {
    console.log(`  ${f.file}:${f.line}  ${f.kind}${f.call ? ` — ${f.call}() on line ${f.callLine}` : ''}${f.detail ? ` — ${f.detail}` : ''}`);
  });
  process.exit(1);
}

module.exports = { findingsFor, scan };
