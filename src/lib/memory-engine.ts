import { getDb } from '@/lib/db';
import { Memory, MemoryCategory, MemoryKind, Settings, MEMORY_CATEGORIES, MEMORY_KINDS } from '@/types';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { EXTRACTION_PROMPT, MEMORY_LIFECYCLE_PROMPT } from '@/lib/prompt-templates';
import { normalizeTags as canonicalizeTags } from '@/lib/memory-tag-spec';
import { normalizeMemoryCategory, inferMemoryDefaults } from '@/lib/memory-category';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { structuredLog } from '@/lib/structured-log';
import { extractBalancedJsonAt } from '@/lib/balanced-json';
import { buildBackgroundChatExtraBody, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { parseMemoryMetadata } from '@/lib/metadata';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { contentSimilarity, supersedeTextSimilarity } from '@/lib/text-similarity';
// 仅类型导入：编译期擦除，不会与 memory-extraction-reference → memory-retrieval → memory-engine
// 形成运行时循环依赖。实现由调用方（memory-queue）注入。
import type { ExtractionCandidateSummary } from '@/lib/memory-extraction-reference';

const CJK_STOPWORDS = new Set([
  // 原有
  '用户', '喜欢', '觉得', '一起', '我们', '这个', '那个', '自己', '对话', '记忆',
  // 高频虚词 / 指代词
  '什么', '怎么', '为什', '为何', '可以', '可能', '应该', '需要', '已经', '还有',
  '一个', '一些', '一下', '一直', '一样', '没有', '不是', '就是', '还是', '只是',
  // 时间词
  '今天', '明天', '昨天', '现在', '以后', '之前', '之后', '时候', '今晚', '最近',
  // 知觉 / 行为
  '知道', '看到', '听到', '想到', '感觉', '希望', '如果', '因为', '所以', '但是',
]);

const LOCAL_RETRIEVAL_CANDIDATE_LIMIT = 500;

// ── 检索 token 集缓存 ──────────────────────────────────────────
// retrieveRelevantMemories 每轮都会对最多 500 条 active 记忆做 tokenizeForRetrieval
// （正则 + CJK bigram + 去停用词），是同步热路径。记忆内容在两轮检索间通常不变，
// 故按 memory.id 缓存「content tokens ∪ tags ∪ category」合集。
// 用 content 的 hash 判定内容是否变化：upsert/supersede 改 content 后自动失效重建，
// 无需手动维护失效。带上限的 FIFO 淘汰，防长生命周期进程无界增长。
const MEMORY_TOKEN_CACHE_LIMIT = 2000;
const memoryTokenCache = new Map<string, { hash: number; tokens: Set<string> }>();

/**
 * 轻量字符串 hash（djb2）。仅用于缓存键比对内容是否变化，不要求密码学强度。
 */
function hashStringForCache(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * 取某条记忆用于检索评分的完整 token 集（content 分词 + tags 小写 + category）。
 * 命中缓存且 content 未变时直接复用，避免每轮重复 tokenize。
 */
function getMemoryTokensForScoring(memory: Memory): Set<string> {
  const hash = hashStringForCache(memory.content);
  const cached = memoryTokenCache.get(memory.id);
  if (cached && cached.hash === hash) {
    return cached.tokens;
  }

  const tokens = tokenizeForRetrieval(memory.content);
  for (const tag of memory.tags) {
    if (tag) tokens.add(tag.toLowerCase());
  }
  tokens.add(memory.category);

  // FIFO 淘汰：达上限时删最早写入的条目（Map 迭代保持插入顺序）
  if (memoryTokenCache.size >= MEMORY_TOKEN_CACHE_LIMIT) {
    const oldestKey = memoryTokenCache.keys().next().value;
    if (oldestKey !== undefined) memoryTokenCache.delete(oldestKey);
  }
  memoryTokenCache.set(memory.id, { hash, tokens });
  return tokens;
}

/**
 * 供记忆写入路径（upsert/supersede/删除）主动失效缓存。
 * content 变化已能靠 hash 自动失效，但 id 被复用或删除后主动清理更干净。
 */
export function invalidateMemoryTokenCache(memoryId: string): void {
  memoryTokenCache.delete(memoryId);
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toBoundedNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(numberValue, 0), 1);
}

function normalizeMemoryKind(value: unknown, fallback: MemoryKind): MemoryKind {
  if (typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)) {
    return value as MemoryKind;
  }
  return fallback;
}

function normalizeMemory(record: Memory): Memory {
  return normalizeMemoryRow(record);
}

function tokenizeForRetrieval(text: string): Set<string> {
  const tokens = new Set<string>();

  for (const pattern of [/《([^》]{1,30})》/g, /「([^」]{1,30})」/g, /"([^"]{1,30})"/g, /'([^']{1,30})'/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const cleaned = (match[1] || '').trim();
      if (cleaned) tokens.add(cleaned.toLowerCase());
    }
  }

  for (const token of text.match(/[A-Za-z0-9]{2,}/g) || []) {
    tokens.add(token.toLowerCase());
  }

  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const bigram = cjk[i] + cjk[i + 1];
    if (!CJK_STOPWORDS.has(bigram)) {
      tokens.add(bigram);
    }
  }

  return tokens;
}

export function retrieveRelevantMemories(
  queryText: string,
  characterId: string,
  maxMemories: number = 30,
): Memory[] {
  const db = getDb();
  const allMemories = db.prepare(
    `SELECT * FROM memories
     WHERE character_id = ? AND status = 'active'
     ORDER BY
       COALESCE(pinned, 0) DESC,
       COALESCE(importance, 0) DESC,
       updated_at DESC
     LIMIT ?`
  ).all(characterId, LOCAL_RETRIEVAL_CANDIDATE_LIMIT) as Memory[];
  const normalizedMemories = allMemories.map(normalizeMemory);

  if (normalizedMemories.length <= maxMemories) {
    return normalizedMemories;
  }

  const queryTokens = tokenizeForRetrieval(queryText);
  if (queryTokens.size === 0) {
    return normalizedMemories.slice(0, maxMemories);
  }

  const scored: Array<[number, Memory]> = [];
  for (const memory of normalizedMemories) {
    const memoryTokens = getMemoryTokensForScoring(memory);

    // 评分归一化：原先只用交集大小，长记忆 token 数天然更多，会霸榜检索结果。
    // 改用 TF-IDF 风格的余弦近似：intersection / sqrt(|memoryTokens| * |queryTokens|)
    // 这样短而精确的记忆不会被长记忆挤出 top-N。
    // 加 1 是为了避免极端短文本的分母过小造成评分爆炸。
    const intersection = [...queryTokens].filter(token => memoryTokens.has(token)).length;
    if (intersection > 0) {
      const denom = Math.sqrt((memoryTokens.size + 1) * (queryTokens.size + 1));
      const score = intersection / denom;
      scored.push([score, memory]);
    }
  }

  if (scored.length === 0) {
    return normalizedMemories.slice(0, maxMemories);
  }

  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, maxMemories).map(([, memory]) => memory);
}

function extractAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  if (!text) return anchors;

  for (const pattern of [/《([^》]{1,30})》/g, /「([^」]{1,30})」/g, /"([^"]{1,30})"/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const cleaned = (match[1] || '').trim();
      if (cleaned) anchors.add(cleaned.toLowerCase());
    }
  }

  for (const token of text.match(/[A-Za-z0-9]{2,}/g) || []) {
    if (!CJK_STOPWORDS.has(token)) anchors.add(token.toLowerCase());
  }

  return anchors;
}

function setIntersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

// 注意：合并规则是「content 取更长的一方」，较短一方的独有信息会被丢弃。
// 这个启发式只在「两条确实是近重复」的前提下安全，所以合并入口必须由下方的
// 相似度阈值把关。不要用「模型指认的 target」绕过阈值直接合并——
// 模型判 upsert 的两条若措辞差异极大，通常是同一对象的不同事实
// （"养了只叫小白的白猫" vs "小白最近生病了"），本就该并存；
// 强行合并会静默丢掉新事实，且返回值仍报 mergeCount 成功。
// 记忆完整性优先：宁可多存一条，不可丢事实。target 只用于 supersede（语义是旧的作废）。
function mergeMemories(existing: Memory[], newMemories: Memory[]): Memory[] {
  const result = [...existing];

  for (const newEntry of newMemories) {
    let bestSimilarity = 0;
    let bestIndex = -1;

    for (let i = 0; i < result.length; i += 1) {
      if (result[i].category !== newEntry.category) continue;

      const textSimilarity = contentSimilarity(result[i].content, newEntry.content);
      const anchorsA = extractAnchors(result[i].content);
      const anchorsB = extractAnchors(newEntry.content);
      const sharedAnchors = [...setIntersection(anchorsA, anchorsB)];
      const tagOverlap = setIntersection(new Set(result[i].tags), new Set(newEntry.tags)).size;

      let similarity = textSimilarity;
      if (anchorsA.size > 0 && anchorsB.size > 0 && sharedAnchors.length === 0) {
        similarity *= 0.55;
      }
      if (sharedAnchors.length > 0) similarity += 0.22;
      if (tagOverlap > 0) similarity += 0.08;
      similarity = Math.min(similarity, 1);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = i;
      }
    }

    // 动态阈值：短文本（如"喜欢猫" vs "喜欢狗"）bigram 重叠率天然偏高但语义可能完全不同，
    // 因此对较短记忆采用更严格的阈值；以两条中较短的一方判定，避免长记忆带短记忆"蹭过"阈值。
    if (bestIndex >= 0) {
      const shorterLen = Math.min(result[bestIndex].content.length, newEntry.content.length);
      const threshold = shorterLen < 20 ? 0.85 : 0.72;
      if (bestSimilarity >= threshold) {
        const existingEntry = result[bestIndex];
        result[bestIndex] = {
          ...existingEntry,
          content: newEntry.content.length > existingEntry.content.length ? newEntry.content : existingEntry.content,
          confidence: Math.max(existingEntry.confidence, newEntry.confidence),
          tags: [...new Set([...existingEntry.tags, ...newEntry.tags])].slice(0, 5),
          source_msg_ids: uniqueStrings([...existingEntry.source_msg_ids, ...newEntry.source_msg_ids]),
          memory_kind: newEntry.importance >= existingEntry.importance ? newEntry.memory_kind : existingEntry.memory_kind,
          importance: Math.max(existingEntry.importance, newEntry.importance),
          emotional_weight: Math.max(existingEntry.emotional_weight, newEntry.emotional_weight),
          updated_at: new Date().toISOString(),
        };
        continue;
      }
    }
    result.push(newEntry);
  }

  return result;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function findSimilarExistingMemories(existing: Memory[], entry: Memory): Memory[] {
  return existing.filter(memory => {
    if (memory.category !== entry.category) return false;
    const textSimilarity = supersedeTextSimilarity(memory.content, entry.content);
    const anchorsA = extractAnchors(memory.content);
    const anchorsB = extractAnchors(entry.content);
    const sharedAnchors = setIntersection(anchorsA, anchorsB).size;
    const tagOverlap = setIntersection(new Set(memory.tags), new Set(entry.tags)).size;
    return (
      textSimilarity >= 0.82 ||
      (textSimilarity >= 0.72 && (sharedAnchors >= 1 || tagOverlap >= 1))
    );
  });
}

function insertCandidate(params: {
  db: ReturnType<typeof getDb>;
  characterId: string;
  options?: ExtractMemoryOptions;
  rawCandidateJson?: unknown;
  rawResponse: string;
  status: 'repairable' | 'ignored';
  errorReason: string;
}): void {
  const now = new Date().toISOString();
  params.db.prepare(`
    INSERT INTO memory_extraction_candidates (
      task_id, character_id, conversation_id, raw_candidate_json, raw_response,
      status, error_reason, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.options?.taskId ?? null,
    params.characterId,
    params.options?.conversationId ?? null,
    params.rawCandidateJson === undefined ? null : JSON.stringify(params.rawCandidateJson),
    params.rawResponse,
    params.status,
    params.errorReason,
    now,
    now,
  );
}

interface RawMemoryData {
  category: MemoryCategory;
  memory_kind: MemoryKind;
  content: string;
  confidence: number;
  tags: string[];
  importance: number;
  emotional_weight: number;
  lifecycle_action: 'insert' | 'upsert' | 'supersede' | 'ignore';
  /** 阶段二模型指认的「被取代/被合并」目标记忆 id；阶段一不产出 */
  supersede_target_ids?: string[];
}

type NewMemoryEntry = Memory & {
  lifecycle_action: RawMemoryData['lifecycle_action'];
  supersede_target_ids?: string[];
};

/**
 * 提取参考的注入接口。由 memory-queue 提供实现，让 memory-engine 无需 import
 * memory-extraction-reference（后者依赖 memory-retrieval，而 memory-retrieval 依赖本模块）。
 */
export interface ExtractionReferenceProvider {
  /** 阶段一参考：角色画像 + 高优先级记忆概览 */
  overview: { profileText: string; priorityText: string };
  /** 阶段二参考：以候选条目为锚点召回相似旧记忆 */
  recallForLifecycle: (candidates: ExtractionCandidateSummary[]) => Promise<{
    text: string;
    profileText: string;
    mode: string;
    /** 与 text 里 E 编号一一对应的 memory id，供模型指认的 target 映射回真实记忆 */
    memoryIds: string[];
    diagnostics?: { embeddingFailed?: string; truncated?: boolean; recallCount?: number };
  }>;
}

interface ExtractMemoryOptions {
  messageIds?: string[];
  taskId?: number;
  conversationId?: string;
  reference?: ExtractionReferenceProvider;
}

function normalizeTags(value: unknown): string[] {
  const parsed = parseJsonField(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeLifecycleAction(value: unknown): RawMemoryData['lifecycle_action'] {
  if (value === 'insert' || value === 'upsert' || value === 'supersede' || value === 'ignore') {
    return value;
  }
  return 'upsert';
}

function hasCharacterPromiseSignal(content: string): boolean {
  return /我会记得|我会记住|我答应|我承诺|以后我会|以后会|不会忘/.test(content);
}

function calibrateRawMemoryItem(item: RawMemoryData): RawMemoryData {
  let category = item.category;
  let memoryKind = item.memory_kind;
  let importance = item.importance;
  let emotionalWeight = item.emotional_weight;

  if (
    hasCharacterPromiseSignal(item.content) &&
    (memoryKind === 'user_fact' || memoryKind === 'user_preference')
  ) {
    category = '关系动态';
    memoryKind = 'character_promise';
  }

  if (memoryKind === 'character_promise') {
    category = '关系动态';
    importance = Math.max(importance, 0.8);
    emotionalWeight = Math.max(emotionalWeight, 0.7);
  } else if (memoryKind === 'relationship_event' || category === '重要事件' || category === '关系动态') {
    emotionalWeight = Math.max(emotionalWeight, 0.6);
  } else if (category === '话题历史' || memoryKind === 'general') {
    importance = Math.min(importance, 0.6);
  }

  return {
    ...item,
    category,
    memory_kind: memoryKind,
    importance: toBoundedNumber(importance, 0.5),
    emotional_weight: toBoundedNumber(emotionalWeight, 0),
  };
}

function normalizeRawMemoryItem(value: unknown): RawMemoryData | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!content) return null;

  const category = normalizeMemoryCategory(
    typeof record.category === 'string' ? record.category : '话题历史',
  );
  const defaults = inferMemoryDefaults(category);

  return calibrateRawMemoryItem({
    category,
    memory_kind: normalizeMemoryKind(record.memory_kind, defaults.memory_kind),
    content,
    confidence: toBoundedNumber(record.confidence, 0.8),
    tags: normalizeTags(record.tags),
    importance: toBoundedNumber(record.importance, defaults.importance),
    emotional_weight: toBoundedNumber(record.emotional_weight, defaults.emotional_weight),
    lifecycle_action: normalizeLifecycleAction(record.lifecycle_action),
  });
}

function parseMemoryPayload(value: unknown): RawMemoryData[] {
  if (Array.isArray(value)) return value.map(normalizeRawMemoryItem).filter((item): item is RawMemoryData => Boolean(item));
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.memories)) {
    return record.memories.map(normalizeRawMemoryItem).filter((item): item is RawMemoryData => Boolean(item));
  }
  if (record.content || record.category) {
    const item = normalizeRawMemoryItem(record);
    return item ? [item] : [];
  }
  return [];
}

function parseExtractionResponse(response: string): RawMemoryData[] {
  let text = response.trim();
  if (text.startsWith('```')) {
    text = text.split('\n').slice(1).join('\n');
  }
  if (text.endsWith('```')) {
    text = text.slice(0, text.lastIndexOf('```'));
  }

  try {
    const result = JSON.parse(text);
    return parseMemoryPayload(result);
  } catch {
    // 回退策略：从 "memories" 关键字位置出发，向前找最近的 '{' 作为对象起点，
    // 然后向后做花括号配对扫描（考虑字符串与转义），找到匹配的 '}' 截取再尝试 JSON.parse。
    // 这样比贪婪正则更稳健，避免越过同一响应中的多个 JSON 块。
    const candidates: number[] = [];

    const keywordIdx = text.indexOf('"memories"');
    if (keywordIdx !== -1) {
      for (let i = keywordIdx; i >= 0; i -= 1) {
        if (text[i] === '{') {
          candidates.push(i);
          break;
        }
      }
    }

    const arrayIdx = text.indexOf('[');
    if (arrayIdx !== -1) candidates.push(arrayIdx);

    const objectIdx = text.indexOf('{');
    if (objectIdx !== -1) candidates.push(objectIdx);

    for (const startIdx of candidates) {
      const snippet = extractBalancedJsonAt(text, startIdx);
      if (!snippet) continue;
      try {
        const parsed = parseMemoryPayload(JSON.parse(snippet));
        if (parsed.length > 0) return parsed;
      } catch {
        continue;
      }
    }
    return [];
  }
}

function hasMemoryTaskResultCommittedColumn(db: ReturnType<typeof getDb>): boolean {
  const columns = db.prepare('PRAGMA table_info(memory_tasks)').all() as { name: string }[];
  return columns.some(column => column.name === 'result_committed');
}

/**
 * 读取任务级 durable commit marker。
 * 若任务此前已成功提交记忆写入，崩溃恢复后不得再次 INSERT/UPDATE 同一批结果。
 */
export function getCommittedExtractionResult(
  taskId: number | undefined,
  db: ReturnType<typeof getDb> = getDb(),
): { insertCount: number; mergeCount: number } | null {
  if (taskId === undefined || !hasMemoryTaskResultCommittedColumn(db)) return null;
  const row = db.prepare(`
    SELECT result_committed, result_insert_count, result_merge_count
    FROM memory_tasks
    WHERE id = ?
  `).get(taskId) as {
    result_committed: number;
    result_insert_count: number;
    result_merge_count: number;
  } | undefined;
  if (!row || !row.result_committed) return null;
  return {
    insertCount: row.result_insert_count || 0,
    mergeCount: row.result_merge_count || 0,
  };
}

interface LifecycleDecision {
  action: RawMemoryData['lifecycle_action'];
  /** 已有记忆列表里的 E 编号；调用方据此映射回 memory id */
  targets: number[];
}

/** 严格解析非负整数编号；拒绝 null/false/""/[] 等会被 Number() 静默转成 0 的值。 */
function parseDecisionIndex(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const matched = /^\s*E?(\d+)\s*$/i.exec(value);
    if (matched) return Number(matched[1]);
  }
  return null;
}

function parseDecisionTargets(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  const targets: number[] = [];
  for (const item of raw) {
    // 已有记忆在 prompt 里显示为 "E3"，模型很可能原样回填；两种写法都接受。
    // 严格匹配而非 Number()：后者会把 false/null/""/[] 静默转成 0，
    // 而 E0 恰好是 pinned DESC 排序下最重要的那条，误伤代价极高。
    const index = parseDecisionIndex(item);
    if (index !== null) targets.push(index);
  }
  return [...new Set(targets)];
}

function parseLifecycleDecisions(
  response: string,
  count: number,
): Map<number, LifecycleDecision> {
  const decisions = new Map<number, LifecycleDecision>();

  let text = response.trim();
  if (text.startsWith('```')) {
    text = text.split('\n').slice(1).join('\n');
  }
  if (text.endsWith('```')) {
    text = text.slice(0, text.lastIndexOf('```'));
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 与提取响应同样的稳健回退：从第一个 '{' 起做花括号配对扫描，避免被前后解释性文字带偏
    const start = text.indexOf('{');
    const snippet = start === -1 ? null : extractBalancedJsonAt(text, start);
    if (snippet) {
      try {
        parsed = JSON.parse(snippet);
      } catch {
        parsed = null;
      }
    }
  }

  const list = parsed && typeof parsed === 'object'
    ? (parsed as { decisions?: unknown }).decisions
    : null;
  if (!Array.isArray(list)) return decisions;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    // 严格解析：prompt 里教了模型写 "target": null，它很可能也写出 "index": null，
    // 而 Number(null) === 0 会把整条判定错绑到候选 0（键缺失反而安全，是 NaN）。
    const index = parseDecisionIndex(record.index);
    if (index === null || index >= count) continue;
    const action = record.lifecycle_action;
    if (action === 'insert' || action === 'upsert' || action === 'supersede' || action === 'ignore') {
      decisions.set(index, { action, targets: parseDecisionTargets(record.target) });
    }
  }

  return decisions;
}

function toCandidateSummary(item: RawMemoryData): ExtractionCandidateSummary {
  return { category: item.category, content: item.content, tags: item.tags };
}

/**
 * 阶段二：以候选条目为锚点召回相似旧记忆，再让模型重判 lifecycle_action。
 *
 * 就地覆盖 rawData 中被明确判定的条目（含模型指认的 supersede 目标 id）；
 * 未被提及或判定非法的条目保留阶段一的值。
 * 失败不阻塞：召回或 LLM 任一环节出错都直接返回，记忆按阶段一判定照常入库。
 */
async function applyLifecycleDecisions(
  rawData: RawMemoryData[],
  reference: ExtractionReferenceProvider,
  context: {
    characterId: string;
    taskId?: number;
    llmSettings: Settings;
    extraBody: Record<string, unknown> | undefined;
    timeoutMs: number | undefined;
  },
): Promise<void> {
  try {
    const recall = await reference.recallForLifecycle(rawData.map(toCandidateSummary));
    if (!recall.text.trim()) return;

    // 召回结果的降级原因必须落日志：否则 embedding 上游挂掉后参考静默退化，
    // 只看 mode 完全看不出来。
    if (recall.diagnostics?.embeddingFailed || recall.diagnostics?.truncated) {
      structuredLog('warn', 'memory.extraction.reference_degraded', {
        taskId: context.taskId,
        characterId: context.characterId,
        operation: recall.mode,
        status: 'degraded',
        detail: {
          embeddingFailed: recall.diagnostics.embeddingFailed,
          truncated: recall.diagnostics.truncated,
          recallCount: recall.diagnostics.recallCount,
        },
      });
    }

    const candidateList = rawData
      .map((item, index) => `${index}. [${item.category}] ${item.content}`)
      .join('\n');

    const prompt = MEMORY_LIFECYCLE_PROMPT
      .replace('{memory_profile}', () => recall.profileText || '暂无')
      .replace('{existing_memories}', () => recall.text)
      .replace('{candidates}', () => candidateList);

    const response = await runWithBackgroundLlmDeadline(
      context.timeoutMs,
      signal => chatCompletion(context.llmSettings, [{ role: 'user', content: prompt }], signal, context.extraBody),
    );

    const decisions = parseLifecycleDecisions(response, rawData.length);
    let resolvedTargets = 0;
    for (const [index, decision] of decisions) {
      rawData[index].lifecycle_action = decision.action;
      // E 编号 → memory id。越界编号（模型幻觉）直接丢弃，退回词法匹配兜底。
      const ids = decision.targets
        .map(target => recall.memoryIds[target])
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      // 只有 supersede 消费 target。其它 action 一律不写入，避免字段名与写入条件脱节：
      // upsert 曾因「按模型指认的目标合并」绕过相似度阈值而静默丢掉更短的新事实。
      if (decision.action === 'supersede' && ids.length > 0) {
        rawData[index].supersede_target_ids = [...new Set(ids)];
        resolvedTargets += 1;
      }
    }

    structuredLog('info', 'memory.extraction.lifecycle_resolved', {
      taskId: context.taskId,
      characterId: context.characterId,
      operation: recall.mode,
      status: 'ok',
      detail: { candidates: rawData.length, decided: decisions.size, withTarget: resolvedTargets },
    });
  } catch (error) {
    // 阶段一结果已可用，这里失败只降级为「沿用阶段一判定」，不产生 repairable 候选
    structuredLog('warn', 'memory.extraction.lifecycle_failed', {
      taskId: context.taskId,
      characterId: context.characterId,
      status: 'failed',
    }, error);
  }
}

export async function extractMemories(
  characterId: string,
  conversationText: string,
  settings: Settings,
  options: ExtractMemoryOptions = {},
): Promise<{ insertCount: number; mergeCount: number }> {
  if (conversationText.length < 100) return { insertCount: 0, mergeCount: 0 };

  const db = getDb();

  // 任务结果已 durable 提交时短路：只返回上次计数，不再次写记忆。
  const committed = getCommittedExtractionResult(options.taskId, db);
  if (committed) {
    return committed;
  }

  const existingMemories = db.prepare(
    "SELECT * FROM memories WHERE character_id = ? AND status = 'active' ORDER BY updated_at DESC"
  ).all(characterId) as Memory[];
  const normalizedExisting = existingMemories.map(normalizeMemory);

  // ── 阶段一：纯抽取 ──────────────────────────────────────────
  // 参考材料是「画像 + 高优先级记忆」，不再是全量已有记忆：全量在长期使用后会线性膨胀，
  // 且长列表中部条目本就容易被模型忽略。真正的去重/冲突判定交给阶段二（锚点召回后重判）。
  // 未注入 reference 时（直接调用/旧测试）保持原全量行为，避免行为回退。
  let profileSection = '暂无';
  let prioritySection: string;
  if (options.reference) {
    profileSection = options.reference.overview.profileText || '暂无';
    prioritySection = options.reference.overview.priorityText || '暂无';
  } else {
    const relevantExisting = settings.limit_inject
      ? retrieveRelevantMemories(conversationText, characterId, settings.memory_max_inject || 30)
      : normalizedExisting;
    prioritySection = relevantExisting.length > 0
      ? relevantExisting.map(memory => `- [${memory.category}] ${memory.content}`).join('\n')
      : '暂无';
  }

  // 用函数形式的 replacement:字符串形式 replacement 会把对话原文里的 $&、$'、$`、$$、$n 当作替换模式展开,
  // 损坏发给 LLM 的提示词(用户发代码/shell/含 $ 文本即可触发)。函数返回值不做 $ 特殊解析。
  const prompt = EXTRACTION_PROMPT
    .replace('{memory_profile}', () => profileSection)
    .replace('{priority_memories}', () => prioritySection)
    .replace('{conversation_text}', () => conversationText);

  const bgConfig = resolveBackgroundConfig(settings);
  const extractionSettings = mergeSettingsForBackgroundLlm(settings, bgConfig, {
    max_tokens: Math.max(settings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS),
  });
  const backgroundExtraBody = buildBackgroundChatExtraBody(settings, extractionSettings.model);
  const response = await runWithBackgroundLlmDeadline(
    settings.memory_background_timeout_ms,
    signal => chatCompletion(extractionSettings, [{ role: 'user', content: prompt }], signal, backgroundExtraBody),
  );
  const rawData = parseExtractionResponse(response);
  if (rawData.length === 0) {
    if (response.trim()) {
      insertCandidate({
        db,
        characterId,
        options,
        rawResponse: response,
        status: 'repairable',
        errorReason: 'parse_or_no_valid_memory',
      });
    }
    return { insertCount: 0, mergeCount: 0 };
  }

  // ── 阶段二：生命周期判定 ────────────────────────────────────
  // 以候选条目本身为锚点召回相似旧记忆后重判 lifecycle_action。锚点必须是候选而非对话文本：
  // 否则措辞差异大但语义冲突的旧记忆召不回来（"迷上做甜点" 召不回 "不爱吃甜"），
  // 该 supersede 的会被判成 insert，两条矛盾记忆并存。
  if (options.reference) {
    await applyLifecycleDecisions(rawData, options.reference, {
      characterId,
      taskId: options.taskId,
      llmSettings: extractionSettings,
      extraBody: backgroundExtraBody,
      timeoutMs: settings.memory_background_timeout_ms,
    });
  }

  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const sourceMsgIds = uniqueStrings(options.messageIds || []);
  const ignoredItems = rawData.filter(item => item.lifecycle_action === 'ignore');
  for (const item of ignoredItems) {
    insertCandidate({
      db,
      characterId,
      options,
      rawCandidateJson: { ...item, source_msg_ids: sourceMsgIds },
      rawResponse: response,
      status: 'ignored',
      errorReason: 'lifecycle_action_ignore',
    });
  }

  const newEntries: NewMemoryEntry[] = rawData
    .filter(item => item.content && validCategories.has(item.category) && item.lifecycle_action !== 'ignore')
    .map((item): NewMemoryEntry => ({
      // 48 bit (12 hex) 碰撞概率远低于 32 bit；不会影响已有数据，仅新插入条目变长
      id: crypto.randomUUID().slice(0, 12),
      character_id: characterId,
      category: item.category as MemoryCategory,
      content: item.content,
      confidence: Math.min(Math.max(item.confidence || 0.8, 0), 1),
      tags: canonicalizeTags(item.tags).slice(0, 3),
      source_msg_ids: sourceMsgIds,
      memory_kind: item.memory_kind,
      importance: item.importance,
      emotional_weight: item.emotional_weight,
      status: 'active',
      pinned: false,
      last_used_at: null,
      usage_count: 0,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      lifecycle_action: item.lifecycle_action,
      supersede_target_ids: item.supersede_target_ids,
    }));

  if (newEntries.length === 0) {
    if (ignoredItems.length === 0 && response.trim()) {
      insertCandidate({
        db,
        characterId,
        options,
        rawResponse: response,
        status: 'repairable',
        errorReason: 'no_valid_formal_memory',
      });
    }
    return { insertCount: 0, mergeCount: 0 };
  }

  const existingMap = new Map(normalizedExisting.map(m => [m.id, m]));
  const insertEntries = newEntries.filter(entry => entry.lifecycle_action === 'insert');
  const supersedeEntries = newEntries.filter(entry => entry.lifecycle_action === 'supersede');
  const upsertEntries = newEntries.filter(entry => entry.lifecycle_action === 'upsert');
  const merged = mergeMemories(normalizedExisting, upsertEntries);

  // 真实统计：mergeCount 是"已有条目被有效更新"的数量；
  // insertCount 是"全新插入到 DB"的数量。
  // 之前外部用 `newEntries.length`（LLM 解析出的全部条目）判断"是否成功提取"，
  // 在 LLM 反复返回与已有记忆完全等同内容的情况下会得到不准确的语义。
  // 改为返回真实计数后，调用方可以精确判定"本次是否真的产生了新增或更新"。
  let mergeCount = 0;
  let insertCount = 0;
  const embeddingTasks: Array<{ memoryId: string; characterId: string; reason: 'created' | 'updated' }> = [];

  // 用事务包裹整个写入循环，保证多条 UPDATE/INSERT 原子提交，
  // 避免中途崩溃导致记忆部分写入、状态不一致。
  // 同时在同一事务内写入 task 级 result_committed marker，使崩溃恢复可跳过重复应用。
  // 注意：chatCompletion 等异步调用已在事务外完成，事务函数内只放同步的写入与计数累加。
  db.transaction(() => {
    // 事务内二次检查 marker，堵住「读 marker 后、写记忆前」的并发/恢复竞态。
    if (options.taskId !== undefined && hasMemoryTaskResultCommittedColumn(db)) {
      const again = getCommittedExtractionResult(options.taskId, db);
      if (again) {
        insertCount = again.insertCount;
        mergeCount = again.mergeCount;
        return;
      }
    }

    const insertMemory = (entry: NewMemoryEntry) => {
      insertCount++;
      db.prepare(`
        INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, memory_kind, importance, emotional_weight, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.character_id,
        entry.category,
        entry.content,
        entry.confidence,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.source_msg_ids),
        entry.memory_kind,
        entry.importance,
        entry.emotional_weight,
        entry.created_at,
        entry.updated_at,
      );
      embeddingTasks.push({ memoryId: entry.id, characterId: entry.character_id, reason: 'created' });
    };

    for (const entry of insertEntries) {
      insertMemory(entry);
    }

    for (const entry of supersedeEntries) {
      // 优先用阶段二模型指认的目标：语义冲突的新旧记忆词法相似度通常极低
      // （"用户不爱吃甜" vs "用户迷上做甜点" 实测 ~0.04，远低于 0.72/0.82 门槛），
      // 只靠 findSimilarExistingMemories 会一条都匹配不上，supersede 静默退化成 insert。
      // 词法匹配保留为兜底：模型没给 target、或 target 已失效时仍能工作。
      const declaredIds = new Set(entry.supersede_target_ids || []);
      const declared = declaredIds.size > 0
        ? normalizedExisting.filter(memory => declaredIds.has(memory.id))
        : [];
      const targets = declared.length > 0
        ? declared
        : findSimilarExistingMemories(normalizedExisting, entry);
      for (const target of targets) {
        const metadata = parseMemoryMetadata(target.metadata);
        metadata.previousStatus = target.status;
        metadata.supersededBy = {
          action: 'memory_extraction_supersede',
          memoryId: entry.id,
          sourceMsgIds: entry.source_msg_ids,
          supersededAt: entry.updated_at,
        };
        db.prepare(`
          UPDATE memories
          SET status = 'superseded', metadata = ?, updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(JSON.stringify(metadata), entry.updated_at, target.id);
      }
      insertMemory(entry);
    }

    for (const entry of merged) {
      const existing = existingMap.get(entry.id);
      if (existing) {
        // 检查是否真的发生了修改以避免多余的更新和错误的计数
        const isChanged =
          existing.content !== entry.content ||
          existing.confidence !== entry.confidence ||
          JSON.stringify(existing.tags) !== JSON.stringify(entry.tags) ||
          JSON.stringify(existing.source_msg_ids) !== JSON.stringify(entry.source_msg_ids) ||
          existing.memory_kind !== entry.memory_kind ||
          existing.importance !== entry.importance ||
          existing.emotional_weight !== entry.emotional_weight;

        if (isChanged) {
          // content/tags 变化后，检索 token 集缓存按 hash 自动失效；
          // 此处主动清理是对「同事务内该 id 先被 supersede、又作为 merged upsert 目标」
          // 等边界的兜底，避免任何残留旧 token 集被后续检索误用。
          invalidateMemoryTokenCache(entry.id);
          // 乐观锁：守卫 LLM 前快照的 updated_at。
          // - status 已非 active（同事务 supersede）→ 落空，插入新 active 行
          // - 用户在 LLM 窗口内手工改过该记忆 → updated_at 变了，落空，不覆盖用户版本，
          //   把本轮合并信息作为新 active 记忆插入，双保留、不丢内容
          const result = db.prepare(`
            UPDATE memories
            SET content = ?, confidence = ?, tags = ?, source_msg_ids = ?, memory_kind = ?, importance = ?, emotional_weight = ?, updated_at = ?
            WHERE id = ? AND status = 'active' AND updated_at = ?
          `).run(
            entry.content,
            entry.confidence,
            JSON.stringify(entry.tags),
            JSON.stringify(entry.source_msg_ids),
            entry.memory_kind,
            entry.importance,
            entry.emotional_weight,
            entry.updated_at,
            entry.id,
            existing.updated_at,
          );
          if (result.changes > 0) {
            mergeCount++;
            embeddingTasks.push({ memoryId: entry.id, characterId: entry.character_id, reason: 'updated' });
          } else {
            // UPDATE 落空：supersede 或用户并发编辑。新信息作为全新 active 记忆插入，避免静默丢失。
            insertMemory({ ...entry, id: crypto.randomUUID().slice(0, 12), created_at: entry.updated_at } as NewMemoryEntry);
          }
        }
      } else {
        insertMemory(entry as NewMemoryEntry);
      }
    }

    // 与记忆写入同事务提交 durable marker；恢复路径看到 marker 后只补 metadata/task 状态。
    if (options.taskId !== undefined && hasMemoryTaskResultCommittedColumn(db)) {
      db.prepare(`
        UPDATE memory_tasks
        SET result_committed = 1,
            result_insert_count = ?,
            result_merge_count = ?,
            merge_count = ?,
            updated_at = ?
        WHERE id = ?
      `).run(insertCount, mergeCount, mergeCount, new Date().toISOString(), options.taskId);
    }
  })();

  // 若事务内因二次 marker 检查短路，embedding 队列无需再入。
  if (options.taskId !== undefined && embeddingTasks.length === 0) {
    const after = getCommittedExtractionResult(options.taskId, db);
    if (after) {
      return after;
    }
  }

  let queuedEmbeddingTasks = 0;
  for (const task of embeddingTasks) {
    try {
      if (enqueueMemoryEmbeddingTask(task.memoryId, task.characterId, task.reason, db)) {
        queuedEmbeddingTasks++;
      }
    } catch (err) {
      structuredLog('error', 'memory.embedding.enqueue_failed', {
        taskId: task.memoryId,
        characterId: task.characterId,
        operation: task.reason,
        status: 'failed',
      }, err);
    }
  }
  if (queuedEmbeddingTasks > 0) {
    triggerMemoryIndexProcessing();
  }

  return { insertCount, mergeCount };
}
