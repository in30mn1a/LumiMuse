// 回归检查：记忆系统升级的数据层基础
// 覆盖：
// 1. memories 表新增字段和旧数据默认值
// 2. 新增 embedding / 队列 / 角色覆盖配置 / 提取候选旁路表
// 3. 默认 memory_engine 为本地模式
// 4. 旧格式 POST /api/memories 仍可创建，并返回新字段默认值

const fs = require('fs');

const read = file => fs.readFileSync(file, 'utf8');
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${message}`);
  }
};

const dbFile = read('src/lib/db.ts');
const memoryEmbeddingSchemaFile = read('src/lib/memory-embedding-schema.ts');
const dbSchemaFiles = `${dbFile}\n${memoryEmbeddingSchemaFile}`;
const typesFile = read('src/types/index.ts');
const settingsFile = read('src/lib/settings.ts');
const schemasFile = read('src/lib/schemas.ts');
const memoryPromptContractFile = read('src/lib/memory-prompt-contract.ts');
const memoryNormalizationFile = read('src/lib/memory-normalization.ts');
const memoriesRoute = read('src/app/api/memories/route.ts');
const memoryDetailRoute = read('src/app/api/memories/[id]/route.ts');

const hasSqlColumn = (column, definition, source = dbFile) => {
  const pattern = new RegExp(`${escapeRegExp(column)}\\s+${definition}`, 'i');
  return pattern.test(source);
};

for (const [column, definition] of [
  ['memory_kind', "TEXT\\s+NOT\\s+NULL\\s+DEFAULT\\s+'general'"],
  ['importance', 'REAL\\s+NOT\\s+NULL\\s+DEFAULT\\s+0\\.5'],
  ['emotional_weight', 'REAL\\s+NOT\\s+NULL\\s+DEFAULT\\s+0\\.0'],
  ['status', "TEXT\\s+NOT\\s+NULL\\s+DEFAULT\\s+'active'"],
  ['pinned', 'INTEGER\\s+NOT\\s+NULL\\s+DEFAULT\\s+0'],
  ['last_used_at', 'TEXT'],
  ['usage_count', 'INTEGER\\s+NOT\\s+NULL\\s+DEFAULT\\s+0'],
  ['metadata', "TEXT\\s+NOT\\s+NULL\\s+DEFAULT\\s+'\\{\\}'"],
]) {
  assert(hasSqlColumn(column, definition), `memories 迁移包含 ${column} 字段及默认值`);
}

for (const table of [
  'memory_embeddings',
  'memory_embedding_tasks',
  'character_memory_configs',
  'memory_extraction_candidates',
]) {
  assert(dbSchemaFiles.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `迁移创建 ${table} 表`);
}

assert(hasSqlColumn('embedding_blob', 'BLOB\\s+NOT\\s+NULL', dbSchemaFiles), 'memory_embeddings 使用 BLOB 存储向量');
assert(
  /CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?ON\s+memory_embeddings\s*\(\s*memory_id\s*,\s*provider\s*,\s*model\s*,\s*dimension\s*\)/i.test(dbSchemaFiles) ||
  /PRIMARY\s+KEY\s*\(\s*memory_id\s*,\s*provider\s*,\s*model\s*,\s*dimension\s*\)/i.test(dbSchemaFiles),
  'memory_embeddings 支持 ON CONFLICT(memory_id, provider, model, dimension)',
);
assert(
  /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+memory_embedding_tasks\s*\(\s*memory_id\s*\)[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*\)/i.test(dbSchemaFiles),
  'memory_embedding_tasks 对 pending/processing 任务按 memory_id 去重',
);

assert(typesFile.includes('export interface MemoryEngineSettings'), '类型定义包含 MemoryEngineSettings');
assert(typesFile.includes('memory_engine: MemoryEngineSettings'), 'Settings 包含 memory_engine');
assert(typesFile.includes("retrieval_mode: 'local'"), '默认 memory_engine.retrieval_mode 为 local');
assert(typesFile.includes('embedding_enabled: false'), '默认 memory_engine 关闭 embedding');
assert(typesFile.includes('reranker_enabled: false'), '默认 memory_engine 关闭 reranker');
assert(typesFile.includes('fallback_local_enabled: true'), '默认 memory_engine 开启本地 fallback');
assert(
  typesFile.includes('memory_package_token_budget: DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET')
    && memoryPromptContractFile.includes('DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET = 12000'),
  '默认 memory_engine 包含 token 硬预算',
);

assert(settingsFile.includes('map.memory_engine'), 'loadSettings 深合并 memory_engine');
assert(schemasFile.includes('memory_kind'), 'memoryCreateSchema 接受 memory_kind');
assert(schemasFile.includes('emotional_weight'), 'memoryCreateSchema 接受 emotional_weight');
assert(schemasFile.includes('pinned'), 'memoryCreateSchema 接受 pinned');

assert(
  memoriesRoute.includes('normalizeMemoryRow') && memoryNormalizationFile.includes('export function normalizeMemoryRow'),
  'memories 列表/创建统一规范化返回新字段',
);
assert(memoriesRoute.includes('inferMemoryDefaults'), '旧格式创建记忆会推断默认 memory_kind/importance/emotional_weight');
assert(memoriesRoute.includes('INSERT INTO memories') && memoriesRoute.includes('memory_kind'), 'POST /api/memories 写入新字段');

assert(memoryDetailRoute.includes('memoryUpdateSchema'), 'PUT /api/memories/[id] 使用更新 schema 校验');
assert(
  memoryDetailRoute.includes('normalizeMemoryRow') && memoryNormalizationFile.includes('export function normalizeMemoryRow'),
  'PUT /api/memories/[id] 返回规范化新字段',
);
assert(memoryDetailRoute.includes('memory_kind = ?'), 'PUT /api/memories/[id] 可更新 memory_kind');

if (process.exitCode) process.exit(process.exitCode);
console.log('记忆数据层升级回归检查通过');
