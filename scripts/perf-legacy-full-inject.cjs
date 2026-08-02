/**
 * 对照计时：增强记忆关闭(full inject) vs 开启(local retrieve)
 * 用于验证「关增强记忆后发消息体感变慢」是否来自本地 trim/tokenize 路径。
 *
 * 用法: node scripts/perf-legacy-full-inject.cjs [memoryCount] [budget]
 */
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
      jsx: ts.JsxEmit.ReactJSX,
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

function makeMemory(i, { long = false, importance = 0.4, pinned = false } = {}) {
  const base = long
    ? `第${i}条超长记忆：用户在某次聊天里详细描述了自己对咖啡、甜点、深夜写作和雨天散步的偏好，并且反复强调希望角色能记得这些细节。`.repeat(8)
    : `第${i}条记忆：用户喜欢第${i}种小习惯，角色答应会记得。`;
  return {
    id: `m-${i}`,
    character_id: 'char-a',
    category: '话题历史',
    content: base,
    confidence: 0.9,
    tags: '[]',
    source_msg_ids: '[]',
    memory_kind: 'general',
    importance,
    emotional_weight: 0.2,
    status: 'active',
    pinned: pinned ? 1 : 0,
    last_used_at: null,
    usage_count: 0,
    metadata: '{}',
    created_at: `2026-01-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`,
    updated_at: `2026-01-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`,
  };
}

function baseSettings(overrides = {}) {
  const { memory_engine: engineOverrides, ...rest } = overrides;
  return {
    memory_inject: true,
    limit_inject: false,
    memory_max_inject: 30,
    ...rest,
    memory_engine: {
      enabled: true,
      allow_memory_context_in_chat: true,
      allow_external_memory_payloads: true,
      retrieval_mode: 'local',
      embedding_enabled: false,
      embedding_api_base: '',
      embedding_api_key: '',
      embedding_model: '',
      embedding_dimension: 1024,
      reranker_enabled: false,
      reranker_api_base: '',
      reranker_api_key: '',
      reranker_model: '',
      fallback_local_enabled: true,
      memory_package_token_budget: 12000,
      retrieval_token_budget: 8000,
      vector_top_k: 80,
      keyword_top_k: 20,
      reranker_top_k: 40,
      final_top_k: 30,
      embedding_timeout_ms: 1500,
      reranker_timeout_ms: 2000,
      total_retrieval_timeout_ms: 2500,
      profile_token_budget: 1200,
      ...(engineOverrides || {}),
    },
  };
}

async function timeOnce(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { label, ms, result };
}

async function main() {
  const count = Number(process.argv[2] || 800);
  const budget = Number(process.argv[3] || 12000);
  const useRealTokenizer = process.argv.includes('--real-tokenizer');

  const memories = Array.from({ length: count }, (_, i) =>
    makeMemory(i, {
      // 混入约 15% 长记忆，逼出 skipOversized 扫描
      long: i % 7 === 0,
      importance: i % 50 === 0 ? 0.95 : 0.35 + (i % 10) * 0.02,
      pinned: i % 80 === 0,
    }),
  );

  let tokenCalls = 0;
  let tokenChars = 0;
  const cheapCounter = (text) => {
    tokenCalls += 1;
    tokenChars += text.length;
    return Math.ceil(text.length / 4);
  };

  const { estimateTokens } = requireFreshWithMocks(path.join(root, 'src/lib/token-counter.ts'), {});
  const realCounter = (text) => {
    tokenCalls += 1;
    tokenChars += text.length;
    return estimateTokens(text);
  };
  const tokenCounter = useRealTokenizer ? realCounter : cheapCounter;

  const { retrieveWorkingMemoryPackage } = requireFreshWithMocks(
    path.join(root, 'src/lib/memory-retrieval.ts'),
    {
      '@/lib/db': { getDb: () => { throw new Error('db should not be hit'); } },
      '@/lib/memory-engine': {
        retrieveRelevantMemories: (q, cid, limit) => memories.slice(0, Math.min(limit, memories.length)),
      },
      '@/lib/memory-profile': { readMemoryProfile: () => null, renderMemoryProfile: () => '' },
      '@/lib/memory-embeddings': {
        embedText: async () => [],
        loadReadyMemoryEmbeddings: () => [],
      },
      '@/lib/memory-reranker': { rerankDocuments: async () => [] },
    },
  );

  const commonDeps = {
    loadLegacyMemories: () => memories,
    localRetrieve: (q, cid, limit) => memories.slice(0, Math.min(limit, memories.length)),
    loadPriorityMemories: () => memories.filter(m => m.pinned || m.importance >= 0.85).slice(0, 30),
    loadMemoryProfile: () => null,
    markMemoriesUsed: () => {},
    tokenCounter,
  };

  // warmup tokenizer if real
  if (useRealTokenizer) estimateTokens('warmup 中文 English 123');

  const scenarios = [
    {
      name: 'OFF enhanced + limit_inject=false (full inject path)',
      settings: baseSettings({
        limit_inject: false,
        memory_engine: { enabled: false, memory_package_token_budget: budget },
      }),
    },
    {
      name: 'OFF enhanced + limit_inject=true (legacy keyword limit)',
      settings: baseSettings({
        limit_inject: true,
        memory_max_inject: 30,
        memory_engine: { enabled: false, memory_package_token_budget: budget },
      }),
    },
    {
      name: 'ON enhanced local (keyword_top_k=20, final_top_k=30)',
      settings: baseSettings({
        limit_inject: false,
        memory_engine: {
          enabled: true,
          embedding_enabled: false,
          reranker_enabled: false,
          memory_package_token_budget: budget,
          keyword_top_k: 20,
          final_top_k: 30,
        },
      }),
    },
    {
      name: 'ON enhanced local with wide recall (keyword 200, final 120)',
      settings: baseSettings({
        limit_inject: false,
        memory_engine: {
          enabled: true,
          embedding_enabled: false,
          reranker_enabled: false,
          memory_package_token_budget: budget,
          keyword_top_k: 200,
          final_top_k: 120,
        },
      }),
    },
  ];

  console.log(JSON.stringify({
    count,
    budget,
    tokenizer: useRealTokenizer ? 'js-tiktoken-cl100k' : 'cheap-len/4',
  }, null, 2));

  for (const scenario of scenarios) {
    tokenCalls = 0;
    tokenChars = 0;
    const timed = await timeOnce(scenario.name, () =>
      retrieveWorkingMemoryPackage({
        characterId: 'char-a',
        queryText: '你还记得我喜欢的咖啡和甜点吗',
        settings: scenario.settings,
        deps: commonDeps,
      }),
    );
    console.log({
      scenario: timed.label,
      ms: Math.round(timed.ms),
      mode: timed.result.mode,
      selected: timed.result.selectedMemories.length,
      tokens: timed.result.tokenCount,
      tokenCalls,
      tokenChars,
      textLen: timed.result.text.length,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
