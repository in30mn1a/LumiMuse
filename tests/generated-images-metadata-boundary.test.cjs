const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    return originalResolveFilename.call(
      this,
      path.resolve(__dirname, '../src', request.slice(2)),
      parent,
      isMain,
      options,
    );
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

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
  generatedImageSchema,
  messageMetadataSchema,
} = require(path.resolve(__dirname, '../src/lib/schemas.ts'));

test('message metadata schema accepts valid generated images and rejects malformed values', () => {
  assert.equal(messageMetadataSchema.safeParse({
    generatedImages: [
      {
        id: 'ready',
        prompt: 'ready prompt',
        url: '/api/files/generated/ready.png',
        status: 'ready',
        versions: [
          {
            id: 'v-ready',
            prompt: 'ready prompt',
            url: '/api/files/generated/ready.png',
          },
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
    ],
  }).success, true);

  assert.equal(messageMetadataSchema.safeParse({ generatedImages: {} }).success, false);
  assert.equal(messageMetadataSchema.safeParse({ generatedImages: 'bad' }).success, false);
  assert.equal(generatedImageSchema.safeParse({ id: 'bad', prompt: 123 }).success, false);
});

test('chat generated image read paths use the shared metadata sanitizer', () => {
  const messageBubble = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageBubble.tsx'), 'utf8');
  const imageGenerationHook = fs.readFileSync(path.resolve(__dirname, '../src/hooks/chat/useChatImageGeneration.ts'), 'utf8');
  const chatView = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/ChatView.tsx'), 'utf8');

  assert.match(messageBubble, /sanitizeGeneratedImages\(meta\.generatedImages\)/);
  assert.match(imageGenerationHook, /sanitizeGeneratedImages\([^)]*generatedImages\)/);
  assert.match(chatView, /useChatImageGeneration\(/);
  assert.doesNotMatch(messageBubble, /generatedImages as Array<GeneratedImage>/);
  assert.doesNotMatch(imageGenerationHook, /generatedImages as Array</);
});
