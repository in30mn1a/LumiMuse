export interface TextDiff {
  prefix: string;
  removed: string;
  added: string;
  suffix: string;
}

/**
 * 去掉公共前缀和后缀，中间就是改动。够看清一处修改，不追求最小编辑距离。
 * 按码点切分，避免把 emoji 等代理对拆成两半。
 */
export function diffText(before: string, after: string): TextDiff {
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return {
    prefix: a.slice(0, start).join(''),
    removed: a.slice(start, a.length - end).join(''),
    added: b.slice(start, b.length - end).join(''),
    suffix: a.slice(a.length - end).join(''),
  };
}
