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
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
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
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function createSummarizeDb() {
  return {
    prepare(sql) {
      if (sql.includes('SELECT * FROM conversations WHERE id = ?')) {
        return {
          get(conversationId) {
            assert.equal(conversationId, 'conv-a');
            return { character_id: 'char-a', title: '需要总结的对话' };
          },
        };
      }
      if (sql.includes('SELECT * FROM characters WHERE id = ?')) {
        return {
          get(characterId) {
            assert.equal(characterId, 'char-a');
            return { id: 'char-a', name: '艾莉丝' };
          },
        };
      }
      if (sql.includes('SELECT * FROM messages WHERE conversation_id = ?')) {
        return {
          all(conversationId) {
            assert.equal(conversationId, 'conv-a');
            return [
              {
                id: 'msg-user-1',
                conversation_id: 'conv-a',
                role: 'user',
                content: '今天想整理一下上下文。',
                token_count: 12,
                created_at: '2026-06-08T00:00:00.000Z',
                seq: 1,
                metadata: '{}',
              },
              {
                id: 'msg-assistant-1',
                conversation_id: 'conv-a',
                role: 'assistant',
                content: '好呀，我们可以温柔地归纳重点。',
                token_count: 12,
                created_at: '2026-06-08T00:01:00.000Z',
                seq: 2,
                metadata: '{}',
              },
            ];
          },
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

test('summarize route wraps MAX(seq)+INSERT in a transaction', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/api/summarize/route.ts'), 'utf8');
  // 事务内必须同时包含 nextSeq 分配与 INSERT，避免与聊天并发抢 seq
  assert.match(
    source,
    /db\.transaction\(\(\)\s*=>\s*\{[\s\S]*MAX\(seq\)[\s\S]*INSERT INTO messages[\s\S]*UPDATE conversations[\s\S]*\}\)\(\)/,
  );
});

test('/api/summarize POST redacts sensitive upstream error details', async () => {
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createSummarizeDb() },
    '@/lib/memory-profile': {
      readMemoryProfile() { return null; },
      renderMemoryProfile() { return ''; },
    },
    '@/lib/settings': {
      loadSettings() {
        return {
          api_base: 'https://llm.example/v1',
          api_key: 'local-secret',
          model: 'main-model',
          max_tokens: 1024,
          temperature: 0.7,
        };
      },
      resolveBackgroundConfig() {
        return {
          api_base: 'https://llm.example/v1',
          api_key: 'sk-request-key-should-not-appear',
          model: 'summary-model',
        };
      },
      buildBackgroundChatExtraBody() {
        return {};
      },
    },
    '@/lib/ssrf-guard': {
      safeFetch: async () => new Response(
        'upstream failed Authorization: Bearer sk-upstream-secret-123456789 api_key=plain-secret and token sk-second-secret-987654321',
        { status: 502 },
      ),
    },
  });

  const response = await route.POST(jsonRequest({ conversation_id: 'conv-a' }));
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.match(payload.error, /^LLM API error 502:/);
  assert.match(payload.error, /\[REDACTED\]/);
  assert.doesNotMatch(payload.error, /sk-upstream-secret-123456789/);
  assert.doesNotMatch(payload.error, /plain-secret/);
  assert.doesNotMatch(payload.error, /sk-second-secret-987654321/);
});

test('/api/summarize applies one combined deadline signal to fetch and SSE and returns structured 504', async () => {
  const requestController = new AbortController();
  let fetchSignal;
  let parserSignal;
  let cancelCount = 0;
  const reader = {
    async cancel() {
      cancelCount += 1;
    },
  };
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createSummarizeDb() },
    '@/lib/memory-profile': {
      readMemoryProfile() { return null; },
      renderMemoryProfile() { return ''; },
    },
    '@/lib/settings': {
      loadSettings() {
        return {
          max_tokens: 1024,
          temperature: 0.7,
          memory_background_timeout_ms: 10,
        };
      },
      resolveBackgroundConfig() {
        return {
          api_base: 'https://llm.example/v1',
          api_key: 'summary-secret',
          model: 'summary-model',
        };
      },
      buildBackgroundChatExtraBody() {
        return {};
      },
    },
    '@/lib/ssrf-guard': {
      async safeFetch(_url, init) {
        fetchSignal = init.signal;
        return {
          ok: true,
          body: { getReader: () => reader },
        };
      },
    },
    '@/lib/sse-parser': {
      parseSseStream: async (_reader, _onEvent, options) => {
        parserSignal = options.signal;
        return new Promise((resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('deadline signal was not applied')), 100);
          options.signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(options.signal.reason);
          }, { once: true });
        });
      },
    },
  });

  const request = {
    signal: requestController.signal,
    async json() {
      return { conversation_id: 'conv-a' };
    },
  };
  const response = await route.POST(request);
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(payload.code, 'UPSTREAM_TIMEOUT');
  assert.equal(typeof payload.error, 'string');
  assert.equal(fetchSignal, parserSignal);
  assert.notEqual(fetchSignal, requestController.signal);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(requestController.signal.aborted, false);
  assert.equal(cancelCount, 1);
});
