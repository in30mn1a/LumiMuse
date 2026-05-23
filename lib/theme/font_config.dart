import 'package:flutter/material.dart';

// ╔══════════════════════════════════════════════════════════════════════╗
// ║ 字体契约                                                             ║
// ║ • 中文正文：霞鹜文楷（LXGWWenKaiScreen，bundled）                     ║
// ║ • 英文标题 / 展示字：Quicksand（google_fonts 加载）                   ║
// ║ 切换须通过 MaterialApp 顶层 ThemeData 重建（INV-9 / RC-8）           ║
// ╚══════════════════════════════════════════════════════════════════════╝

/// 与设置项 `font_style` 兼容
enum FontStackKind { wenkai, system, serif }

/// 字体栈 — 正文与标题分流
@immutable
class FontStack {
  const FontStack._(this.kind);

  final FontStackKind kind;

  /// 展示 / 英文标题主字体（--font-display）
  static const String displayPrimary = 'Quicksand';

  /// 中文正文字体（--font-sans 默认）
  static const String bodyPrimary = 'LXGWWenKaiScreen';

  static const FontStack wenkai = FontStack._(FontStackKind.wenkai);
  static const FontStack system = FontStack._(FontStackKind.system);
  static const FontStack serif = FontStack._(FontStackKind.serif);

  /// 展示字回退：英文 Quicksand 缺字时落回文楷与系统中文字体
  List<String> get displayFallback => [
        bodyPrimary,
        'PingFang SC',
        'Hiragino Sans GB',
        'Microsoft YaHei',
        'Noto Sans SC',
      ];

  /// 正文回退：中文文楷缺字时落回 Quicksand（英文）与系统字体
  List<String> get bodyFallback {
    switch (kind) {
      case FontStackKind.wenkai:
        return [
          displayPrimary,
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Noto Sans SC',
        ];
      case FontStackKind.system:
        return [
          displayPrimary,
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          'Noto Sans SC',
        ];
      case FontStackKind.serif:
        return [
          displayPrimary,
          'Noto Serif SC',
          'Source Han Serif SC',
          'SimSun',
          'Georgia',
        ];
    }
  }

  static FontStack of(FontStackKind kind) {
    switch (kind) {
      case FontStackKind.system:
        return system;
      case FontStackKind.serif:
        return serif;
      case FontStackKind.wenkai:
        return wenkai;
    }
  }

  static FontStack fromStyle(String? style) {
    switch (style) {
      case 'system':
        return system;
      case 'serif':
        return serif;
      case 'wenkai':
      default:
        return wenkai;
    }
  }
}

class FontConfig {
  FontConfig._();

  static const FontStack defaultStack = FontStack.wenkai;

  /// 展示 / 英文标题：Quicksand 优先
  static TextStyle withDisplayFontStack(
    TextStyle base, [
    FontStack stack = defaultStack,
  ]) {
    return base.copyWith(
      fontFamily: FontStack.displayPrimary,
      fontFamilyFallback: stack.displayFallback,
    );
  }

  /// 中文正文：霞鹜文楷优先
  static TextStyle withBodyFontStack(
    TextStyle base, [
    FontStack stack = defaultStack,
  ]) {
    return base.copyWith(
      fontFamily: FontStack.bodyPrimary,
      fontFamilyFallback: stack.bodyFallback,
    );
  }

  /// 把整个 TextTheme 按 display / body 分流
  static TextTheme applyFontStack(
    TextTheme theme, [
    FontStack stack = defaultStack,
  ]) {
    TextStyle? display(TextStyle? s) =>
        s == null ? null : withDisplayFontStack(s, stack);
    TextStyle? body(TextStyle? s) =>
        s == null ? null : withBodyFontStack(s, stack);
    return TextTheme(
      displayLarge: display(theme.displayLarge),
      displayMedium: display(theme.displayMedium),
      displaySmall: display(theme.displaySmall),
      headlineLarge: display(theme.headlineLarge),
      headlineMedium: display(theme.headlineMedium),
      headlineSmall: display(theme.headlineSmall),
      titleLarge: display(theme.titleLarge),
      titleMedium: display(theme.titleMedium),
      titleSmall: display(theme.titleSmall),
      bodyLarge: body(theme.bodyLarge),
      bodyMedium: body(theme.bodyMedium),
      bodySmall: body(theme.bodySmall),
      labelLarge: body(theme.labelLarge),
      labelMedium: body(theme.labelMedium),
      labelSmall: body(theme.labelSmall),
    );
  }
}
