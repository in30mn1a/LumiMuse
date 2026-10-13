const test = require('node:test');
const assert = require('node:assert/strict');

function loadDomHelper() {
  try {
    return require('./helpers/dom-test-environment.cjs');
  } catch {
    return {};
  }
}

test('DOM test helper installs a usable document and restores globals', () => {
  const { installDomTestEnvironment } = loadDomHelper();
  assert.equal(typeof installDomTestEnvironment, 'function');

  const originalDocument = global.document;
  const cleanup = installDomTestEnvironment();
  try {
    const button = document.createElement('button');
    button.textContent = 'focus me';
    document.body.appendChild(button);
    button.focus();

    assert.ok(document.activeElement === button, 'the created button should receive focus');
    assert.equal(typeof requestAnimationFrame, 'function');
  } finally {
    cleanup();
  }

  assert.equal(global.document, originalDocument);
});
