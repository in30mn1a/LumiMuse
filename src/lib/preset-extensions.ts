function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 重建条目 ID 后同步插件关联；LogUpload 不移植，任何导入路径都不恢复它。 */
export function remapPresetExtensions(
  raw: unknown,
  entryIdMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const source = asRecord(raw);
  if (!source) return {};

  const remapKeys = (value: unknown): unknown => {
    const record = asRecord(value);
    return record
      ? Object.fromEntries(Object.entries(record).map(([key, entry]) => [entryIdMap.get(key) ?? key, entry]))
      : value;
  };

  const extensions: Record<string, unknown> = { ...source };
  const spreset = asRecord(source.SPreset);
  if (spreset) {
    const nextSpreset: Record<string, unknown> = { ...spreset };
    delete nextSpreset.LogUpload;
    if (Object.hasOwn(nextSpreset, 'ToolBindings')) {
      nextSpreset.ToolBindings = remapKeys(nextSpreset.ToolBindings);
    }
    if (Object.hasOwn(nextSpreset, 'MessageInjections')) {
      nextSpreset.MessageInjections = remapKeys(nextSpreset.MessageInjections);
    }
    extensions.SPreset = nextSpreset;
  }
  return extensions;
}
