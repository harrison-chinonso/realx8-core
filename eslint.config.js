const js = require('@eslint/js');
const globals = require('globals');

/**
 * What this is for.
 *
 * Node does not resolve a reference until it runs the line, so a service can
 * require cleanly, pass every smoke test, and throw ReferenceError the first
 * time a particular branch is taken. That happened here: commissionStore called
 * insertReturningId while importing only isDuplicateError from the same module.
 * `node -e "require(...)"` said the file loaded; the fault would have surfaced
 * the first time a payout batch ran in production.
 *
 * `no-undef` catches that class outright, which is why this file exists.
 *
 * It is deliberately not a style guide. This codebase is large and consistent
 * with itself, and a formatting preset would bury the few findings that matter.
 * Correctness as errors, tidiness as warnings, nothing about layout.
 */
module.exports = [
  {
    /*
     * This codebase carries eslint-disable comments from a stricter preset —
     * no-await-in-loop, import/no-dynamic-require and friends. Those rules are
     * not enabled here, which made ESLint report 127 "unused directive"
     * warnings and error on the ones naming a plugin that is not installed.
     *
     * The comments are not wrong; this config is narrower than the one they
     * were written for. Deleting them to quieten a rule set they predate would
     * throw away the reasoning, so the reporting is turned off instead.
     */
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'coverage/**',
      'uploads/**',
      'public/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Best-effort lookups swallow deliberately, all over this codebase.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
