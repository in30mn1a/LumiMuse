// AppSurfaces 四种装饰契约单元测试
//
// 覆盖范围：
//   - panel       ：圆角 24、阴影 0 22px 54px rgba(92,74,139,0.08)
//   - panelQuiet  ：圆角 22、无阴影
//   - card        ：圆角 20、阴影 0 14px 28px rgba(92,74,139,0.06)
//   - hero        ：圆角 28、阴影 0 24px 58px rgba(92,74,139,0.10)
//
// 断言策略：
//   1. `borderRadius` 与设计令牌（需求 A1.3）逐字面量相等；
//   2. `boxShadow` 的 blurRadius / offset / color 与 CSS box-shadow 一致；
//   3. 浅色 / 暗色两种模式下圆角与阴影数值不变（颜色随模式调整）；
//   4. 移动端响应式收缩常量 heroCompactRadius / panelCompactRadius 为 18。
//
// Validates: Requirements A1.3

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/surfaces.dart';

/// 把 BoxDecoration 的 borderRadius 提取为 `Radius` 字面量，
/// 假定四种装饰均使用 `BorderRadius.circular(...)`（即四角同径）。
Radius _topLeftRadius(BoxDecoration decoration) {
  final br = decoration.borderRadius;
  expect(br, isA<BorderRadius>(), reason: 'borderRadius 应为 BorderRadius 类型');
  return (br! as BorderRadius).topLeft;
}

void main() {
  group('AppSurfaces · borderRadius 数值（需求 A1.3）', () {
    test('panel 圆角为 24 像素', () {
      expect(_topLeftRadius(AppSurfaces.panel()), const Radius.circular(24));
      expect(
        _topLeftRadius(AppSurfaces.panel(mode: Brightness.dark)),
        const Radius.circular(24),
        reason: '暗色模式下 panel 圆角不变',
      );
    });

    test('panelQuiet 圆角为 22 像素', () {
      expect(_topLeftRadius(AppSurfaces.panelQuiet()), const Radius.circular(22));
      expect(
        _topLeftRadius(AppSurfaces.panelQuiet(mode: Brightness.dark)),
        const Radius.circular(22),
        reason: '暗色模式下 panelQuiet 圆角不变',
      );
    });

    test('card 圆角为 20 像素', () {
      expect(_topLeftRadius(AppSurfaces.card()), const Radius.circular(20));
      expect(
        _topLeftRadius(AppSurfaces.card(mode: Brightness.dark)),
        const Radius.circular(20),
        reason: '暗色模式下 card 圆角不变',
      );
    });

    test('hero 圆角为 28 像素', () {
      expect(_topLeftRadius(AppSurfaces.hero()), const Radius.circular(28));
      expect(
        _topLeftRadius(AppSurfaces.hero(mode: Brightness.dark)),
        const Radius.circular(28),
        reason: '暗色模式下 hero 圆角不变',
      );
    });

    test('四角圆角同径（symmetric）', () {
      // 任何一面均使用 `BorderRadius.circular(...)`，四角必须一致
      for (final dec in <BoxDecoration>[
        AppSurfaces.panel(),
        AppSurfaces.panelQuiet(),
        AppSurfaces.card(),
        AppSurfaces.hero(),
      ]) {
        final br = dec.borderRadius! as BorderRadius;
        expect(br.topLeft, br.topRight);
        expect(br.topRight, br.bottomLeft);
        expect(br.bottomLeft, br.bottomRight);
      }
    });
  });

  group('AppSurfaces · boxShadow 数值（需求 A1.3）', () {
    test('panel 阴影：0 22px 54px rgba(92,74,139,0.08)', () {
      // CSS 字面量：box-shadow: 0 22px 54px rgba(92, 74, 139, 0.08)
      // ARGB 表示：0x14 ≈ round(0.08 * 255) = 20 = 0x14
      const expected = BoxShadow(
        color: Color(0x145C4A8B),
        blurRadius: 54,
        offset: Offset(0, 22),
      );

      final shadows = AppSurfaces.panel().boxShadow;
      expect(shadows, isNotNull);
      expect(shadows!.length, 1, reason: 'panel 必须只有一条阴影');

      final actual = shadows.single;
      expect(actual.color, expected.color);
      expect(actual.blurRadius, expected.blurRadius);
      expect(actual.offset, expected.offset);
      expect(actual.spreadRadius, 0, reason: 'panel 阴影无扩散半径');

      // 暗色模式下阴影数值保持一致
      final darkShadow = AppSurfaces.panel(mode: Brightness.dark).boxShadow!.single;
      expect(darkShadow.color, expected.color);
      expect(darkShadow.blurRadius, expected.blurRadius);
      expect(darkShadow.offset, expected.offset);
    });

    test('panelQuiet 无阴影（CSS 中无 box-shadow）', () {
      // surface-panel-quiet 在 globals.css 中不声明 box-shadow，
      // 实现里要么 boxShadow 为 null，要么为空数组，二者皆视为「无阴影」
      final lightShadows = AppSurfaces.panelQuiet().boxShadow;
      final darkShadows =
          AppSurfaces.panelQuiet(mode: Brightness.dark).boxShadow;
      expect(lightShadows == null || lightShadows.isEmpty, isTrue);
      expect(darkShadows == null || darkShadows.isEmpty, isTrue);
    });

    test('card 阴影：0 14px 28px rgba(92,74,139,0.06)', () {
      // 0x0F = round(0.06 * 255) = 15 = 0x0F
      const expected = BoxShadow(
        color: Color(0x0F5C4A8B),
        blurRadius: 28,
        offset: Offset(0, 14),
      );

      final shadows = AppSurfaces.card().boxShadow;
      expect(shadows, isNotNull);
      expect(shadows!.length, 1, reason: 'card 必须只有一条阴影');

      final actual = shadows.single;
      expect(actual.color, expected.color);
      expect(actual.blurRadius, expected.blurRadius);
      expect(actual.offset, expected.offset);
      expect(actual.spreadRadius, 0, reason: 'card 阴影无扩散半径');

      final darkShadow = AppSurfaces.card(mode: Brightness.dark).boxShadow!.single;
      expect(darkShadow.color, expected.color);
      expect(darkShadow.blurRadius, expected.blurRadius);
      expect(darkShadow.offset, expected.offset);
    });

    test('hero 阴影：0 24px 58px rgba(92,74,139,0.10)', () {
      // 0x1A = round(0.10 * 255) = 26 = 0x1A
      const expected = BoxShadow(
        color: Color(0x1A5C4A8B),
        blurRadius: 58,
        offset: Offset(0, 24),
      );

      final shadows = AppSurfaces.hero().boxShadow;
      expect(shadows, isNotNull);
      expect(shadows!.length, 1, reason: 'hero 必须只有一条阴影');

      final actual = shadows.single;
      expect(actual.color, expected.color);
      expect(actual.blurRadius, expected.blurRadius);
      expect(actual.offset, expected.offset);
      expect(actual.spreadRadius, 0, reason: 'hero 阴影无扩散半径');

      final darkShadow = AppSurfaces.hero(mode: Brightness.dark).boxShadow!.single;
      expect(darkShadow.color, expected.color);
      expect(darkShadow.blurRadius, expected.blurRadius);
      expect(darkShadow.offset, expected.offset);
    });
  });

  group('AppSurfaces · 响应式收缩常量（需求 A4.3）', () {
    test('heroCompactRadius / panelCompactRadius 均为 18 像素', () {
      // globals.css `@media (max-width: 760px)` 下：
      //   .surface-hero  { border-radius: 18px; }
      //   .surface-panel { border-radius: 18px; }
      expect(AppSurfaces.heroCompactRadius, 18);
      expect(AppSurfaces.panelCompactRadius, 18);
    });
  });

  group('AppSurfaces · 公开阴影常量与四种装饰的字面量一致', () {
    // 对外暴露的阴影常量必须与各 BoxDecoration 内嵌的阴影一致，
    // 防止「常量改了但 BoxDecoration 没改」造成漂移。
    test('softPanelShadow == panel.boxShadow.single', () {
      final shadow = AppSurfaces.panel().boxShadow!.single;
      expect(shadow.color, AppSurfaces.softPanelShadow.color);
      expect(shadow.blurRadius, AppSurfaces.softPanelShadow.blurRadius);
      expect(shadow.offset, AppSurfaces.softPanelShadow.offset);
    });

    test('softCardShadow == card.boxShadow.single', () {
      final shadow = AppSurfaces.card().boxShadow!.single;
      expect(shadow.color, AppSurfaces.softCardShadow.color);
      expect(shadow.blurRadius, AppSurfaces.softCardShadow.blurRadius);
      expect(shadow.offset, AppSurfaces.softCardShadow.offset);
    });

    test('heroShadow == hero.boxShadow.single', () {
      final shadow = AppSurfaces.hero().boxShadow!.single;
      expect(shadow.color, AppSurfaces.heroShadow.color);
      expect(shadow.blurRadius, AppSurfaces.heroShadow.blurRadius);
      expect(shadow.offset, AppSurfaces.heroShadow.offset);
    });
  });
}
