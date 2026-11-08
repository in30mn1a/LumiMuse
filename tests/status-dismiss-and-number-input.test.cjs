const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, fireEvent, render, waitFor } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const originalFetch = global.fetch;
const mocks = {
  '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
};

Module._resolveFilename = function resolveFilename(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function load(request, ...args) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;

const AgentStatusBar = require('../src/components/agent/AgentStatusBar.tsx').default;
const NumberInput = require('../src/components/ui/NumberInput.tsx').default;

test.afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  window.localStorage.clear();
});
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

function status(extraction) {
  return {
    failed_tasks: { extraction, profile: 0, embedding: 0 },
    repairable_candidates: 0,
    recent_errors: 0,
    recent_error_window_hours: 24,
    agent: { configured: true },
  };
}

function serve(values) {
  let index = 0;
  global.fetch = async () => {
    const body = status(values[Math.min(index, values.length - 1)]);
    index += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const isWarn = chip => chip.className.includes('text-danger');

test('mark as read stops highlighting current counts, and new failures after a drop are flagged again', async () => {
  serve([7, 7, 0, 3]);
  const view = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  const chip = () => view.container.querySelector('[data-status="extraction"]');

  await waitFor(() => assert.ok(chip()));
  assert.equal(isWarn(chip()), true, 'unread failures are highlighted');
  fireEvent.click(view.getByRole('button', { name: 'agent.status.dismiss' }));
  assert.equal(isWarn(chip()), false, 'dismissed counts are no longer highlighted');
  assert.match(chip().textContent, /7/, 'the count itself stays visible');
  assert.equal(view.queryByRole('button', { name: 'agent.status.dismiss' }), null);

  // 同样的 7 条：刷新后仍保持已读
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 1 }));
  await waitFor(() => assert.match(chip().textContent, /7/));
  assert.equal(isWarn(chip()), false);

  // 回落到 0 再新增 3 条：新的 3 条必须重新提醒
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 2 }));
  await waitFor(() => assert.match(chip().textContent, /0/));
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 3 }));
  await waitFor(() => assert.match(chip().textContent, /3/));
  assert.equal(isWarn(chip()), true, 'failures that appear after the count dropped are flagged');
});

test('dismissal survives a remount through localStorage', async () => {
  serve([5]);
  const first = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  await waitFor(() => assert.ok(first.getByRole('button', { name: 'agent.status.dismiss' })));
  fireEvent.click(first.getByRole('button', { name: 'agent.status.dismiss' }));
  first.unmount();

  const second = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  await waitFor(() => assert.ok(second.container.querySelector('[data-status="extraction"]')));
  assert.equal(isWarn(second.container.querySelector('[data-status="extraction"]')), false);
});

function NumberHarness({ initial, onCommit }) {
  const [value, setValue] = React.useState(initial);
  return React.createElement(NumberInput, {
    'aria-label': 'num',
    value,
    onValueChange: next => { onCommit(next); setValue(next); },
  });
}

test('number input can be cleared while editing and restores the last value on blur', async () => {
  const commits = [];
  const view = render(React.createElement(NumberHarness, { initial: 4096, onCommit: v => commits.push(v) }));
  const input = view.getByRole('spinbutton', { name: 'num' });

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '' } });
  assert.equal(input.value, '', 'an emptied field stays empty instead of snapping to 0');
  assert.deepEqual(commits, [], 'empty input is not committed as 0');

  fireEvent.change(input, { target: { value: '8' } });
  fireEvent.change(input, { target: { value: '8192' } });
  assert.deepEqual(commits, [8, 8192]);

  fireEvent.change(input, { target: { value: '' } });
  await act(async () => { fireEvent.blur(input); });
  assert.equal(input.value, '8192', 'blur shows the last committed value');
});
