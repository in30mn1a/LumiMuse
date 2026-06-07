const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function hasStaticValueImport(source, importPath) {
  const escapedPath = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^import\\s+(?!type\\b)[^;]*\\s+from\\s+['"]${escapedPath}['"];`,
    'm',
  );
  return pattern.test(source);
}

function hasLazyImport(source, importPath) {
  const escapedPath = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:dynamic|lazy)\\s*\\(\\s*\\(\\)\\s*=>\\s*import\\s*\\(\\s*['"]${escapedPath}['"]\\s*\\)`,
  ).test(source);
}

test('ChatView uses the lightweight client token helper instead of the server tokenizer', () => {
  const chatView = readProjectFile('src/components/chat/ChatView.tsx');
  const clientCounter = readProjectFile('src/lib/token-counter-client.ts');

  assert.equal(
    hasStaticValueImport(chatView, '@/lib/token-counter'),
    false,
    'ChatView must not statically import the server token counter because it pulls js-tiktoken ranks into the page entry chunk',
  );
  assert.match(chatView, /@\/lib\/token-counter-client/);
  assert.doesNotMatch(clientCounter, /js-tiktoken|cl100k_base/);
});

test('ChatView lazy-loads low-frequency modals that are not needed for first paint', () => {
  const chatView = readProjectFile('src/components/chat/ChatView.tsx');

  for (const modalPath of ['./ImageManagerModal', './ResetExtractionModal', './TokenBreakdownModal']) {
    assert.equal(
      hasStaticValueImport(chatView, modalPath),
      false,
      `${modalPath} should not be a static value import from ChatView`,
    );
    assert.ok(
      hasLazyImport(chatView, modalPath),
      `${modalPath} should be loaded through a dynamic import or equivalent lazy boundary`,
    );
  }

  assert.match(
    chatView,
    /\{imageManagerOpen && \(\s*<ImageManagerModal/,
    'ImageManagerModal should only mount when opened so its jszip chunk is not requested on first paint',
  );
  assert.match(
    chatView,
    /\{tokenBreakdownOpen && \(\s*<TokenBreakdownModal/,
    'TokenBreakdownModal should only mount when opened',
  );
});
