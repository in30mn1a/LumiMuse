// 上游错误脱敏不变量测试
// 对齐主项目 `src/lib/api-client.ts` 的 `sanitizeUpstreamError` 6 条规则。
// 覆盖：Authorization Bearer/其他方案、独立 Bearer、api_key/api-key/apikey、
// sk- 前缀、正常错误文本语义保留、超 200 字符截断。

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/utils/sanitize.dart';

void main() {
  group('sanitizeUpstreamError', () {
    // ── 规则1：Authorization: Bearer xxx ──
    // 注意：主项目规则顺序下，规则1 先把 `Authorization: Bearer xxx` 替换为
    // `Authorization: Bearer [REDACTED]`，规则2 紧接着又匹配其中 `Authorization:
    // Bearer`（Bearer 被当作其他认证方案值）再替换为 `Authorization: [REDACTED]`。
    // 因此最终 Bearer 标记不保留，这与主项目串联行为一致。
    test('Authorization: Bearer 整段脱敏（Bearer 标记被规则2兜底吃掉）', () {
      const input = 'Authorization: Bearer sk-abcdef123456 回显';
      final out = sanitizeUpstreamError(input);
      // 规则1 → `Authorization: Bearer [REDACTED] 回显`，
      // 规则2 再匹配 `Authorization: Bearer` → `Authorization: [REDACTED]`，
      // 最终 token 段与 Bearer 标记都被脱敏。
      expect(out, equals('Authorization: [REDACTED] [REDACTED] 回显'));
      // 确保原始 token 与 Bearer 标记都不再出现
      expect(out.contains('sk-abcdef123456'), isFalse);
      expect(out.contains('Bearer'), isFalse);
    });

    test('authorization=Bearer xxx 大小写不敏感（i flag）', () {
      const input = 'authorization=Bearer tok.abc-def_ghi';
      final out = sanitizeUpstreamError(input);
      // 规则1 替换为 `Authorization: Bearer [REDACTED]`，规则2 再兜底吃掉 Bearer
      expect(out, equals('Authorization: [REDACTED] [REDACTED]'));
    });

    // ── 规则2：Authorization 其他认证方案 ──
    // 规则2 字符类 `[^\s,;"'}\]]+` 遇空白即停，因此 `Authorization: Basic dXNlcjpwYXNz`
    // 只脱敏 `Basic` 这个词，token `dXNlcjpwYXNz` 仍保留（与主项目一致）。
    test('Authorization: Basic xxx 其他方案脱敏（到空白边界）', () {
      const input = 'Authorization: Basic dXNlcjpwYXNz';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('Authorization: [REDACTED] dXNlcjpwYXNz'));
    });

    test('Authorization 用 = 紧跟引号不脱敏（引号被字符类排除）', () {
      // 规则2 字符类排除单引号，`=` 后立即 `'` 导致量词 `+` 匹配空、整体不匹配，
      // 与主项目行为一致：这种写法原样保留。
      const input = "Authorization='rawtoken123'";
      final out = sanitizeUpstreamError(input);
      expect(out, equals("Authorization='rawtoken123'"));
    });

    // ── 规则3：独立 Bearer xxx（大小写敏感）──
    test('独立 Bearer abc.def-ghi 脱敏', () {
      const input = '错误：Bearer abc.def-ghi 泄漏';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('错误：Bearer [REDACTED] 泄漏'));
    });

    test('独立 bearer 小写不被规则3脱敏（无 i flag）', () {
      // 规则3 大小写敏感，bearer 不匹配；但若前面无 Authorization，规则1/2 也不命中
      const input = 'bearer abc.def-ghi';
      final out = sanitizeUpstreamError(input);
      // 大小写敏感：规则3 不匹配 'bearer'，原样保留
      expect(out, equals('bearer abc.def-ghi'));
    });

    // ── 规则4：api_key / api-key / apikey ──
    test('api_key=xxx 脱敏（保留 key 名）', () {
      const input = 'api_key=sk-secretvalue123';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('api_key=[REDACTED]'));
    });

    test('api-key="xxx" 带引号脱敏（保留 key 名）', () {
      const input = 'api-key="mytoken-abc_def.ghi"';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('api-key=[REDACTED]'));
    });

    test('apikey:xxx 冒号分隔脱敏（保留 key 名）', () {
      const input = 'apikey:mytoken123';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('apikey=[REDACTED]'));
    });

    test('API_KEY 大写大小写不敏感（i flag）', () {
      const input = 'API_KEY=mysecrettoken';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('API_KEY=[REDACTED]'));
    });

    // ── 规则5：sk-xxxxx ──
    test('sk-abcdefgh12345（≥8 字符后缀）脱敏', () {
      const input = '错误 sk-abcdefgh12345 泄漏';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('错误 sk-[REDACTED] 泄漏'));
    });

    test('sk-短串（<8 字符）不脱敏', () {
      // sk- 后不足 8 个 [\w-] 字符不匹配规则5
      const input = 'sk-abcd';
      final out = sanitizeUpstreamError(input);
      expect(out, equals('sk-abcd'));
    });

    // ── 规则6：200 字符截断 ──
    test('超 200 字符截断到 200（不追加省略号）', () {
      final input = 'A' * 250;
      final out = sanitizeUpstreamError(input);
      expect(out.length, equals(200));
      expect(out, equals('A' * 200));
    });

    test('恰好 200 字符不截断', () {
      final input = 'B' * 200;
      final out = sanitizeUpstreamError(input);
      expect(out.length, equals(200));
      expect(out, equals(input));
    });

    // ── 正常不含敏感串的错误文本语义保留 ──
    test('正常错误文本语义保留', () {
      const input = 'Connection refused: server at 192.168.1.1 unreachable';
      final out = sanitizeUpstreamError(input);
      expect(out, equals(input));
    });

    test('空字符串原样返回', () {
      expect(sanitizeUpstreamError(''), equals(''));
    });

    // ── 综合场景 ──
    test('多敏感字段同时出现全部脱敏', () {
      const input =
          'Authorization: Bearer sk-leak12345678 api_key=othertoken9876';
      final out = sanitizeUpstreamError(input);
      expect(out.contains('sk-leak12345678'), isFalse);
      expect(out.contains('othertoken9876'), isFalse);
      expect(out.contains('[REDACTED]'), isTrue);
    });
  });
}
