// AppPalette 设计令牌色板单元测试
//
// 覆盖范围：
//   - 浅色 14 个常量（warm-50/100/200/300、accent/light/dark、
//     surface/surfaceRaised、textPrimary/Secondary/Muted、border/borderLight）
//   - 暗色 13 个常量（darkWarm-50/100/200/300、darkAccent/AccentDark、
//     darkSurface/SurfaceRaised、darkTextPrimary/Secondary/Muted、
//     darkBorder/BorderLight）
//
// 断言策略：
//   1. 与需求 A1.1 / A1.2 列出的字面量逐字节相等（同 ARGB 32 位整数值）；
//   2. 同时校验 alpha 通道为 0xFF（CSS 字面量均为不透明色）。
//
// Validates: Requirements A1.1, A1.2

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_theme.dart';

void main() {
  group('AppPalette · 浅色 14 个常量（需求 A1.1）', () {
    test('暖色阶梯 warm-50 / 100 / 200 / 300', () {
      // 与 src/app/globals.css `@theme` 区块逐字面量对应
      expect(AppPalette.warm50, const Color(0xFFFAF7FF));
      expect(AppPalette.warm100, const Color(0xFFF2EBFF));
      expect(AppPalette.warm200, const Color(0xFFE4D7FF));
      expect(AppPalette.warm300, const Color(0xFFC7B0FF));
    });

    test('主色 accent / accent-light / accent-dark', () {
      expect(AppPalette.accent, const Color(0xFF9B7CF0));
      expect(AppPalette.accentLight, const Color(0xFFC4B0FF));
      expect(AppPalette.accentDark, const Color(0xFF6F52C5));
    });

    test('表面 surface / surface-raised', () {
      expect(AppPalette.surface, const Color(0xFFFFFFFF));
      expect(AppPalette.surfaceRaised, const Color(0xFFFCFBFF));
    });

    test('文字 text-primary / text-secondary / text-muted', () {
      expect(AppPalette.textPrimary, const Color(0xFF221B33));
      expect(AppPalette.textSecondary, const Color(0xFF5C5670));
      expect(AppPalette.textMuted, const Color(0xFF887F9C));
    });

    test('边框 border / border-light', () {
      expect(AppPalette.border, const Color(0xFFDDD1F2));
      expect(AppPalette.borderLight, const Color(0xFFECE5FB));
    });

    test('全部浅色常量 alpha 通道为 0xFF（不透明）', () {
      // alpha 字节相等校验，与 CSS 字面量一致
      const lightTokens = <Color>[
        AppPalette.warm50,
        AppPalette.warm100,
        AppPalette.warm200,
        AppPalette.warm300,
        AppPalette.accent,
        AppPalette.accentLight,
        AppPalette.accentDark,
        AppPalette.surface,
        AppPalette.surfaceRaised,
        AppPalette.textPrimary,
        AppPalette.textSecondary,
        AppPalette.textMuted,
        AppPalette.border,
        AppPalette.borderLight,
      ];
      expect(lightTokens.length, 14, reason: '浅色色板必须暴露 14 个常量');
      for (final color in lightTokens) {
        // ignore: deprecated_member_use
        final argb = color.value;
        expect(
          (argb >> 24) & 0xFF,
          0xFF,
          reason: '浅色色板 alpha 通道必须为 0xFF：$color',
        );
      }
    });
  });

  group('AppPalette · 暗色 13 个常量（需求 A1.2）', () {
    test('暖色阶梯 dark warm-50 / 100 / 200 / 300', () {
      // 与 src/app/globals.css `.dark` 区块逐字面量对应
      expect(AppPalette.darkWarm50, const Color(0xFF171321));
      expect(AppPalette.darkWarm100, const Color(0xFF20192E));
      expect(AppPalette.darkWarm200, const Color(0xFF2A223B));
      expect(AppPalette.darkWarm300, const Color(0xFF3B3251));
    });

    test('主色 darkAccent / darkAccentDark（暗色无 accentLight）', () {
      expect(AppPalette.darkAccent, const Color(0xFFC4B0FF));
      expect(AppPalette.darkAccentDark, const Color(0xFF9B7CF0));
    });

    test('表面 darkSurface / darkSurfaceRaised', () {
      expect(AppPalette.darkSurface, const Color(0xFF1F192D));
      expect(AppPalette.darkSurfaceRaised, const Color(0xFF29203A));
    });

    test('文字 darkTextPrimary / Secondary / Muted', () {
      expect(AppPalette.darkTextPrimary, const Color(0xFFF3EFFC));
      expect(AppPalette.darkTextSecondary, const Color(0xFFBBB2CF));
      expect(AppPalette.darkTextMuted, const Color(0xFF8F86A4));
    });

    test('边框 darkBorder / darkBorderLight', () {
      expect(AppPalette.darkBorder, const Color(0xFF3A304F));
      expect(AppPalette.darkBorderLight, const Color(0xFF2F2643));
    });

    test('全部暗色常量 alpha 通道为 0xFF（不透明）', () {
      const darkTokens = <Color>[
        AppPalette.darkWarm50,
        AppPalette.darkWarm100,
        AppPalette.darkWarm200,
        AppPalette.darkWarm300,
        AppPalette.darkAccent,
        AppPalette.darkAccentDark,
        AppPalette.darkSurface,
        AppPalette.darkSurfaceRaised,
        AppPalette.darkTextPrimary,
        AppPalette.darkTextSecondary,
        AppPalette.darkTextMuted,
        AppPalette.darkBorder,
        AppPalette.darkBorderLight,
      ];
      expect(darkTokens.length, 13, reason: '暗色色板必须暴露 13 个常量');
      for (final color in darkTokens) {
        // ignore: deprecated_member_use
        final argb = color.value;
        expect(
          (argb >> 24) & 0xFF,
          0xFF,
          reason: '暗色色板 alpha 通道必须为 0xFF：$color',
        );
      }
    });
  });

  group('AppPalette · 与 AppTheme 内的并行常量保持一致', () {
    // 任务 1.1 约定：AppPalette 与 AppTheme 内的静态字段并行存在，
    // 必须逐字段值相等，避免「一边改了另一边没改」造成漂移。
    test('浅色字段值与 AppTheme 同源', () {
      expect(AppPalette.warm50, AppTheme.warm50);
      expect(AppPalette.warm100, AppTheme.warm100);
      expect(AppPalette.warm200, AppTheme.warm200);
      expect(AppPalette.warm300, AppTheme.warm300);
      expect(AppPalette.accent, AppTheme.accent);
      expect(AppPalette.accentLight, AppTheme.accentLight);
      expect(AppPalette.accentDark, AppTheme.accentDark);
      expect(AppPalette.surface, AppTheme.surface);
      expect(AppPalette.surfaceRaised, AppTheme.surfaceRaised);
      expect(AppPalette.textPrimary, AppTheme.textPrimary);
      expect(AppPalette.textSecondary, AppTheme.textSecondary);
      expect(AppPalette.textMuted, AppTheme.textMuted);
      expect(AppPalette.border, AppTheme.border);
      expect(AppPalette.borderLight, AppTheme.borderLight);
    });

    test('暗色字段值与 AppTheme 同源', () {
      expect(AppPalette.darkWarm50, AppTheme.darkWarm50);
      expect(AppPalette.darkWarm100, AppTheme.darkWarm100);
      expect(AppPalette.darkWarm200, AppTheme.darkWarm200);
      expect(AppPalette.darkWarm300, AppTheme.darkWarm300);
      expect(AppPalette.darkAccent, AppTheme.darkAccent);
      expect(AppPalette.darkAccentDark, AppTheme.darkAccentDark);
      expect(AppPalette.darkSurface, AppTheme.darkSurface);
      expect(AppPalette.darkSurfaceRaised, AppTheme.darkSurfaceRaised);
      expect(AppPalette.darkTextPrimary, AppTheme.darkTextPrimary);
      expect(AppPalette.darkTextSecondary, AppTheme.darkTextSecondary);
      expect(AppPalette.darkTextMuted, AppTheme.darkTextMuted);
      expect(AppPalette.darkBorder, AppTheme.darkBorder);
      expect(AppPalette.darkBorderLight, AppTheme.darkBorderLight);
    });
  });
}
