/**
 * Cross-platform test entry: expand test globs ourselves so Windows CI
 * does not pass a literal `tests/*.test.cjs` path to `node --test`.
 *
 * PowerShell / cmd do not expand globs the way bash does; without this
 * helper, `npm test` fails on GitHub Actions windows-2022 with:
 *   Could not find '...\\tests\\*.test.cjs'
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');

function listMatchingTests() {
  const entries = fs.readdirSync(testsDir);
  return entries
    .filter(name => name.endsWith('.test.cjs') || name.endsWith('-smoke.cjs'))
    .sort()
    .map(name => path.join('tests', name));
}

const files = listMatchingTests();
if (files.length === 0) {
  console.error('No test files matched tests/*.test.cjs or tests/*-smoke.cjs');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', ...files],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    // Windows needs shell:false with absolute node + relative file args.
    shell: false,
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
