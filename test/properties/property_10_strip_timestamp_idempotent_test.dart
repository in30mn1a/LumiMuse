// Feature: flutter-pixel-perfect-parity, Property 10: stripTimestampPrefix 幂等性
// Validates: Requirements B6.4 (INV-4)
//
// 设计说明
// ────────
// design.md §6 与 INV-4 要求：对任意字符串 x，
//   stripTimestampPrefix(stripTimestampPrefix(x)) == stripTimestampPrefix(x)。
//
// 该不变量保证：无论历史消息或 AI 回复经过多少次时间戳剥离，结果都收敛到一个
// 不动点（fixed point），不会因为多次清洗而误吞正文内容。
//
// 实现状态：`stripTimestampPrefix` 已落在
// `lumimuse_flutter/lib/core/utils/time_context_builder.dart`，本测试直接 import
// 该实现，避免重复占位实现。
//
// 生成器策略
// ──────────
// 为了「对任意字符串成立」这条全称量词被高概率覆盖，本测试自定义一个
// `mixedFuzzyString` 生成器，混合以下四类输入（等概率抽样）：
//   - 类 A：空字符串（对齐 15.6 边界）。
//   - 类 B：纯随机字符（中英文 + 标点 + ASCII 空白），可能不含合法时间戳。
//   - 类 C：合法时间戳前缀 + 随机后缀（高概率命中 strip 分支）。
//   - 类 D：含 `[` / `]` / 数字 / 分隔符的"半破损"前缀（命中正则失败分支，
//     验证不合法前缀也满足幂等）。
//
// 100 次 runs（与 tasks.md §5.10 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/utils/time_context_builder.dart';

// ──────────────────────────────────────────────────────────────────────────
// 生成器：mixedFuzzyString
//
// 用 seed 构造确定性 Random，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  /// 生成一个用于幂等性测试的"任意字符串"，混合空串 / 纯文本 /
  /// 合法时间戳前缀 / 半破损前缀四种类别。
  Generator<String> get mixedFuzzyString {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final kind = rng.nextInt(4); // 0=空 1=纯文本 2=合法前缀 3=半破损前缀
      switch (kind) {
        case 0:
          return '';
        case 1:
          return _randomPlainText(rng);
        case 2:
          return _randomTimestampedText(rng);
        case 3:
        default:
          return _randomBrokenPrefixText(rng);
      }
    });
  }
}

/// 类 B：纯随机文本（中英文 + 标点 + ASCII 空白），不刻意构造时间戳。
String _randomPlainText(math.Random rng) {
  const pool = [
    '你', '好', '呀', '世', '界', '今', '天', '不', '错',
    'a', 'b', 'c', 'X', 'Y', 'Z',
    '0', '1', '2', '7', '9',
    ' ', '\t', '\n',
    '.', ',', '!', '?', '。', '，',
    '-', '/', ':', ']', '[',
  ];
  final len = rng.nextInt(20);
  if (len == 0) return '';
  return List.generate(len, (_) => pool[rng.nextInt(pool.length)]).join();
}

/// 类 C：合法时间戳前缀（与 `_timestampPrefixPattern` 对齐）+ 随机后缀。
///
/// 与 TimeContextBuilder 中正则
/// `^\s*\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*` 等价构造。
String _randomTimestampedText(math.Random rng) {
  // 0–3 个 ASCII 前导空白。
  const wsPool = [' ', '\t', '\n', '\r'];
  final wsLen = rng.nextInt(4);
  final whitespace = List.generate(
    wsLen,
    (_) => wsPool[rng.nextInt(wsPool.length)],
  ).join();

  final year = 1000 + rng.nextInt(9000);
  final month = 1 + rng.nextInt(12);
  final day = 1 + rng.nextInt(28);
  final hour = rng.nextInt(24);
  final minute = rng.nextInt(60);
  final useSlash = rng.nextBool();
  final hasSec = rng.nextBool();
  final sep = useSlash ? '/' : '-';

  String oneOrTwoDigits(int n) {
    if (n >= 10) return '$n';
    return rng.nextBool() ? '$n' : n.toString().padLeft(2, '0');
  }

  final mm = minute.toString().padLeft(2, '0');
  final base =
      '[$year$sep${oneOrTwoDigits(month)}$sep${oneOrTwoDigits(day)} ${oneOrTwoDigits(hour)}:$mm';
  final timestamp = hasSec
      ? '$base:${rng.nextInt(60).toString().padLeft(2, '0')}]'
      : '$base]';

  final suffix = _randomPlainText(rng);
  return '$whitespace$timestamp$suffix';
}

/// 类 D：含 `[` / `]` / 数字 / 分隔符的"半破损"前缀，
/// 多数会落在正则失败分支，用以覆盖原样返回路径的幂等性。
String _randomBrokenPrefixText(math.Random rng) {
  const pieces = [
    '[', ']', '2026', '5', '16', '14', '30', '-', '/', ':', ' ',
    '你好', 'hello', ']剩余', '[半破损', '2026-5-', '14:', '[2026-05-16]',
  ];
  final len = 1 + rng.nextInt(6);
  return List.generate(len, (_) => pieces[rng.nextInt(pieces.length)]).join();
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 10: stripTimestampPrefix 幂等性', () {
    Glados<String>(
      any.mixedFuzzyString,
      ExploreConfig(numRuns: 100),
    ).test(
      '对任意字符串 x：stripTimestampPrefix(stripTimestampPrefix(x)) == stripTimestampPrefix(x)',
      (input) {
        final once = TimeContextBuilder.stripTimestampPrefix(input);
        final twice = TimeContextBuilder.stripTimestampPrefix(once);
        expect(
          twice,
          once,
          reason:
              'INV-4 违反：两次剥离结果应相同。\n'
              '  输入 = ${_debugQuote(input)}\n'
              '  一次 = ${_debugQuote(once)}\n'
              '  二次 = ${_debugQuote(twice)}',
        );
      },
    );
  });
}

/// 用于失败提示的可读化打印，避免输出中包含原始换行 / 制表符破坏报告布局。
String _debugQuote(String s) {
  final escaped = s
      .replaceAll('\\', r'\\')
      .replaceAll('\n', r'\n')
      .replaceAll('\r', r'\r')
      .replaceAll('\t', r'\t');
  return '"$escaped"';
}
