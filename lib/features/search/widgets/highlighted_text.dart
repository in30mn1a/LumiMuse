import 'package:flutter/material.dart';

import '../../../theme/app_theme.dart';

/// 搜索结果命中文本的高亮区间，半开区间 `[start, end)`。
///
/// 区间索引基于 Dart 字符串的 UTF-16 code unit 偏移，与 `String.substring`
/// 直接兼容；不再做 BMP 合并，调用方按需自行处理 emoji 等组合字符。
class HighlightRange {
  final int start;
  final int end;

  const HighlightRange(this.start, this.end);

  @override
  bool operator ==(Object other) =>
      other is HighlightRange && other.start == start && other.end == end;

  @override
  int get hashCode => Object.hash(start, end);

  @override
  String toString() => 'HighlightRange($start, $end)';
}

/// 计算 [text] 中所有需要高亮的字符区间。
///
/// 用于支撑搜索结果 snippet 的关键词高亮渲染，与 Node.js 主项目
/// `src/components/sidebar/Sidebar.tsx` 把命中关键字加粗变色的视觉行为对齐，
/// 但不引入正则匹配语义，避免特殊字符注入与中文分词歧义。
///
/// 算法：
/// 1. 按 ASCII 空白拆分 [query] 为关键词列表，丢弃空字符串
/// 2. 全部转小写后，对 [text].toLowerCase() 顺次 indexOf 扫描
/// 3. 收集所有命中区间，按 start 升序排序
/// 4. 合并相邻 / 重叠区间，使输出半开区间互不相交且严格升序
///
/// 边界：
/// - [text] 空 / [query] 空 / 关键词全部为空白 → 返回空列表
/// - 单个关键词长度为 0（理论不会发生，因为 split 会过滤）→ 跳过
List<HighlightRange> computeHighlightRanges(String text, String query) {
  if (text.isEmpty) return const [];
  final keywords = query
      .split(RegExp(r'\s+'))
      .where((s) => s.isNotEmpty)
      .map((s) => s.toLowerCase())
      .toList(growable: false);
  if (keywords.isEmpty) return const [];

  final lowerText = text.toLowerCase();
  final raw = <HighlightRange>[];
  for (final kw in keywords) {
    if (kw.isEmpty) continue;
    var from = 0;
    while (from <= lowerText.length - kw.length) {
      final i = lowerText.indexOf(kw, from);
      if (i < 0) break;
      raw.add(HighlightRange(i, i + kw.length));
      from = i + kw.length; // 不允许同一关键词区间重叠
    }
  }
  if (raw.isEmpty) return const [];
  raw.sort((a, b) {
    final c = a.start.compareTo(b.start);
    return c != 0 ? c : a.end.compareTo(b.end);
  });

  // 合并相邻 / 重叠区间
  final merged = <HighlightRange>[];
  var curStart = raw.first.start;
  var curEnd = raw.first.end;
  for (var i = 1; i < raw.length; i++) {
    final r = raw[i];
    if (r.start <= curEnd) {
      if (r.end > curEnd) curEnd = r.end;
    } else {
      merged.add(HighlightRange(curStart, curEnd));
      curStart = r.start;
      curEnd = r.end;
    }
  }
  merged.add(HighlightRange(curStart, curEnd));
  return merged;
}

/// 搜索结果命中关键字的高亮文本 widget。
///
/// 使用 [computeHighlightRanges] 计算 [text] 中所有需要高亮的字符区间，
/// 用 `Text.rich` 渲染。可选 [prefix] 在文本前以 [prefixStyle] 渲染（前缀
/// 永不参与高亮）。
///
/// 边界：
/// - [text] 为空字符串、[query] 为空 / 仅空白时仍正常渲染，不抛异常。
class HighlightedText extends StatelessWidget {
  /// 待渲染的原始文本（搜索结果 snippet）。
  final String text;

  /// 关键词输入（搜索框内容）。空 / 全空白时退化为单段普通文本。
  final String query;

  /// 文本基础样式（继承当前主题色为默认值）。
  final TextStyle? baseStyle;

  /// 可选前缀（永不参与高亮）。
  final String? prefix;

  /// 前缀样式（默认与 [baseStyle] 一致）。
  final TextStyle? prefixStyle;

  /// 最大行数（默认 null = 不限）
  final int? maxLines;

  /// 溢出策略（默认 [TextOverflow.ellipsis]）
  final TextOverflow? overflow;

  const HighlightedText({
    super.key,
    required this.text,
    required this.query,
    this.baseStyle,
    this.prefix,
    this.prefixStyle,
    this.maxLines,
    this.overflow,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final base = baseStyle ?? const TextStyle(fontSize: 13);
    final prefStyle = prefixStyle ?? base;

    final highlightStyle = base.copyWith(
      color: isDark ? AppTheme.darkAccent : AppTheme.accent,
      fontWeight: FontWeight.w600,
    );

    final ranges = computeHighlightRanges(text, query);

    final spans = <InlineSpan>[];
    if (prefix != null && prefix!.isNotEmpty) {
      spans.add(TextSpan(text: prefix, style: prefStyle));
    }
    if (ranges.isEmpty) {
      spans.add(TextSpan(text: text, style: base));
    } else {
      var cursor = 0;
      for (final r in ranges) {
        if (r.start > cursor) {
          spans.add(
            TextSpan(text: text.substring(cursor, r.start), style: base),
          );
        }
        spans.add(
          TextSpan(
            text: text.substring(r.start, r.end),
            style: highlightStyle,
          ),
        );
        cursor = r.end;
      }
      if (cursor < text.length) {
        spans.add(TextSpan(text: text.substring(cursor), style: base));
      }
    }

    return Text.rich(
      TextSpan(children: spans, style: base),
      maxLines: maxLines,
      overflow: overflow ?? TextOverflow.ellipsis,
    );
  }
}
