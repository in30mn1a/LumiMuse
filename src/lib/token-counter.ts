// Token 估算
//
// 实现策略：
// 1. 首选 js-tiktoken 的 cl100k_base BPE 分词器（与 GPT-3.5/4 / 大部分 OpenAI
//    兼容协议一致），误差通常 < 5%。
// 2. encoder 在首次调用时 lazy-init，初始化或 encode 抛错则永久回退到
//    粗略估算，避免单一依赖把整个应用拖垮。
// 3. 接口保持完全同步（js-tiktoken 是纯 JS 同步 API），所有调用方无需改动。
//
// 注：Anthropic 模型理论上用不同的 BPE 词表，但项目走的是 "OpenAI 兼容"
// 协议（chat completions），cl100k_base 在中英文 / 代码 / 标点上的整体
// 误差仍显著小于按字符规则估算。
import type { Tiktoken } from 'js-tiktoken/lite';

let encoder: Tiktoken | null = null;
let encoderInitFailed = false;

function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderInitFailed) return null;
  try {
    // 使用 lite 版 + 显式 import ranks，避免触发完整 registry 的副作用加载
    const { Tiktoken: TiktokenCls } = require('js-tiktoken/lite') as typeof import('js-tiktoken/lite');
    const cl100k = require('js-tiktoken/ranks/cl100k_base') as typeof import('js-tiktoken/ranks/cl100k_base');
    encoder = new TiktokenCls(cl100k.default ?? cl100k);
    return encoder;
  } catch {
    encoderInitFailed = true;
    return null;
  }
}

/**
 * 粗略 fallback 估算（与主流 BPE tokenizer 行为对齐的近似规则）：
 * - CJK（中日韩）字符：1.5 token/char
 * - 拉丁单词：⌈len/4⌉ token
 * - 数字串：每 4 位算 1 token
 * - 标点 / 其他：1 token/char
 * - 空白：跳过
 */
function fallbackEstimate(text: string): number {
  let count = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const codePoint = text.codePointAt(i)!;
    const charSize = codePoint > 0xffff ? 2 : 1;
    const char = String.fromCodePoint(codePoint);

    // 1. 空白：跳过
    if (/\s/.test(char)) {
      i += charSize;
      continue;
    }

    // 2. CJK 统一表意文字：1.5 token/char
    if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
      count += 1.5;
      i += charSize;
      continue;
    }

    // 3. ASCII 字母：贪心匹配整个单词
    if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
        if (!isLetter) break;
        j += 1;
      }
      const wordLen = j - i;
      count += Math.ceil(wordLen / 4);
      i = j;
      continue;
    }

    // 4. 数字串：贪心匹配整段数字
    if (codePoint >= 0x30 && codePoint <= 0x39) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        if (c < 0x30 || c > 0x39) break;
        j += 1;
      }
      const digits = j - i;
      count += Math.ceil(digits / 4);
      i = j;
      continue;
    }

    // 5. ASCII 标点 / 其他字符：1 token/char
    count += 1;
    i += charSize;
  }

  return Math.ceil(count);
}

/**
 * 估算文本的 token 数量。
 *
 * - 优先使用 cl100k_base BPE 分词器（精确）
 * - encoder 初始化失败 / encode 抛错时回退到粗略估算
 * - 同步返回 number，与原有接口完全一致
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // 单次 encode 失败不污染全局状态，仅本次回退
    }
  }

  return fallbackEstimate(text);
}
