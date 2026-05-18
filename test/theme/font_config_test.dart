// 字体回退链属性测试
// Feature: flutter-visual-polish, Property 1: Font fallback chain integrity
// Validates: Requirements 3.4


import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/theme/font_config.dart';

/// 为 TextStyle 提供自定义生成器
extension TextStyleGenerators on Any {
  /// 生成随机 TextStyle，模拟各种可能的输入配置
  Generator<TextStyle> get textStyle {
    return combine3<double, int, double, TextStyle>(
      doubleInRange(8.0, 72.0), // fontSize
      intInRange(0, 8), // fontWeight 索引
      doubleInRange(-2.0, 5.0), // letterSpacing
      (fontSize, weightIndex, letterSpacing) {
        const weights = FontWeight.values;
        return TextStyle(
          fontSize: fontSize,
          fontWeight: weights[weightIndex],
          letterSpacing: letterSpacing,
        );
      },
    );
  }

  /// 生成随机 TextTheme，包含 5 个随机 TextStyle
  Generator<TextTheme> get textTheme {
    return combine5<TextStyle, TextStyle, TextStyle, TextStyle, TextStyle,
        TextTheme>(
      textStyle,
      textStyle,
      textStyle,
      textStyle,
      textStyle,
      (s1, s2, s3, s4, s5) {
        return TextTheme(
          displayLarge: s1,
          displayMedium: s2,
          displaySmall: s3,
          headlineLarge: s4,
          headlineMedium: s5,
        );
      },
    );
  }
}

void main() {
  group('Property 1: Font fallback chain integrity', () {
    // 辅助方法：从 TextTheme 中提取所有 TextStyle
    List<TextStyle?> extractAllStyles(TextTheme theme) {
      return [
        theme.displayLarge,
        theme.displayMedium,
        theme.displaySmall,
        theme.headlineLarge,
        theme.headlineMedium,
        theme.headlineSmall,
        theme.titleLarge,
        theme.titleMedium,
        theme.titleSmall,
        theme.bodyLarge,
        theme.bodyMedium,
        theme.bodySmall,
        theme.labelLarge,
        theme.labelMedium,
        theme.labelSmall,
      ];
    }

    Glados(any.textTheme, ExploreConfig(numRuns: 100)).test(
      '所有 TextStyle 经过 applyFallback 后 fontFamilyFallback 包含 LXGWWenKaiScreen',
      (textTheme) {
        // 对 TextTheme 应用字体回退链
        final result = FontConfig.applyFallback(textTheme);

        // 提取所有样式并验证
        final allStyles = extractAllStyles(result);

        for (final style in allStyles) {
          if (style != null) {
            // 验证 fontFamilyFallback 不为 null 且包含 'LXGWWenKaiScreen'
            expect(
              style.fontFamilyFallback,
              isNotNull,
              reason: '应用回退后 fontFamilyFallback 不应为 null',
            );
            expect(
              style.fontFamilyFallback!.contains('LXGWWenKaiScreen'),
              isTrue,
              reason:
                  'fontFamilyFallback 应包含 LXGWWenKaiScreen，实际值: ${style.fontFamilyFallback}',
            );
          }
        }
      },
    );

    Glados(any.textStyle, ExploreConfig(numRuns: 100)).test(
      '单个 TextStyle 经过 withCjkFallback 后 fontFamilyFallback 包含 LXGWWenKaiScreen',
      (textStyle) {
        // 对单个 TextStyle 应用字体回退
        final result = FontConfig.withCjkFallback(textStyle);

        // 验证 fontFamilyFallback 包含 'LXGWWenKaiScreen'
        expect(
          result.fontFamilyFallback,
          isNotNull,
          reason: 'withCjkFallback 后 fontFamilyFallback 不应为 null',
        );
        expect(
          result.fontFamilyFallback!.contains('LXGWWenKaiScreen'),
          isTrue,
          reason:
              'fontFamilyFallback 应包含 LXGWWenKaiScreen，实际值: ${result.fontFamilyFallback}',
        );

        // 验证 fontFamily 为 Quicksand（字体回退链首位）
        expect(
          result.fontFamily,
          equals('Quicksand'),
          reason: '主字体应为 Quicksand',
        );
      },
    );

    Glados(any.textStyle, ExploreConfig(numRuns: 100)).test(
      'withCjkFallback 保留原始 TextStyle 的其他属性（fontSize、fontWeight、letterSpacing）',
      (textStyle) {
        final result = FontConfig.withCjkFallback(textStyle);

        // 验证原始属性被保留
        expect(result.fontSize, equals(textStyle.fontSize),
            reason: 'fontSize 应被保留');
        expect(result.fontWeight, equals(textStyle.fontWeight),
            reason: 'fontWeight 应被保留');
        expect(result.letterSpacing, equals(textStyle.letterSpacing),
            reason: 'letterSpacing 应被保留');
      },
    );
  });
}
