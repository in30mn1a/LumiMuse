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

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 1 });

const { cleanup, render, waitFor, within } = require('@testing-library/react');
const userEvent = require('@testing-library/user-event').default;

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

const image = {
  url: '/api/files/generated/cached-image.png',
  conversationId: 'conversation-1',
  conversationTitle: 'Cached conversation',
  messageId: 'message-1',
  referenceCount: 1,
};

function icon() {
  return React.createElement('span', { 'aria-hidden': 'true' });
}

function loadImageManagerModal(imageBlobCache, { useRealModal = false } = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/image-blob-cache') return imageBlobCache;
    if (request === '@/lib/character-image-list-cache') {
      return {
        getCharacterImageListCache: () => [image],
        loadCharacterImageList: async () => [image],
        setCharacterImageListCache() {},
        subscribeCharacterImageList: () => () => {},
      };
    }
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: key => key }) };
    }
    if (request === '@/lib/i18n') {
      return { formatTemplate: template => template };
    }
    if (request === '@/components/ui/icons') {
      return { ImageIcon: icon, TrashIcon: icon };
    }
    if (!useRealModal && request === '@/components/ui/Modal') {
      return {
        __esModule: true,
        default: ({ open, children }) => open ? React.createElement('section', null, children) : null,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = '../src/components/chat/ImageManagerModal.tsx';
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath).default;
  } finally {
    Module._load = originalLoad;
  }
}

function renderModal(imageBlobCache, options) {
  const ImageManagerModal = loadImageManagerModal(imageBlobCache, options);
  return render(React.createElement(ImageManagerModal, {
    open: true,
    character: { id: 'character-1', name: 'Alice' },
    onClose() {},
    showToast() {},
  }));
}

test.afterEach(() => cleanup());
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('gallery consumes a warmed blob when the cache fills between render and effect', async () => {
  const blobUrl = 'blob:http://localhost/cached-image';
  let peekCalls = 0;
  let warmCalls = 0;
  const view = renderModal({
    peekImageBlobUrl: () => {
      peekCalls += 1;
      return peekCalls === 1 ? null : blobUrl;
    },
    warmImageBlob: async () => {
      warmCalls += 1;
      return blobUrl;
    },
    forgetImageBlobs() {},
  });

  await waitFor(() => {
    const renderedImage = view.container.querySelector('img');
    assert.ok(renderedImage, 'the placeholder should be replaced with a rendered image');
    assert.equal(renderedImage.getAttribute('src'), blobUrl);
  });
  assert.equal(warmCalls, 1, 'the effect must consume warmImageBlob even after an effect-time cache hit');
});

test('gallery falls back to the raw URL when warming produces no blob', async () => {
  const view = renderModal({
    peekImageBlobUrl: () => null,
    warmImageBlob: async () => null,
    forgetImageBlobs() {},
  });

  await waitFor(() => {
    const renderedImage = view.container.querySelector('img');
    assert.ok(renderedImage, 'the raw image should render after the cache miss');
    assert.equal(renderedImage.getAttribute('src'), image.url);
  });
});

test('gallery preview is the only active dialog and Escape closes only the preview', async () => {
  const user = userEvent.setup({ document });
  let closeCalls = 0;
  const ImageManagerModal = loadImageManagerModal({
    peekImageBlobUrl: () => 'blob:http://localhost/cached-image',
    warmImageBlob: async () => 'blob:http://localhost/cached-image',
    forgetImageBlobs: async () => {},
  }, { useRealModal: true });
  render(React.createElement(ImageManagerModal, {
    open: true,
    character: { id: 'character-1', name: 'Alice' },
    onClose: () => { closeCalls += 1; },
    showToast() {},
  }));

  const galleryDialog = await waitFor(() => (
    within(document.body).getByRole('dialog', { name: 'chat.imageManagerTitle' })
  ));
  const previewTrigger = within(galleryDialog).getByRole('button', { name: 'chat.imageViewLarge' });
  await user.click(previewTrigger);

  const previewDialog = within(document.body).getByRole('dialog', { name: 'chat.imagePreviewTitle' });
  assert.ok(within(previewDialog).getByRole('img', { name: 'chat.imagePreviewAlt' }));
  assert.equal(galleryDialog.getAttribute('aria-hidden'), 'true');

  await user.keyboard('{Escape}');
  await waitFor(() => assert.equal(
    within(document.body).queryByRole('dialog', { name: 'chat.imagePreviewTitle' }),
    null,
  ));
  assert.equal(closeCalls, 0, 'Escape must not close the underlying gallery');
  assert.ok(within(document.body).getByRole('dialog', { name: 'chat.imageManagerTitle' }));
  assert.equal(document.activeElement, previewTrigger, 'focus should return to the preview trigger');
});

test('gallery preview keeps a visible loading viewport while cache warming is pending', async () => {
  const user = userEvent.setup({ document });
  let resolveWarm;
  const warmPromise = new Promise(resolve => { resolveWarm = resolve; });
  const view = renderModal({
    peekImageBlobUrl: () => null,
    warmImageBlob: () => warmPromise,
    forgetImageBlobs: async () => {},
  }, { useRealModal: true });

  const galleryDialog = await waitFor(() => (
    within(document.body).getByRole('dialog', { name: 'chat.imageManagerTitle' })
  ));
  await user.click(within(galleryDialog).getByRole('button', { name: 'chat.imageViewLarge' }));

  const previewDialog = within(document.body).getByRole('dialog', { name: 'chat.imagePreviewTitle' });
  const loadingStatus = within(previewDialog).getByRole('status');
  assert.equal(loadingStatus.textContent, 'common.loading');
  assert.match(loadingStatus.className, /h-\[70dvh\]/);
  assert.match(loadingStatus.className, /w-\[90vw\]/);

  resolveWarm(null);
  await waitFor(() => assert.ok(within(previewDialog).getByRole('img', { name: 'chat.imagePreviewAlt' })));
  assert.equal(view.container.isConnected, true);
});
