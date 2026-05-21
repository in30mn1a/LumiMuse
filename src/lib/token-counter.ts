// 粗略 token 估算
// 估算依据（与主流 BPE tokenizer 行为对齐的近似规则）：
// - CJK（中日韩）字符：1.5 token/char（一个汉字常被拆成多个 byte 级 token）
// - 拉丁单词：约 1 token/词（英文 BPE 大致每个常见词一个 token，原先 0.25 严重低估）
// - 标点符号：单独算 1 token
// - 数字串：每 4 位算 1 token（数字常被合并为短 token）
// - 其他（如全角符号、emoji 等）：1 token/char
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  let i = 0;
  const len = text.length;

  // 用码点遍历以正确处理代理对（Array.from 也可，但显式索引更高效）
  while (i < len) {
    const codePoint = text.codePointAt(i)!;
    const charSize = codePoint > 0xffff ? 2 : 1;
    const char = String.fromCodePoint(codePoint);

    // 1. 空白：跳过（不计入；它们更多用于分词边界）
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

    // 3. ASCII 字母：贪心匹配整个单词，按词计 1 token
    if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
        if (!isLetter) break;
        j += 1;
      }
      count += 1;
      i = j;
      continue;
    }

    // 4. 数字串：贪心匹配整段数字，每 4 位算 1 token（不足 4 位也算 1 token）
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
