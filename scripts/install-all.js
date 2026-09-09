#!/usr/bin/env node
/**
 * `npm run install:all` — install both repos' dependencies in one go.
 * Same UI_DIR rule as dev-all.js.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CORE_DIR = path.resolve(__dirname, '..');
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const UI_DIR = path.resolve(expandHome(process.env.UI_DIR || path.join(CORE_DIR, '..', 'Realx8-Ui')));

const run = (label, cwd) => {
  console.log(`\n── installing ${label}  (${cwd})`);
  const r = spawnSync('npm', ['install'], { cwd, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\n${label} install failed.`); process.exit(r.status ?? 1); }
};

run('Realx8-Core', CORE_DIR);
if (fs.existsSync(path.join(UI_DIR, 'package.json'))) {
  run('Realx8-Ui', UI_DIR);
} else {
  console.log(`\n── skipping Realx8-Ui: nothing at ${UI_DIR}`);
  console.log('   (point UI_DIR at it if it lives elsewhere)');
}
console.log('\nDone. Start everything with:  npm run dev:all\n');
