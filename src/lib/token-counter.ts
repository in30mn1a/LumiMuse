// 粗略 token 估算：每个中文字符约 1.5 个 token，每个拉丁词约 0.75 个 token
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) {
      count += 1.5;
    } else if (code <= 0x7f && /\s/.test(char)) {
      count += 0.25;
    } else if (code <= 0x7f) {
      count += 0.25;
    } else {
      count += 1;
    }
  }
  return Math.ceil(count);
}
