/**
 * Finds raw SQL that MySQL accepts and Postgres does not.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Development runs on MySQL and production runs on Postgres. That asymmetry
 * produces a specific, nasty failure mode: a query that is *more permissive* on
 * MySQL passes every local test, passes review, and fails for the first time in
 * front of a customer. `SELECT SUM(...) ... FOR UPDATE` did exactly that — it
 * was on the payment-approval path, which is the only caller that locks, so
 * every other read of the same table worked and nothing local could reproduce
 * it.
 *
 * verify:dialect catches this class too, but only for code somebody thought to
 * write a case for. This catches it by PATTERN, across every raw query in the
 * repository, including ones written next week.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * Not a SQL parser. It matches shapes, so it can be fooled by unusual
 * formatting, and it reports `guarded` separately rather than pretending to
 * understand control flow. A finding is a prompt to look, not a proof of a bug.
 * Findings it cannot classify are surfaced rather than dropped — the whole
 * point is to stop things being invisible.
 *
 * Run: npm run lint:sql
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'shared', 'platform'];

/** Files whose whole job is to paper over the difference. */
const EXEMPT = [
  path.join('shared', 'src', 'dialect.js'),
  path.join('shared', 'src', 'enumSync.js'),
];

const RED = '\x1b[31m'; const YELLOW = '\x1b[33m'; const GREEN = '\x1b[32m';
const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

/**
 * The rules.
 *
 * `severity: 'error'`   Postgres rejects this outright.
 * `severity: 'warn'`    Postgres accepts it but means something different, or
 *                       the construct is engine-specific enough to need a guard.
 */
const walk = (dir, files = []) => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  });
  return files;
};

const RULES = [
  {
    id: 'aggregate-with-for-update',
    severity: 'error',
    why: 'Postgres: "FOR UPDATE is not allowed with aggregate functions". A row lock '
      + 'claims rows; an aggregate has already collapsed them. MySQL permits it. '
      + 'Select the rows under the lock and aggregate in JavaScript.',
    test: (sql) => /\b(SUM|COUNT|AVG|MIN|MAX|GROUP_CONCAT)\s*\(/i.test(sql)
      && /\bFOR\s+UPDATE\b/i.test(sql)
      // A subquery aggregate is fine as long as the locking level has none.
      && !/\)\s*(AS\s+\w+\s*)?\)\s*\w*\s*$/i.test(sql.split(/\bFOR\s+UPDATE\b/i)[0].trim()),
  },
  {
    id: 'distinct-with-for-update',
    severity: 'error',
    why: 'Postgres: "FOR UPDATE is not allowed with DISTINCT". Same reason as the '
      + 'aggregate case — the lock has no rows to attach to.',
    test: (sql) => /\bSELECT\s+DISTINCT\b/i.test(sql) && /\bFOR\s+UPDATE\b/i.test(sql),
  },
  {
    id: 'group-by-with-for-update',
    severity: 'error',
    why: 'Postgres: "FOR UPDATE is not allowed with GROUP BY".',
    test: (sql) => /\bGROUP\s+BY\b/i.test(sql) && /\bFOR\s+UPDATE\b/i.test(sql),
  },
  {
    id: 'union-with-for-update',
    severity: 'error',
    why: 'Postgres: "FOR UPDATE is not allowed with UNION/INTERSECT/EXCEPT".',
    test: (sql) => /\b(UNION|INTERSECT|EXCEPT)\b/i.test(sql) && /\bFOR\s+UPDATE\b/i.test(sql),
  },
  {
    id: 'null-safe-equality',
    severity: 'error',
    why: 'The `<=>` operator is MySQL-only. Postgres spells it IS NOT DISTINCT FROM.',
    test: (sql) => /<=>/.test(sql),
  },
  {
    id: 'mysql-only-function',
    severity: 'error',
    why: 'MySQL-only function. Postgres equivalents: IFNULL→COALESCE, '
      + 'DATE_FORMAT→to_char, DATE_ADD/DATE_SUB→interval arithmetic, CURDATE→CURRENT_DATE, '
      + 'GROUP_CONCAT→string_agg, UNIX_TIMESTAMP→extract(epoch from …), '
      + 'STR_TO_DATE→to_timestamp, RAND→random, LAST_INSERT_ID→RETURNING.',
    test: (sql) => /\b(IFNULL|DATE_FORMAT|DATE_ADD|DATE_SUB|CURDATE|GROUP_CONCAT|UNIX_TIMESTAMP|STR_TO_DATE|LAST_INSERT_ID)\s*\(/i.test(sql)
      || /\bRAND\s*\(\s*\)/i.test(sql),
  },
  {
    id: 'mysql-only-statement',
    severity: 'error',
    why: 'MySQL-only statement form. INSERT IGNORE → ON CONFLICT DO NOTHING; '
      + 'ON DUPLICATE KEY UPDATE → ON CONFLICT … DO UPDATE; SHOW … → information_schema. '
      + 'shared/src/dialect.js has helpers for the first two.',
    test: (sql) => /\bINSERT\s+IGNORE\b/i.test(sql)
      || /\bON\s+DUPLICATE\s+KEY\b/i.test(sql)
      || /\bSHOW\s+(TABLES|COLUMNS|INDEX|INDEXES|CREATE)\b/i.test(sql),
  },
  {
    id: 'update-with-join',
    severity: 'error',
    why: 'MySQL writes `UPDATE a JOIN b …`; Postgres writes `UPDATE a SET … FROM b WHERE …`. '
      + 'The MySQL form is a syntax error there.',
    test: (sql) => /\bUPDATE\s+[`"\w.]+\s+(?:AS\s+\w+\s+)?(?:INNER\s+|LEFT\s+|RIGHT\s+)?JOIN\b/i.test(sql),
  },
  {
    id: 'delete-with-join',
    severity: 'error',
    why: 'MySQL writes `DELETE a FROM a JOIN b …`; Postgres writes `DELETE FROM a USING b …`.',
    test: (sql) => /\bDELETE\s+[`"\w.]+\s+FROM\b/i.test(sql),
  },
  {
    id: 'backtick-identifier',
    severity: 'error',
    why: 'Backticks are MySQL-only quoting; Postgres uses double quotes. '
      + 'Use quoteIdent/q from shared/src/dialect.js, which spells it per engine.',
    test: (sql) => /`[a-z_][a-z0-9_]*`/i.test(sql),
  },
  {
    id: 'limit-with-offset-comma',
    severity: 'error',
    why: 'MySQL accepts `LIMIT offset, count`; Postgres requires `LIMIT count OFFSET offset`.',
    test: (sql) => /\bLIMIT\s+:?\w+\s*,\s*:?\w+/i.test(sql),
  },
  {
    id: 'boolean-compared-to-integer',
    severity: 'error',
    why: 'Postgres rejects comparing a BOOLEAN column to 0/1 — "operator does not exist: '
      + 'boolean = integer". It fails loudly, but a catch block can turn that into a '
      + 'silently empty result. Use `IS TRUE` / `IS FALSE`.',
    test: (sql) => /\b(is_active|is_default|is_shareable|is_flagged|is_enabled|enabled|two_factor_enabled|public_enabled|actor_is_platform|is_read|is_primary|is_verified)\s*(=|!=|<>)\s*[01]\b/i.test(sql),
  },
  {
    id: 'double-quoted-literal',
    severity: 'warn',
    why: 'MySQL reads "x" as a string; Postgres reads it as an identifier and errors if no '
      + 'such column exists. Use single quotes for literals.',
    test: (sql) => /(=|\bIN\s*\(|\bLIKE\s+)\s*"[^"]*"/.test(sql),
  },
  {
    id: 'mysql-ddl-types',
    severity: 'warn',
    why: 'MySQL-only DDL. AUTO_INCREMENT→SERIAL/GENERATED, TINYINT(1)→BOOLEAN, '
      + 'DATETIME→TIMESTAMP, UNSIGNED has no Postgres equivalent, ENGINE=/CHARSET= are ignored. '
      + 'Guard the whole statement per engine.',
    test: (sql) => /\b(AUTO_INCREMENT|TINYINT\s*\(\s*1\s*\)|ENGINE\s*=|DEFAULT\s+CHARSET|UNSIGNED)\b/i.test(sql),
  },
  {
    id: 'group-by-selects-bare-column',
    severity: 'warn',
    why: 'Postgres requires every non-aggregated column in the SELECT list to appear in '
      + 'GROUP BY. MySQL (without ONLY_FULL_GROUP_BY) returns an arbitrary row\'s value '
      + 'instead of erroring — so this may be returning wrong data locally, not just '
      + 'failing in production.',
    test: (sql) => {
      const match = /\bSELECT\b([\s\S]+?)\bFROM\b[\s\S]*?\bGROUP\s+BY\b([\s\S]+?)(?:\bORDER\b|\bHAVING\b|\bLIMIT\b|$)/i.exec(sql);
      if (!match) return false;
      const groupTerms = match[2].split(',').map((part) => part.trim().toLowerCase());
      const grouped = groupTerms.map((term) => term.replace(/^.*\./, ''));

      /**
       * Tables whose PRIMARY KEY is in the GROUP BY.
       *
       * Postgres does allow a bare column when the query groups by the primary
       * key of the table it belongs to — every row in the group shares one
       * value, so there is nothing ambiguous to choose between. It just will
       * not extend that inference across a join, which is the real difference
       * from MySQL. Without this, every correctly written `GROUP BY i.id` query
       * is reported, and the one genuine case is buried among them.
       */
      const pkGrouped = new Set(
        groupTerms
          .filter((term) => /^\w+\.id$/.test(term))
          .map((term) => term.split('.')[0]),
      );

      return match[1].split(',').some((column) => {
        const expression = column.trim();
        if (!expression || /\b(SUM|COUNT|AVG|MIN|MAX|STRING_AGG|ARRAY_AGG|JSON|BOOL_)\s*\(/i.test(expression)) return false;
        if (/^\*$/.test(expression) || /\bCASE\b/i.test(expression)) return false;

        const qualified = expression.replace(/\s+AS\s+\w+$/i, '').trim().toLowerCase();
        const alias = /^(\w+)\.\w+$/.exec(qualified)?.[1];
        if (alias && pkGrouped.has(alias)) return false;

        const name = qualified.replace(/^.*\./, '');
        return /^[a-z_][a-z0-9_]*$/.test(name) && !grouped.includes(name);
      });
    },
  },
];

/**
 * Whether this query sits inside an explicit engine branch.
 *
 * Two separate questions, because the guard is in two different places.
 *
 * IN THE FILE — a ternary or an `if` a few lines above the query. Looked for in
 * a window, weighted backwards because that is where a guard sits relative to
 * the thing it guards.
 *
 * AT THE CALL SITE — and this is the one that matters most here. A whole
 * migration file can be MySQL-only without containing the word MySQL anywhere,
 * because its service's index.js invokes it inside `if (isMySQL(sequelize))`.
 * Those files are full of backticks and AUTO_INCREMENT quite legitimately: they
 * exist to walk a legacy MySQL installation forward and have nothing to do on
 * Postgres. Reporting them is not a small annoyance — twenty-one false
 * positives is a scanner people stop running, which costs more than the check
 * was ever worth.
 */
const GUARD = /\b(isMySQL|isMysql|isPostgres)\s*\(/;
const GUARD_BEFORE = 30;
const GUARD_AFTER = 6;

const isGuardedInFile = (lines, startLine) => {
  const from = Math.max(0, startLine - 1 - GUARD_BEFORE);
  const to = Math.min(lines.length, startLine - 1 + GUARD_AFTER);
  return lines.slice(from, to).some((line) => GUARD.test(line));
};

/** The body of the first balanced `{ … }` after `from`. */
const blockAfter = (source, from) => {
  const open = source.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
};

/**
 * Modules a service only ever calls under `if (isMySQL(...))`.
 *
 * Resolved from each service's index.js, both spellings the codebase uses:
 * `await require('./migrations/x')(sequelize)` inline, and `await x(sequelize)`
 * against a top-level require.
 */
const mysqlOnlyModules = () => {
  const only = new Set();

  SCAN_DIRS.map((dir) => path.join(ROOT, dir))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => walk(dir))
    .filter((file) => file.endsWith(path.join('src', 'index.js')))
    .forEach((indexFile) => {
      const source = fs.readFileSync(indexFile, 'utf8');
      const dir = path.dirname(indexFile);

      // Top-level `const name = require('./x')`, so a bare call can be resolved.
      const imports = new Map();
      const importPattern = /const\s+(\w+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let found = importPattern.exec(source);
      while (found) { imports.set(found[1], found[2]); found = importPattern.exec(source); }

      const resolve = (relative) => {
        const base = path.resolve(dir, relative);
        const candidate = base.endsWith('.js') ? base : `${base}.js`;
        if (fs.existsSync(candidate)) only.add(path.relative(ROOT, candidate));
      };

      const guardPattern = /if\s*\(\s*isMySQL\s*\(/g;
      let guard = guardPattern.exec(source);
      while (guard) {
        const body = blockAfter(source, guard.index);

        const inline = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
        let call = inline.exec(body);
        while (call) { resolve(call[1]); call = inline.exec(body); }

        const bare = /await\s+(\w+)\s*\(/g;
        call = bare.exec(body);
        while (call) {
          if (imports.has(call[1])) resolve(imports.get(call[1]));
          call = bare.exec(body);
        }

        guard = guardPattern.exec(source);
      }
    });

  return only;
};

/** Template literals and quoted strings that look like SQL. */
const SQL_SHAPE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+UNIQUE)\b/i;

/**
 * Blanks out comments, preserving line numbers.
 *
 * Necessary because this codebase explains itself at length, and the
 * explanations quote the very SQL they are warning against — the fix for the
 * aggregate-under-lock bug documents the broken shape in a comment directly
 * above the corrected query. A scanner that reads comments flags the file it
 * just fixed, which is both useless and actively misleading: the one place the
 * pattern is guaranteed to be harmless is a comment saying "do not do this".
 *
 * Replaced with spaces rather than removed so that every reported line number
 * still points at the right line.
 */
const stripComments = (source) => {
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Skip over string and template bodies so a `//` inside one is not read as
    // a comment. Templates may nest, but a `//` inside `${...}` is vanishingly
    // rare and would only cost a false negative.
    const quote = source[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) { j += 1; break; }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }

    out += source[i];
    i += 1;
  }
  return out;
};

/** `/* … *\/` and `-- …` inside a query string. */
const stripSqlComments = (sql) => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

const extractQueries = (source) => {
  const found = [];
  const push = (text, index) => {
    if (!SQL_SHAPE.test(text)) return;
    /**
     * The delimiters come off before any rule sees the query.
     *
     * Left on, a trailing quote sticks to the last token — `GROUP BY status'`
     * never matches the `status` in the select list, and every correctly
     * grouped query in the codebase is reported. Six false positives out of six
     * findings, which is a scanner that has taught you to ignore it.
     */
    found.push({
      /**
       * SQL's own comment forms come out too.
       *
       * Queries in this codebase carry `/* … *\/` blocks INSIDE the template
       * literal, explaining the very construct they are getting right — the
       * invoice query documents why it groups by `p.name`, using the words
       * "GROUP BY" in the prose. Left in, the first GROUP BY the rule finds is
       * the one in the sentence, and it parses a paragraph as a column list.
       */
      sql: stripSqlComments(text.slice(1, -1)),
      line: source.slice(0, index).split('\n').length,
    });
  };

  // Template literals, including multi-line ones.
  const template = /`(?:[^`\\]|\\[\s\S])*`/g;
  let match = template.exec(source);
  while (match) { push(match[0], match.index); match = template.exec(source); }

  // Single-line quoted strings.
  const quoted = /'(?:[^'\\\n]|\\.)*'/g;
  match = quoted.exec(source);
  while (match) { push(match[0], match.index); match = quoted.exec(source); }

  return found;
};

const main = () => {
  const files = SCAN_DIRS
    .map((dir) => path.join(ROOT, dir))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => walk(dir));

  const errors = [];
  const warnings = [];
  const guarded = [];
  let queriesScanned = 0;

  const mysqlOnly = mysqlOnlyModules();
  const driverBound = [];

  files.forEach((file) => {
    const relative = path.relative(ROOT, file);
    if (EXEMPT.includes(relative)) return;

    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');

    /**
     * A file that talks to the mysql2 driver and nothing else cannot reach
     * Postgres at all.
     *
     * `require('mysql2')` is not a hint about intent, it is a hard constraint:
     * the connection it opens speaks the MySQL wire protocol. Standalone
     * seeders written that way are MySQL-only by construction, and their
     * backticks are correct rather than overlooked.
     *
     * The `&& !Sequelize` half matters. Every service's config/database.js
     * imports mysql2 for one guarded bootstrap query AND builds the Sequelize
     * instance that may well be pointed at Postgres. Skipping those files
     * wholesale would blind the scanner to the connection layer of all nine
     * services — the opposite of what it is for.
     */
    const usesDriver = /require\(\s*['"]mysql2(\/promise)?['"]\s*\)/.test(source);
    const usesSequelize = /\bnew Sequelize\b|\bsequelize\.query\b|require\(\s*['"]sequelize['"]\s*\)/.test(source);
    if (usesDriver && !usesSequelize) {
      driverBound.push(relative);
      return;
    }

    extractQueries(stripComments(source)).forEach(({ sql, line }) => {
      queriesScanned += 1;
      RULES.forEach((rule) => {
        if (!rule.test(sql)) return;
        const finding = {
          file: relative, line, rule: rule.id, why: rule.why,
          excerpt: sql.replace(/\s+/g, ' ').trim().slice(0, 150),
        };
        const guardedHere = mysqlOnly.has(relative) || isGuardedInFile(lines, line);
        if (guardedHere) {
          guarded.push({ ...finding, by: mysqlOnly.has(relative) ? 'mysql-only migration' : 'engine branch' });
        }
        else if (rule.severity === 'error') errors.push(finding);
        else warnings.push(finding);
      });
    });
  });

  const report = (label, colour, findings) => {
    if (!findings.length) return;
    console.log(`\n${colour}${label} (${findings.length})${RESET}`);
    const byRule = new Map();
    findings.forEach((finding) => {
      if (!byRule.has(finding.rule)) byRule.set(finding.rule, []);
      byRule.get(finding.rule).push(finding);
    });
    byRule.forEach((group, rule) => {
      console.log(`\n  ${colour}${rule}${RESET}`);
      console.log(`  ${DIM}${group[0].why}${RESET}`);
      group.forEach((finding) => {
        console.log(`    ${finding.file}:${finding.line}`);
        console.log(`      ${DIM}${finding.excerpt}${RESET}`);
      });
    });
  };

  console.log(`\nScanned ${queriesScanned} raw queries across ${files.length} files.`);
  if (driverBound.length) {
    console.log(`${DIM}${driverBound.length} file(s) bound to the mysql2 driver were skipped: `
      + `${driverBound.join(', ')}${RESET}`);
  }
  report('MUST FIX — Postgres will reject these', RED, errors);
  report('REVIEW — accepted by both, but they do not mean the same thing', YELLOW, warnings);

  if (guarded.length) {
    console.log(`\n${DIM}${guarded.length} match(es) sit inside an explicit engine branch `
      + `and were not counted. Listed for completeness:${RESET}`);
    const byFile = new Map();
    guarded.forEach((finding) => {
      const key = `${finding.file} (${finding.by})`;
      byFile.set(key, (byFile.get(key) || 0) + 1);
    });
    [...byFile.entries()].sort().forEach(([file, count]) => {
      console.log(`  ${DIM}${file} — ${count} match${count === 1 ? '' : 'es'}${RESET}`);
    });
  }

  console.log('');
  if (errors.length) {
    console.log(`${RED}${errors.length} unguarded incompatibilit${errors.length === 1 ? 'y' : 'ies'}.${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}No unguarded Postgres incompatibilities.${RESET}`
    + (warnings.length ? ` ${YELLOW}${warnings.length} to review.${RESET}` : '') + '\n');
};

main();
