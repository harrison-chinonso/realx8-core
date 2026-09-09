#!/usr/bin/env node
/**
 * `npm run dev:all` — the whole stack in one command, one terminal.
 *
 * Starts the backend (this repo, all nine services in one process on :3000) and
 * the web app (Realx8-Ui, Vite on :5173) side by side, with prefixed and
 * coloured output so you can tell which is which. Ctrl-C stops both.
 *
 * This is the ONLY place the two repos know about each other, and only for
 * local development — nothing in the Docker images, the deployment configs or
 * the running code refers across. The UI is found next door by default; point
 * UI_DIR somewhere else if you keep it elsewhere:
 *
 *     UI_DIR=~/code/Realx8-Ui npm run dev:all
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CORE_DIR = path.resolve(__dirname, '..');
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const UI_DIR = path.resolve(expandHome(process.env.UI_DIR || path.join(CORE_DIR, '..', 'Realx8-Ui')));

if (!fs.existsSync(path.join(UI_DIR, 'package.json'))) {
  console.error(`\nCannot find Realx8-Ui at:\n  ${UI_DIR}\n`);
  console.error('Clone it next to this repo, or point UI_DIR at it:');
  console.error('  UI_DIR=/path/to/Realx8-Ui npm run dev:all\n');
  console.error('To run the backend on its own instead:  npm run dev\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(UI_DIR, 'node_modules'))) {
  console.error(`\nRealx8-Ui has no node_modules yet. Run:\n  npm run install:all\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(CORE_DIR, 'cred.env'))) {
  console.error('\nNo cred.env in this repo. Create it from the template:');
  console.error('  cp cred.env.example cred.env\n');
  console.error('then set DB_* and JWT_SECRET. See README.md.\n');
  process.exit(1);
}

// concurrently is a devDependency here; resolve its binary rather than assume
// it is on PATH.
const concurrently = path.join(CORE_DIR, 'node_modules', '.bin', 'concurrently');

const child = spawn(concurrently, [
  '--names', 'core,ui',
  '--prefix-colors', 'cyan.bold,magenta.bold',
  // If one dies the other is useless on its own, so take both down.
  '--kill-others',
  // Ctrl-C should exit quietly, not print a stack trace.
  '--success', 'first',
  `npm run dev --prefix ${JSON.stringify(CORE_DIR)}`,
  `npm run dev --prefix ${JSON.stringify(UI_DIR)}`,
], { stdio: 'inherit', shell: false });

console.log(`\n  backend  ${CORE_DIR}  ->  http://localhost:3000`);
console.log(`  web app  ${UI_DIR}  ->  http://localhost:5173`);
console.log('  open http://localhost:5173 — it proxies /api to the backend\n');

child.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0));
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => child.kill(s)));
