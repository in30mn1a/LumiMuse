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
    dismissal_snapshot: Array.from({ length: extraction }, (_, index) => ({ kind: 'extraction', id: index + 1, version: 'v1' })),
    agent: { configured: true },
  };
}

function json(body, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
}

function serve(initial) {
  let current = status(initial);
  const writes = [];
  global.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(init.body));
      current = status(0);
    }
    return json(current);
  };
  return { writes, setExtraction: value => { current = status(value); } };
}

const isWarn = chip => chip.className.includes('text-danger');

test('mark as read persists the displayed snapshot and new active failures are highlighted', async () => {
  const server = serve(7);
  const view = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  const chip = () => view.container.querySelector('[data-status="extraction"]');

  await waitFor(() => assert.ok(chip()));
  assert.equal(isWarn(chip()), true, 'unread failures are highlighted');
  fireEvent.click(view.getByRole('button', { name: 'agent.status.dismiss' }));
  await waitFor(() => assert.equal(server.writes.length, 1));
  assert.deepEqual(server.writes[0], { dismissal_snapshot: status(7).dismissal_snapshot });
  await waitFor(() => assert.match(chip().textContent, /0/));
  assert.equal(isWarn(chip()), false, 'dismissed counts are no longer highlighted');
  assert.equal(view.queryByRole('button', { name: 'agent.status.dismiss' }), null);

  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 1 }));
  await waitFor(() => assert.match(chip().textContent, /0/));
  assert.equal(isWarn(chip()), false);

  server.setExtraction(3);
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 2 }));
  await waitFor(() => assert.match(chip().textContent, /3/));
  assert.equal(isWarn(chip()), true, 'new active failures are flagged');
});

test('dismissal survives remounts through server state instead of a browser count', async () => {
  serve(5);
  const first = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  await waitFor(() => assert.ok(first.getByRole('button', { name: 'agent.status.dismiss' })));
  fireEvent.click(first.getByRole('button', { name: 'agent.status.dismiss' }));
  await waitFor(() => assert.match(first.container.querySelector('[data-status="extraction"]').textContent, /0/));
  first.unmount();
  window.localStorage.clear();

  const second = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  await waitFor(() => assert.ok(second.container.querySelector('[data-status="extraction"]')));
  assert.equal(isWarn(second.container.querySelector('[data-status="extraction"]')), false);
});

test('failed dismissal keeps active warnings and displays the failure', async () => {
  global.fetch = async (_url, init) => init?.method === 'POST'
    ? json({ error: 'cannot save dismissal' }, 500)
    : json(status(2));
  const view = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  const button = await view.findByRole('button', { name: 'agent.status.dismiss' });
  fireEvent.click(button);
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /cannot save dismissal/));
  assert.equal(isWarn(view.container.querySelector('[data-status="extraction"]')), true);
  assert.equal(button.disabled, false);
});

test('an older GET response cannot restore warnings after a successful dismissal', async () => {
  let reads = 0;
  let resolveOldRead;
  global.fetch = async (_url, init) => {
    if (init?.method === 'POST') return json(status(0));
    reads += 1;
    if (reads === 2) return new Promise(resolve => { resolveOldRead = resolve; });
    return json(status(2));
  };
  const view = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  await view.findByRole('button', { name: 'agent.status.dismiss' });
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 1 }));
  await waitFor(() => assert.equal(typeof resolveOldRead, 'function'));
  fireEvent.click(view.getByRole('button', { name: 'agent.status.dismiss' }));
  await waitFor(() => assert.match(view.container.querySelector('[data-status="extraction"]').textContent, /0/));
  await act(async () => { resolveOldRead(json(status(2))); });
  assert.equal(isWarn(view.container.querySelector('[data-status="extraction"]')), false);
});

test('refreshes during dismissal run afterwards and reveal new issues without duplicate POSTs', async () => {
  let reads = 0;
  let writes = 0;
  let resolveWrite;
  global.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      writes += 1;
      return new Promise(resolve => { resolveWrite = resolve; });
    }
    reads += 1;
    return json(status(reads === 1 ? 2 : 1));
  };
  const view = render(React.createElement(AgentStatusBar, { refreshKey: 0 }));
  const button = await view.findByRole('button', { name: 'agent.status.dismiss' });
  fireEvent.click(button);
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.equal(writes, 1);
  view.rerender(React.createElement(AgentStatusBar, { refreshKey: 1 }));
  assert.equal(reads, 1, 'a refresh waits for the dismissal to finish');
  await act(async () => { resolveWrite(json(status(0))); });
  await waitFor(() => assert.equal(reads, 2));
  await waitFor(() => assert.match(view.container.querySelector('[data-status="extraction"]').textContent, /1/));
  assert.equal(isWarn(view.container.querySelector('[data-status="extraction"]')), true);
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
