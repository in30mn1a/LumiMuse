/**
 * 流式响应把思考链按增量逐段给出（`reasoning_details` 每段只有几个字），原样保存时一次回复能有
 * 上千个对象，每个都带完整的 type/format/index 外壳：存储和回传体积都被放大，本地 token 估算也被
 * 外壳拖高数倍。这里把属于同一块的连续文本段拼回一条，等同于按 index 累积流式增量。
 *
 * 只合并能确定属于同一块的段：都是 `reasoning.text`、format 与 index 相同、id 不冲突，
 * 且前一段还没带签名（签名出现在一块的末尾）。带有其它字段的段原样保留，不跨过它合并。
 */
const MERGEABLE_KEYS = new Set(['type', 'text', 'format', 'index', 'signature', 'id']);

type ReasoningPart = Record<string, unknown>;

function isMergeableText(part: unknown): part is ReasoningPart & { text: string } {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
  const record = part as ReasoningPart;
  return record.type === 'reasoning.text'
    && typeof record.text === 'string'
    && Object.keys(record).every(key => MERGEABLE_KEYS.has(key));
}

function sameBlock(previous: ReasoningPart, next: ReasoningPart): boolean {
  if (previous.signature !== undefined && previous.signature !== null) return false;
  if (previous.format !== next.format || previous.index !== next.index) return false;
  const previousId = previous.id ?? null;
  const nextId = next.id ?? null;
  return previousId === null || nextId === null || previousId === nextId;
}

export function mergeReasoningDetails(details: readonly unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const part of details) {
    const previous = merged[merged.length - 1];
    if (isMergeableText(part) && isMergeableText(previous) && sameBlock(previous, part)) {
      const combined: ReasoningPart = { ...previous, text: previous.text + part.text };
      for (const [key, value] of Object.entries(part)) {
        if (key !== 'text' && value !== undefined && value !== null) combined[key] = value;
      }
      merged[merged.length - 1] = combined;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/** 其余字段原样保留；没有可合并的思考段时返回原对象。 */
export function compactAssistantFields(fields: Record<string, unknown>): Record<string, unknown> {
  const details = fields.reasoning_details;
  if (!Array.isArray(details)) return fields;
  const merged = mergeReasoningDetails(details);
  return merged.length === details.length ? fields : { ...fields, reasoning_details: merged };
}
