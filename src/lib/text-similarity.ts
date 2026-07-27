/**
 * 纯文本相似度工具（无 DB 依赖）。
 * 从 memory-engine 抽出，供提取 supersede、AI 整理聚类等复用。
 */

/** Bigram Jaccard 相似度（去空白、小写）。 */
export function contentSimilarity(a: string, b: string): number {
  const left = a.replace(/\s+/g, '').toLowerCase();
  const right = b.replace(/\s+/g, '').toLowerCase();
  if (!left || !right) return 0;

  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < left.length - 1; i += 1) bigramsA.add(left[i] + left[i + 1]);
  for (let i = 0; i < right.length - 1; i += 1) bigramsB.add(right[i] + right[i + 1]);

  const intersectionSize = [...bigramsA].filter(item => bigramsB.has(item)).length;
  const unionSize = new Set([...bigramsA, ...bigramsB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * supersede / 聚类用的文本相似度：Jaccard 与「较短方包含度」取 max。
 * 短文本（较短方 < 20 字）不做包含度加成，避免误并。
 */
export function supersedeTextSimilarity(a: string, b: string): number {
  const left = a.replace(/\s+/g, '').toLowerCase();
  const right = b.replace(/\s+/g, '').toLowerCase();
  if (left.length < 2 || right.length < 2) return contentSimilarity(a, b);
  const shorterLength = Math.min(left.length, right.length);

  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < left.length - 1; i += 1) bigramsA.add(left[i] + left[i + 1]);
  for (let i = 0; i < right.length - 1; i += 1) bigramsB.add(right[i] + right[i + 1]);

  const intersectionSize = [...bigramsA].filter(item => bigramsB.has(item)).length;
  const smallerSize = Math.min(bigramsA.size, bigramsB.size);
  const containmentSimilarity = smallerSize === 0 || shorterLength < 20 ? 0 : intersectionSize / smallerSize;
  return Math.max(contentSimilarity(a, b), containmentSimilarity);
}
