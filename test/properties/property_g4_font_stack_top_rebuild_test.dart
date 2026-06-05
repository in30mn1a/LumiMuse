// Feature: flutter-parity-gaps-fill, Property G4: INV-9 fontStack 顶层重建契约
// Validates: INV-9 / RC-8（参见 lib/theme/font_config.dart 头部契约说明）
//
// 设计说明
// ────────
// INV-9 规约：fontStack 切换必须通过 `MaterialApp` 顶层 ThemeData 重建实现，
// 子 widget 不应自己根据 fontKind 分支决定字体。换言之，对任意合法
// FontStack `s`，下列恒等式必须成立：
//
//   AppTheme.light(fontStack: s).textTheme.bodyLarge.fontFamily
//     == FontStack.bodyPrimary
//   AppTheme.light(fontStack: s).textTheme.bodyLarge.fontFamilyFallback
//     == s.bodyFallback
//
// 暗色 `AppTheme.dark` 同上。这保证了「换 fontStack 即换 ThemeData」是
// 字体切换的唯一路径。
//
// 实施位置：lib/theme/app_theme.dart `_buildTextTheme` 调用
// `FontConfig.applyFontStack`，后者把 stack 应用到 TextTheme 的所有字段；
// 本测试用 ThemeData 单元断言（不 pump widget）以最低成本验证不变量。
//
// 生成器：本文件直接定义 `Generator<FontStack>`，不修改
// `test/_helpers/generators.dart`（避免与其他工作包并行修改冲突）。
//
// 测试基础设施
// ────────────
// `AppTheme.light/dark` 内部用 `GoogleFonts.quicksand(...)` 构造 TextTheme，
// 即便在纯单元测试场景，构造时也会触发 `loadFontIfNecessary` 异步路径，
// 需要 `TestWidgetsFlutterBinding.ensureInitialized()` + `HttpOverrides`
// 拦截网络下载 + `path_provider` mock channel 三件套，参考
// `test/theme/dark_mode_test.dart` 的同款做法。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test, setUpAll, tearDownAll;
import 'package:lumimuse/theme/app_theme.dart';
import 'package:lumimuse/theme/font_config.dart';

// ──────────────────────────────────────────────────────────────────────────
// FontStack 生成器 —— 从 {wenkai, system, serif} 等概率选取
// ──────────────────────────────────────────────────────────────────────────

const List<FontStack> _kAllFontStacks = <FontStack>[
  FontStack.wenkai,
  FontStack.system,
  FontStack.serif,
];

extension on Any {
  Generator<FontStack> get fontStack {
    return intInRange(0, _kAllFontStacks.length).map((i) => _kAllFontStacks[i]);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 阻止 google_fonts 在测试环境发起 HTTP 字体下载
// ──────────────────────────────────────────────────────────────────────────

class _NoHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (_, __, ___) => true;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 共享断言：对一个 ThemeData，验证所有 textTheme 字段都正确反映传入的 stack
// ──────────────────────────────────────────────────────────────────────────

void _assertTextThemeReflectsStack(ThemeData theme, FontStack stack) {
  // 正文（body / label）通道：fontFamily 必须是 FontStack.bodyPrimary（霞鹜文楷），
  // fallback 严格等于 stack.bodyFallback —— 这是 INV-9 的核心断言。
  final bodyLarge = theme.textTheme.bodyLarge;
  expect(
    bodyLarge,
    isNotNull,
    reason: '_buildTextTheme 必须填充 bodyLarge，否则 INV-9 无法验证',
  );
  expect(
    bodyLarge!.fontFamily,
    equals(FontStack.bodyPrimary),
    reason:
        'INV-9：bodyLarge.fontFamily 必须是 FontStack.bodyPrimary（霞鹜文楷），'
        '才能保证 fontStack 切换由 MaterialApp 顶层重建实现，子 widget 不分支。\n'
        '  stack    = $stack\n'
        '  expected = "${FontStack.bodyPrimary}"\n'
        '  actual   = "${bodyLarge.fontFamily}"',
  );
  expect(
    bodyLarge.fontFamilyFallback,
    equals(stack.bodyFallback),
    reason:
        'INV-9：bodyLarge.fontFamilyFallback 必须严格等于 stack.bodyFallback。\n'
        '  stack    = $stack\n'
        '  expected = ${stack.bodyFallback}\n'
        '  actual   = ${bodyLarge.fontFamilyFallback}',
  );

  // 同步抽样校验 bodyMedium / bodySmall / labelLarge —— 这些是 body 通道
  for (final entry in <String, TextStyle?>{
    'bodyMedium': theme.textTheme.bodyMedium,
    'bodySmall': theme.textTheme.bodySmall,
    'labelLarge': theme.textTheme.labelLarge,
  }.entries) {
    final style = entry.value;
    expect(style, isNotNull, reason: '${entry.key} 不应为 null');
    expect(
      style!.fontFamily,
      equals(FontStack.bodyPrimary),
      reason:
          'INV-9：${entry.key}.fontFamily 必须是 FontStack.bodyPrimary。\n'
          '  stack = $stack',
    );
    expect(
      style.fontFamilyFallback,
      equals(stack.bodyFallback),
      reason:
          'INV-9：${entry.key}.fontFamilyFallback 必须严格等于 stack.bodyFallback。\n'
          '  stack = $stack',
    );
  }

  // 标题（display / headline / title）走 display 通道：fontFamily 是 Quicksand，
  // fallback 是 stack.displayFallback（与 kind 无关，但 stack.bodyPrimary 占位）
  final titleLarge = theme.textTheme.titleLarge;
  expect(titleLarge, isNotNull);
  expect(
    titleLarge!.fontFamily,
    equals(FontStack.displayPrimary),
    reason:
        'INV-9：titleLarge.fontFamily 必须是 FontStack.displayPrimary（Quicksand）',
  );
  expect(
    titleLarge.fontFamilyFallback,
    equals(stack.displayFallback),
    reason:
        'INV-9：titleLarge.fontFamilyFallback 必须严格等于 stack.displayFallback。\n'
        '  stack = $stack',
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  // 关键：google_fonts 在构造 TextStyle 时会启动异步下载流程，需要 binding
  // 已初始化才能访问 ServicesBinding.instance；并 mock path_provider，
  // 否则 google_fonts 缓存字体抛 MissingPluginException 会污染异步结果。
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    HttpOverrides.global = _NoHttpOverrides();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async {
        if (methodCall.method == 'getApplicationSupportDirectory' ||
            methodCall.method == 'getTemporaryDirectory') {
          return Directory.systemTemp.path;
        }
        return null;
      },
    );
  });

  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
  });

  group('property g4: INV-9 fontStack 顶层重建', () {
    // ── 属性 1：light 主题 ──────────────────────────────────────────────
    Glados<FontStack>(
      any.fontStack,
      ExploreConfig(numRuns: 60),
    ).test(
      'AppTheme.light(fontStack: x).textTheme 严格反映 x（INV-9）',
      (FontStack stack) {
        final theme = AppTheme.light(fontStack: stack);
        _assertTextThemeReflectsStack(theme, stack);
      },
    );

    // ── 属性 2：dark 主题 ───────────────────────────────────────────────
    Glados<FontStack>(
      any.fontStack,
      ExploreConfig(numRuns: 60),
    ).test(
      'AppTheme.dark(fontStack: x).textTheme 严格反映 x（INV-9，与 light 同契约）',
      (FontStack stack) {
        final theme = AppTheme.dark(fontStack: stack);
        _assertTextThemeReflectsStack(theme, stack);
      },
    );

    // ── 例测：把三种 FontStack 的关键路径再固化一次（双层保护） ─────────
    test('light 三种 FontStack 的 bodyLarge.fontFamilyFallback 各不相同（kind 区分）', () {
      final wenkaiFallback =
          AppTheme.light(fontStack: FontStack.wenkai).textTheme.bodyLarge!.fontFamilyFallback;
      final systemFallback =
          AppTheme.light(fontStack: FontStack.system).textTheme.bodyLarge!.fontFamilyFallback;
      final serifFallback =
          AppTheme.light(fontStack: FontStack.serif).textTheme.bodyLarge!.fontFamilyFallback;

      // 三种 kind 的 bodyFallback 列表内容应当不同（避免 stack 切换无效）
      expect(
        wenkaiFallback,
        isNot(equals(systemFallback)),
        reason: 'wenkai 与 system 的 bodyFallback 应不同',
      );
      expect(
        wenkaiFallback,
        isNot(equals(serifFallback)),
        reason: 'wenkai 与 serif 的 bodyFallback 应不同',
      );
      expect(
        systemFallback,
        isNot(equals(serifFallback)),
        reason: 'system 与 serif 的 bodyFallback 应不同',
      );
    });

    test('dark 与 light 在同一 FontStack 下 textTheme 的字体契约一致', () {
      for (final stack in _kAllFontStacks) {
        final lightBody =
            AppTheme.light(fontStack: stack).textTheme.bodyLarge!;
        final darkBody = AppTheme.dark(fontStack: stack).textTheme.bodyLarge!;
        expect(lightBody.fontFamily, equals(darkBody.fontFamily));
        expect(
          lightBody.fontFamilyFallback,
          equals(darkBody.fontFamilyFallback),
          reason:
              'INV-9：dark 与 light 在同 stack 下 bodyLarge.fontFamilyFallback 必须一致',
        );
      }
    });
  });
}
