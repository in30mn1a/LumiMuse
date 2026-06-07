const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  collectUniqueGeneratedImageItems,
  sanitizeGeneratedImages,
  removeGeneratedImageReferences,
} = require(path.resolve(__dirname, '../src/lib/generated-image-assets.ts'));

test('collectUniqueGeneratedImageItems groups copied conversation images by URL', () => {
  const images = collectUniqueGeneratedImageItems([
    {
      messageId: 'msg-original',
      conversationId: 'conv-original',
      conversationTitle: 'Original',
      createdAt: '2026-05-31T10:00:00.000Z',
      metadata: JSON.stringify({
        generatedImages: [
          {
            id: 'img-old',
            url: '/api/files/generated/shared.png',
            prompt: 'shared prompt',
          },
        ],
      }),
    },
    {
      messageId: 'msg-copy',
      conversationId: 'conv-copy',
      conversationTitle: 'Copy',
      createdAt: '2026-05-31T11:00:00.000Z',
      metadata: JSON.stringify({
        generatedImages: [
          {
            id: 'img-old',
            url: '/api/files/generated/shared.png',
            prompt: 'shared prompt',
          },
          {
            id: 'img-new',
            url: '/api/files/generated/copy-only.png',
            prompt: 'copy only prompt',
          },
        ],
      }),
    },
  ]);

  assert.equal(images.length, 2);

  const shared = images.find(image => image.url === '/api/files/generated/shared.png');
  assert.ok(shared);
  assert.equal(shared.referenceCount, 2);
  assert.deepEqual(
    shared.references.map(reference => reference.messageId).sort(),
    ['msg-copy', 'msg-original'],
  );

  const copyOnly = images.find(image => image.url === '/api/files/generated/copy-only.png');
  assert.ok(copyOnly);
  assert.equal(copyOnly.referenceCount, 1);
  assert.equal(copyOnly.references[0].conversationId, 'conv-copy');
});

test('removeGeneratedImageReferences removes all selected URL references from one message', () => {
  const result = removeGeneratedImageReferences(
    {
      generatedImages: [
        {
          id: 'img-shared',
          url: '/api/files/generated/shared.png',
          prompt: 'shared prompt',
          versions: [
            {
              id: 'v-shared',
              url: '/api/files/generated/shared.png',
              prompt: 'shared prompt',
            },
            {
              id: 'v-copy-only',
              url: '/api/files/generated/copy-only.png',
              prompt: 'copy only prompt',
            },
          ],
          activeVersion: 0,
        },
      ],
    },
    { urls: new Set(['/api/files/generated/shared.png']) },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.removedUrls, ['/api/files/generated/shared.png']);
  assert.deepEqual(result.metadata.generatedImages, [
    {
      id: 'img-shared',
      url: '/api/files/generated/copy-only.png',
      prompt: 'copy only prompt',
      versions: [
        {
          id: 'v-copy-only',
          url: '/api/files/generated/copy-only.png',
          prompt: 'copy only prompt',
        },
      ],
      activeVersion: 0,
    },
  ]);
});

test('sanitizeGeneratedImages ignores non-array values and malformed entries', () => {
  assert.deepEqual(sanitizeGeneratedImages({}), []);
  assert.deepEqual(sanitizeGeneratedImages('bad'), []);
  assert.deepEqual(sanitizeGeneratedImages([
    null,
    'bad',
    { id: 123, prompt: 'bad id', url: '/api/files/generated/bad-id.png' },
    { id: 'bad-prompt', prompt: 123, url: '/api/files/generated/bad-prompt.png' },
    {
      id: 'ready',
      prompt: 'ready prompt',
      url: '/api/files/generated/ready.png',
      status: 'ready',
      error: 123,
      versions: [
        { id: 'v-ready', url: '/api/files/generated/ready.png', prompt: 'ready prompt' },
        { id: 'v-bad', url: 123, prompt: 'bad version' },
      ],
      activeVersion: 0,
    },
    {
      id: 'pending',
      prompt: 'pending prompt',
      status: 'pending_image',
    },
    {
      id: 'failed',
      prompt: 'failed prompt',
      status: 'failed',
      error: 'boom',
      activeVersion: 'bad',
    },
  ]), [
    {
      id: 'ready',
      prompt: 'ready prompt',
      url: '/api/files/generated/ready.png',
      status: 'ready',
      versions: [
        { id: 'v-ready', url: '/api/files/generated/ready.png', prompt: 'ready prompt' },
      ],
      activeVersion: 0,
    },
    {
      id: 'pending',
      prompt: 'pending prompt',
      status: 'pending_image',
    },
    {
      id: 'failed',
      prompt: 'failed prompt',
      status: 'failed',
      error: 'boom',
    },
  ]);
});

test('collectUniqueGeneratedImageItems skips malformed generatedImages metadata', () => {
  const images = collectUniqueGeneratedImageItems([
    {
      messageId: 'msg-object',
      conversationId: 'conv',
      conversationTitle: 'Bad object',
      createdAt: '2026-06-07T10:00:00.000Z',
      metadata: { generatedImages: {} },
    },
    {
      messageId: 'msg-string',
      conversationId: 'conv',
      conversationTitle: 'Bad string',
      createdAt: '2026-06-07T10:01:00.000Z',
      metadata: { generatedImages: 'bad' },
    },
    {
      messageId: 'msg-mixed',
      conversationId: 'conv',
      conversationTitle: 'Mixed',
      createdAt: '2026-06-07T10:02:00.000Z',
      metadata: {
        generatedImages: [
          null,
          { id: 'bad', prompt: 123, url: '/api/files/generated/bad.png' },
          { id: 'ok', prompt: 'ok prompt', url: '/api/files/generated/ok.png' },
        ],
      },
    },
  ]);

  assert.deepEqual(images.map(image => image.url), ['/api/files/generated/ok.png']);
  assert.equal(images[0].prompt, 'ok prompt');
});

test('removeGeneratedImageReferences skips malformed generatedImages metadata', () => {
  assert.deepEqual(
    removeGeneratedImageReferences(
      { generatedImages: {} },
      { urls: new Set(['/api/files/generated/ok.png']) },
    ),
    {
      metadata: { generatedImages: {} },
      removedUrls: [],
      changed: false,
    },
  );

  const result = removeGeneratedImageReferences(
    {
      generatedImages: [
        'bad',
        { id: 'bad-version', prompt: 'bad version', versions: [{ id: 'v-bad', url: 123, prompt: 'bad' }] },
        { id: 'ok', prompt: 'ok prompt', url: '/api/files/generated/ok.png' },
      ],
    },
    { urls: new Set(['/api/files/generated/ok.png']) },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.removedUrls, ['/api/files/generated/ok.png']);
  assert.deepEqual(result.metadata, {});
});
