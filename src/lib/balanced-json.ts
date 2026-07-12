export type JsonRootKind = 'object' | 'array' | 'either';

export function extractBalancedJsonAt(text: string, startIndex: number): string | null {
  const opener = text[startIndex];
  if (opener !== '{' && opener !== '[') return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;

    const expectedOpener = char === '}' ? '{' : '[';
    if (stack.at(-1) !== expectedOpener) return null;
    stack.pop();
    if (stack.length === 0) return text.slice(startIndex, index + 1);
  }

  return null;
}

export function findFirstBalancedJson(
  text: string,
  rootKind: JsonRootKind = 'either',
  fromIndex = 0,
): string | null {
  for (let index = Math.max(0, fromIndex); index < text.length; index += 1) {
    const char = text[index];
    const allowed = rootKind === 'either'
      ? char === '{' || char === '['
      : rootKind === 'object'
        ? char === '{'
        : char === '[';
    if (!allowed) continue;
    const snippet = extractBalancedJsonAt(text, index);
    if (snippet) return snippet;
  }
  return null;
}
