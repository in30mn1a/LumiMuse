import type { ImagePromptStyle } from '@/lib/nai-image';
import {
  buildInlinePromptInstructionForStyle,
  INLINE_PROMPT_SYSTEM_REMINDER,
} from '@/lib/image-prompt-instructions';

export { INLINE_PROMPT_SYSTEM_REMINDER };

/**
 * 内联生图提示词（inline image prompt）
 *
 * 思路：让聊天模型在正常回复的末尾，用 [IMG]...[/IMG] 包裹一段生图提示词。
 * 聊天本身是流式且很快的，相当于「顺风车」捎带把提示词生成了，出图时直接复用，
 * 免去单独调用慢速的 /api/image-gen/prompt（推理模型生成数千 token 要等数十秒）。
 *
 * 约定：
 * - 标记用 [IMG] / [/IMG]，大小写不敏感
 * - V3/V4/SD：英文 danbooru tag，逗号分隔
 * - NAI V5：Prompt / Character N 字段，tag 与自然语言混写
 * - 提取后会从正文中剥离，保证上下文 / 记忆 / token 统计干净，前端也不展示该块
 */

/**
 * 匹配 [IMG]...[/IMG] 块（含标记本身），大小写不敏感、跨行。
 * 块内不允许再出现 [IMG]：文本里单独提到的 [IMG] 不能和后面真正的 [/IMG] 配对，把中间的正文吞掉。
 */
const INLINE_IMG_BLOCK = /\[IMG\]((?:(?!\[IMG\])[\s\S])*?)\[\/IMG\]/gi;
/** 流式过程中可能只输出了开头的 [IMG 而尚未闭合，用于实时隐藏未闭合的尾巴 */
const INLINE_IMG_OPEN_TAIL = /\[IMG\b[\s\S]*$/i;
/** 真实提示词至少含一个字母或数字；只有标点的块（`...`、`…`）是模型照抄的格式占位符 */
const INLINE_PROMPT_HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * 内联生图提示词的指令文本。
 *
 * 重要：经实测，deepseek 等模型把该指令放在 system prompt 里时，会被角色长人设 +
 * "回复必须是纯粹角色对话内容"约束 + 历史回复惯性压制，输出极不稳定（常常完全不输出）。
 * 把它作为**最后一条 user 消息的尾部追加**，约束力最强，可稳定触发。
 *
 * 该指令只在发给模型的请求里临时追加，绝不落库 —— 否则会污染对话记录、记忆提取与前端显示。
 *
 * 措辞经实测调校：保持单段紧凑（指令过长模型会整段忽略）。V5 内联是气泡完整规范的压缩版，
 * 口径一致但更短。开头「系统附加要求…不算跳出角色」用于压过角色人设里
 * 「回复必须是纯粹角色对话内容」之类的强约束。
 *
 * @param imageTags 角色固定外貌标签，要求模型务必包含，保证人物外观一致
 * @param userImageTags 用户本人外貌标签，仅当用户出现在画面中时才包含（单人/独白场景忽略）
 * @param style 生图提示词风格；NAI V5 时改为 Prompt / Character 字段
 */
export function buildInlinePromptInstruction(
  imageTags?: string,
  userImageTags?: string,
  style: ImagePromptStyle = 'danbooru',
): string {
  return buildInlinePromptInstructionForStyle(style, imageTags, userImageTags);
}

/**
 * 从完整回复文本中提取内联提示词。
 *
 * 取最后一个有内容的块：指令要求块放在回复最后，而模型思考时可能先照抄格式
 * （system 提醒里就有字面量 `[IMG]...[/IMG]`）。思考没进丢弃块时这些块还在文本里。
 *
 * @returns prompt 为提取到的提示词（去除标记、trim），未找到则为空串
 */
export function extractInlinePrompt(text: string): string {
  let prompt = '';
  for (const match of text.matchAll(INLINE_IMG_BLOCK)) {
    const candidate = match[1].trim();
    if (INLINE_PROMPT_HAS_CONTENT.test(candidate)) prompt = candidate;
  }
  return prompt;
}

/**
 * 从文本中剥离所有 [IMG]...[/IMG] 块，返回干净的正文。
 * 同时处理流式中途「只有开头标记、尚未闭合」的情况，避免半截标记闪现给用户。
 */
export function stripInlinePrompt(text: string): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(INLINE_IMG_BLOCK)) {
    result += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  // 未闭合的尾巴（流式中间态）只可能在最后一个闭合块之后；
  // 更靠前的 [IMG] 只是提到标记，从那里砍到末尾会丢正文。
  result += text.slice(cursor).replace(INLINE_IMG_OPEN_TAIL, '');
  return result.replace(/\s+$/, '');
}
