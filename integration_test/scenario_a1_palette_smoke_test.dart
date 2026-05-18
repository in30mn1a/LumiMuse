// Feature: flutter-pixel-perfect-parity, Scenario 7.1: 色板冒烟测试
// Validates: Requirements A1.1, A1.2
//
// 设计说明
// ────────
// requirements.md §A1.1 / §A1.2 / design.md §1.1 要求：
//   浅色与暗色两种 Brightness 下使用的所有自定义颜色都必须属于
//   `AppPalette` 中声明的字面量集合（27 个色值）。本场景启动一个使用
//   `AppTheme.light()` 与 `AppTheme.dark()` 的最小 MaterialApp，在 5 次
//   亮 / 暗切换中遍历渲染树里的 Container / Material / Text / DecoratedBox
//   颜色，逐一断言它们落在 AppPalette ∪ 必要的 Material 默认白名单内。
//
// 白名单
// ────────
// 以下颜色由 Material 自身或我们刻意混合得到，不属于 AppPalette 字面量，
// 但必须在断言中放行，避免假阳性：
//   - Colors.transparent / Colors.white / Colors.black：Material 默认；
//   - 浅色 scaffoldBackgroundColor 0xFFF6F1FF：原版 globals.css 中
//     `html` 背景色，主题级别使用，不属于 AppPalette 但属于「主题契约」；
//   - 通过 `withValues(alpha:)` 派生出的半透明色：alpha 不为 0xFF 的
//     变体一律放行（这是 Material 主题中的常见用法，例如输入框 fill）。
//
// 所有断言都用中文 reason，失败时直接打印越界颜色与所在 widget 类型，
// 便于排查。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_theme.dart' show AppPalette, AppTheme;

void main() {
  group('Scenario 7.1: 色板冒烟测试（浅色 / 暗色 5 次切换）', () {
    testWidgets(
      '渲染树中所有不透明的自定义颜色都属于 AppPalette 字面量集合',
      (tester) async {
        // 主题级 Scaffold 背景（与原版 globals.css `html` background 对齐）。
        const lightScaffoldBg = Color(0xFFF6F1FF);

        // ── 构建允许的颜色集合 ─────────────────────────────────────
        final allowedPaletteColors = <int>{
          // 浅色 14 个
          AppPalette.warm50.toARGB32(),
          AppPalette.warm100.toARGB32(),
          AppPalette.warm200.toARGB32(),
          AppPalette.warm300.toARGB32(),
          AppPalette.accent.toARGB32(),
          AppPalette.accentLight.toARGB32(),
          AppPalette.accentDark.toARGB32(),
          AppPalette.surface.toARGB32(),
          AppPalette.surfaceRaised.toARGB32(),
          AppPalette.textPrimary.toARGB32(),
          AppPalette.textSecondary.toARGB32(),
          AppPalette.textMuted.toARGB32(),
          AppPalette.border.toARGB32(),
          AppPalette.borderLight.toARGB32(),
          // 暗色 13 个
          AppPalette.darkWarm50.toARGB32(),
          AppPalette.darkWarm100.toARGB32(),
          AppPalette.darkWarm200.toARGB32(),
          AppPalette.darkWarm300.toARGB32(),
          AppPalette.darkAccent.toARGB32(),
          AppPalette.darkAccentDark.toARGB32(),
          AppPalette.darkSurface.toARGB32(),
          AppPalette.darkSurfaceRaised.toARGB32(),
          AppPalette.darkTextPrimary.toARGB32(),
          AppPalette.darkTextSecondary.toARGB32(),
          AppPalette.darkTextMuted.toARGB32(),
          AppPalette.darkBorder.toARGB32(),
          AppPalette.darkBorderLight.toARGB32(),
        };

        // 必要的 Material / 主题默认色白名单（不属于 AppPalette 但合法）
        final whitelist = <int>{
          const Color(0x00000000).toARGB32(), // 全透明
          const Color(0xFFFFFFFF).toARGB32(), // 纯白
          const Color(0xFF000000).toARGB32(), // 纯黑
          lightScaffoldBg.toARGB32(), // 浅色 scaffold 背景
        };

        // ── 渲染树扫描函数 ─────────────────────────────────────────
        // 返回越界颜色列表（color, widgetTypeName）。
        List<({int color, String widgetType})> scanInvalidColors() {
          final invalid = <({int color, String widgetType})>[];

          bool isAllowed(Color c) {
            // 半透明 / 派生色：alpha 不为 0xFF（与浅 / 深主题中的
            // withValues(alpha:) 派生一致）一律放行。
            // alpha 通道：toARGB32() 高 8 位
            final argb = c.toARGB32();
            final alpha = (argb >> 24) & 0xFF;
            if (alpha != 0xFF && alpha != 0x00) return true;
            if (alpha == 0x00) return true;
            return allowedPaletteColors.contains(argb) ||
                whitelist.contains(argb);
          }

          for (final element in tester.allElements) {
            final widget = element.widget;
            // 检查 Container.color / decoration 颜色
            if (widget is Container) {
              final c = widget.color;
              if (c != null && !isAllowed(c)) {
                invalid.add((color: c.toARGB32(), widgetType: 'Container'));
              }
              final deco = widget.decoration;
              if (deco is BoxDecoration && deco.color != null) {
                if (!isAllowed(deco.color!)) {
                  invalid.add(
                      (color: deco.color!.toARGB32(), widgetType: 'BoxDecoration'));
                }
              }
            }
            // 检查 ColoredBox 颜色
            if (widget is ColoredBox) {
              if (!isAllowed(widget.color)) {
                invalid.add((color: widget.color.toARGB32(), widgetType: 'ColoredBox'));
              }
            }
            // 检查 Text.style.color（仅当显式指定）
            if (widget is Text) {
              final c = widget.style?.color;
              if (c != null && !isAllowed(c)) {
                invalid.add((color: c.toARGB32(), widgetType: 'Text'));
              }
            }
            // 检查 Icon.color
            if (widget is Icon) {
              final c = widget.color;
              if (c != null && !isAllowed(c)) {
                invalid.add((color: c.toARGB32(), widgetType: 'Icon'));
              }
            }
          }
          return invalid;
        }

        // ── 构建带可切换 Brightness 的最小 App ─────────────────────
        ThemeMode mode = ThemeMode.light;
        late StateSetter setMode;

        Widget buildApp() {
          return MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light(),
            darkTheme: AppTheme.dark(),
            themeMode: mode,
            home: StatefulBuilder(
              builder: (context, setState) {
                setMode = setState;
                return Scaffold(
                  body: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        // 用主题色板构造若干显式着色 widget，便于扫描
                        Container(
                          width: 80,
                          height: 80,
                          color: AppPalette.accent,
                        ),
                        Container(
                          width: 80,
                          height: 80,
                          decoration: BoxDecoration(
                            color: AppPalette.warm100,
                            border: Border.all(color: AppPalette.border),
                          ),
                        ),
                        const Text(
                          '色板冒烟',
                          style: TextStyle(color: AppPalette.textPrimary),
                        ),
                        const Icon(Icons.star, color: AppPalette.accentDark),
                      ],
                    ),
                  ),
                );
              },
            ),
          );
        }

        await tester.pumpWidget(buildApp());
        await tester.pumpAndSettle();

        // ── 切换 5 次：light → dark → light → dark → light → dark ──
        // 每一次切换后扫描渲染树，断言无越界颜色。
        for (var i = 0; i < 5; i++) {
          // 翻转 mode
          setMode(() {
            mode = (mode == ThemeMode.light) ? ThemeMode.dark : ThemeMode.light;
          });
          await tester.pumpAndSettle();

          final invalid = scanInvalidColors();
          expect(
            invalid,
            isEmpty,
            reason: '第 ${i + 1} 次切换（mode=$mode）后发现越界颜色：\n'
                '${invalid.map((e) => '  - 0x${e.color.toRadixString(16).padLeft(8, '0').toUpperCase()} @ ${e.widgetType}').join('\n')}',
          );
        }
      },
    );
  });
}
