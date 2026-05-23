// Feature: flutter-platform-polish, Property 7, 10
//
// **Validates: Property 7, 10 — Requirements 2.1, 2.2, 2.6, 2.7, 2.11, 2.12, 2.13, 2.14**
//
// 覆盖 [HighlightedText] widget 的两条不变量与三条显式例测：
//
// - Property 7（字符序列保持不变）：任意 `(text, query, prefix)` 下，
//   底层 RichText 中所有 TextSpan.text 按渲染顺序拼接的结果恒等于
//   `(prefix ?? '') + text`，覆盖 query 为空 / text 为空两个特例。
// - Property 10（渲染样式正确性）：落入高亮区间的 span 满足
//   `fontWeight == FontWeight.w600` 且颜色按主题 brightness 在
//   `{AppTheme.accent, AppTheme.darkAccent}` 中二选一；非高亮 span 与
//   调用方传入的 baseStyle 一致；prefix 段使用 prefixStyle。
// - 例测覆盖 Requirements 2.11 / 2.12 / 2.13：分别验证英文、纯中文、
//   多关键词带空格三种典型输入下的精确 span 序列与样式。
//
// 关于 PBT 框架选型：`package:glados` 的 `Glados.test` 与 Flutter 的
// `testWidgets` 不能直接组合（前者基于 `package:test` 的 `test`，无法
// 在内部 pump widget tree），因此本文件采用「在 testWidgets 内手工
// 跑 100 次随机迭代」的等价策略，确定性 seed + 与任务 6.2 一致的
// 字符候选集，覆盖中英混排、emoji、连续空白、ASCII 控制字符等场景。

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/search/widgets/highlighted_text.dart';
import 'package:lumimuse/theme/app_theme.dart';

// 与任务 6.2（highlighted_text_compute_test.dart）保持一致的字符候选集，
// 让随机样本能反复触发 indexOf / 区间合并 / 重叠等关键分支。
const String _mixedAlphabet =
    // ASCII 字母 / 数字 / 常规标点
    'aBcDhio017!?,.'
    // 连续空白：单空格 / 制表符 / 换行
    ' \t\n'
    // ASCII 控制字符：0x01 / 0x07 / 0x1F
    '\x01\x07\x1F'
    // CJK：中文常用字 + 日文假名
    '今天气好の'
    // emoji：代理对，覆盖 UTF-16 多 code unit
    '🌟🐱';

/// 从混合候选集中随机抽取 0–[maxLen] 个字符拼成字符串。
String _randomString(math.Random rng, {int maxLen = 14}) {
  final len = rng.nextInt(maxLen + 1);
  if (len == 0) return '';
  final buf = StringBuffer();
  for (var i = 0; i < len; i++) {
    // _mixedAlphabet 中含代理对（emoji），按 runes 抽取避免拆半个 surrogate。
    final runes = _mixedAlphabet.runes.toList(growable: false);
    final cp = runes[rng.nextInt(runes.length)];
    buf.writeCharCode(cp);
  }
  return buf.toString();
}

/// 找到挂载在 HighlightedText 内的 RichText，并按渲染顺序展开所有
/// `TextSpan.text != null` 的叶子 span。
///
/// 注意：`HighlightedText.build` 使用 `Text.rich(TextSpan(children: spans))`，
/// 顶层 wrapper TextSpan 自身 `text == null`、children 才承载真实文本，
/// 因此 visit 函数仅收集 `text != null` 的节点。
List<TextSpan> _findSpans(WidgetTester tester) {
  final richText = tester.widget<RichText>(
    find
        .descendant(
          of: find.byType(HighlightedText),
          matching: find.byType(RichText),
        )
        .first,
  );
  final result = <TextSpan>[];
  void visit(InlineSpan span) {
    if (span is TextSpan) {
      if (span.text != null) result.add(span);
      final children = span.children;
      if (children != null) {
        for (final c in children) {
          visit(c);
        }
      }
    }
  }

  visit(richText.text);
  return result;
}

/// 构造一个挂载 [HighlightedText] 的最小测试 App，统一处理 MaterialApp 包裹。
Widget _buildApp({
  required String text,
  required String query,
  String? prefix,
  TextStyle? baseStyle,
  TextStyle? prefixStyle,
  Brightness brightness = Brightness.light,
}) {
  final theme = brightness == Brightness.dark
      ? ThemeData(brightness: Brightness.dark)
      : ThemeData(brightness: Brightness.light);
  return MaterialApp(
    theme: theme,
    home: Scaffold(
      body: Material(
        child: HighlightedText(
          text: text,
          query: query,
          baseStyle: baseStyle,
          prefix: prefix,
          prefixStyle: prefixStyle,
        ),
      ),
    ),
  );
}

/// 给定 `(prefix, text, query)` 计算「每个字符位置 → 是否高亮」的布尔表，
/// 索引基于 `(prefix ?? '') + text` 的全文偏移。prefix 部分恒为非高亮。
List<bool> _expectedHighlightMask({
  String? prefix,
  required String text,
  required String query,
}) {
  final prefixLen = (prefix ?? '').length;
  final mask = List<bool>.filled(prefixLen + text.length, false);
  final ranges = computeHighlightRanges(text, query);
  for (final r in ranges) {
    for (var i = r.start; i < r.end; i++) {
      mask[prefixLen + i] = true;
    }
  }
  return mask;
}

void main() {
  // 默认基础样式：刻意指定 fontSize / height / color 等具体字段，便于
  // 后续断言「非高亮 span 与 baseStyle 一致」「高亮 span 仅覆盖
  // fontWeight + color」时进行严格比对。
  const baseStyle = TextStyle(
    fontSize: 13,
    height: 1.55,
    color: Color(0xFF221B33),
    fontWeight: FontWeight.w400,
  );
  const prefixStyle = TextStyle(
    fontSize: 13,
    color: Color(0xFF887F9C),
    fontWeight: FontWeight.w400,
  );

  group('Property 7：字符序列保持不变', () {
    testWidgets('100 次随机迭代下，所有 TextSpan.text 拼接 == (prefix ?? "") + text',
        (tester) async {
      // 固定种子，glados 失败语义下可复现
      final rng = math.Random(20260516);
      for (var i = 0; i < 100; i++) {
        final text = _randomString(rng);
        final query = _randomString(rng);
        // prefix 三态：null / 空串 / 非空字符串，覆盖向前兼容路径
        final prefixDice = rng.nextInt(3);
        final String? prefix = prefixDice == 0
            ? null
            : prefixDice == 1
                ? ''
                : _randomString(rng, maxLen: 6);

        await tester.pumpWidget(
          _buildApp(
            text: text,
            query: query,
            prefix: prefix,
            baseStyle: baseStyle,
            prefixStyle: prefixStyle,
          ),
        );

        final spans = _findSpans(tester);
        final concat = spans.map((s) => s.text ?? '').join();
        final expected = (prefix ?? '') + text;
        expect(
          concat,
          expected,
          reason:
              'iter $i: 拼接 "$concat" 不等于 "(prefix ?? "") + text" = "$expected"',
        );
      }
    });

    testWidgets('特例：query 为空时退化为单段普通文本', (tester) async {
      await tester.pumpWidget(
        _buildApp(text: 'Hello World', query: '', baseStyle: baseStyle),
      );
      final spans = _findSpans(tester);
      expect(spans.length, 1);
      expect(spans.first.text, 'Hello World');
    });

    testWidgets('特例：text 为空时不抛异常且拼接结果为 prefix', (tester) async {
      await tester.pumpWidget(
        _buildApp(
          text: '',
          query: 'foo',
          prefix: '你：',
          baseStyle: baseStyle,
          prefixStyle: prefixStyle,
        ),
      );
      final spans = _findSpans(tester);
      final concat = spans.map((s) => s.text ?? '').join();
      expect(concat, '你：');
    });
  });

  group('Property 10：渲染样式正确性', () {
    /// 在指定主题 brightness 下，断言每个 span 的样式与「期望高亮 mask」吻合。
    Future<void> verifyStylesUnderBrightness(
      WidgetTester tester, {
      required String text,
      required String query,
      String? prefix,
      required Brightness brightness,
    }) async {
      await tester.pumpWidget(
        _buildApp(
          text: text,
          query: query,
          prefix: prefix,
          baseStyle: baseStyle,
          prefixStyle: prefixStyle,
          brightness: brightness,
        ),
      );

      final spans = _findSpans(tester);
      final mask = _expectedHighlightMask(
        prefix: prefix,
        text: text,
        query: query,
      );
      final prefixLen = (prefix ?? '').length;
      final expectedHighlightColor = brightness == Brightness.dark
          ? AppTheme.darkAccent
          : AppTheme.accent;

      var cursor = 0;
      for (final span in spans) {
        final spanText = span.text ?? '';
        if (spanText.isEmpty) continue;
        final spanStart = cursor;
        final spanEnd = cursor + spanText.length;

        if (spanEnd <= prefixLen) {
          // 完全位于 prefix 区间 → 应使用 prefixStyle
          expect(
            span.style?.color,
            prefixStyle.color,
            reason: 'prefix span 颜色应等于 prefixStyle.color',
          );
          expect(
            span.style?.fontWeight,
            prefixStyle.fontWeight,
            reason: 'prefix span fontWeight 应等于 prefixStyle.fontWeight',
          );
        } else {
          // span 完全位于 text 区间（spanStart >= prefixLen），高亮按整段判定。
          // 由于实现按 ranges 切分，单个 span 内字符高亮状态应均匀一致。
          final allHighlighted = !mask
              .sublist(spanStart, spanEnd)
              .contains(false);
          final allPlain = !mask.sublist(spanStart, spanEnd).contains(true);
          expect(
            allHighlighted || allPlain,
            isTrue,
            reason: 'span "$spanText" 跨越了高亮边界，切分逻辑异常',
          );

          if (allHighlighted) {
            expect(
              span.style?.fontWeight,
              FontWeight.w600,
              reason: '高亮 span 应使用 FontWeight.w600',
            );
            expect(
              span.style?.color,
              expectedHighlightColor,
              reason:
                  '高亮 span 颜色应在 ${brightness == Brightness.dark ? "暗色" : "亮色"} 主题下取 '
                  '${brightness == Brightness.dark ? "AppTheme.darkAccent" : "AppTheme.accent"}',
            );
            // copyWith 不会改 fontSize / height，应与 baseStyle 一致
            expect(span.style?.fontSize, baseStyle.fontSize);
            expect(span.style?.height, baseStyle.height);
          } else {
            // 非高亮 span：应与 baseStyle 完全一致（实现里直接传 base）
            expect(span.style?.fontSize, baseStyle.fontSize);
            expect(span.style?.height, baseStyle.height);
            expect(span.style?.color, baseStyle.color);
            expect(span.style?.fontWeight, baseStyle.fontWeight);
          }
        }

        cursor = spanEnd;
      }
    }

    testWidgets('100 次随机迭代下，亮 / 暗主题样式都正确', (tester) async {
      final rng = math.Random(20260517);
      for (var i = 0; i < 100; i++) {
        final text = _randomString(rng);
        final query = _randomString(rng);
        final prefixDice = rng.nextInt(3);
        final String? prefix = prefixDice == 0
            ? null
            : prefixDice == 1
                ? ''
                : _randomString(rng, maxLen: 6);
        // 亮 / 暗主题 1:1 抽样
        final brightness =
            rng.nextBool() ? Brightness.light : Brightness.dark;

        try {
          await verifyStylesUnderBrightness(
            tester,
            text: text,
            query: query,
            prefix: prefix,
            brightness: brightness,
          );
        } catch (e) {
          fail('iter $i 失败 (text="$text", query="$query", '
              'prefix=${prefix == null ? "null" : '"$prefix"'}, '
              'brightness=$brightness): $e');
        }
      }
    });
  });

  group('例测：Requirements 2.11 / 2.12 / 2.13', () {
    testWidgets("Requirements 2.11：text='Hello World', query='hello' "
        "→ 加粗染色 'Hello' + 普通 ' World'", (tester) async {
      await tester.pumpWidget(
        _buildApp(
          text: 'Hello World',
          query: 'hello',
          baseStyle: baseStyle,
        ),
      );
      final spans = _findSpans(tester);
      // 过滤可能出现的空 span（实现细节兜底）
      final nonEmpty = spans.where((s) => (s.text ?? '').isNotEmpty).toList();
      expect(nonEmpty.length, 2,
          reason: '应产生两段：高亮 "Hello" + 普通 " World"');
      // 第一段：高亮 Hello（保留原始大小写）
      expect(nonEmpty[0].text, 'Hello');
      expect(nonEmpty[0].style?.fontWeight, FontWeight.w600);
      expect(nonEmpty[0].style?.color, AppTheme.accent);
      // 第二段：普通 ' World'
      expect(nonEmpty[1].text, ' World');
      expect(nonEmpty[1].style?.fontWeight, baseStyle.fontWeight);
      expect(nonEmpty[1].style?.color, baseStyle.color);
    });

    testWidgets("Requirements 2.12：text='今天天气很好', query='天气' "
        "→ '今天' / 加粗染色 '天气' / '很好'", (tester) async {
      await tester.pumpWidget(
        _buildApp(
          text: '今天天气很好',
          query: '天气',
          baseStyle: baseStyle,
        ),
      );
      final spans = _findSpans(tester);
      final nonEmpty = spans.where((s) => (s.text ?? '').isNotEmpty).toList();
      expect(nonEmpty.length, 3, reason: '应产生三段：今天 / 天气 / 很好');
      expect(nonEmpty[0].text, '今天');
      expect(nonEmpty[0].style?.fontWeight, baseStyle.fontWeight);
      expect(nonEmpty[1].text, '天气');
      expect(nonEmpty[1].style?.fontWeight, FontWeight.w600);
      expect(nonEmpty[1].style?.color, AppTheme.accent);
      expect(nonEmpty[2].text, '很好');
      expect(nonEmpty[2].style?.fontWeight, baseStyle.fontWeight);
    });

    testWidgets("Requirements 2.13：text='foo bar foo', query='foo bar' "
        "→ [foo*, ' ', bar*, ' ', foo*]", (tester) async {
      await tester.pumpWidget(
        _buildApp(
          text: 'foo bar foo',
          query: 'foo bar',
          baseStyle: baseStyle,
        ),
      );
      final spans = _findSpans(tester);
      final nonEmpty = spans.where((s) => (s.text ?? '').isNotEmpty).toList();
      expect(nonEmpty.length, 5, reason: '应产生五段：foo / 空格 / bar / 空格 / foo');
      // 1. 'foo' 高亮
      expect(nonEmpty[0].text, 'foo');
      expect(nonEmpty[0].style?.fontWeight, FontWeight.w600);
      expect(nonEmpty[0].style?.color, AppTheme.accent);
      // 2. 普通空格
      expect(nonEmpty[1].text, ' ');
      expect(nonEmpty[1].style?.fontWeight, baseStyle.fontWeight);
      // 3. 'bar' 高亮
      expect(nonEmpty[2].text, 'bar');
      expect(nonEmpty[2].style?.fontWeight, FontWeight.w600);
      expect(nonEmpty[2].style?.color, AppTheme.accent);
      // 4. 普通空格
      expect(nonEmpty[3].text, ' ');
      expect(nonEmpty[3].style?.fontWeight, baseStyle.fontWeight);
      // 5. 'foo' 高亮
      expect(nonEmpty[4].text, 'foo');
      expect(nonEmpty[4].style?.fontWeight, FontWeight.w600);
      expect(nonEmpty[4].style?.color, AppTheme.accent);
    });
  });
}
