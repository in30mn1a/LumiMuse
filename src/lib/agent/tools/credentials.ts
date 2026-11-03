import type { AgentToolContext, AgentToolResult } from './types';

/**
 * 工具结果的凭据脱敏（第二道防线）。
 *
 * 第一道防线是结构上的：工具只读白名单列，从不查询 api_providers、settings。
 * 但主人可能把密钥贴进过聊天、记忆或角色卡，原样返回就等于把凭据交给了模型。
 * 所以每次返回前，把结果里出现的已知凭据值整段替换掉。
 */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** 设置里以这些后缀结尾的字段视为凭据（api_key、nai_api_key、embedding_api_key 等）。 */
const CREDENTIAL_FIELD = /(?:api_key|secret|password)$/i;

function collectFromValue(value: unknown, fieldName: string, add: (candidate: unknown) => void): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_FIELD.test(fieldName)) add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, fieldName, add);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) collectFromValue(nested, key, add);
  }
}

/** 读取当前全部已知凭据值，按长度降序（长的先替换，避免互相包含时漏掉一截）。 */
export function collectCredentialValues(ctx: AgentToolContext): string[] {
  const found = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate === 'string' && candidate.length > 0) {
      found.add(candidate);
    }
  };

  const providers = ctx.db.prepare('SELECT api_key FROM api_providers').all() as Array<{ api_key: unknown }>;
  for (const row of providers) add(row.api_key);

  const settingRows = ctx.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  for (const row of settingRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    collectFromValue(parsed, row.key, add);
  }

  collectFromValue(ctx.settings, '', add);
  add(process.env.ACCESS_PASSWORD);
  add(process.env.AUTH_SECRET);

  return [...found].sort((a, b) => b.length - a.length);
}

function redactText(value: string, credentials: readonly string[]): string {
  // 短凭据可能与占位符重合；这种情况下直接移除命中，不能通过占位符重新泄漏。
  const replacement = credentials.some(credential => REDACTED_PLACEHOLDER.includes(credential))
    ? ''
    : REDACTED_PLACEHOLDER;
  let output = value;
  for (const credential of credentials) {
    if (output.includes(credential)) output = output.split(credential).join(replacement);
  }
  // 移除内容可能把相邻片段拼成另一条凭据，无法保全时由工具外壳统一拒绝结果。
  if (credentials.some(credential => output.includes(credential))) {
    throw new Error('文本脱敏后仍包含已知凭据');
  }
  return output;
}

function redactValue(value: unknown, credentials: readonly string[], redactKeys = true): unknown {
  if (typeof value === 'string') return redactText(value, credentials);
  if (Array.isArray(value)) return value.map(item => redactValue(item, credentials));
  if (value && typeof value === 'object') {
    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    for (const [key, nested] of Object.entries(value)) {
      const outputKey = redactKeys ? redactText(key, credentials) : key;
      if (keys.has(outputKey)) throw new Error('数据键脱敏后发生冲突');
      keys.add(outputKey);
      entries.push([outputKey, redactValue(nested, credentials)]);
    }
    // fromEntries 将 __proto__ 等名称创建为自有数据属性，不触发原型 setter。
    return Object.fromEntries(entries);
  }
  return value;
}

export function redactCredentials(ctx: AgentToolContext, result: AgentToolResult): AgentToolResult {
  const credentials = collectCredentialValues(ctx);
  if (credentials.length === 0) return result;
  // 根层是固定工具协议（ok、error、memories 等）；嵌套数据对象的键和值均需脱敏。
  return redactValue(result, credentials, false) as AgentToolResult;
}
