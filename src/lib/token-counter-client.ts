export function estimateClientTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const codePoint = text.codePointAt(i)!;
    const charSize = codePoint > 0xffff ? 2 : 1;
    const char = String.fromCodePoint(codePoint);

    if (/\s/.test(char)) {
      i += charSize;
      continue;
    }

    if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
      count += 1.5;
      i += charSize;
      continue;
    }

    if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
        if (!isLetter) break;
        j += 1;
      }
      count += Math.ceil((j - i) / 4);
      i = j;
      continue;
    }

    if (codePoint >= 0x30 && codePoint <= 0x39) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        if (c < 0x30 || c > 0x39) break;
        j += 1;
      }
      count += Math.ceil((j - i) / 4);
      i = j;
      continue;
    }

    count += 1;
    i += charSize;
  }

  return Math.ceil(count);
}
