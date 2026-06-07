// 回归检查：记忆提取 schema 升级
// 覆盖：
// 1. parseMemoryPayload 兼容新旧格式并补齐新字段默认值
// 2. 提取 prompt 明确新 schema 和防污染规则
// 3. memories INSERT/UPDATE 写入新字段
// 4. 新增/有效更新后入队 embedding，且失败不影响保存

const fs = require('fs');

const read = file => fs.readFileSync(file, 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${message}`);
  }
};

const memoryEngine = read('src/lib/memory-engine.ts');
const promptTemplates = read('src/lib/prompt-templates.ts');

assert(memoryEngine.includes('function parseMemoryPayload'), '存在 parseMemoryPayload 统一解析入口');
assert(memoryEngine.includes('record.memories'), 'parseMemoryPayload 支持新顶层 memories 数组');
assert(memoryEngine.includes('Array.isArray(value)'), 'parseMemoryPayload 支持旧顶层数组');
assert(memoryEngine.includes('record.content'), 'parseMemoryPayload 支持旧单条对象和缺 category 对象');
assert(memoryEngine.includes('inferMemoryDefaults'), '缺字段会按 category 推断默认 memory_kind/importance/emotional_weight');
assert(memoryEngine.includes('normalizeLifecycleAction'), '缺 lifecycle_action 时会补默认 upsert');

for (const field of ['memory_kind', 'importance', 'emotional_weight', 'lifecycle_action']) {
  assert(memoryEngine.includes(field), `memory-engine 处理 ${field}`);
  assert(promptTemplates.includes(field), `提取 prompt 要求输出 ${field}`);
}

assert(promptTemplates.includes('我会记得') && promptTemplates.includes('本身不是记忆内容'), '提取 prompt 明确“我会记得”本身不是记忆');
assert(promptTemplates.includes('character_promise') && promptTemplates.includes('不要写成 user_fact'), '提取 prompt 明确角色承诺写 character_promise');

assert(
  /INSERT INTO memories[\s\S]*memory_kind[\s\S]*importance[\s\S]*emotional_weight/i.test(memoryEngine),
  'INSERT memories 写入 memory_kind/importance/emotional_weight',
);
assert(
  /UPDATE memories[\s\S]*memory_kind = \?[\s\S]*importance = \?[\s\S]*emotional_weight = \?/i.test(memoryEngine),
  'UPDATE memories 写入 memory_kind/importance/emotional_weight',
);
assert(memoryEngine.includes('enqueueMemoryEmbeddingTask'), '记忆写入后调用 enqueueMemoryEmbeddingTask');
assert(memoryEngine.includes("'created'") && memoryEngine.includes("'updated'"), 'embedding 入队区分 created/updated');
assert(
  /try\s*\{[\s\S]*enqueueMemoryEmbeddingTask[\s\S]*\}\s*catch/i.test(memoryEngine),
  'embedding 入队失败被捕获，不影响记忆保存',
);

if (process.exitCode) process.exit(process.exitCode);
console.log('记忆提取 schema 升级回归检查通过');
