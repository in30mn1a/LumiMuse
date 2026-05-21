/**
 * 记忆提取队列 — 持久化版本
 *
 * 任务写入 memory_tasks 表，服务重启后自动恢复 pending/processing 任务，
 * 不再因热重载或进程崩溃而丢失。
 */
import { extractMemories } from '@/lib/memory-engine';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { loadSettings } from '@/lib/settings';

let processing = false;
// 正在处理中的 conversationId，防止同一对话并发重复提取
const inFlightConversations = new Set<string>();

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

  // TOCTOU 保护：SELECT + INSERT 必须在同一事务内原子执行
  // 否则两个并发请求可能同时通过 SELECT 检查、各自插入，造成重复任务
  const insertIfAbsent = db.transaction(() => {
    const existing = db.prepare(
      "SELECT id FROM memory_tasks WHERE conversation_id = ? AND status IN ('pending','processing') LIMIT 1"
    ).get(conversationId);
    if (existing) return false;

    db.prepare(`
      INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(characterId, conversationId, messageIds, now, now);
    return true;
  });

  const inserted = insertIfAbsent();
  if (!inserted) return;

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
      // 命中内存去重说明已有同 conversation 的任务正在跑，本任务无需重复处理。
      // 直接标记为 done 跳过，避免重置回 pending 导致下个循环再次取到同一条任务，陷入无限循环。
      db.prepare("UPDATE memory_tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), task.id);
      continue;
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
        // 查询角色名称，用于拼装对话文本
        const charRow = db.prepare('SELECT name FROM characters WHERE id = ?').get(task.character_id) as { name: string } | undefined;
        const characterName = charRow?.name || '角色';

        const { text: convText, includedCompleteUserIds } = buildExtractionText(messages, characterName);
        if (!convText) {
          db.prepare("UPDATE memory_tasks SET status = 'done', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), task.id);
          continue;
        }

        const { mergeCount, insertCount } = await extractMemories(task.character_id, convText, settings);

        // 只有实际产生了提取结果（新条目或合并）才标记消息为已提取
        // 如果 AI 返回空结果（认为没有值得记忆的内容），不标记，下次仍可重新提取。
        // 这里的判断使用真实的 insertCount（实际写入 DB 的新记忆数）和
        // mergeCount（实际更新的已有记忆数），而不是 LLM 解析出的原始条目数；
        // 后者会在 LLM 反复返回与已有记忆完全等同内容时虚报"提取成功"。
        if (insertCount > 0 || mergeCount > 0) {
          for (const msg of messages) {
            if (msg.role !== 'user' || !includedCompleteUserIds.has(msg.id)) continue;
            let meta: Record<string, unknown> = {};
            try { meta = JSON.parse(msg.metadata); } catch { meta = {}; }
            meta.memory_extracted = true;
            db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
              .run(JSON.stringify(meta), msg.id);
          }
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
