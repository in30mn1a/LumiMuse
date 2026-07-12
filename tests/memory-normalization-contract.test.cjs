const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

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

registerTsLoader();

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
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

function requestFor(url, body) {
  return {
    nextUrl: new URL(url),
    async json() {
      return body;
    },
  };
}

function dirtyMemoryRow() {
  return {
    id: 'dirty-memory',
    character_id: 'char-a',
    category: '偏好习惯',
    content: '脏数据规范化对拍',
    confidence: 0.9,
    tags: '[1,"two",null]',
    source_msg_ids: [false, 'message-2'],
    memory_kind: 'unknown-kind',
    importance: '5',
    emotional_weight: '-2',
    status: 'unknown-status',
    pinned: 0,
    last_used_at: 12345,
    usage_count: '7.5',
    metadata: '{"archiveRole":"summary","count":2}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

const expectedNormalizedFields = {
  tags: ['1', 'two', 'null'],
  source_msg_ids: ['false', 'message-2'],
  memory_kind: 'user_preference',
  importance: 1,
  emotional_weight: 0,
  status: 'active',
  pinned: false,
  last_used_at: null,
  usage_count: 7.5,
  metadata: { archiveRole: 'summary', count: 2 },
};

function normalizedFields(memory) {
  return {
    tags: memory.tags,
    source_msg_ids: memory.source_msg_ids,
    memory_kind: memory.memory_kind,
    importance: memory.importance,
    emotional_weight: memory.emotional_weight,
    status: memory.status,
    pinned: memory.pinned,
    last_used_at: memory.last_used_at,
    usage_count: memory.usage_count,
    metadata: memory.metadata,
  };
}

function listDb(row) {
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT COUNT(*)')) {
        return { get: () => ({ count: 1 }) };
      }
      return { all: () => [row] };
    },
  };
}

function updateDb(row) {
  return {
    prepare(sql) {
      if (sql === 'SELECT character_id FROM memories WHERE id = ?') {
        return { get: () => ({ character_id: row.character_id }) };
      }
      if (sql.startsWith('UPDATE memories SET')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql === 'SELECT * FROM memories WHERE id = ?') {
        return { get: () => row };
      }
      throw new Error(`Unexpected SQL in update route test: ${sql}`);
    },
  };
}

function candidateDb(row) {
  return {
    prepare(sql) {
      if (sql.includes('SELECT id, character_id, raw_candidate_json, status FROM memory_extraction_candidates')) {
        return {
          get: () => ({
            id: 1,
            character_id: row.character_id,
            raw_candidate_json: JSON.stringify({
              category: '偏好习惯',
              content: row.content,
              tags: ['two'],
            }),
            status: 'repairable',
          }),
        };
      }
      if (sql.includes('UPDATE memory_extraction_candidates')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql.includes('INSERT INTO memories')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql === 'SELECT * FROM memories WHERE id = ?') {
        return { get: () => row };
      }
      throw new Error(`Unexpected SQL in candidate route test: ${sql}`);
    },
    transaction(fn) {
      return () => fn();
    },
  };
}

test('四个 memory 读取路径与权威 normalizeMemoryRow 对 dirty row 逐字段一致', async () => {
  const row = dirtyMemoryRow();
  const { normalizeMemoryRow } = require('../src/lib/memory-normalization.ts');
  assert.deepEqual(normalizedFields(normalizeMemoryRow(row)), expectedNormalizedFields);

  const listRoute = requireFreshWithMocks('../src/app/api/memories/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => listDb(row) },
  });
  const listResponse = await listRoute.GET(requestFor(
    'http://test.local/api/memories?character_id=char-a&hide_archived=0',
  ));
  const listPayload = await listResponse.json();
  assert.deepEqual(normalizedFields(listPayload[0]), expectedNormalizedFields);

  const updateRoute = requireFreshWithMocks('../src/app/api/memories/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => updateDb(row) },
  });
  const updateResponse = await updateRoute.PUT(
    requestFor('http://test.local/api/memories/dirty-memory', { last_used_at: null }),
    { params: Promise.resolve({ id: row.id }) },
  );
  const updatePayload = await updateResponse.json();
  assert.deepEqual(normalizedFields(updatePayload), expectedNormalizedFields);

  const candidateRoute = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => candidateDb(row) },
    '@/lib/memory-embeddings': { enqueueMemoryEmbeddingTask: () => false },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });
  const candidateResponse = await candidateRoute.POST(
    requestFor('http://test.local/api/memory-candidates/1', { action: 'accept' }),
    { params: Promise.resolve({ id: '1' }) },
  );
  const candidatePayload = await candidateResponse.json();
  assert.deepEqual(normalizedFields(candidatePayload.memory), expectedNormalizedFields);

  const { retrieveWorkingMemoryPackage } = requireFreshWithMocks('../src/lib/memory-retrieval.ts', {});
  const retrieval = await retrieveWorkingMemoryPackage({
    characterId: row.character_id,
    queryText: '规范化',
    settings: {
      memory_inject: true,
      limit_inject: true,
      memory_max_inject: 8,
      memory_engine: {
        enabled: true,
        embedding_enabled: false,
        reranker_enabled: false,
        fallback_local_enabled: true,
        memory_package_token_budget: 1000,
        retrieval_token_budget: 1000,
        vector_top_k: 8,
        keyword_top_k: 8,
        reranker_top_k: 8,
        final_top_k: 8,
        embedding_timeout_ms: 50,
        reranker_timeout_ms: 50,
        total_retrieval_timeout_ms: 1000,
        profile_token_budget: 100,
      },
    },
    deps: {
      loadPriorityMemories: () => [],
      localRetrieve: () => [row],
      loadMemoryProfile: () => null,
      tokenCounter: text => Math.ceil(text.length / 4),
      markMemoriesUsed: () => {},
    },
  });
  assert.deepEqual(normalizedFields(retrieval.selectedMemories[0]), expectedNormalizedFields);
});
