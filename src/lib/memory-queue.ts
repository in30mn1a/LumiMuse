/**
 * 记忆提取队列 — 持久化版本
 *
 * 任务写入 memory_tasks 表，服务重启后自动恢复 pending/processing 任务，
 * 不再因热重载或进程崩溃而丢失。
 */
import { extractMemories } from '@/lib/memory-engine';
import { getDb } from '@/lib/db';
import { Message, DEFAULT_SETTINGS, Settings } from '@/types';

let processing = false;
// 正在处理中的 conversationId，防止同一对话并发重复提取
const inFlightConversations = new Set<string>();

function loadSettings(): Settings {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    try { map[row.key] = JSON.parse(row.value); } catch { map[row.key] = row.value; }
  }
  return { ...DEFAULT_SETTINGS, ...map };
}

/** 把任务写入数据库，如果该对话已有 pending/processing 任务则跳过 */
export function enqueueExtraction(
  characterId: string,
  conversationId: string,
  messages: Message[],
): void {
  const db = getDb();

  // 内存层去重：正在处理中直接跳过
  if (inFlightConversations.has(conversationId)) return;

  // 数据库层去重：已有 pending/processing 任务则跳过
  const existing = db.prepare(
    "SELECT id FROM memory_tasks WHERE conversation_id = ? AND status IN ('pending','processing') LIMIT 1"
  ).get(conversationId);
  if (existing) return;

  const messageIds = JSON.stringify(messages.map(m => m.id));
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(characterId, conversationId, messageIds, now, now);

  if (!processing) void processQueue();
}

/** 服务启动时调用，把上次崩溃遗留的 processing 任务重置为 pending */
export function recoverStaleTasks(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE memory_tasks SET status = 'pending', updated_at = ? WHERE status = 'processing'"
  ).run(now);
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  const db = getDb();

  while (true) {
    // 取一条 pending 任务
    const task = db.prepare(
      "SELECT * FROM memory_tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
    ).get() as { id: number; character_id: string; conversation_id: string; message_ids: string } | undefined;

    if (!task) break;

    // 内存层去重
    if (inFlightConversations.has(task.conversation_id)) {
      // 跳过这条，继续看下一条（避免死循环：标记为跳过后继续）
      db.prepare("UPDATE memory_tasks SET status = 'pending', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), task.id);
      break; // 等下次触发
    }

    inFlightConversations.add(task.conversation_id);

    // 标记为 processing
    db.prepare("UPDATE memory_tasks SET status = 'processing', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), task.id);

    try {
      const settings = loadSettings();
      const messageIds: string[] = JSON.parse(task.message_ids);

      // 从数据库重新读取消息内容（防止内容已被编辑），含 created_at 用于拼时间戳
      const messages = db.prepare(
        `SELECT * FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')}) ORDER BY seq ASC, created_at ASC`
      ).all(...messageIds) as Array<{ id: string; role: string; content: string; metadata: string; created_at: string }>;

      if (messages.length > 0) {
        const convText = messages
          .map(m => {
            const speaker = m.role === 'user' ? '用户' : '角色';
            // 格式化时间戳：2026/3/30 02:01
            const d = new Date(m.created_at);
            const ts = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return `${speaker} (${ts}): ${m.content}`;
          })
          .join('\n');

        const { mergeCount } = await extractMemories(task.character_id, convText, settings);

        // 成功后标记用户消息为已提取（assistant 消息不参与触发计数，无需标记）
        for (const msg of messages) {
          if (msg.role !== 'user') continue;
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(msg.metadata); } catch { meta = {}; }
          meta.memory_extracted = true;
          db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
            .run(JSON.stringify(meta), msg.id);
        }

        // 把合并数量写回任务，供外部轮询
        if (mergeCount > 0) {
          db.prepare("UPDATE memory_tasks SET status = 'done', updated_at = ?, merge_count = ? WHERE id = ?")
            .run(new Date().toISOString(), mergeCount, task.id);
        } else {
          db.prepare("UPDATE memory_tasks SET status = 'done', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), task.id);
        }
      } else {
        db.prepare("UPDATE memory_tasks SET status = 'done', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), task.id);
      }
    } catch (err) {
      console.error('Memory extraction failed:', err);
      // 标记失败，不阻塞后续任务
      db.prepare("UPDATE memory_tasks SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), task.id);
    } finally {
      inFlightConversations.delete(task.conversation_id);
    }
  }

  processing = false;
}

/** 手动触发队列处理（用于外部调用） */
export function triggerQueue(): void {
  if (!processing) void processQueue();
}

export function getQueueLength(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_tasks WHERE status IN ('pending','processing')"
  ).get() as { cnt: number };
  return row.cnt;
}

export function isProcessing(): boolean {
  return processing;
}
