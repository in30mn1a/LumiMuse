/** 聊天框模型列表的置顶：全局一份模型名列表，跨供应商共用，不在当前列表里的条目不显示。 */

export function sanitizePinnedModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((model): model is string => typeof model === 'string' && model.trim() !== ''))];
}

export function togglePinnedModel(pinned: readonly string[], model: string): string[] {
  return pinned.includes(model) ? pinned.filter(item => item !== model) : [...pinned, model];
}

/** 置顶的排在前面；两组内部都保持上游返回的原顺序，切换置顶时其他模型不会乱跳。 */
export function sortModelsByPinned(models: readonly string[], pinned: readonly string[]): string[] {
  if (pinned.length === 0) return [...models];
  const pinnedSet = new Set(pinned);
  return [...models.filter(model => pinnedSet.has(model)), ...models.filter(model => !pinnedSet.has(model))];
}
