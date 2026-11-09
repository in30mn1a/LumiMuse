import type { Memory } from '@/types';

/**
 * 重新生成历史消息时的「记忆时间截止」：只注入在那一刻之前就已经存在的记忆，
 * 避免角色在过去的场景里说出之后才发生的事。
 *
 * 当前可见对话链的来源消息按 seq 判断先后，避免同时间戳无法区分前后消息。
 * 其他对话中的来源消息（source_msg_ids）按 created_at 判断：
 * 提取是批量、延后进行的，记忆行的 created_at 往往晚于它描述的对话，
 * 直接用它会把截止点之前聊过的事误判为「未来」。来源消息都查不到（手写记忆、来源已删除）
 * 时才退回记忆自身的 created_at。
 */

/** 兼容 ISO 字符串与 SQLite datetime('now') 的 "YYYY-MM-DD HH:MM:SS"（UTC）。无法解析返回 null。 */
export function parseStoredTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export interface MemoryTimeCutoff {
  /** 截止时刻（消息的 created_at） */
  cutoff: string;
  /** true：发生时间等于截止时刻也算「之前」（插入回复时以那条用户消息为界）；false：严格早于 */
  inclusive: boolean;
  /** 当前可见对话链内的截止序号；其他对话仍使用截止时刻。 */
  seq?: number;
}

export interface MemorySourceMessage {
  created_at: string;
  /** 仅当前可见对话链内的来源带 seq；链范围外为 null / undefined。 */
  seq?: number | null;
}

/**
 * 生成记忆过滤谓词。lookupMessage 由调用方注入（生产环境查 messages 表），
 * 结果按消息 id 缓存，同一轮检索里多条记忆共享来源时只查一次。
 * 截止时刻本身无法解析时返回 undefined（不过滤，保持原行为）。
 */
export function createMemoryTimeCutoffFilter(
  { cutoff, inclusive, seq: cutoffSeq }: MemoryTimeCutoff,
  lookupMessage: (messageId: string) => MemorySourceMessage | null | undefined,
): ((memory: Memory) => boolean) | undefined {
  const cutoffMs = parseStoredTimestamp(cutoff);
  if (cutoffMs === null) return undefined;

  const messageTimeCache = new Map<string, { time: number | null; seq: number | null }>();
  const messageTime = (messageId: string) => {
    const cached = messageTimeCache.get(messageId);
    if (cached) return cached;
    const source = lookupMessage(messageId);
    const result = { time: parseStoredTimestamp(source?.created_at), seq: source?.seq ?? null };
    messageTimeCache.set(messageId, result);
    return result;
  };

  return (memory: Memory) => {
    let hasKnownSource = false;
    for (const sourceId of Array.isArray(memory.source_msg_ids) ? memory.source_msg_ids : []) {
      if (typeof sourceId !== 'string') continue;
      const source = messageTime(sourceId);
      if (source.seq !== null && cutoffSeq !== undefined) {
        hasKnownSource = true;
        if (inclusive ? source.seq > cutoffSeq : source.seq >= cutoffSeq) return false;
      } else if (source.time !== null) {
        hasKnownSource = true;
        if (inclusive ? source.time > cutoffMs : source.time >= cutoffMs) return false;
      }
    }
    if (hasKnownSource) return true;
    const happenedAt = parseStoredTimestamp(memory.created_at);
    // 时间完全无法判断的记忆不丢：宁可多注入，也不让角色无端失忆
    if (happenedAt === null) return true;
    return inclusive ? happenedAt <= cutoffMs : happenedAt < cutoffMs;
  };
}
