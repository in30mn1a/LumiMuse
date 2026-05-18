import 'package:flutter/material.dart';

// ╔══════════════════════════════════════════════════════════════════════╗
// ║ 字体切换契约（与 INV-9 / RC-8 一致）                                  ║
// ║                                                                      ║
// ║ 字体切换必须通过 `MaterialApp` 顶层重建实现，禁止在子 widget 内       ║
// ║ 用 `if (fontKind == ...)` 之类的分支字体逻辑做局部覆盖。              ║
// ║                                                                      ║
// ║ 唯一正确做法：                                                        ║
// ║   1. 在根 widget（lib/app.dart）读取 fontStack 设置；                  ║
// ║   2. 把 `FontStack` 透传给 `AppTheme.light(fontStack: ...)` /         ║
// ║      `AppTheme.dark(fontStack: ...)`；                                ║
// ║   3. Flutter 框架在 `ThemeData` 变化时自动重建整棵 widget 树，         ║
// ║      所有 `Text` / `TextField` / 自定义 `TextStyle` 一次性更新。       ║
// ║                                                                      ║
// ║ 反面案例（绝对禁止）：                                                ║
// ║   • 在某个子 widget 里读取 fontKind，再通过 `if/switch` 选择不同      ║
// ║     `TextStyle` 渲染——会产生「上层重建后，子层没收到信号」的           ║
// ║     不一致状态；                                                       ║
// ║   • 主项目曾在 Tailwind v4 上踩过同源的坑：靠 CSS 选择器优先级覆盖     ║
// ║     `font-family` 在 `@layer theme` 下完全失效，最终改为直接修改       ║
// ║     `--font-sans` CSS 变量（参见 src/lib/font-stacks.ts）。            ║
// ║   Flutter 端等价方案 = 修改顶层 `ThemeData.textTheme` 的               ║
// ║   `fontFamily` / `fontFamilyFallback`，触发 `MaterialApp` 全局重建。   ║
// ║                                                                      ║
// ║ 三栈定义与主项目 `src/lib/font-stacks.ts` 一一对应：                   ║
// ║   • wenkai = Quicksand（英文）+ 霞鹜文楷屏幕版（中文）                 ║
// ║   • system = Quicksand（英文）+ 系统中文字体（PingFang/YaHei/...）     ║
// ║   • serif  = Quicksand（英文）+ 衬线中文字体（Noto Serif/SimSun/...）  ║
// ╚══════════════════════════════════════════════════════════════════════╝

/// 字体栈枚举，与主项目 `FontStyle` 类型一一对应。
///
/// 注意：枚举值名称必须保持稳定（`wenkai` / `system` / `serif`），
/// 因为它们会被序列化进设置存储与导入导出 JSON。
enum FontStackKind { wenkai, system, serif }

/// 字体栈：英文主字体 + 中文 / 系统 / 衬线 回退链。
///
/// 与主项目 `src/lib/font-stacks.ts` 的 `FONT_STACKS` 字典严格对齐：
/// 英文统一走 Quicksand（与主项目通过 `next/font` 加载 Quicksand 一致），
/// 中文部分根据用户选择落在三种回退链之一。
@immutable
class FontStack {
  const FontStack._({
    required this.kind,
    required this.primary,
    required this.fallback,
  });

  /// 字体栈类型
  final FontStackKind kind;

  /// 主字体（用于英文渲染）
  final String primary;

  /// 字体回退链（用于中文及缺字回退）
  final List<String> fallback;

  /// 霞鹜文楷栈：Quicksand + LXGWWenKaiScreen + 系统中文回退
  ///
  /// 对齐主项目：
  /// `wenkai: "'LXGW WenKai Screen', 'PingFang SC', 'Hiragino Sans GB',
  /// 'Microsoft YaHei', 'Noto Sans SC', system-ui, -apple-system, sans-serif"`
  static const FontStack wenkai = FontStack._(
    kind: FontStackKind.wenkai,
    primary: 'Quicksand',
    fallback: <String>[
      'LXGWWenKaiScreen',
      'PingFang SC',
      'Hiragino Sans GB',
      'Microsoft YaHei',
      'Noto Sans SC',
    ],
  );

  /// 系统字体栈：Quicksand + 平台默认中文字体
  ///
  /// 对齐主项目：
  /// `system: "ui-sans-serif, 'PingFang SC', 'Hiragino Sans GB',
  /// 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC',
  /// system-ui, -apple-system, sans-serif"`
  static const FontStack system = FontStack._(
    kind: FontStackKind.system,
    primary: 'Quicksand',
    fallback: <String>[
      'PingFang SC',
      'Hiragino Sans GB',
      'Microsoft YaHei UI',
      'Microsoft YaHei',
      'Noto Sans SC',
    ],
  );

  /// 衬线字体栈：Quicksand + 中文衬线回退
  ///
  /// 对齐主项目：
  /// `serif: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', Georgia, serif"`
  static const FontStack serif = FontStack._(
    kind: FontStackKind.serif,
    primary: 'Quicksand',
    fallback: <String>[
      'Noto Serif SC',
      'Source Han Serif SC',
      'SimSun',
      'Georgia',
    ],
  );

  /// 根据枚举值取对应栈
  static FontStack of(FontStackKind kind) {
    switch (kind) {
      case FontStackKind.wenkai:
        return wenkai;
      case FontStackKind.system:
        return system;
      case FontStackKind.serif:
        return serif;
    }
  }
}

/// 字体配置工具:
/// 1) 把单个 `TextStyle` 注入 `fontFamily` + `fontFamilyFallback`；
/// 2) 把整个 `TextTheme` 一次性应用某个字体栈。
///
/// 重要：本工具只在 `AppTheme.light(...)` / `AppTheme.dark(...)`
/// 内部使用一次。任何子 widget 都不应该再调用本工具去做局部覆盖
/// （那会变成 RC-8 禁止的「子组件级字体选择器」反例）。
class FontConfig {
  FontConfig._();

  /// 默认栈（与主项目默认 `wenkai` 一致）
  static const FontStack defaultStack = FontStack.wenkai;

  /// 把字体栈注入到一个 `TextStyle` 上
  static TextStyle withFontStack(
    TextStyle base, [
    FontStack stack = defaultStack,
  ]) {
    return base.copyWith(
      fontFamily: stack.primary,
      fontFamilyFallback: stack.fallback,
    );
  }

  /// 兼容旧调用：等价于 [withFontStack] (base, [FontStack.wenkai])
  ///
  /// 仅供历史调用点使用，新代码请直接调用 [withFontStack]。
  static TextStyle withCjkFallback(TextStyle base) =>
      withFontStack(base, FontStack.wenkai);

  /// 把字体栈应用到整个 `TextTheme` 的所有样式上
  static TextTheme applyFontStack(
    TextTheme theme, [
    FontStack stack = defaultStack,
  ]) {
    TextStyle? apply(TextStyle? s) =>
        s == null ? null : withFontStack(s, stack);
    return TextTheme(
      displayLarge: apply(theme.displayLarge),
      displayMedium: apply(theme.displayMedium),
      displaySmall: apply(theme.displaySmall),
      headlineLarge: apply(theme.headlineLarge),
      headlineMedium: apply(theme.headlineMedium),
      headlineSmall: apply(theme.headlineSmall),
      titleLarge: apply(theme.titleLarge),
      titleMedium: apply(theme.titleMedium),
      titleSmall: apply(theme.titleSmall),
      bodyLarge: apply(theme.bodyLarge),
      bodyMedium: apply(theme.bodyMedium),
      bodySmall: apply(theme.bodySmall),
      labelLarge: apply(theme.labelLarge),
      labelMedium: apply(theme.labelMedium),
      labelSmall: apply(theme.labelSmall),
    );
  }

  /// 兼容旧调用：等价于 [applyFontStack] (theme, [FontStack.wenkai])
  static TextTheme applyFallback(TextTheme theme) =>
      applyFontStack(theme, FontStack.wenkai);
}
