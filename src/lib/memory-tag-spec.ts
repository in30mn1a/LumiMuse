/**
 * 记忆标签规范表（单一事实来源）。
 *
 * 目的：记忆提取与 AI 整理都会分多批次、跨多页独立调用 LLM，靠模型自觉对齐标签天生不可靠。
 * 这里提供两层保障：
 *   1) CANONICAL_TAG_GROUPS —— 一套推荐的标准标签，注入到提取/整理 prompt 作为强引导（全局共享，不随批次/页变化）。
 *   2) TAG_ALIASES + normalizeTags —— 服务端确定性别名归一，无论 LLM 给出哪种近义写法都收敛到同一规范词，
 *      这才是跨批次一致性的真正兜底（不依赖模型行为）。
 *
 * 设计取向（与项目"宁可保守"一致）：这是「规范参考」而非「硬白名单」——
 * 找不到合适标准标签时仍允许新建标签，别名表只收敛高频近义词，避免意外改写语义。
 */

/** 按领域分组的标准标签，仅用于 prompt 引导展示。改动这里即同时影响提取与整理的引导词。 */
export const CANONICAL_TAG_GROUPS: ReadonlyArray<{ group: string; tags: readonly string[] }> = [
  { group: '关系', tags: ['称呼', '承诺', '约定', '情话', '告白', '亲密', '吵架', '和好', '纪念日', '陪伴方式'] },
  { group: '情感', tags: ['依赖', '思念', '安全感', '吃醋', '感动'] },
  { group: '偏好', tags: ['饮食', '口味', '作息', '娱乐', '音乐', '电影', '书籍', '游戏', '运动', '穿搭'] },
  { group: '日常', tags: ['早餐', '午餐', '晚餐', '夜宵', '睡眠', '天气', '通勤', '家务', '散步', '购物'] },
  { group: '基础信息', tags: ['年龄', '身高', '体重', '职业', '学业', '专业', '家乡', '住址', '家庭', '健康', '星座', 'MBTI'] },
  { group: '人格', tags: ['性格', '价值观', '焦虑', '自我认知', '习惯'] },
  { group: '事件', tags: ['考试', '面试', '答辩', '旅行', '生病', '成就', '决定', '搬家', '生日', '节日'] },
  { group: '话题', tags: ['对话', '观点', '计划', '推荐', '回忆'] },
];

/** 扁平标准标签集合，供需要校验/展示全集的场景使用。 */
export const CANONICAL_TAGS: readonly string[] = CANONICAL_TAG_GROUPS.flatMap(g => g.tags);

/**
 * 别名 → 标准标签映射。只收敛高频近义写法，保持保守，避免误改语义。
 * 注意：映射目标必须是某个标准标签；不在此表中的标签会原样保留（允许新标签生长）。
 */
export const TAG_ALIASES: Readonly<Record<string, string>> = {
  // 餐食
  午饭: '午餐', 中饭: '午餐',
  晚饭: '晚餐',
  早饭: '早餐',
  宵夜: '夜宵',
  // 对话
  聊天: '对话', 谈话: '对话', 交流: '对话',
  // 影音书
  影片: '电影', 观影: '电影',
  歌曲: '音乐',
  书: '书籍', 读书: '书籍', 阅读: '书籍',
  // 作息
  睡觉: '睡眠',
  // 学业 / 运动 / 旅行 / 穿搭
  学习: '学业', 上学: '学业',
  健身: '运动', 锻炼: '运动',
  旅游: '旅行', 出游: '旅行',
  衣服: '穿搭', 服装: '穿搭', 打扮: '穿搭',
};

/** 归一单个标签：去空白后查别名表，命中则替换，否则原样返回。空串返回空串。 */
export function normalizeTag(raw: unknown): string {
  const tag = String(raw ?? '').trim();
  if (!tag) return '';
  return TAG_ALIASES[tag] ?? tag;
}

/** 归一标签数组：逐个归一 + 去空 + 去重（保序）。这是确定性兜底，跨批次/跨页结果一致。 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** 渲染标签规范表为 prompt 片段，注入提取/整理 prompt 作为全局共享引导。保持紧凑以控制 prompt 体积。 */
export function buildTagSpecPromptSection(): string {
  const groups = CANONICAL_TAG_GROUPS.map(g => `- ${g.group}：${g.tags.join('、')}`).join('\n');
  const aliasExamples = '午饭/中饭→午餐、晚饭→晚餐、聊天/谈话→对话、影片/观影→电影、读书/阅读→书籍、健身/锻炼→运动、旅游→旅行';
  return `## 标签规范表（优先从中选用，保证跨条目/批次一致）
${groups}

近义写法统一示例：${aliasExamples}
- 优先复用上表标准标签；上表确实没有合适项时才新建短标签
- 同一含义只用一个写法，不要混用近义词`;
}

/** 标签规范 prompt 片段常量（模块加载时求值一次），供静态 prompt 模板直接内插。 */
export const TAG_SPEC_PROMPT_SECTION = buildTagSpecPromptSection();
