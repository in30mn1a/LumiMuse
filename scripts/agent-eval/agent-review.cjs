/** 完整 Agent 评测：真实循环与工具，虚构内存库，只收集提案而不批准。 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// 必须在加载生产 DB 模块之前安装，阻止任何遗漏单例注入的路径打开磁盘库。
const databasePath = require.resolve('better-sqlite3');
const OriginalDatabase = require(databasePath);
const checkDatabase = args => {
  if (args[0] !== ':memory:') {
    process.exitCode = 1;
    throw new Error('Agent evaluation only permits :memory: databases');
  }
};
require.cache[databasePath].exports = new Proxy(OriginalDatabase, {
  construct(target, args, newTarget) { checkDatabase(args); return Reflect.construct(target, args, newTarget); },
  apply(target, thisArg, args) { checkDatabase(args); return Reflect.apply(target, thisArg, args); },
});

const Database = require(databasePath);
const { __migrateForTests, __setDbForTests } = require('../../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../../src/types/index.ts');
const { completeRequest, REASONING_SAFE_MAX_TOKENS } = require('../../src/lib/api-client.ts');
const { runAgentTurn, EMPTY_REPLY_NOTE } = require('../../src/lib/agent/loop.ts');
const { createAgentSession } = require('../../src/lib/agent/store.ts');
const { AGENT_TOOLS } = require('../../src/lib/agent/tools/index.ts');
const { AGENT_SKILLS } = require('../../src/lib/agent/skills/memory-review.ts');
const { getMemoryReviewPlan } = require('../../src/lib/memory-review-plan.ts');
const { redactSecret } = require('./upstream-config.cjs');

const CHARACTER_ID = 'agent-eval-character';
const GOALS = ['conflict', 'duplicate', 'category'];
const GOAL_TEXT = {
  conflict: '只检查矛盾，包括需要主人确认哪条旧记忆应退场的前后变化；用 report_conflict 记录。暂不决定哪条退场，不合并、不改字段。',
  duplicate: '只检查可以无损合并的重复；保留所有具体事实，用 merge 提案记录。不能把矛盾、前后变化或看起来相似的不同事实合并。',
  category: '只检查明显错误的分类；用 update 提案修改 category，不改正文、标签或其他字段。',
};
const REQUEST_TIMEOUT_MS = 600_000;
let implementationHash;

/** 记录实际 Agent/工具和评测驱动的代码指纹，代码变了就不能复用旧 Agent 结果。 */
function agentImplementationHash() {
  if (implementationHash) return implementationHash;
  const root = path.resolve(__dirname, '..', '..');
  const files = [];
  const collect = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.tsx?$/.test(entry.name)) files.push(file);
    }
  };
  collect(path.join(root, 'src', 'lib'));
  collect(path.join(root, 'src', 'types'));
  files.push(__filename);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
  implementationHash = hash.digest('hex');
  return implementationHash;
}

function goalPrompt(goal) {
  return `这是虚构数据上的记忆整理评测。目标角色 ID：${CHARACTER_ID}。
本次唯一目标：${GOAL_TEXT[goal]}
先 load_skill 读取 memory-review，再读取角色设定和画像，并 prepare_memory_review。
读完全部批次，每批完整检查；有疑点时跨批搜索，必须读取真实来源再提出判断。
本次没有 embedding；关键词没搜到不代表不存在，后续批次也要比较。前后变化不能跳过。
只收集结构化提案和发现，不批准、不执行，不做归档、新增或个人笔记。每项必须有理由和真实来源依据。
有可执行项的提案会结束本轮；之后会要求你继续尚未完成的检查，不意味着提案已获批准。全部检查完后明确结束。`;
}

function seedDatabase(db, sample) {
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  db.prepare('INSERT INTO characters (id, name, basic_info, personality) VALUES (?, ?, ?, ?)')
    .run(CHARACTER_ID, sample.character.name, sample.character.persona, sample.character.persona);
  db.prepare('INSERT INTO character_memory_profiles (character_id, user_profile_summary) VALUES (?, ?)')
    .run(CHARACTER_ID, sample.character.profile);
  const insertConversation = db.prepare('INSERT INTO conversations (id, character_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertMemory = db.prepare(`INSERT INTO memories
    (id, character_id, category, content, tags, importance, memory_kind, pinned, source_msg_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const memory of sample.memories) {
      const conversationId = `eval-source-${memory.id}`;
      insertConversation.run(conversationId, CHARACTER_ID, '虚构来源', memory.created_at, memory.created_at);
      const sourceIds = memory.source_messages.map((message, index) => {
        const id = `eval-msg-${memory.id}-${index}`;
        insertMessage.run(id, conversationId, message.role, message.content, index + 1, memory.created_at);
        return id;
      });
      insertMemory.run(memory.id, CHARACTER_ID, memory.category, memory.content, JSON.stringify(memory.tags), memory.importance,
        memory.memory_kind, memory.pinned, JSON.stringify(sourceIds), memory.created_at, memory.created_at);
    }
  })();
}

/** 上游配置只在调用边界使用，不进入虚构设置、请求记录或结果文件。 */
function createAgentModelCaller({ apiBase, apiKey }, model) {
  return async (settings, body, options) => {
    try {
      return await completeRequest({ ...settings, api_base: apiBase, api_key: apiKey, model }, body, options);
    } catch (error) {
      throw new Error(redactSecret(error instanceof Error ? error.message : String(error), apiKey));
    }
  };
}

function normalizeProposals(db) {
  const normalized = { conflicts: [], merges: [], corrections: [], dropped_conflicts: [], tag_only_corrections: 0, unsupported_suggestions: [] };
  const rows = db.prepare('SELECT id, op, reason, evidence_json, before_json, after_json FROM agent_proposal_items ORDER BY id').all();
  for (const row of rows) {
    const before = JSON.parse(row.before_json);
    const after = JSON.parse(row.after_json);
    const evidence = JSON.parse(row.evidence_json);
    const ids = before?.memories?.map(memory => memory.id) ?? [];
    const details = { reason: row.reason, evidence: evidence.message_ids?.length ? JSON.stringify(evidence.message_ids) : evidence.note };
    if (row.op === 'report_conflict') normalized.conflicts.push({ source_ids: ids, ...details });
    else if (row.op === 'merge') normalized.merges.push({ source_ids: ids, merged_content: after.content, ...details });
    else if (row.op === 'update' && after.category && after.category !== before.memories[0].snapshot.category) {
      normalized.corrections.push({ id: ids[0], category: after.category, ...details });
    } else if (row.op === 'update' && Object.keys(after).every(key => key === 'tags' || key === 'importance')) {
      normalized.tag_only_corrections += 1;
    } else {
      normalized.unsupported_suggestions.push({ id: row.id, op: row.op, source_ids: ids, ...details });
    }
  }
  return normalized;
}

/** 每个进程串行运行内存库，避免 __setDbForTests 的单例被并行样本覆盖。 */
async function runAgent(sample, complete, {
  model = 'agent-eval-fixture', goals = GOALS, maxTurns = 12, contextWindow = 48_000,
  retryDelaysMs = [5_000, 20_000], log = () => {}, signal,
} = {}) {
  const db = new Database(':memory:');
  seedDatabase(db, sample);
  const initialMemories = JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all());
  const settings = {
    ...DEFAULT_SETTINGS, api_base: 'https://agent-eval.invalid/v1', api_key: '', model,
    streaming: false, json_mode: false, max_tokens: REASONING_SAFE_MAX_TOKENS,
    agent_context_window: contextWindow, memory_background_timeout_ms: REQUEST_TIMEOUT_MS,
    memory_engine: { ...DEFAULT_SETTINGS.memory_engine, index_enabled: false },
  };
  const calls = [];
  const phases = [];
  let firstBatches = [];
  let transportFailed = false;
  let modelFailed = 0;
  try {
    for (const goal of goals) {
      const sessionId = createAgentSession(db, { character_id: CHARACTER_ID }, new Date().toISOString()).id;
      const covered = new Set();
      const foldedMemoryIds = new Set();
      const refetchedSources = new Set();
      const phase = { goal, turns: [], skill_loaded: false, character_loaded: false, profile_loaded: false, folded_results: 0, source_reads: 0, tool_errors: 0 };
      let planId;
      const trackedComplete = async (llmSettings, body, options) => {
        const folded = body.messages.filter(message => message.role === 'tool').flatMap(message => {
          try { const value = JSON.parse(message.content.split('\n', 1)[0]); return value.folded ? [value] : []; }
          catch { return []; }
        });
        phase.folded_results += folded.length;
        for (const value of folded) {
          const args = value.arguments;
          if (Array.isArray(args?.memory_ids)) for (const id of args.memory_ids) foldedMemoryIds.add(id);
          if (value.tool === 'read_review_batch') {
            const plan = getMemoryReviewPlan(args?.plan_id);
            for (const id of plan?.batches[args?.batch_index] ?? []) foldedMemoryIds.add(id);
          }
        }
        for (let attempt = 0; ; attempt += 1) {
          const startedAt = Date.now();
          log(`Agent ${goal}：模型调用 ${calls.length + 1}，已读取 ${covered.size}/${sample.memories.length}，折叠 ${folded.length} 条结果`);
          try {
            const result = await complete(llmSettings, body, options);
            calls.push({ goal, status: 'ok', elapsed_ms: Date.now() - startedAt, folded_tools: folded.map(value => value.tool),
              text: result.text, tool_calls: result.toolCalls, finish_reason: result.finishReason });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retryable = !/^API error (?!429\b)4\d\d\b/.test(message) && message !== EMPTY_REPLY_NOTE;
            const retry = retryable && attempt < retryDelaysMs.length && !options.signal?.aborted;
            calls.push({ goal, status: retry ? 'retryable_error' : 'transport_failed', elapsed_ms: Date.now() - startedAt, error: message });
            if (!retry) { transportFailed = true; throw error; }
            await delay(retryDelaysMs[attempt], undefined, { signal: options.signal });
          }
        }
      };
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const userContent = turn === 0 ? goalPrompt(goal)
          : `继续刚才的${goal}检查。提案只是被收集，仍未批准，不得声称写入。已读取 ${covered.size}/${sample.memories.length} 条；继续读完剩余批次并完成判断，不重复原提案。全部检查完后结束。`;
        const result = await runAgentTurn({ db, sessionId, settings, tools: AGENT_TOOLS, skills: AGENT_SKILLS, userContent, complete: trackedComplete, signal,
          events: { onToolEnd({ name, result: value }) {
            if (!value.ok) { phase.tool_errors += 1; return; }
            if (name === 'load_skill') phase.skill_loaded = true;
            if (name === 'get_character') phase.character_loaded = true;
            if (name === 'get_memory_profile') phase.profile_loaded = true;
            if (name === 'prepare_memory_review') {
              planId = value.plan_id;
              if (firstBatches.length === 0) firstBatches = getMemoryReviewPlan(planId)?.batches ?? [];
            }
            if (name === 'read_review_batch') for (const memory of value.memories) covered.add(memory.id);
            if (name === 'get_memory_sources') {
              phase.source_reads += 1;
              for (const memory of value.memories) if (memory.sources.length > 0 && foldedMemoryIds.has(memory.memory_id)) refetchedSources.add(memory.memory_id);
            }
          } },
        });
        phase.turns.push(result);
        if (result.status === 'done' && covered.size === sample.memories.length) break;
        if (result.status === 'aborted' || result.status === 'error') { if (!transportFailed) modelFailed += 1; break; }
      }
      phase.covered_ids = [...covered];
      phase.complete = covered.size === sample.memories.length && phase.turns.at(-1)?.status === 'done'
        && phase.skill_loaded && phase.character_loaded && phase.profile_loaded;
      phase.refetched_source_ids_after_fold = [...refetchedSources];
      phases.push(phase);
      log(`Agent ${goal}：${phase.complete ? '完成' : '未完成'}，覆盖 ${covered.size}/${sample.memories.length}，来源读取 ${phase.source_reads} 次`);
      if (transportFailed || signal?.aborted) break;
    }
    const memoryUnchanged = JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all()) === initialMemories;
    assert.ok(memoryUnchanged, 'Agent evaluation modified role memories without approval');
    const normalized = normalizeProposals(db);
    return {
      batches: firstBatches,
      calls,
      phases,
      normalized,
      memory_unchanged: memoryUnchanged,
      failed_calls: modelFailed,
      incomplete: phases.length !== goals.length || phases.some(phase => !phase.complete),
      failure_kind: transportFailed ? 'transport' : phases.some(phase => !phase.complete) ? 'coverage_or_model' : null,
    };
  } finally {
    // 关闭后仍留注入连接：任何迟到的异步访问都不能回落到真实磁盘库。
    db.close();
  }
}

module.exports = { agentImplementationHash, createAgentModelCaller, goalPrompt, normalizeProposals, runAgent };
