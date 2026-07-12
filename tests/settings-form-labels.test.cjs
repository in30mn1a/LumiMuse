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
const { cleanup, fireEvent, render } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
}

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

function assertNoOrphanLabels(container) {
  const orphaned = [...container.querySelectorAll('label')]
    .filter(label => label.control === null)
    .map(label => label.textContent?.trim() || '<empty>');
  assert.deepEqual(orphaned, []);
}

function loadSettingsComponents() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => () => React.createElement('span', { 'aria-hidden': 'true' }) });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const modulePath of [
      '../src/components/settings/ImageGenSettingsSection.tsx',
      '../src/components/settings/memory/MemoryEngineSection.tsx',
    ]) {
      delete require.cache[require.resolve(modulePath)];
    }
    return {
      ImageGenSettingsSection: require('../src/components/settings/ImageGenSettingsSection.tsx').ImageGenSettingsSection,
      MemoryEngineSection: require('../src/components/settings/memory/MemoryEngineSection.tsx').MemoryEngineSection,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function loadSettingsPage() {
  const noop = () => {};
  const asyncNoop = async () => {};
  const nullPanel = () => null;
  const memoryIndexPanel = {
    status: null,
    loading: false,
    rebuilding: false,
    retrying: false,
    indexingUnindexed: false,
    clearing: false,
    stopping: false,
    error: null,
    activeTasks: [],
    blockedReason: null,
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: null,
    loadMemoryIndexStatus: asyncNoop,
    loadMemoryDiagnostics: asyncNoop,
    handleRetryFailedMemoryIndex: noop,
    handleRebuildMemoryIndex: noop,
    handleIndexUnindexedMemoryIndex: noop,
    handleClearMemoryIndex: noop,
    handleStopCurrentMemoryTask: noop,
  };
  const memoryManagementPanel = {
    memoryManagementCharacterId: '',
    memoryManagementCharacterIdRef: { current: '' },
    handleMemoryManagementCharacterChange: noop,
    loadMemoryManagementCharacters: asyncNoop,
  };
  const memoryProfilePanel = { resetProfile: noop, loadMemoryProfile: asyncNoop };
  const memoryArchivePanel = {
    resetArchiveForCharacterChange: noop,
    loadMemoryArchiveMemories: asyncNoop,
    loadMemoryArchiveBatches: asyncNoop,
  };
  const memoryCandidatesPanel = { loadMemoryCandidates: asyncNoop };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/navigation') return { useRouter: () => ({ push: noop, replace: noop }) };
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key, setLang: noop }) };
    if (request === '@/components/ui/Toast') return { useToast: () => ({ showToast: noop }) };
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => () => React.createElement('span', { 'aria-hidden': 'true' }) });
    }
    if (request === '@/lib/font-stacks') return { applyFontStyle: noop };
    if (request === '@/lib/theme-provider') return { writeThemeStorage: noop };
    if (request === '@/hooks/settings/useSettingsAuth') {
      return { useSettingsAuth: () => ({ authEnabled: false, handleLogout: noop }) };
    }
    if (request === '@/hooks/settings/useSettingsProviders') {
      return {
        useSettingsProviders: () => ({
          providers: [],
          activeProviderId: null,
          editingProvider: {
            id: '',
            name: '',
            api_base: '',
            api_key: '',
            model: '',
            temperature: 1,
            max_tokens: 4096,
            context_window: 131072,
          },
          setEditingProvider: noop,
          handleActivateProvider: noop,
          handleDeleteProvider: noop,
          handleSaveProvider: noop,
          handleSaveCurrentAsProvider: noop,
          handleUpdateCurrentProvider: noop,
        }),
      };
    }
    if (request === '@/hooks/settings/useMemoryIndexPanel') return { useMemoryIndexPanel: () => memoryIndexPanel };
    if (request === '@/hooks/settings/useMemoryManagementCharacters') return { useMemoryManagementCharacters: () => memoryManagementPanel };
    if (request === '@/hooks/settings/useMemoryProfilePanel') return { useMemoryProfilePanel: () => memoryProfilePanel };
    if (request === '@/hooks/settings/useMemoryArchivePanel') return { useMemoryArchivePanel: () => memoryArchivePanel };
    if (request === '@/hooks/settings/useMemoryCandidatesPanel') return { useMemoryCandidatesPanel: () => memoryCandidatesPanel };
    if (/^@\/components\/settings\/memory\/(?!MemoryEngineSection)/.test(request)) {
      const exportName = path.basename(request);
      return { [exportName]: nullPanel };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve('../src/app/settings/page.tsx');
    delete require.cache[resolved];
    return require(resolved).default;
  } finally {
    Module._load = originalLoad;
  }
}

const t = key => key;
const noop = () => {};
const parseNumber = value => Number(value) || 0;

test.afterEach(() => cleanup());
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('settings page visible labels resolve to API and generation controls', () => {
  const previousFetch = global.fetch;
  global.fetch = () => new Promise(() => {});
  try {
    const SettingsPage = loadSettingsPage();
    const view = render(React.createElement(SettingsPage));

    assert.equal(view.getByLabelText('settings.providerName').id, 'settings-provider-name');
    assert.equal(view.getAllByLabelText('settings.apiBase').length, 2);
    assert.equal(view.getAllByLabelText('settings.apiKey').length, 2);
    assert.equal(view.getAllByLabelText('settings.model').length, 2);
    assertNoOrphanLabels(view.container);

    fireEvent.click(view.getByRole('button', { name: 'settings.tabGeneration' }));
    for (const label of [
      'settings.temperature',
      'settings.maxTokens',
      'settings.contextWindow',
      'settings.topP',
      'settings.topK',
      'settings.frequencyPenalty',
      'settings.presencePenalty',
      'settings.repetitionPenalty',
      'settings.seed',
    ]) {
      assert.ok(view.getByLabelText(label));
    }
    assertNoOrphanLabels(view.container);
  } finally {
    global.fetch = previousFetch;
  }
});

test('image generation labels resolve across every conditional engine', () => {
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const { ImageGenSettingsSection } = loadSettingsComponents();

  for (const engine of ['sd', 'nai', 'comfyui', 'custom']) {
    const settings = {
      ...DEFAULT_SETTINGS,
      image_gen: { ...DEFAULT_SETTINGS.image_gen, enabled: true, engine },
    };
    const view = render(React.createElement(ImageGenSettingsSection, {
      settings,
      update: noop,
      parseNumber,
      t,
    }));

    assert.equal(view.getByLabelText('settings.imageGenEngine').tagName, 'SELECT');
    if (engine === 'sd') assert.equal(view.getByLabelText('settings.imageGenSDUrl').tagName, 'INPUT');
    if (engine === 'nai') assert.equal(view.getByLabelText('settings.imageGenNAIArtist').tagName, 'TEXTAREA');
    if (engine === 'comfyui') assert.equal(view.getByLabelText('settings.imageGenComfyWorkflow').tagName, 'TEXTAREA');
    if (engine === 'custom') assert.equal(view.getByLabelText('settings.imageGenCustomUrl').tagName, 'INPUT');
    assertNoOrphanLabels(view.container);
    view.unmount();
  }
});

test('memory model labels keep one target id for input and select variants', () => {
  const { DEFAULT_MEMORY_ENGINE_SETTINGS, DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const { MemoryEngineSection } = loadSettingsComponents();

  for (const withModelLists of [false, true]) {
    const settings = {
      ...DEFAULT_SETTINGS,
      memory_engine: {
        ...DEFAULT_MEMORY_ENGINE_SETTINGS,
        enabled: true,
        reranker_enabled: true,
      },
      memory_trigger_interval_enabled: true,
      memory_trigger_time_enabled: true,
      memory_trigger_keyword_enabled: true,
      limit_inject: true,
    };
    const models = withModelLists ? ['model-a'] : [];
    const view = render(React.createElement(MemoryEngineSection, {
      settings,
      providers: [],
      bgModelList: models,
      bgModelLoading: false,
      bgModelError: null,
      embeddingModelList: models,
      embeddingModelLoading: false,
      embeddingModelError: null,
      rerankerModelList: models,
      rerankerModelLoading: false,
      rerankerModelError: null,
      memoryModePreset: 'balanced',
      update: noop,
      updateMemoryEngine: noop,
      onMemoryModeChange: noop,
      onFetchBgModels: noop,
      onFetchEmbeddingModels: noop,
      onFetchRerankerModels: noop,
      onClearBgModelList: noop,
      onClearEmbeddingModelList: noop,
      onClearRerankerModelList: noop,
      parseNumber,
      t,
      children: null,
    }));

    const expectedTag = withModelLists ? 'SELECT' : 'INPUT';
    assert.equal(view.getByLabelText('settings.memoryBackgroundModel').tagName, expectedTag);
    assert.equal(view.getByLabelText('settings.memoryEmbeddingModel').tagName, expectedTag);
    assert.equal(view.getByLabelText('settings.memoryRerankerModel').tagName, expectedTag);
    assertNoOrphanLabels(view.container);
    view.unmount();
  }
});

test('settings source has no unassociated label elements', () => {
  for (const relativePath of [
    'src/app/settings/page.tsx',
    'src/components/settings/ImageGenSettingsSection.tsx',
    'src/components/settings/memory/MemoryEngineSection.tsx',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const orphaned = [];

    function visit(node) {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'label') {
        const hasHtmlFor = node.openingElement.attributes.properties.some(
          attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'htmlFor',
        );
        let hasWrappedControl = false;
        function findControl(child) {
          if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))) {
            const opening = ts.isJsxElement(child) ? child.openingElement : child;
            if (['input', 'select', 'textarea'].includes(opening.tagName.getText(sourceFile))) {
              hasWrappedControl = true;
              return;
            }
          }
          ts.forEachChild(child, findControl);
        }
        ts.forEachChild(node, findControl);
        if (!hasHtmlFor && !hasWrappedControl) orphaned.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    assert.deepEqual(orphaned, [], `${relativePath} contains orphan labels on lines ${orphaned.join(', ')}`);
  }
});
