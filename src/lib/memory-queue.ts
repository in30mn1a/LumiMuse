/**
 * 记忆提取队列 — 持久化版本
 *
 * 任务写入 memory_tasks 表，服务重启后自动恢复 pending/processing 任务，
 * 不再因热重载或进程崩溃而丢失。
 *
 * claim/lease/recover/drain 走 DbTaskQueue；同对话串行仍由进程内 inFlightConversations 负责。
 */
import { DEFAULT_BACKGROUND_TASK_LEASE_SECONDS } from '@/lib/background-task-recovery';
import { createDbTaskQueue } from '@/lib/db-task-queue';
import { extractMemories, getCommittedExtractionResult } from '@/lib/memory-engine';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { loadSettings } from '@/lib/settings';
import { enqueueMemoryProfilePatchExtraction, triggerMemoryProfileQueue } from '@/lib/memory-profile';
import { structuredLog } from '@/lib/structured-log';

const extractionTaskQueue = createDbTaskQueue({
  table: 'memory_tasks',
  timestampMode: 'iso',
  defaultLeaseSeconds: DEFAULT_BACKGROUND_TASK_LEASE_SECONDS,
});

// 正在处理中的 conversationId，防止同一对话并发重复提取（业务层策略，非通用队列原语）
const inFlightConversations = new Set<string>();

type ExtractionTaskRow = {
  id: number;
  character_id: string;
  conversation_id: string;
  message_ids: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  merge_count: number;
  retry_count: number;
  error_message: string | null;
  status: string;
};

function formatExtractionMessage(
  message: { role: string; content: string; created_at: string },
  characterName: string,
): string {
  const speaker = message.role === 'user' ? '用户' : characterName;
  const d = new Date(message.created_at);
  const ts = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${speaker} (${ts}): ${message.content}`;
}

function buildExtractionText(
  messages: Array<{ id: string; role: string; content: string; created_at: string }>,
  characterName: string,
): { text: string; includedCompleteUserIds: Set<string> } {
  const lines: string[] = [];
  const includedCompleteUserIds = new Set<string>();

  for (const message of messages) {
    if (!message.content) continue;

    const line = formatExtractionMessage(message, characterName);
    lines.push(line);
    if (message.role === 'user') includedCompleteUserIds.add(message.id);
  }

  return { text: lines.join('\n'), includedCompleteUserIds };
}

function hasTable(db: ReturnType<typeof getDb>, tableName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName);
  return Boolean(row);
}

function markIncludedUserMessagesProcessed(
  db: ReturnType<typeof getDb>,
  messages: Array<{ id: string; role: string; metadata: string }>,
  includedCompleteUserIds: Set<string>,
  noopExtractedAt?: string,
): void {
  for (const msg of messages) {
    if (msg.role !== 'user' || !includedCompleteUserIds.has(msg.id)) continue;
    // 写前重读最新 metadata：提取 LLM 窗口可达秒~分钟级，期间用户可能补附件/切版本/PATCH metadata。
    // 若用调用前快照整包覆写，会静默丢掉这些字段；只合并提取标记字段。
    const row = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(msg.id) as
      | { metadata: string | null }
      | undefined;
    if (!row) continue;
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      meta = {};
    }
    meta.memory_extracted = true;
    if (noopExtractedAt) {
      meta.memory_noop_extracted_at = noopExtractedAt;
    }
    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(meta), msg.id);
  }
}

function hasRepairableExtractionCandidate(db: ReturnType<typeof getDb>, taskId: number): boolean {
  if (!hasTable(db, 'memory_extraction_candidates')) return false;
  const row = db.prepare(`
    SELECT id FROM memory_extraction_candidates
    WHERE task_id = ? AND status = 'repairable'
    LIMIT 1
  `).get(taskId);
  return Boolean(row);
}

function markTaskStartedAt(db: ReturnType<typeof getDb>, task: ExtractionTaskRow): void {
  if (!task.claim_token) return;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE memory_tasks
    SET started_at = ?, updated_at = ?
    WHERE id = ? AND claim_token = ? AND status = 'processing'
  `).run(now, now, task.id, task.claim_token);
}

/** 把任务写入数据库，如果该对话已有 pending/processing 任务则跳过 */
export function enqueueExtraction(
  characterId: string,
  conversationId: string,
  messages: Message[],
): void {
  const db = getDb();

  // 内存层去重：仅作为快速短路，不能替代 DB 层去重
  // （多进程/多实例场景下内存 Set 不共享，仍需 DB 事务兜底）
  if (inFlightConversations.has(conversationId)) return;

  const messageIds = JSON.stringify(messages.map(m => m.id));
  const now = new Date().toISOString();

  const enqueued = extractionTaskQueue.enqueue(db, {
    columns: {
      character_id: characterId,
      conversation_id: conversationId,
      message_ids: messageIds,
      created_at: now,
      updated_at: now,
    },
    dedupeKey: { column: 'conversation_id', value: conversationId },
  });
  if (!enqueued.inserted) return;

  extractionDrainGate.trigger();
}

/** 服务启动时调用：仅回收租约已过期/缺失的 processing（崩溃孤儿），不抢另一实例 in-flight 任务 */
export function recoverStaleTasks(): void {
  const db = getDb();
  extractionTaskQueue.recoverStale(db);
  // 诊断字段 started_at：过期回收后清掉，避免 UI 把孤儿当仍在跑
  db.prepare(`
    UPDATE memory_tasks
    SET started_at = NULL
    WHERE status = 'pending'
      AND claim_token IS NULL
      AND started_at IS NOT NULL
  `).run();
}

/**
 * 领取并处理至多一条提取任务。
 * 同对话串行：SQL 层排除 inFlightConversations，避免误标 done 丢新消息。
 */
async function processOneExtractionTask(): Promise<{ claimed: number }> {
  const db = getDb();
  const inFlightList = [...inFlightConversations];
  const filters = inFlightList.length > 0
    ? [{
        sql: `conversation_id NOT IN (${inFlightList.map(() => '?').join(',')})`,
        params: inFlightList,
      }]
    : [];

  const tasks = extractionTaskQueue.claim<ExtractionTaskRow>(db, {
    limit: 1,
    filters,
  });
  const task = tasks[0];
  if (!task) return { claimed: 0 };

  inFlightConversations.add(task.conversation_id);

  try {
    // started_at 仅诊断用；写失败不得阻断提取（旧库/精简测试 fixture 可能无该列）
    try {
      markTaskStartedAt(db, task);
    } catch {
      // ignore diagnostic column write failures
    }

    const settings = loadSettings();
    const messageIds: string[] = JSON.parse(task.message_ids);

    // 从数据库重新读取消息内容（防止内容已被编辑），含 created_at 用于拼时间戳
    const messages = db.prepare(
      `SELECT * FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')}) ORDER BY seq ASC, created_at ASC`
    ).all(...messageIds) as Array<{ id: string; role: string; content: string; metadata: string; created_at: string }>;

    if (messages.length > 0) {
      // 查询角色名称，用于拼装对话文本
      const charRow = db.prepare('SELECT name FROM characters WHERE id = ?').get(task.character_id) as { name: string } | undefined;
      const characterName = charRow?.name || '角色';

      const { text: convText, includedCompleteUserIds } = buildExtractionText(messages, characterName);
      if (!convText) {
        extractionTaskQueue.complete(db, task);
        return { claimed: 1 };
      }

      // 崩溃恢复：若记忆结果已 durable 提交，只补齐 metadata 与 task 状态，不再次调用 LLM。
      const alreadyCommitted = getCommittedExtractionResult(task.id, db);
      let mergeCount = alreadyCommitted?.mergeCount ?? 0;
      let insertCount = alreadyCommitted?.insertCount ?? 0;

      if (!alreadyCommitted) {
        const extracted = await extractMemories(task.character_id, convText, settings, {
          messageIds,
          taskId: task.id,
          conversationId: task.conversation_id,
        });
        mergeCount = extracted.mergeCount;
        insertCount = extracted.insertCount;
      }

      if (insertCount === 0 && mergeCount === 0 && hasRepairableExtractionCandidate(db, task.id)) {
        throw new Error('repairable memory extraction candidate created; task remains retryable');
      }

      // 只有实际产生了提取结果（新条目或合并）才标记消息为已提取
      // 这里的判断使用真实的 insertCount（实际写入 DB 的新记忆数）和
      // mergeCount（实际更新的已有记忆数），而不是 LLM 解析出的原始条目数；
      // 后者会在 LLM 反复返回与已有记忆完全等同内容时虚报"提取成功"。
      if (insertCount > 0 || mergeCount > 0) {
        markIncludedUserMessagesProcessed(db, messages, includedCompleteUserIds);

        // 提取产生了新记忆 → 入队角色画像更新（用本轮对话文本作为信号）并异步触发处理。
        // 画像 patch 是较慢的后台 LLM 调用，trigger 为 fire-and-forget；失败不得影响提取主流程。
        // 已提交恢复路径也允许再入队：画像队列自身有去重/幂等保护，丢一次补一次更安全。
        try {
          enqueueMemoryProfilePatchExtraction(task.character_id, convText, 'memory_extraction', db);
          triggerMemoryProfileQueue();
        } catch (profileErr) {
          structuredLog('error', 'memory.profile.enqueue_failed', {
            taskId: task.id,
            characterId: task.character_id,
            conversationId: task.conversation_id,
            operation: 'enqueue_profile_update',
            status: 'failed',
          }, profileErr);
        }
      } else {
        markIncludedUserMessagesProcessed(db, messages, includedCompleteUserIds, new Date().toISOString());
      }

      // 把合并数量写回任务，供外部轮询
      if (mergeCount > 0) {
        extractionTaskQueue.complete(db, task, { columns: { merge_count: mergeCount } });
      } else {
        extractionTaskQueue.complete(db, task);
      }
    } else {
      extractionTaskQueue.complete(db, task);
    }
  } catch (err) {
    structuredLog('error', 'memory.extraction.failed', {
      taskId: task.id,
      characterId: task.character_id,
      conversationId: task.conversation_id,
      operation: 'extract',
      status: 'failed',
    }, err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      extractionTaskQueue.fail(db, task, errorMessage);
    } catch {
      // 极旧 schema 可能缺 retry_count/error_message：降级为按 claim 清状态
      try {
        db.prepare(`
          UPDATE memory_tasks
          SET status = 'failed', claim_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(new Date().toISOString(), task.id, task.claim_token);
      } catch {
        db.prepare(`
          UPDATE memory_tasks SET status = 'failed', updated_at = ? WHERE id = ?
        `).run(new Date().toISOString(), task.id);
      }
    }
  } finally {
    inFlightConversations.delete(task.conversation_id);
  }

  return { claimed: 1 };
}

const extractionDrainGate = extractionTaskQueue.createDrainGate(
  () => processOneExtractionTask(),
  {
    maxRounds: 100_000,
    onError: (err) => {
      structuredLog('error', 'memory.extraction.queue_failed', {
        operation: 'drain',
        status: 'failed',
      }, err);
    },
  },
);

/** 手动触发队列处理（用于外部调用） */
export function triggerQueue(): void {
  extractionDrainGate.trigger();
}

export function getQueueLength(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_tasks WHERE status IN ('pending','processing')"
  ).get() as { cnt: number };
  return row.cnt;
}

export function isProcessing(): boolean {
  return extractionDrainGate.isActive();
}

export function __processQueueForTest(): Promise<void> {
  // 测试用：同步排空一轮（drain gate 是 fire-and-forget，这里直接循环）
  return (async () => {
    for (let i = 0; i < 1000; i += 1) {
      const result = await processOneExtractionTask();
      if (result.claimed === 0) break;
    }
  })();
}
