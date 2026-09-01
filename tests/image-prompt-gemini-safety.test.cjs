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
            return {
              get: () => ({
                character_id: 'char-1',
                parent_id: null,
                parent_seq_end: null,
              }),
            };
          }
          if (sql.includes('FROM characters')) {
            return {
              get: () => ({
                name: 'Mira',
                // 气泡按钮会把这些角色字段也拼进 /api/image-gen/prompt 的 LLM 上下文；
                // 即使敏感 tag 在别处重复出现，出站请求也不得泄漏。
                personality: 'quiet, childhood memories, 1.3::loli::',
                scenario: 'school scene, lolita fashion, 1.2 :: kindergarten uniform ::',
                image_tags: 'blue eyes, 1.3::loli::, child, kindergarten uniform, 1.1::little girl::, red hair',
                user_image_tags: '',
              }),
            };
          }
          if (sql.includes('SELECT seq FROM messages')) {
            return { get: () => ({ seq: 7 }) };
          }
          if (sql.includes('FROM messages')) {
            return {
              all: () => [{
                role: 'assistant',
                content: 'smiles softly, (loli:1.3), loli_style, loli角色, <lora:loli:0.8>, kindergarten playground, little_girl',
              }],
            };
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

  const response = await route.POST(jsonRequest({
    conversation_id: 'conv-1',
    message_id: 'message-7',
    user_hint: 'keep the ::LOLI:: design',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedPrompt, /blue eyes/);
  assert.match(capturedPrompt, /red hair/);
  assert.doesNotMatch(capturedPrompt, /loli(?!ta)/i);
  assert.doesNotMatch(capturedPrompt, /child(?!hood)/i);
  assert.doesNotMatch(capturedPrompt, /kindergarten/i);
  assert.doesNotMatch(capturedPrompt, /little[\s_]+girl/i);
  assert.match(capturedPrompt, /quiet/);
  assert.match(capturedPrompt, /childhood memories/);
  assert.match(capturedPrompt, /school scene/);
  assert.match(capturedPrompt, /lolita fashion/);
  assert.match(capturedPrompt, /smiles softly/);
  assert.match(capturedPrompt, /keep the\s+design/);
  // 按 image_tags 原顺序恢复所有敏感 tag。
  assert.equal(
    body.prompt,
    'best quality, 1girl, blue eyes, 1.3::loli::, child, kindergarten uniform, 1.1::little girl::, red hair',
  );
}

test('Gemini image prompt generation strips kindergarten tags before the AI call and restores them in output', async () => {
  await runSensitiveTagStripRouteTest('gemini-3.1-pro-preview');
});

test('Grok image prompt generation strips sensitive tags before the AI call and restores them in output', async () => {
  await runSensitiveTagStripRouteTest('grok-4.5-fast');
});

test('non-gemini/grok models strip and restore sensitive tags the same way', async () => {
  await runSensitiveTagStripRouteTest('deepseek-chat');
  await runSensitiveTagStripRouteTest('gpt-4o');
});

test('image prompt route isolates sensitive tags in image_tags and user_image_tags and restores them', async () => {
  let capturedPrompt = '';
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': {
      getDb: () => ({
        prepare: (sql) => {
          if (sql.includes('FROM conversations')) {
            return {
              get: () => ({
                character_id: 'char-2',
                parent_id: null,
                parent_seq_end: null,
              }),
            };
          }
          if (sql.includes('FROM characters')) {
            return {
              get: () => ({
                name: 'Alice',
                personality: '性格：温柔可爱',
                scenario: '世界观：奇幻学院',
                image_tags: 'blue eyes，{1.3::loli::}，red hair',
                user_image_tags: '1boy, (shota:1.3), black hair',
              }),
            };
          }
          if (sql.includes('FROM messages')) {
            return {
              all: () => [
                { role: 'user', content: '请帮我画一张插图' },
                { role: 'assistant', content: '好的！[IMG]1girl, {1.3::loli::}[/IMG]' },
              ],
            };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      }),
    },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'gpt-4o',
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
        return 'POSITIVE: best quality, 1girl, blue eyes, red hair, 1boy, black hair';
      },
    },
  });

  const response = await route.POST(jsonRequest({ conversation_id: 'conv-2' }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.doesNotMatch(capturedPrompt, /loli/i);
  assert.doesNotMatch(capturedPrompt, /shota/i);
  assert.match(capturedPrompt, /blue eyes/);
  assert.match(capturedPrompt, /red hair/);
  assert.match(capturedPrompt, /1boy/);
  assert.match(capturedPrompt, /black hair/);

  // 原始敏感标签应在安全位置被恢复
  assert.match(body.prompt, /\{1\.3::loli::\}/);
  assert.match(body.prompt, /\(shota:1\.3\)/);
});

test('NAI V5 prompt generation uses the V5 system prompt and structured Character fields', async () => {
  let capturedSystem = '';
  let capturedUser = '';
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': {
      getDb: () => ({
        prepare: (sql) => {
          if (sql.includes('FROM conversations')) {
            return { get: () => ({ character_id: 'char-v5', parent_id: null, parent_seq_end: null }) };
          }
          if (sql.includes('FROM characters')) {
            return {
              get: () => ({
                name: 'Mira',
                personality: 'quiet',
                scenario: 'rainy cafe',
                image_tags: 'blue eyes, 1.3::loli::, red hair',
                user_image_tags: '',
              }),
            };
          }
          if (sql.includes('FROM messages')) {
            return { all: () => [{ role: 'assistant', content: '看着窗外的雨。' }] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      }),
    },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'gpt-4o',
        image_gen: {
          enabled: true,
          engine: 'nai',
          nai_model: 'nai-diffusion-5-full',
        },
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
        capturedSystem = messages[0].content;
        capturedUser = messages[1].content;
        return `Prompt:\n1girl, from side, rainy window\n\nCharacter 1:\ngirl, blue eyes, red hair`;
      },
    },
  });

  const response = await route.POST(jsonRequest({ conversation_id: 'conv-v5' }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedSystem, /NovelAI Diffusion V5/);
  assert.match(capturedSystem, /Character N/);
  assert.doesNotMatch(capturedSystem, /POSITIVE:/);
  assert.match(capturedUser, /Character 1/);
  assert.doesNotMatch(capturedUser, /POSITIVE/);
  assert.doesNotMatch(capturedUser, /loli/i);
  assert.match(body.prompt, /^Prompt:/);
  assert.match(body.prompt, /Character 1:/);
  assert.match(body.prompt, /1\.3::loli::/);
  assert.doesNotMatch(body.prompt.split('Character 1:')[0], /loli/);
});
