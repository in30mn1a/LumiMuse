import { getDb } from '@/lib/db';
import { Memory, MemoryCategory, Settings, MEMORY_CATEGORIES } from '@/types';
import { chatCompletion } from '@/lib/api-client';
import { EXTRACTION_PROMPT } from '@/lib/prompt-templates';
import { normalizeMemoryCategory } from '@/lib/memory-category';

const CJK_STOPWORDS = new Set(['用户', '喜欢', '觉得', '一起', '我们', '这个', '那个', '自己', '对话', '记忆']);

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
  const allMemories = db.prepare('SELECT * FROM memories WHERE character_id = ?').all(characterId) as Memory[];
  const normalizedMemories = allMemories.map(normalizeMemory);

  if (normalizedMemories.length <= maxMemories) {
    return normalizedMemories;
  }

  const queryTokens = tokenizeForRetrieval(queryText);
  if (queryTokens.size === 0) {
    return normalizedMemories.slice(-maxMemories);
  }

  const scored: Array<[number, Memory]> = [];
  for (const memory of normalizedMemories) {
    const memoryTokens = tokenizeForRetrieval(memory.content);
    for (const tag of memory.tags) {
      if (tag) memoryTokens.add(tag.toLowerCase());
    }
    memoryTokens.add(memory.category);

    const score = [...queryTokens].filter(token => memoryTokens.has(token)).length;
    if (score > 0) scored.push([score, memory]);
  }

  if (scored.length === 0) {
    return normalizedMemories.slice(-maxMemories);
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
    if (result.memories && Array.isArray(result.memories)) return result.memories;
    if (Array.isArray(result)) return result;
    if (result.category) return [result];
    return [];
  } catch {
    // 回退策略：从 "memories" 关键字位置出发，向前找最近的 '{' 作为对象起点，
    // 然后向后做花括号配对扫描（考虑字符串与转义），找到匹配的 '}' 截取再尝试 JSON.parse。
    // 这样比贪婪正则更稳健，避免越过同一响应中的多个 JSON 块。
    const keywordIdx = text.indexOf('"memories"');
    if (keywordIdx === -1) return [];

    let startIdx = -1;
    for (let i = keywordIdx; i >= 0; i -= 1) {
      if (text[i] === '{') { startIdx = i; break; }
    }
    if (startIdx === -1) return [];

    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) return [];

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx + 1));
      if (Array.isArray(parsed.memories)) return parsed.memories;
    } catch {
      return [];
    }
    return [];
  }
}

export async function extractMemories(
  characterId: string,
  conversationText: string,
  settings: Settings,
): Promise<{ newEntries: Memory[]; mergeCount: number }> {
  if (conversationText.length < 100) return { newEntries: [], mergeCount: 0 };

  const db = getDb();
  const existingMemories = db.prepare('SELECT * FROM memories WHERE character_id = ?').all(characterId) as Memory[];
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
  if (rawData.length === 0) return { newEntries: [], mergeCount: 0 };

  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const newEntries: Memory[] = rawData
    .filter(item => item.content && validCategories.has(item.category))
    .map(item => ({
      id: crypto.randomUUID().slice(0, 8),
      character_id: characterId,
      category: item.category as MemoryCategory,
      content: item.content,
      confidence: Math.min(Math.max(item.confidence || 0.8, 0), 1),
      tags: (item.tags || []).slice(0, 3),
      source_msg_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  if (newEntries.length === 0) return { newEntries: [], mergeCount: 0 };

  const existingMap = new Map(normalizedExisting.map(m => [m.id, m]));
  const merged = mergeMemories(normalizedExisting, newEntries);

  // 统计被合并（更新）的旧条目数量
  let mergeCount = 0;

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

  return { newEntries, mergeCount };
}
