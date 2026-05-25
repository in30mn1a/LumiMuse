import { getDb } from '@/lib/db';
import { Memory, MemoryCategory, Settings, MEMORY_CATEGORIES } from '@/types';
import { chatCompletion } from '@/lib/api-client';
import { EXTRACTION_PROMPT } from '@/lib/prompt-templates';
import { normalizeMemoryCategory } from '@/lib/memory-category';

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

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeMemory(record: Memory): Memory {
  const normalized = record as unknown as Record<string, unknown>;
  normalized.category = normalizeMemoryCategory(String(normalized.category || '话题历史'));
  normalized.tags = Array.isArray(normalized.tags) ? normalized.tags : parseJsonField(normalized.tags);
  normalized.source_msg_ids = Array.isArray(normalized.source_msg_ids)
    ? normalized.source_msg_ids
    : parseJsonField(normalized.source_msg_ids);
  return normalized as Memory;
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
    'SELECT * FROM memories WHERE character_id = ? ORDER BY updated_at DESC'
  ).all(characterId) as Memory[];
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
    const memoryTokens = tokenizeForRetrieval(memory.content);
    for (const tag of memory.tags) {
      if (tag) memoryTokens.add(tag.toLowerCase());
    }
    memoryTokens.add(memory.category);

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

function contentSimilarity(a: string, b: string): number {
  const left = a.replace(/\s+/g, '').toLowerCase();
  const right = b.replace(/\s+/g, '').toLowerCase();
  if (!left || !right) return 0;

  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < left.length - 1; i += 1) bigramsA.add(left[i] + left[i + 1]);
  for (let i = 0; i < right.length - 1; i += 1) bigramsB.add(right[i] + right[i + 1]);

  const intersectionSize = [...bigramsA].filter(item => bigramsB.has(item)).length;
  const unionSize = new Set([...bigramsA, ...bigramsB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
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
          updated_at: new Date().toISOString(),
        };
        continue;
      }
    }
    result.push(newEntry);
  }

  return result;
}

interface RawMemoryData {
  category: string;
  content: string;
  confidence: number;
  tags: string[];
}

function parseMemoryPayload(value: unknown): RawMemoryData[] {
  if (Array.isArray(value)) return value as RawMemoryData[];
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.memories)) return record.memories as RawMemoryData[];
  if (record.category) return [record as unknown as RawMemoryData];
  return [];
}

function findBalancedJsonSnippet(text: string, startIdx: number): string | null {
  const first = text[startIdx];
  if (first !== '{' && first !== '[') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }

  return null;
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

    for (const startIdx of candidates) {
      const snippet = findBalancedJsonSnippet(text, startIdx);
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

export async function extractMemories(
  characterId: string,
  conversationText: string,
  settings: Settings,
): Promise<{ insertCount: number; mergeCount: number }> {
  if (conversationText.length < 100) return { insertCount: 0, mergeCount: 0 };

  const db = getDb();
  const existingMemories = db.prepare(
    'SELECT * FROM memories WHERE character_id = ? ORDER BY updated_at DESC'
  ).all(characterId) as Memory[];
  const normalizedExisting = existingMemories.map(normalizeMemory);

  // 提取时给 AI 参考的已有记忆：未启用注入限制时发送全部，启用时按相关性截取
  let relevantExisting: Memory[];
  if (!settings.limit_inject) {
    // 不限制：全部已有记忆都发给 AI 参考，避免重复提取
    relevantExisting = normalizedExisting;
  } else {
    // 启用限制：按相关性检索，最多 memory_max_inject 条
    relevantExisting = retrieveRelevantMemories(conversationText, characterId, settings.memory_max_inject || 30);
  }
  const existingSummary = relevantExisting.length > 0
    ? relevantExisting.map(memory => `- [${memory.category}] ${memory.content}`).join('\n')
    : '暂无';

  const prompt = EXTRACTION_PROMPT
    .replace('{existing_memories}', existingSummary)
    .replace('{conversation_text}', conversationText);

  const response = await chatCompletion(settings, [{ role: 'user', content: prompt }]);
  const rawData = parseExtractionResponse(response);
  if (rawData.length === 0) return { insertCount: 0, mergeCount: 0 };

  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const newEntries: Memory[] = rawData
    .filter(item => item.content && validCategories.has(item.category))
    .map(item => ({
      // 48 bit (12 hex) 碰撞概率远低于 32 bit；不会影响已有数据，仅新插入条目变长
      id: crypto.randomUUID().slice(0, 12),
      character_id: characterId,
      category: item.category as MemoryCategory,
      content: item.content,
      confidence: Math.min(Math.max(item.confidence || 0.8, 0), 1),
      tags: (item.tags || []).slice(0, 3),
      source_msg_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  if (newEntries.length === 0) return { insertCount: 0, mergeCount: 0 };

  const existingMap = new Map(normalizedExisting.map(m => [m.id, m]));
  const merged = mergeMemories(normalizedExisting, newEntries);

  // 真实统计：mergeCount 是"已有条目被有效更新"的数量；
  // insertCount 是"全新插入到 DB"的数量。
  // 之前外部用 `newEntries.length`（LLM 解析出的全部条目）判断"是否成功提取"，
  // 在 LLM 反复返回与已有记忆完全等同内容的情况下会得到不准确的语义。
  // 改为返回真实计数后，调用方可以精确判定"本次是否真的产生了新增或更新"。
  let mergeCount = 0;
  let insertCount = 0;

  for (const entry of merged) {
    const existing = existingMap.get(entry.id);
    if (existing) {
      // 检查是否真的发生了修改以避免多余的更新和错误的计数
      const isChanged =
        existing.content !== entry.content ||
        existing.confidence !== entry.confidence ||
        JSON.stringify(existing.tags) !== JSON.stringify(entry.tags);

      if (isChanged) {
        mergeCount++;
        db.prepare(`
          UPDATE memories
          SET content = ?, confidence = ?, tags = ?, updated_at = ?
          WHERE id = ?
        `).run(entry.content, entry.confidence, JSON.stringify(entry.tags), entry.updated_at, entry.id);
      }
    } else {
      insertCount++;
      db.prepare(`
        INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        entry.id,
        entry.character_id,
        entry.category,
        entry.content,
        entry.confidence,
        JSON.stringify(entry.tags),
        entry.created_at,
        entry.updated_at,
      );
    }
  }

  return { insertCount, mergeCount };
}
