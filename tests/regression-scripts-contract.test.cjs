const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('package regression script executes checked-in regression scripts', () => {
  const pkg = readJson('package.json');
  const command = pkg.scripts && pkg.scripts.regression;

  assert.equal(typeof command, 'string');
  assert.notEqual(command.trim(), '');

  const scriptRefs = [...command.matchAll(/node\s+scripts\/(regression-check-[^\s&]+\.js)/g)]
    .map((match) => match[1]);

  assert.ok(scriptRefs.length > 0, 'expected at least one regression script in the gate');

  for (const script of scriptRefs) {
    const scriptPath = `scripts/${script}`;
    assert.ok(fs.existsSync(path.join(root, scriptPath)), `${scriptPath} should exist`);
    assert.doesNotThrow(
      () => childProcess.execFileSync('git', ['ls-files', '--error-unmatch', scriptPath], {
        cwd: root,
        stdio: 'pipe',
      }),
      `${scriptPath} should be tracked by git`,
    );
  }
});

test('CI runs the regression gate after the regular test suite', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const testIndex = ci.indexOf('run: npm test');
  const regressionIndex = ci.indexOf('run: npm run regression');

  assert.notEqual(testIndex, -1);
  assert.notEqual(regressionIndex, -1);
  assert.ok(regressionIndex > testIndex);
});

test('memory index smoke does not depend on optional agent-browser automation', () => {
  const smoke = fs.readFileSync(path.join(root, 'tests', 'memory-index-flow-smoke.cjs'), 'utf8');

  assert.equal(smoke.includes('agent-browser'), false);
  assert.equal(smoke.includes('skipped: true'), false);
});
