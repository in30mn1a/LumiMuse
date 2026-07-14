const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const resetPath of [
      modulePath,
      '../src/lib/schemas.ts',
      '../src/types/index.ts',
    ]) {
      const resolved = require.resolve(resetPath);
      delete require.cache[resolved];
    }
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

async function runSensitiveTagStripRouteTest(model) {
  let capturedPrompt = '';
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': {
      getDb: () => ({
        prepare: (sql) => {
          if (sql.includes('FROM conversations')) {
            return { get: () => ({ character_id: 'char-1' }) };
          }
          if (sql.includes('FROM characters')) {
            return {
              get: () => ({
                name: 'Mira',
                personality: '',
                scenario: '',
                image_tags: 'blue eyes, 1.3::loli::, kindergarten uniform, red hair',
                user_image_tags: '',
              }),
            };
          }
          if (sql.includes('FROM messages')) {
            return { all: () => [{ role: 'assistant', content: 'smiles softly' }] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      }),
    },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model,
      }),
      resolveBackgroundConfig: (s) => ({
        api_base: s.api_base,
        api_key: s.api_key,
        model: s.model,
      }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      chatCompletion: async (_settings, messages) => {
        capturedPrompt = messages[1].content;
        return 'POSITIVE: best quality, 1girl, blue eyes, red hair';
      },
    },
  });

  const response = await route.POST(jsonRequest({ conversation_id: 'conv-1' }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedPrompt, /blue eyes/);
  assert.match(capturedPrompt, /red hair/);
  assert.doesNotMatch(capturedPrompt, /loli/i);
  assert.doesNotMatch(capturedPrompt, /kindergarten uniform/i);
  // 按 image_tags 原顺序：blue eyes, 1.3::loli::, kindergarten uniform, red hair
  assert.equal(
    body.prompt,
    'best quality, 1girl, blue eyes, 1.3::loli::, kindergarten uniform, red hair',
  );
}

test('Gemini image prompt generation strips kindergarten tags before the AI call and restores them in output', async () => {
  await runSensitiveTagStripRouteTest('gemini-3.1-pro-preview');
});

test('Grok image prompt generation strips sensitive tags before the AI call and restores them in output', async () => {
  await runSensitiveTagStripRouteTest('grok-4.5-fast');
});
