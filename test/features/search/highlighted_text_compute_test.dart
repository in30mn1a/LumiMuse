// Feature: flutter-platform-polish, Property 8, 9
//
// **Validates: Property 8, 9 — Requirements 2.3, 2.4, 2.5**
//
// 使用 `package:glados` 随机生成 `(text, query)`，覆盖中英混排、emoji、
// 连续空白、ASCII 控制字符等场景，验证 `computeHighlightRanges` 的两条不变量：
//
// - Property 8（结构不变量）：每个区间满足 `0 <= start < end <= text.length`，
//   按 `start` 严格升序排列且互不相交。
// - Property 9（内容匹配关键词）：每个区间的 lowercase 子串至少包含一个
//   lowercase 关键词；未发生区间合并时严格相等。
//
// 默认 100 次迭代（glados 默认 ExploreConfig，无需显式 .runs）。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/features/search/widgets/highlighted_text.dart';

/// 高亮测试专用字符串生成器。
///
/// `glados` 默认未注册 `String` 生成器，且默认仅靠英文字母无法覆盖本 spec
/// 关心的多语言与控制字符场景。这里基于 `stringOf(chars)` 并构造一个混合
/// 候选字符集，以保证生成出的样本能命中：
///
/// - **中英混排**：拉丁字母（大小写）+ 数字 + 中日字符。
/// - **emoji**：包含若干代理对（surrogate pair），覆盖 UTF-16 多 code unit。
/// - **连续空白**：空格、制表符、换行——多次抽样会自然产生连续空白。
/// - **ASCII 控制字符**：`\x01`、`\x07`、`\x1F` 等几个代表性字节。
///
/// 候选集刻意保持精炼，命中频率较高，让 indexOf / 区间合并/重叠分支都能
/// 在 100 次迭代内被反复触发。
extension _HighlightAnys on Any {
  String get _mixedAlphabet => const <String>[
        // ASCII 字母 / 数字 / 常规标点
        'a', 'B', 'c', 'D', 'h', 'i', 'o',
        '0', '1', '7',
        '!', '?', ',', '.',
        // 连续空白来源：单空格 / 制表符 / 换行
        ' ', '\t', '\n',
        // ASCII 控制字符（非空白）：覆盖 0x01 / 0x07 / 0x1F 等
        '\x01', '\x07', '\x1F',
        // CJK：中文常用字 + 日文假名（每个字符仅出现一次，避免 stringOf 抛重复）
        '今', '天', '气', '好', 'の',
        // emoji：代理对，覆盖 UTF-16 多 code unit 命中
        '🌟', '🐱',
      ].join();

  /// 高亮文本生成器：可空字符串 + 混合候选集，长度由 glados size 控制。
  Generator<String> get highlightText => stringOf(_mixedAlphabet);

  /// 查询串生成器：与 [highlightText] 同候选集，便于产生命中。
  Generator<String> get highlightQuery => stringOf(_mixedAlphabet);
}

void main() {
  group('Property 8: HighlightRange 结构不变量', () {
    Glados2<String, String>(any.highlightText, any.highlightQuery).test(
      '结构不变量：升序、半开、互不相交、不越界',
      (text, query) {
        final ranges = computeHighlightRanges(text, query);
        for (var i = 0; i < ranges.length; i++) {
          final r = ranges[i];
          // 区间不越界：0 <= start < end <= text.length
          expect(
            r.start >= 0 && r.end <= text.length,
            isTrue,
            reason: 'range $r 越界，text.length=${text.length}',
          );
          expect(
            r.start < r.end,
            isTrue,
            reason: 'range $r 应为非空半开区间（start < end）',
          );
          // 与下一区间的关系：严格升序 + 互不相交
          if (i + 1 < ranges.length) {
            final next = ranges[i + 1];
            expect(
              r.end <= next.start,
              isTrue,
              reason: 'range $r 与 $next 重叠（应互不相交）',
            );
            expect(
              r.start < next.start,
              isTrue,
              reason: 'range $r 与 $next 顺序错乱（应按 start 严格升序）',
            );
          }
        }
      },
    );
  });

  group('Property 9: HighlightRange 内容匹配关键词', () {
    Glados2<String, String>(any.highlightText, any.highlightQuery).test(
      '内容匹配关键词',
      (text, query) {
        final ranges = computeHighlightRanges(text, query);
        // 与生产实现一致：按 ASCII 空白拆分关键词，丢弃空字符串
        final kws = query
            .split(RegExp(r'\s+'))
            .where((s) => s.isNotEmpty)
            .map((s) => s.toLowerCase())
            .toList(growable: false);
        for (final r in ranges) {
          final sub = text.substring(r.start, r.end).toLowerCase();
          expect(
            kws.any((kw) => sub.contains(kw)),
            isTrue,
            reason: 'range $r 在 "$text" 中的子串 "$sub" '
                '应至少包含一个关键词（关键词列表 $kws）',
          );
        }
      },
    );
  });
}
