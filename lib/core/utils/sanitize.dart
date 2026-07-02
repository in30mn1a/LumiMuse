/// 清理上游响应中可能回显的敏感字段（Authorization 头、API key 片段等），
/// 防止错误消息被透传到客户端日志/前端时泄漏凭据。最终长度限制 200。
///
/// 对齐主项目 `src/lib/api-client.ts` 的 `sanitizeUpstreamError`，6 条规则
/// 顺序与原文一致：先脱敏带 Bearer 的 Authorization，再脱敏其他认证方案的
/// Authorization，再处理独立 Bearer，再 api_key/api-key/apikey，最后 sk- 前缀。
/// 截断到 200 字符与主项目 `.slice(0, 200)` 行为一致（不追加省略号）。
String sanitizeUpstreamError(String text) {
  var sanitized = text;
  // 规则1：Authorization: Bearer xxx（含 Bearer 后整段 token），i flag
  sanitized = sanitized.replaceAll(
    RegExp(
      r'Authorization\s*[:=]\s*Bearer\s+[\w.\-+/=]+',
      caseSensitive: false,
    ),
    'Authorization: Bearer [REDACTED]',
  );
  // 规则2：Authorization: 其他认证方案（Basic/Digest/纯 token 等），i flag
  // 字符类排除空白与常见分隔符（含单/双引号、方括号），保留其余作为认证值。
  sanitized = sanitized.replaceAll(
    RegExp(
      r'''Authorization\s*[:=]\s*[^\s,;"'}\]]+''',
      caseSensitive: false,
    ),
    'Authorization: [REDACTED]',
  );
  // 规则3：独立出现的 Bearer xxx，无 i flag（大小写敏感）
  sanitized = sanitized.replaceAll(
    RegExp(r'Bearer\s+[\w.\-+/=]+'),
    'Bearer [REDACTED]',
  );
  // 规则4：api_key=xxx / api-key=xxx / apikey=xxx（query string 或 JSON 风格），
  // 保留 key 名、值脱敏，i flag
  sanitized = sanitized.replaceAllMapped(
    RegExp(
      r"""(api[_-]?key)\s*[:=]\s*["']?[\w.\-+/=]+["']?""",
      caseSensitive: false,
    ),
    (Match m) => '${m.group(1)}=[REDACTED]',
  );
  // 规则5：OpenAI 风格的 sk-xxxxx，无 i flag
  sanitized = sanitized.replaceAll(
    RegExp(r'sk-[\w-]{8,}'),
    'sk-[REDACTED]',
  );
  // 规则6：最终截断到 200 字符
  return sanitized.length > 200
      ? sanitized.substring(0, 200)
      : sanitized;
}
