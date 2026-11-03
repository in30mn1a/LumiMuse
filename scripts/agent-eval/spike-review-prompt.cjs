/**
 * 小型验证（TASK-EVAL-SPIKE）的提示词：约 40 条 + 来源消息 + 角色设定和画像 + 单一目标。
 *
 * 不跑工具循环，只回答一个问题：同一模型拿到更小的批次、原文依据和角色背景后，判断会不会变好。
 * 提示词里的例子不得取自评测样本。
 */
const { registerTsLoader } = require('../../tests/helpers/register-ts-loader.cjs');

registerTsLoader();
const { findFirstBalancedJson } = require('../../src/lib/balanced-json.ts');

const SPIKE_BATCH_SIZE = 40;
const SPIKE_GOALS = ['conflict', 'duplicate', 'category'];

const GOAL_INSTRUCTIONS = {
  conflict: `## 本次唯一目标：找出互相矛盾的记忆
找出不可能同时成立的两条或多条记忆，它们会让角色说出自相矛盾的话。
- 矛盾常常措辞完全不同，不要只比较字面。逐条想它隐含的事实（例如「每天弹钢琴」隐含「手能正常活动」），再和其他条目比较。
- 下判断前核对来源消息：确认说的是用户本人还是别人，是事实还是玩笑，有没有特殊情况。来源能解释通的不算矛盾。
- 记录时间能解释的前后变化（例如换了城市）不算矛盾。
- 同一主题但能同时成立的条目不算矛盾。没有把握就不要报。

## 输出格式
只输出 JSON 对象，不要解释。没有发现就输出空数组。
{"conflicts":[{"memory_ids":["id1","id2"],"reason":"为什么不可能同时成立","evidence":"引用记忆或来源消息的原文"}]}`,
  duplicate: `## 本次唯一目标：找出可以无损合并的重复记忆
找出说的是同一件事、合并后不会丢失任何事实的条目。
- 只合并同一事实的不同说法。两次不同的经历、不同主语的事实、不同的约定、前后发生的变化，都不合并。
- 下判断前核对来源消息，确认确实是同一件事。
- merged_content 必须保留全部具体事实，宁长勿简。沿用记忆的人称：角色自身用「我」，用户用「用户」。
- 同一组重复条目只输出一条，把全部 ID 放进 source_ids；每个 ID 最多出现一次。
- 标注「不可合并」的条目不得出现在 source_ids 中。没有把握就不要报。

## 输出格式
只输出 JSON 对象，不要解释。没有发现就输出空数组。
{"merges":[{"source_ids":["id1","id2"],"merged_content":"合并后的完整内容","reason":"为什么是同一件事","evidence":"引用记忆或来源消息的原文"}]}`,
  category: `## 本次唯一目标：找出明显分错类的记忆
分类含义：
- 关系动态：我和用户之间的关系、约定、相处方式
- 话题历史：聊过的话题和一次性的看法
- 基础信息：用户稳定的客观事实
- 偏好习惯：用户长期的喜好和习惯
- 人格特质：用户的性格和待人处事的方式
- 重要事件：对用户有长期影响的经历
- 四季日常：过后就不再重要的日常琐事
只修改明显错误的分类，两类都说得通的不要改。没有把握就不要报。

## 输出格式
只输出 JSON 对象，不要解释。没有发现就输出空数组。
{"corrections":[{"id":"记忆ID","category":"正确分类","reason":"为什么原分类不对","evidence":"引用记忆或来源消息的原文"}]}`,
};

const SOURCE_LABELS = { user: '用户', assistant: '角色' };

function buildSpikeEntry(memory, index) {
  const mergeMarker = memory.pinned === 1 ? ' | 不可合并' : '';
  const source = memory.source_messages
    .map(message => `  ${SOURCE_LABELS[message.role]}：${message.content}`)
    .join('\n');
  return `[${index + 1}] ID:${memory.id} | 分类:${memory.category} | 标签:${memory.tags.join(',') || '无'} | 重要度:${memory.importance} | 种类:${memory.memory_kind} | 记录时间:${memory.created_at}${mergeMarker}\n${memory.content}\n来源消息：\n${source}`;
}

function buildSpikePrompt(goal, batchMemories, character) {
  const entries = batchMemories.map(buildSpikeEntry).join('\n\n');
  return `你在帮用户检查 AI 陪伴角色的长期记忆。记忆是从角色视角记录的。

## 角色设定
名字：${character.name}
${character.persona}

## 角色对用户的画像
${character.profile}

${GOAL_INSTRUCTIONS[goal]}

只能使用下面列出的 ID。

## 记忆列表
${entries}`;
}

function parseSpikePayload(text) {
  const trimmed = text.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const snippet = findFirstBalancedJson(trimmed, 'object');
    if (!snippet) throw new Error('No JSON object');
    parsed = JSON.parse(snippet);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Spike response must be a JSON object');
  }
  return parsed;
}

module.exports = { SPIKE_BATCH_SIZE, SPIKE_GOALS, buildSpikePrompt, parseSpikePayload };
