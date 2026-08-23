import type Database from 'better-sqlite3';

/**
 * 对话链（「仅索引复制」）
 *
 * 复制对话时可以选择不物理复制消息，只在 conversations 上记录
 * `parent_id` + `parent_seq_end`：子对话继承父对话中 seq <= parent_seq_end 的全部消息。
 * 常规追加消息从链高水位之后编号；在历史用户消息后插入的新回复可能物理属于子对话、
 * 但 seq 位于祖先消息中间。seq 始终表示链内顺序，因此所有基于 seq 的既有逻辑
 * （分页 `seq < before_seq`、上下文 `seq >= 最后一条总结`、配图取最近 N 条）语义不变，
 * 只需把 `conversation_id = ?` 换成本模块生成的链范围。
 *
 * 无父对话时 `buildChainMessageScope` 退化成 `conversation_id = ?`，与改造前逐字节等价。
 */

/** 链上的一段：某个对话，以及它在本链中被继承的 seq 上界 */
export type ChainSegment = {
  conversationId: string;
  /** 只有 seq <= seqEnd 的消息属于本链；null 表示不设上界（链尾的当前对话） */
  seqEnd: number | null;
};

export type ChainScope = {
  /** 可直接拼进 WHERE 的条件片段 */
  sql: string;
  params: (string | number)[];
};

type ChainRow = {
  parent_id: string | null;
  parent_seq_end: number | null;
};

// 较短链保留可走 messages(conversation_id, seq) 索引的 OR 形式；超长链改用
// 单个 JSON 参数，避免 SQLite 的表达式树深度和绑定参数数量形成隐式链长上限。
const INLINE_SCOPE_SEGMENT_THRESHOLD = 128;

export class ConversationChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationChainError';
  }
}

/**
 * 沿 parent_id 回溯，返回从链根到 conversationId 的完整链（根在前，当前对话在最后）。
 *
 * 下游 `parent_seq_end` 截止的是父对话的「完整视图」，因此要向祖先传播累计最小值。
 * 脏链必须 fail-fast，不能把部分历史伪装成完整结果；合法链不设固定深度上限。
 * 仅请求的 conversationId 本身不存在时保留旧行为，返回单段空 scope，由具体 API 决定
 * 是返回空列表、404，还是让外键约束拒绝写入。
 */
export function resolveConversationChain(
  db: Database.Database,
  conversationId: string,
): ChainSegment[] {
  const stmt = db.prepare('SELECT parent_id, parent_seq_end FROM conversations WHERE id = ?');
  const chain: ChainSegment[] = [{ conversationId, seqEnd: null }];
  const visited = new Set<string>([conversationId]);

  let cursor = conversationId;
  let descendantSeqEnd: number | null = null;
  while (true) {
    const row = stmt.get(cursor) as ChainRow | undefined;
    if (!row) {
      if (cursor === conversationId) break;
      throw new ConversationChainError(`Conversation chain parent not found: ${cursor}`);
    }

    const parentId = row.parent_id;
    const parentSeqEnd = row.parent_seq_end;
    if (parentId === null && parentSeqEnd === null) break;
    if (!parentId
      || typeof parentSeqEnd !== 'number'
      || !Number.isInteger(parentSeqEnd)
      || parentSeqEnd < 0) {
      throw new ConversationChainError(`Invalid conversation chain link at: ${cursor}`);
    }
    if (visited.has(parentId)) {
      throw new ConversationChainError(`Conversation chain cycle detected at: ${parentId}`);
    }

    const effectiveSeqEnd: number = descendantSeqEnd === null
      ? parentSeqEnd
      : Math.min(parentSeqEnd, descendantSeqEnd);
    visited.add(parentId);
    chain.unshift({ conversationId: parentId, seqEnd: effectiveSeqEnd });
    cursor = parentId;
    descendantSeqEnd = effectiveSeqEnd;
  }

  return chain;
}

/** 把链转成 WHERE 条件片段；单段链退化为 `conversation_id = ?` */
export function buildChainMessageScope(chain: ChainSegment[]): ChainScope {
  if (chain.length === 1 && chain[0].seqEnd === null) {
    return { sql: 'conversation_id = ?', params: [chain[0].conversationId] };
  }

  if (chain.length > INLINE_SCOPE_SEGMENT_THRESHOLD) {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM json_each(?) AS chain_segment
        WHERE json_extract(chain_segment.value, '$[0]') = conversation_id
          AND (
            json_extract(chain_segment.value, '$[1]') IS NULL
            OR seq <= json_extract(chain_segment.value, '$[1]')
          )
      )`,
      params: [JSON.stringify(
        chain.map(segment => [segment.conversationId, segment.seqEnd]),
      )],
    };
  }

  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const segment of chain) {
    if (segment.seqEnd === null) {
      parts.push('conversation_id = ?');
      params.push(segment.conversationId);
    } else {
      parts.push('(conversation_id = ? AND seq <= ?)');
      params.push(segment.conversationId, segment.seqEnd);
    }
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * 返回消息升序读取的安全 SQL 片段（不含 `ORDER BY`）。
 *
 * 独立对话严格保留历史的 created_at-first 语义；链式对话以 seq 为权威时间轴，
 * 因为晚生成的插入回复可能物理属于子对话、但 seq 位于祖先消息中间。
 */
export function ascendingMessageOrderSqlForChain(chain: readonly ChainSegment[]): string {
  return chain.length > 1
    ? 'seq ASC, created_at ASC, id ASC'
    : 'created_at ASC, seq ASC';
}

/** 与 ascendingMessageOrderSqlForChain 对称的降序读取片段（不含 `ORDER BY`）。 */
export function descendingMessageOrderSqlForChain(chain: readonly ChainSegment[]): string {
  return chain.length > 1
    ? 'seq DESC, created_at DESC, id DESC'
    : 'created_at DESC, seq DESC';
}

/** 便捷入口：一步拿到某个对话的消息可见范围 */
export function resolveMessageScope(
  db: Database.Database,
  conversationId: string,
): ChainScope {
  return buildChainMessageScope(resolveConversationChain(db, conversationId));
}

/**
 * 链上（可见范围内）的最大 seq，0 表示还没有任何消息。
 *
 * 新消息必须接在这个值之后：链式子对话刚建立时自身没有消息，
 * 若按单对话取 MAX 会得到 0，新消息 seq=1 将与继承来的历史撞号。
 */
export function chainMaxSeq(db: Database.Database, scope: ChainScope): number {
  const row = db.prepare(
    `SELECT MAX(seq) AS m FROM messages WHERE ${scope.sql}`,
  ).get(...scope.params) as { m: number | null };
  return row.m ?? 0;
}

/**
 * 分配链上的下一个 seq。调用方需自行保证与 INSERT 处于同一事务内。
 *
 * linked 子对话冻结的是 seq 边界。若物理尾消息被删除，只看 MAX(messages.seq) 会复用
 * 已冻结的编号，让父对话的新消息泄入旧快照。因此直接子对话的最大边界也是高水位。
 */
export function nextChainSeq(db: Database.Database, conversationId: string): number {
  const visibleMax = chainMaxSeq(db, resolveMessageScope(db, conversationId));
  const ownBoundary = db.prepare(`
    SELECT parent_seq_end AS m
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as { m: number | null } | undefined;
  const childBoundary = db.prepare(`
    SELECT MAX(parent_seq_end) AS m
    FROM conversations
    WHERE parent_id = ?
  `).get(conversationId) as { m: number | null };
  return Math.max(visibleMax, ownBoundary?.m ?? 0, childBoundary.m ?? 0) + 1;
}

/** 直接引用该对话的子对话（不递归） */
export function findChildConversations(
  db: Database.Database,
  conversationId: string,
): { id: string; title: string }[] {
  return db.prepare(
    'SELECT id, title FROM conversations WHERE parent_id = ? ORDER BY created_at ASC',
  ).all(conversationId) as { id: string; title: string }[];
}
