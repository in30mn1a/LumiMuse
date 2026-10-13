const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const originalLoad = Module._load;
// 仅测试用的假凭据，不对应任何真实服务
const SECRET = 'DUMMY_TEST_ONLY_KEY_20261013';

function loadWithFetch(relative, safeFetch) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/ssrf-guard') return { safeFetch };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(relative)];
    return require(relative);
  } finally {
    Module._load = originalLoad;
  }
}

// 上游/网关鉴权失败时回显凭据的三种常见形态：带 Authorization 标记、带 api_key 标记、无标记原样回显
const REFLECTED_BODIES = [
  ['authorization header', JSON.stringify({ error: { message: `Incorrect API key. Authorization: Bearer ${SECRET}` } })],
  ['api_key field', `invalid request: api_key=${SECRET}`],
  ['bare key', `token ${SECRET} was rejected by gateway`],
];

for (const [label, body] of REFLECTED_BODIES) {
  test(`embedding adapter redacts reflected credentials: ${label}`, async () => {
    const { embedText } = loadWithFetch('../src/lib/memory-embeddings.ts', async () => new Response(body, { status: 401 }));
    await assert.rejects(
      embedText('hello', { api_base: 'https://embedding.invalid/v1', api_key: SECRET, model: 'test-embedding' }),
      error => {
        assert.match(error.message, /embedding API error 401/);
        assert.ok(!error.message.includes(SECRET), `凭据不得进入错误消息: ${error.message}`);
        return true;
      },
    );
  });

  test(`reranker adapter redacts reflected credentials: ${label}`, async () => {
    const { rerankDocuments } = loadWithFetch('../src/lib/memory-reranker.ts', async () => new Response(body, { status: 401 }));
    await assert.rejects(
      rerankDocuments('query', [{ id: 'doc-1', text: 'text' }], {
        api_base: 'https://reranker.invalid/v1', api_key: SECRET, model: 'test-reranker',
      }),
      error => {
        assert.match(error.message, /reranker API error 401/);
        assert.ok(!error.message.includes(SECRET), `凭据不得进入错误消息: ${error.message}`);
        return true;
      },
    );
  });
}

test('upstream error diagnostics survive redaction', async () => {
  const { embedText } = loadWithFetch('../src/lib/memory-embeddings.ts',
    async () => new Response('{"error":{"message":"model test-embedding not found"}}', { status: 404 }));
  await assert.rejects(
    embedText('hello', { api_base: 'https://embedding.invalid/v1', api_key: SECRET, model: 'test-embedding' }),
    /embedding API error 404: .*model test-embedding not found/,
  );
});
