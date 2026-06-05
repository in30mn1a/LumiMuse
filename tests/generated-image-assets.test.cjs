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
