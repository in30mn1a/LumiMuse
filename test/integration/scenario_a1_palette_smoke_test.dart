// Feature: flutter-pixel-perfect-parity, Scenario 7.1: 集成场景 A1 — 色板冒烟测试
// Validates: Requirements A1.1, A1.2
//
// 目标
// ────
// 在最小测试 widget 树上按浅色 / 暗色两种模式切换 5 次，
// 断言每次切换后渲染树中出现的所有颜色都来自 `AppPalette` 字面量集合。
// 即「颜色不会因为代码漂移而出现非基准值」。
//
// 实施策略（与 spec 任务说明一致）：
// 1. 不启动整个应用，只构建一个最小 widget：包含若干使用 `AppPalette`
//    颜色的 Container / Text；
// 2. 用一个布尔 `darkMode` 在两种主题间切换；
// 3. 切换 5 次（5 个 setState），每次切换后：
//    a. 断言 ThemeData 的 colorScheme 关键字段等于 `AppPalette` 期望值；
//    b. 遍历测试 widget 树中所有 `Container` 与 `Text`，收集 BoxDecoration
//       的颜色 / 边框颜色 / Text style color，断言全部 ⊆ `AppPalette` 的字面量集合；
// 4. 整个测试不依赖真实网络与数据库。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:lumimuse/theme/app_theme.dart';

// ─────────── 字面量集合 ───────────
// 与 design.md §1.1 / requirements.md A1.1+A1.2 列出的色值全集严格对齐。
// 任何不在这个集合中的「非透明 / 非黑白」颜色都视为 palette 漂移。
final Set<int> _kPaletteValues = <int>{
  // 浅色（14）
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
  // 暗色（13）
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

/// 判断颜色是否为 palette 字面量；完全透明色（alpha=0）视为「无色」直接跳过，
/// 因为它们对视觉无影响（典型场景：未设置 background 的 Container 默认透明）。
bool _isPaletteOrTransparent(Color color) {
  if (color.a == 0.0) return true;
  return _kPaletteValues.contains(color.toARGB32());
}

/// 最小测试页：一组使用 `AppPalette` 颜色的关键节点
///
/// 注意：本页面**只能**使用 `AppPalette` 中的字面量上色，不能用
/// `Theme.of(context).colorScheme.primary.withOpacity(...)` 之类的派生色。
/// 这样才能在切换主题后还能逐节点地断言「颜色全部来自 palette」。
class _PaletteSmokePage extends StatelessWidget {
  final bool darkMode;
  const _PaletteSmokePage({required this.darkMode});

  @override
  Widget build(BuildContext context) {
    final bg = darkMode ? AppPalette.darkSurface : AppPalette.surface;
    final fg = darkMode ? AppPalette.darkTextPrimary : AppPalette.textPrimary;
    final borderColor = darkMode ? AppPalette.darkBorder : AppPalette.border;
    final accent = darkMode ? AppPalette.darkAccent : AppPalette.accent;

    return Scaffold(
      // 用 palette 暖色作为整体底；浅色用 warm50、暗色用 darkWarm50
      backgroundColor:
          darkMode ? AppPalette.darkWarm50 : AppPalette.warm50,
      body: Column(
        key: const ValueKey('palette-smoke-root'),
        children: [
          // 卡片节点：背景 + 边框 + 文字三个独立颜色
          Container(
            key: const ValueKey('palette-card'),
            decoration: BoxDecoration(
              color: bg,
              border: Border.all(color: borderColor),
            ),
            padding: const EdgeInsets.all(12),
            child: Text(
              '色板冒烟测试卡片',
              style: TextStyle(color: fg),
            ),
          ),
          // 强调色节点：accent
          Container(
            key: const ValueKey('palette-accent'),
            decoration: BoxDecoration(color: accent),
            padding: const EdgeInsets.all(8),
            child: Text(
              '强调色',
              style: TextStyle(
                color: darkMode
                    ? AppPalette.darkTextPrimary
                    : AppPalette.surface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 顶层切换器：在两种主题间切换；每次切换会重建整棵子树。
class _PaletteSmokeApp extends StatefulWidget {
  const _PaletteSmokeApp();

  @override
  State<_PaletteSmokeApp> createState() => _PaletteSmokeAppState();
}

class _PaletteSmokeAppState extends State<_PaletteSmokeApp> {
  bool _darkMode = false;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: _darkMode ? ThemeMode.dark : ThemeMode.light,
      home: _PaletteSmokePage(darkMode: _darkMode),
    );
  }

  void toggle() => setState(() => _darkMode = !_darkMode);
}

void main() {
  testWidgets(
    '场景 A1：浅色 / 暗色切换 5 次后渲染树颜色全部来自 AppPalette',
    (tester) async {
      await tester.pumpWidget(const _PaletteSmokeApp());
      await tester.pumpAndSettle();

      // 切换 5 次：每次切换后做一次完整断言
      for (var i = 0; i < 5; i++) {
        // 1) 主题色断言：colorScheme 的 primary / surface / outline 必须是
        //    palette 字面量；这是「主题层」对齐的快速断言。
        final BuildContext ctx = tester.element(find.byType(_PaletteSmokePage));
        final theme = Theme.of(ctx);
        expect(
          theme.colorScheme.primary.toARGB32(),
          theme.brightness == Brightness.dark
              ? AppPalette.darkAccent.toARGB32()
              : AppPalette.accent.toARGB32(),
          reason: '第 $i 次切换：colorScheme.primary 应为 palette accent',
        );
        // colorScheme.surface 在浅色下绑定到 warm50（见 AppTheme.light）
        expect(
          theme.colorScheme.surface.toARGB32(),
          theme.brightness == Brightness.dark
              ? AppPalette.darkWarm50.toARGB32()
              : AppPalette.warm50.toARGB32(),
          reason: '第 $i 次切换：colorScheme.surface 应为 palette warm50',
        );
        expect(
          theme.colorScheme.outline.toARGB32(),
          theme.brightness == Brightness.dark
              ? AppPalette.darkBorder.toARGB32()
              : AppPalette.border.toARGB32(),
          reason: '第 $i 次切换：colorScheme.outline 应为 palette border',
        );

        // 2) 渲染树断言：Container / Text 节点出现的所有颜色都属于 palette
        //    （或完全透明）。
        final containers = find
            .descendant(
              of: find.byKey(const ValueKey('palette-smoke-root')),
              matching: find.byType(Container),
            )
            .evaluate()
            .map((e) => e.widget as Container)
            .toList();
        expect(
          containers.length >= 2,
          isTrue,
          reason: '第 $i 次切换：测试页应至少含 2 个 Container 节点',
        );
        for (final c in containers) {
          final color = c.color;
          if (color != null) {
            expect(
              _isPaletteOrTransparent(color),
              isTrue,
              reason: '第 $i 次切换：Container.color 不在 palette 集合：$color',
            );
          }
          final decoration = c.decoration;
          if (decoration is BoxDecoration) {
            final dColor = decoration.color;
            if (dColor != null) {
              expect(
                _isPaletteOrTransparent(dColor),
                isTrue,
                reason:
                    '第 $i 次切换：BoxDecoration.color 不在 palette 集合：$dColor',
              );
            }
            final border = decoration.border;
            if (border is Border) {
              for (final side in <BorderSide>[
                border.top,
                border.right,
                border.bottom,
                border.left,
              ]) {
                if (side.style != BorderStyle.none) {
                  expect(
                    _isPaletteOrTransparent(side.color),
                    isTrue,
                    reason:
                        '第 $i 次切换：边框颜色不在 palette 集合：${side.color}',
                  );
                }
              }
            }
          }
        }

        // 3) Text 节点上的显式颜色（注意：不检查继承自 ThemeData 的 textTheme，
        //    因为 textTheme 内部由 GoogleFonts 派生，颜色虽然属于 palette
        //    但在不同栈上会被 copyWith 出无关字段；本测试只关心我们在
        //    `_PaletteSmokePage` 内显式设定的 TextStyle.color）。
        final texts = find
            .descendant(
              of: find.byKey(const ValueKey('palette-smoke-root')),
              matching: find.byType(Text),
            )
            .evaluate()
            .map((e) => e.widget as Text)
            .toList();
        expect(
          texts.length >= 2,
          isTrue,
          reason: '第 $i 次切换：测试页应至少含 2 个 Text 节点',
        );
        for (final t in texts) {
          final color = t.style?.color;
          if (color != null) {
            expect(
              _isPaletteOrTransparent(color),
              isTrue,
              reason: '第 $i 次切换：Text 颜色不在 palette 集合：$color',
            );
          }
        }

        // 触发下一次切换
        final state =
            tester.state<_PaletteSmokeAppState>(find.byType(_PaletteSmokeApp));
        state.toggle();
        await tester.pumpAndSettle();
      }
    },
  );
}
