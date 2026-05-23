// Feature: flutter-parity-completion, Property 25: stripTimestampPrefix 不变量
// **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6**
//
// 通过 `package:glados` 生成 `(W, T, suffix)` 三元组覆盖以下不变量：
// - 15.1 正则与 Node.js 端等价：`^\s*\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*`。
// - 15.2 / 15.3 / 15.4 多种时间戳格式（`-` / `/` 分隔、可选秒数、不定位数月/日/时）均被剥离。
// - 15.5 仅剥离 ASCII 前导空白与时间戳前缀，suffix 内的非 ASCII 字符（如全角空格）原样保留。
// - 15.6 不合法前缀输入原样返回。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。
// suffix 限制为不含 `[` 字符，避免后续片段被误识别为另一个时间戳前缀。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/utils/time_context_builder.dart';

import '../../_helpers/generators.dart';

void main() {
  group('Property 25: stripTimestampPrefix 不变量', () {
    Glados3<String, String, String>(
      any.asciiLeadingWhitespace,
      any.validTimestampLiteral,
      any.suffixWithoutBracket,
    ).test(
      '剥离合法前缀后剩余 suffix（15.1–15.5）',
      (whitespace, timestamp, suffix) {
        final input = '$whitespace$timestamp$suffix';
        final result = TimeContextBuilder.stripTimestampPrefix(input);
        expect(result, suffix);
      },
    );

    Glados3<String, String, String>(
      any.asciiLeadingWhitespace,
      any.validTimestampLiteral,
      any.suffixWithoutBracket,
    ).test(
      '幂等：再次调用结果不变（15.1）',
      (whitespace, timestamp, suffix) {
        final input = '$whitespace$timestamp$suffix';
        final once = TimeContextBuilder.stripTimestampPrefix(input);
        final twice = TimeContextBuilder.stripTimestampPrefix(once);
        expect(twice, once);
      },
    );

    Glados<String>(any.suffixWithoutBracket).test(
      '不含合法时间戳前缀的输入原样返回（15.6）',
      (suffix) {
        // suffix 已被生成器约束为不含 `[`，因此整段都不会匹配前缀正则。
        final result = TimeContextBuilder.stripTimestampPrefix(suffix);
        expect(result, suffix);
      },
    );

    // ─────────────────────────────────────────────
    // 例测：显式覆盖 acceptance criteria 的关键样本，
    // 与属性测试形成双层保护。
    // ─────────────────────────────────────────────

    test('15.2 [YYYY-MM-DD HH:mm] hello → hello', () {
      const input = '[2026-05-16 14:30] hello';
      expect(TimeContextBuilder.stripTimestampPrefix(input), 'hello');
    });

    test('15.3 [YYYY/M/D H:mm] hello → hello（不定位数月/日/时）', () {
      const input = '[2026/5/6 9:05] hello';
      expect(TimeContextBuilder.stripTimestampPrefix(input), 'hello');
    });

    test('15.4 [YYYY-MM-DD HH:mm:ss] hello → hello（带秒）', () {
      const input = '[2026-05-16 14:30:25] hello';
      expect(TimeContextBuilder.stripTimestampPrefix(input), 'hello');
    });

    test('15.5 仅剥离 ASCII 前导空白与时间戳前缀，正文非 ASCII 字符（如中文）原样保留', () {
      // ASCII 前导空白被剥离；正文中的中文、标点等非 ASCII 字符不被吞掉。
      const input = '  [2026-05-16 14:30] 你好';
      expect(TimeContextBuilder.stripTimestampPrefix(input), '你好');
    });

    test('15.6 不合法前缀（缺少时间部分）原样返回', () {
      const input = '[2026-05-16] 你好';
      expect(TimeContextBuilder.stripTimestampPrefix(input), input);
    });
  });
}
