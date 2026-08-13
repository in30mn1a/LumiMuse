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

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function loadReservedChatImage(imageBlobCache) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/image-blob-cache') return imageBlobCache;
    if (request === '@/lib/image-aspect-cache') {
      return {
        DEFAULT_IMAGE_ASPECT_RATIO: 1,
        peekImageAspectRatio: () => null,
        rememberImageAspectRatio() {},
        warmImageAspectRatio: async () => 1,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = '../src/components/chat/ReservedChatImage.tsx';
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath).default;
  } finally {
    Module._load = originalLoad;
  }
}

function renderImage(warmResult, src = '/api/files/generated/persisted-image.png') {
  const ReservedChatImage = loadReservedChatImage({
    isInMemoryImageSrc: () => false,
    peekImageBlobUrl: () => null,
    warmImageBlob: () => warmResult,
  });
  return {
    src,
    view: render(React.createElement(ReservedChatImage, { src, alt: 'cached image' })),
  };
}

test.afterEach(() => cleanup());
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('waits for the persistent cache before exposing the remote image source, then shows the warmed blob', async () => {
  const warming = deferred();
  const blobUrl = 'blob:http://localhost/persisted-image';
  const { src, view } = renderImage(warming.promise);

  await waitFor(() => {
    const pendingImage = view.container.querySelector('img');
    assert.notEqual(
      pendingImage?.getAttribute('src'),
      src,
      'the remote URL must not be exposed while the persistent cache lookup is pending',
    );
  });

  await act(async () => warming.resolve(blobUrl));

  await waitFor(() => {
    const renderedImage = view.container.querySelector('img');
    assert.ok(renderedImage);
    assert.equal(renderedImage.getAttribute('src'), blobUrl);
    assert.notEqual(renderedImage.getAttribute('src'), src);
  });
});

test('falls back to the remote image source only after persistent warming misses', async () => {
  const warming = deferred();
  const { src, view } = renderImage(warming.promise);

  await waitFor(() => {
    const pendingImage = view.container.querySelector('img');
    assert.notEqual(pendingImage?.getAttribute('src'), src);
  });

  await act(async () => warming.resolve(null));

  await waitFor(() => {
    const renderedImage = view.container.querySelector('img');
    assert.ok(renderedImage);
    assert.equal(renderedImage.getAttribute('src'), src);
  });
});

test('shows a blob that appears between render and the effect cache lookup', async () => {
  const src = '/api/files/generated/render-effect-race.png';
  const blobUrl = 'blob:http://localhost/render-effect-race';
  let peekCount = 0;
  let warmCount = 0;
  const peekImageBlobUrl = () => {
    peekCount += 1;
    return peekCount % 2 === 0 ? blobUrl : null;
  };
  const ReservedChatImage = loadReservedChatImage({
    isInMemoryImageSrc: () => false,
    peekImageBlobUrl,
    warmImageBlob: async () => {
      warmCount += 1;
      return peekImageBlobUrl();
    },
  });

  const view = render(React.createElement(ReservedChatImage, { src, alt: 'cached image' }));

  await waitFor(() => {
    const renderedImage = view.container.querySelector('img');
    assert.ok(renderedImage, 'the effect-time cache hit must leave the placeholder state');
    assert.equal(renderedImage.getAttribute('src'), blobUrl);
  });
  assert.equal(warmCount, 1, 'the component must consume the authoritative warm result');
});

test('falls back to the raw URL when a warmed blob image fails to load', async () => {
  const blobUrl = 'blob:http://localhost/revoked-image';
  const { src, view } = renderImage(Promise.resolve(blobUrl), '/api/files/generated/blob-error.png');

  const renderedImage = await waitFor(() => {
    const image = view.container.querySelector('img');
    assert.ok(image);
    assert.equal(image.getAttribute('src'), blobUrl);
    return image;
  });

  fireEvent.error(renderedImage);

  await waitFor(() => {
    const fallbackImage = view.container.querySelector('img');
    assert.ok(fallbackImage);
    assert.equal(fallbackImage.getAttribute('src'), src);
  });
});
