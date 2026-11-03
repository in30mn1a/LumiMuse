/**
 * 旧 AI 整理的冻结副本，只用于复现评测基线。
 *
 * 来源：src/app/api/memory-review/route.ts、src/lib/memory-tag-spec.ts @ commit 98a47b0。
 * 旧功能退役后源文件会被删除，这里必须保持原样：提示词、截断、解析和过滤规则都不要改进。
 * 与生产的差异只有两点：标签规范写成字面量；不可合并只看 pinned，因为样本不含合并或归档元数据。
 */
const { registerTsLoader } = require('../../tests/helpers/register-ts-loader.cjs');

registerTsLoader();
const { findFirstBalancedJson } = require('../../src/lib/balanced-json.ts');

const LEGACY_BATCH_SIZE = 500;
const LEGACY_ENTRY_CONTENT_CHAR_LIMIT = 4000;
const LEGACY_TAG_OVERVIEW_CHAR_LIMIT = 1200;
const LEGACY_VALID_CATEGORIES = ['关系动态', '话题历史', '基础信息', '偏好习惯', '人格特质', '重要事件', '四季日常'];

const TAG_SPEC_PROMPT_SECTION = `## 标签规范表（优先从中选用，保证跨条目/批次一致）
- 关系：称呼、承诺、约定、情话、告白、亲密、吵架、和好、纪念日、陪伴方式
- 情感：依赖、思念、安全感、吃醋、感动
- 偏好：饮食、口味、作息、娱乐、音乐、电影、书籍、游戏、运动、穿搭
- 日常：早餐、午餐、晚餐、夜宵、睡眠、天气、通勤、家务、散步、购物
- 基础信息：年龄、身高、体重、职业、学业、专业、家乡、住址、家庭、健康、星座、MBTI
- 人格：性格、价值观、焦虑、自我认知、习惯
- 事件：考试、面试、答辩、旅行、生病、成就、决定、搬家、生日、节日
- 话题：对话、观点、计划、推荐、回忆

近义写法统一示例：午饭/中饭→午餐、晚饭→晚餐、聊天/谈话→对话、影片/观影→电影、读书/阅读→书籍、健身/锻炼→运动、旅游→旅行
- 优先复用上表标准标签；上表确实没有合适项时才新建短标签
- 同一含义只用一个写法，不要混用近义词`;

function truncateForReview(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[内容过长，已截断用于本次审核]`;
}

function buildTagOverview(memories) {
  const counts = new Map();
  for (const memory of memories) {
    for (const tag of memory.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  const text = ranked.map(([tag, count]) => `${tag}×${count}`).join('、') || '无';
  return truncateForReview(text, LEGACY_TAG_OVERVIEW_CHAR_LIMIT);
}

function buildMemoryReviewEntry(memory, index) {
  const content = truncateForReview(memory.content, LEGACY_ENTRY_CONTENT_CHAR_LIMIT);
  const mergeMarker = memory.pinned === 1 ? ' | 不可合并' : '';
  return `[${index + 1}] ID:${memory.id} | 分类:${memory.category} | 标签:${memory.tags.join(',') || '无'} | 重要度:${memory.importance} | 种类:${memory.memory_kind}${mergeMarker}\n${content}`;
}

function buildMemoryReviewPrompt(memoriesText, validCategories, tagOverview, batchIndex, batchCount) {
  return `你是 LumiMuse 的记忆审核助手。请审阅以下记忆条目，检查并修正问题。

## 检查项
1. **缺失标签**：没有任何标签的记忆，根据内容给出合适的短标签（优先取自下方标签规范表）
2. **标签整理**：整理当前条目的已有标签，删除重复、过泛或不贴切的标签，并在所有条目中统一意思相近的标签；优先替换为下方标签规范表中的标准标签；例如：午饭/午餐统一为"午餐"，聊天/对话统一为"对话"
3. **缺失重要度**：importance 为 0 或明显离谱的，给出建议值（0-1）
4. **分类错误**：明显归类不当的，给出正确的分类（可选：${validCategories}）
   - 例如：日常琐事（作息、饮食、天气）不应归"重要事件"，应归"四季日常"
   - 例如：有长期价值的信息不应归"四季日常"，应归"偏好习惯"或"基础信息"
5. **可合并重复**（仅建议，不要直接改库）：若本批内存在语义重复、可无损合并的条目，输出 merge_suggestions；时序互相否定的不要合并，kind 标为 conflict

${TAG_SPEC_PROMPT_SECTION}

## 全局参考
- 这是第 ${batchIndex + 1}/${batchCount} 批；本批只输出本批条目的 correction / merge_suggestions，不要输出其他批次的 ID
- 全部已有标签概览（标签×出现次数）：${tagOverview}

## 规则
- 只修正确实有问题的条目，不需要改的就不要输出
- 如果只统一标签，也要输出该条 correction；最终 tags 应该是统一后的完整标签数组，而不是只输出新增标签
- 合并建议铁律：
  1. merged_content 必须保留全部具体事实，宁长勿简，禁止为简洁丢弃细节
  2. 时序互相否定、无法无损合并的事实不得合并，输出 kind=conflict
  3. source_ids 至少 2 个，且必须都是本批 ID
  4. 人称视角铁律：沿用记忆第一人称约定——记忆是从 AI 角色视角记录的，角色自身用"我"，用户用"用户"；不得写成"用户和LumiMuse"之类的第三人称并列表述，LumiMuse 是系统名，不是角色名，禁止出现在 merged_content 中
  5. 同一组重复条目只输出一条 kind=merge 建议，把该组全部重复条目的 ID 放进同一个 source_ids；每个 ID 最多出现在一条 kind=merge 建议中，不要拆成多条两两合并
  6. 标注"不可合并"的条目（置顶 / 已是合并结果 / 归档摘要）照常审核 correction，但不得出现在任何 kind=merge 建议的 source_ids 中
- 只输出 JSON 对象，不要解释

## 输出格式
{"corrections":[{"id":"<记忆ID>","category":"<正确分类>","tags":["标签1","标签2"],"importance":0.65}],"merge_suggestions":[{"source_ids":["id1","id2"],"merged_content":"...","category":"偏好习惯","tags":["标签"],"importance":0.7,"kind":"merge","reason":"重复描述同一偏好"}]}

## 记忆列表
${memoriesText}

请审阅并输出修正：`;
}

/** 与生产解析一致，额外返回被丢弃的 conflict（merged_content 为空），只用于诊断旧解析器的影响。 */
function parseMemoryReviewPayload(llmResult) {
  let text = llmResult.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
  if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const snippet = findFirstBalancedJson(text, 'object');
    if (!snippet) throw new Error('No JSON object');
    parsed = JSON.parse(snippet);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Memory review response must be a JSON object');
  }
  const corrections = Array.isArray(parsed.corrections)
    ? parsed.corrections.filter(correction => correction && typeof correction === 'object' && typeof correction.id === 'string')
    : [];

  const mergeSuggestions = [];
  const droppedConflicts = [];
  if (Array.isArray(parsed.merge_suggestions)) {
    for (const row of parsed.merge_suggestions) {
      if (!row || typeof row !== 'object') continue;
      const sourceIds = Array.isArray(row.source_ids)
        ? row.source_ids.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
        : [];
      const mergedContent = typeof row.merged_content === 'string' ? row.merged_content.trim() : '';
      const kind = row.kind === 'conflict' ? 'conflict' : row.kind === 'merge' ? 'merge' : null;
      if (sourceIds.length >= 2 && !mergedContent && kind === 'conflict') {
        droppedConflicts.push({ source_ids: [...new Set(sourceIds)], reason: typeof row.reason === 'string' ? row.reason : undefined });
      }
      if (sourceIds.length < 2 || !mergedContent || !kind) continue;
      mergeSuggestions.push({
        source_ids: [...new Set(sourceIds)],
        merged_content: mergedContent,
        category: typeof row.category === 'string' ? row.category : undefined,
        tags: Array.isArray(row.tags) ? row.tags.map(tag => String(tag)).filter(Boolean) : undefined,
        importance: typeof row.importance === 'number' && Number.isFinite(row.importance) ? row.importance : undefined,
        kind,
        reason: typeof row.reason === 'string' ? row.reason : undefined,
      });
    }
  }
  return { corrections, merge_suggestions: mergeSuggestions, dropped_conflicts: droppedConflicts };
}

function dropOverlappingMergeSuggestions(suggestions) {
  const claimedIds = new Set();
  const kept = new Set();
  const mergeBySizeDesc = suggestions
    .filter(suggestion => suggestion.kind === 'merge')
    .sort((a, b) => b.source_ids.length - a.source_ids.length);
  for (const suggestion of mergeBySizeDesc) {
    if (suggestion.source_ids.some(id => claimedIds.has(id))) continue;
    for (const id of suggestion.source_ids) claimedIds.add(id);
    kept.add(suggestion);
  }
  return suggestions.filter(suggestion => suggestion.kind !== 'merge' || kept.has(suggestion));
}

/**
 * 与生产路由的后处理一致：建议的来源必须同属一批，merge 不得包含不可合并条目，并消除来源重叠。
 * 生产按页处理，一页就是一批，这里逐批调用。
 */
function filterBatchSuggestions(suggestions, batchMemories) {
  const validIds = new Set(batchMemories.map(memory => memory.id));
  const unmergeableIds = new Set(batchMemories.filter(memory => memory.pinned === 1).map(memory => memory.id));
  return dropOverlappingMergeSuggestions(suggestions.filter(suggestion => {
    if (suggestion.source_ids.length < 2) return false;
    if (!suggestion.source_ids.every(id => validIds.has(id))) return false;
    if (suggestion.kind === 'merge' && suggestion.source_ids.some(id => unmergeableIds.has(id))) return false;
    return true;
  }));
}

module.exports = {
  LEGACY_BATCH_SIZE,
  LEGACY_VALID_CATEGORIES,
  buildMemoryReviewEntry,
  buildMemoryReviewPrompt,
  buildTagOverview,
  filterBatchSuggestions,
  parseMemoryReviewPayload,
  truncateForReview,
};
