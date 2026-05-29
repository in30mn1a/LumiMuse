import 'package:flutter/material.dart';

import 'font_config.dart';

/// LumiMuse 主题定义 — 淡紫、轻奢、安静、柔和、陪伴感
/// 完整还原原版 CSS 设计语言
class AppTheme {
  AppTheme._();

  // ═══════════════════════════════════════════════════════════════
  // 核心色板 — 与原版 globals.css 完全对应
  // ═══════════════════════════════════════════════════════════════

  // 暖色阶梯
  static const Color warm50 = Color(0xFFFAF7FF);
  static const Color warm100 = Color(0xFFF2EBFF);
  static const Color warm200 = Color(0xFFE4D7FF);
  static const Color warm300 = Color(0xFFC7B0FF);

  // 主色
  static const Color accent = Color(0xFF9B7CF0);
  static const Color accentLight = Color(0xFFC4B0FF);
  static const Color accentDark = Color(0xFF6F52C5);

  // 表面
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceRaised = Color(0xFFFCFBFF);

  // 文字
  static const Color textPrimary = Color(0xFF221B33);
  static const Color textSecondary = Color(0xFF5C5670);
  static const Color textMuted = Color(0xFF887F9C);

  // 边框
  static const Color border = Color(0xFFDDD1F2);
  static const Color borderLight = Color(0xFFECE5FB);

  // 暗色模式
  static const Color darkWarm50 = Color(0xFF171321);
  static const Color darkWarm100 = Color(0xFF20192E);
  static const Color darkWarm200 = Color(0xFF2A223B);
  static const Color darkWarm300 = Color(0xFF3B3251);
  static const Color darkAccent = Color(0xFFC4B0FF);
  static const Color darkAccentDark = Color(0xFF9B7CF0);
  static const Color darkSurface = Color(0xFF1F192D);
  static const Color darkSurfaceRaised = Color(0xFF29203A);
  static const Color darkTextPrimary = Color(0xFFF3EFFC);
  static const Color darkTextSecondary = Color(0xFFBBB2CF);
  static const Color darkTextMuted = Color(0xFF8F86A4);
  static const Color darkBorder = Color(0xFF3A304F);
  static const Color darkBorderLight = Color(0xFF2F2643);

  // 兼容旧引用
  static const Color primaryLight = accent;
  static const Color primaryDark = accentDark;
  static const Color textSecondaryLight = textSecondary;

  // ═══════════════════════════════════════════════════════════════
  // 消息气泡渐变
  // ═══════════════════════════════════════════════════════════════

  static const LinearGradient userBubbleGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, accentDark],
  );

  static const BoxShadow userBubbleShadow = BoxShadow(
    color: Color(0x386F52C5), // rgba(111, 82, 197, 0.22)
    blurRadius: 30,
    offset: Offset(0, 14),
  );

  static const BoxShadow panelShadow = BoxShadow(
    color: Color(0x145C4A8B), // rgba(92, 74, 139, 0.08)
    blurRadius: 54,
    offset: Offset(0, 22),
  );

  static const BoxShadow cardShadow = BoxShadow(
    color: Color(0x0F5C4A8B), // rgba(92, 74, 139, 0.06)
    blurRadius: 24,
    offset: Offset(0, 12),
  );

  /// 中文正文 — 霞鹜文楷
  static TextStyle _body(
    FontStack stack, {
    required double fontSize,
    FontWeight? fontWeight,
    required Color color,
    double? height,
    double? letterSpacing,
  }) {
    return FontConfig.withBodyFontStack(
      TextStyle(
        fontSize: fontSize,
        fontWeight: fontWeight,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
      ),
      stack,
    );
  }

  /// 亮色主题
  ///
  /// [fontStack] 决定整个 `ThemeData.textTheme` 的 `fontFamily` /
  /// `fontFamilyFallback`。字体切换必须通过 `MaterialApp` 顶层重建
  /// 实现（参见 [FontStack] 头部注释 / INV-9 / RC-8），子 widget 不要
  /// 自己根据 fontKind 分支字体。
  static ThemeData light({FontStack fontStack = FontConfig.defaultStack}) {
    const colorScheme = ColorScheme.light(
      primary: accent,
      secondary: accentLight,
      surface: warm50,
      onPrimary: Colors.white,
      onSecondary: textPrimary,
      onSurface: textPrimary,
      outline: border,
      outlineVariant: borderLight,
    );

    return _polishInteraction(
      ThemeData(
        useMaterial3: true,
        colorScheme: colorScheme,
        scaffoldBackgroundColor: const Color(0xFFF6F1FF), // 原版 html background
        cardColor: surface,
        dividerColor: borderLight,
        textTheme: _buildTextTheme(textPrimary, textSecondary, fontStack),
        appBarTheme: AppBarTheme(
          backgroundColor: Colors.transparent,
          foregroundColor: textPrimary,
          elevation: 0,
          scrolledUnderElevation: 0,
          centerTitle: false,
          titleTextStyle: _body(
            fontStack,
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: textPrimary,
          ),
        ),
        cardTheme: CardThemeData(
          color: surface.withValues(alpha: 0.9),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: const BorderSide(color: borderLight),
          ),
          shadowColor: const Color(0x0F5C4A8B),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: surface.withValues(alpha: 0.86),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: const BorderSide(color: borderLight),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: const BorderSide(color: borderLight),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: BorderSide(
              color: accent.withValues(alpha: 0.46),
              width: 1.5,
            ),
          ),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 16,
            vertical: 14,
          ),
          hintStyle: _body(
            fontStack,
            fontSize: 14,
            color: textMuted.withValues(alpha: 0.7),
          ),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: accent,
            foregroundColor: Colors.white,
            elevation: 0,
            shadowColor: const Color(0x386F52C5),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            textStyle: _body(
              fontStack,
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: Colors.white,
            ),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: textPrimary,
            side: const BorderSide(color: borderLight),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            backgroundColor: surface.withValues(alpha: 0.72),
          ),
        ),
        floatingActionButtonTheme: FloatingActionButtonThemeData(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          elevation: 8,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
          ),
        ),
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: surface.withValues(alpha: 0.92),
          indicatorColor: accent.withValues(alpha: 0.12),
          labelTextStyle: WidgetStatePropertyAll(
            _body(
              fontStack,
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: textPrimary,
            ),
          ),
        ),
        popupMenuTheme: PopupMenuThemeData(
          color: surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: borderLight),
          ),
          elevation: 8,
          shadowColor: const Color(0x145C4A8B),
        ),
        dialogTheme: DialogThemeData(
          backgroundColor: surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(24),
          ),
          titleTextStyle: _body(
            fontStack,
            fontSize: 20,
            fontWeight: FontWeight.w500,
            color: textPrimary,
            height: 1.35,
          ),
          contentTextStyle: _body(
            fontStack,
            fontSize: 14,
            color: textPrimary,
            height: 1.65,
          ),
          elevation: 16,
          shadowColor: const Color(0x1A5C4A8B),
        ),
        snackBarTheme: SnackBarThemeData(
          backgroundColor: surface,
          contentTextStyle: _body(fontStack, fontSize: 13, color: textPrimary),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          behavior: SnackBarBehavior.floating,
          elevation: 4,
        ),
        bottomSheetTheme: const BottomSheetThemeData(
          backgroundColor: surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          ),
        ),
        switchTheme: SwitchThemeData(
          thumbColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) return accent;
            return textMuted.withValues(alpha: 0.4);
          }),
          trackColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) {
              return accent.withValues(alpha: 0.3);
            }
            return textMuted.withValues(alpha: 0.12);
          }),
        ),
        sliderTheme: SliderThemeData(
          activeTrackColor: accent,
          inactiveTrackColor: accent.withValues(alpha: 0.15),
          thumbColor: accent,
          overlayColor: accent.withValues(alpha: 0.12),
        ),
      ),
    );
  }

  /// 暗色主题
  ///
  /// [fontStack] 决定整个 `ThemeData.textTheme` 的 `fontFamily` /
  /// `fontFamilyFallback`，与 [light] 保持一致的字体切换契约。
  static ThemeData dark({FontStack fontStack = FontConfig.defaultStack}) {
    const colorScheme = ColorScheme.dark(
      primary: darkAccent,
      secondary: darkAccentDark,
      surface: darkWarm50,
      onPrimary: darkWarm50,
      onSecondary: darkTextPrimary,
      onSurface: darkTextPrimary,
      outline: darkBorder,
      outlineVariant: darkBorderLight,
    );

    return _polishInteraction(
      ThemeData(
        useMaterial3: true,
        colorScheme: colorScheme,
        scaffoldBackgroundColor: darkWarm50,
        cardColor: darkSurface,
        dividerColor: darkBorderLight,
        textTheme: _buildTextTheme(
          darkTextPrimary,
          darkTextSecondary,
          fontStack,
        ),
        appBarTheme: AppBarTheme(
          backgroundColor: Colors.transparent,
          foregroundColor: darkTextPrimary,
          elevation: 0,
          scrolledUnderElevation: 0,
          centerTitle: false,
          titleTextStyle: _body(
            fontStack,
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: darkTextPrimary,
          ),
        ),
        cardTheme: CardThemeData(
          color: darkSurface,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(color: darkBorder.withValues(alpha: 0.5)),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: darkSurfaceRaised,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: const BorderSide(color: darkBorder),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: const BorderSide(color: darkBorder),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(16),
            borderSide: BorderSide(
              color: darkAccent.withValues(alpha: 0.5),
              width: 1.5,
            ),
          ),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 16,
            vertical: 14,
          ),
          hintStyle: _body(
            fontStack,
            fontSize: 14,
            color: darkTextMuted.withValues(alpha: 0.7),
          ),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: darkAccentDark,
            foregroundColor: Colors.white,
            // FIX: 暗色模式显式声明 elevation/shadowColor，避免依赖 ThemeData 默认值
            elevation: 0,
            shadowColor: Colors.transparent,
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            textStyle: _body(
              fontStack,
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: Colors.white,
            ),
          ),
        ),
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: darkSurface.withValues(alpha: 0.92),
          indicatorColor: darkAccent.withValues(alpha: 0.15),
          labelTextStyle: WidgetStatePropertyAll(
            _body(
              fontStack,
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: darkTextPrimary,
            ),
          ),
        ),
        popupMenuTheme: PopupMenuThemeData(
          color: darkSurfaceRaised,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: darkBorder),
          ),
          // FIX: 暗色模式显式声明 elevation/shadowColor，避免依赖 ThemeData 默认值
          elevation: 0,
          shadowColor: Colors.transparent,
        ),
        dialogTheme: DialogThemeData(
          backgroundColor: darkSurfaceRaised,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(24),
          ),
          titleTextStyle: _body(
            fontStack,
            fontSize: 20,
            fontWeight: FontWeight.w500,
            color: darkTextPrimary,
            height: 1.35,
          ),
          contentTextStyle: _body(
            fontStack,
            fontSize: 14,
            color: darkTextPrimary,
            height: 1.65,
          ),
          // FIX: 暗色模式显式声明 elevation/shadowColor，避免依赖 ThemeData 默认值
          elevation: 16,
          shadowColor: const Color(0x33000000),
        ),
        snackBarTheme: SnackBarThemeData(
          backgroundColor: darkSurfaceRaised,
          contentTextStyle: _body(
            fontStack,
            fontSize: 13,
            color: darkTextPrimary,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          behavior: SnackBarBehavior.floating,
          // FIX: 暗色模式显式声明 elevation，避免依赖 ThemeData 默认值
          elevation: 0,
        ),
        bottomSheetTheme: const BottomSheetThemeData(
          backgroundColor: darkSurfaceRaised,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          ),
        ),
        switchTheme: SwitchThemeData(
          thumbColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) return darkAccent;
            return darkTextMuted.withValues(alpha: 0.4);
          }),
          trackColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) {
              return darkAccent.withValues(alpha: 0.3);
            }
            return darkTextMuted.withValues(alpha: 0.12);
          }),
        ),
        sliderTheme: SliderThemeData(
          activeTrackColor: darkAccent,
          inactiveTrackColor: darkAccent.withValues(alpha: 0.15),
          thumbColor: darkAccent,
        ),
      ),
    );
  }

  /// 弱化 Material 水波纹，贴近主项目 soft-button 手感
  static ThemeData _polishInteraction(ThemeData theme) {
    return theme.copyWith(
      splashFactory: NoSplash.splashFactory,
      splashColor: Colors.transparent,
      highlightColor: Colors.transparent,
      hoverColor: Colors.transparent,
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: CupertinoPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          // 桌面端（Windows/macOS/Linux）同样采用 Cupertino 横滑转场，
          // 避免默认 ZoomPageTransitionsBuilder 与移动端风格割裂。
          TargetPlatform.windows: CupertinoPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.linux: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }

  /// 构建 TextTheme：display/headline/title → Quicksand，body/label → 霞鹜文楷
  static TextTheme _buildTextTheme(
    Color primary,
    Color secondary, [
    FontStack fontStack = FontConfig.defaultStack,
  ]) {
    final baseTheme = TextTheme(
      displayLarge: TextStyle(
        fontSize: 32,
        fontWeight: FontWeight.w600,
        color: primary,
      ),
      headlineMedium: TextStyle(
        fontSize: 24,
        fontWeight: FontWeight.w600,
        color: primary,
      ),
      titleLarge: TextStyle(
        fontSize: 20,
        fontWeight: FontWeight.w500,
        color: primary,
      ),
      titleMedium: TextStyle(
        fontSize: 16,
        fontWeight: FontWeight.w600,
        color: primary,
      ),
      bodyLarge: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w400,
        color: primary,
        height: 1.65,
      ),
      bodyMedium: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w400,
        color: primary,
        height: 1.65,
      ),
      bodySmall: TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w400,
        color: secondary,
        height: 1.5,
      ),
      labelLarge: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        color: primary,
      ),
      labelSmall: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w500,
        color: secondary,
        letterSpacing: 0.5,
      ),
    );

    return FontConfig.applyFontStack(baseTheme, fontStack);
  }
}

// ═══════════════════════════════════════════════════════════════
// AppPalette — 设计令牌色板契约
// ═══════════════════════════════════════════════════════════════
//
// 与主项目 `src/app/globals.css` 的 `@theme` / `.dark` 区块逐字面量对应，
// 字段命名严格沿用其 CSS 变量名（去掉 `--color-` 前缀、连字符转驼峰）。
//
// 设计契约：
// 1. 浅色 14 个常量、暗色 13 个常量（暗色没有 `darkAccentLight`），
//    对应需求 A1.1 / A1.2 与 design §1.1 的设计令牌。
// 2. 本类仅作为「子 spec 共用的色值字面量来源」暴露给主题之外的调用方
//    （例如 `AppSurfaces` / `AppShell` / 各 widget 直接取色），保持
//    与 `AppTheme` 内静态字段并行存在；本任务不在此处替换任何现有调用方。
// 3. 任何对色板的修改必须先回到 `src/app/globals.css` 调整，再同步到本类，
//    以维持「主项目是唯一基准」。
abstract class AppPalette {
  AppPalette._();

  // ── 浅色：暖色阶梯（warm-50/100/200/300） ──
  /// `--color-warm-50` — 应用底纹 / 弱化背景
  static const Color warm50 = Color(0xFFFAF7FF);

  /// `--color-warm-100` — 卡片悬浮背景
  static const Color warm100 = Color(0xFFF2EBFF);

  /// `--color-warm-200` — 高亮 chip / 选中态背景
  static const Color warm200 = Color(0xFFE4D7FF);

  /// `--color-warm-300` — 装饰边线 / 悬停色
  static const Color warm300 = Color(0xFFC7B0FF);

  // ── 浅色：主色（accent / accent-light / accent-dark） ──
  /// `--color-accent` — 主色，淡紫主调
  static const Color accent = Color(0xFF9B7CF0);

  /// `--color-accent-light` — 主色浅版（按钮悬停 / 高亮渐变末端）
  static const Color accentLight = Color(0xFFC4B0FF);

  /// `--color-accent-dark` — 主色深版（用户气泡渐变末端 / 强调态文字）
  static const Color accentDark = Color(0xFF6F52C5);

  // ── 浅色：表面（surface / surface-raised） ──
  /// `--color-surface` — 基础表面（卡片纯白底）
  static const Color surface = Color(0xFFFFFFFF);

  /// `--color-surface-raised` — 抬升表面（输入框 / 悬浮背景）
  static const Color surfaceRaised = Color(0xFFFCFBFF);

  // ── 浅色：文字（text-primary / text-secondary / text-muted） ──
  /// `--color-text-primary` — 主文字色
  static const Color textPrimary = Color(0xFF221B33);

  /// `--color-text-secondary` — 次级文字（描述 / 副标题）
  static const Color textSecondary = Color(0xFF5C5670);

  /// `--color-text-muted` — 弱化文字（占位符 / 计数器）
  static const Color textMuted = Color(0xFF887F9C);

  // ── 浅色：边框（border / border-light） ──
  /// `--color-border` — 标准边框
  static const Color border = Color(0xFFDDD1F2);

  /// `--color-border-light` — 浅色边框（卡片描边 / 分隔线）
  static const Color borderLight = Color(0xFFECE5FB);

  // ═══════════════════════════════════════════════════════════════
  // 暗色色板 — 对应 globals.css `.dark` 区块
  // ═══════════════════════════════════════════════════════════════

  // ── 暗色：暖色阶梯 ──
  /// `.dark --color-warm-50` — 暗色应用底色
  static const Color darkWarm50 = Color(0xFF171321);

  /// `.dark --color-warm-100` — 暗色卡片悬浮背景
  static const Color darkWarm100 = Color(0xFF20192E);

  /// `.dark --color-warm-200` — 暗色高亮 chip
  static const Color darkWarm200 = Color(0xFF2A223B);

  /// `.dark --color-warm-300` — 暗色装饰边线
  static const Color darkWarm300 = Color(0xFF3B3251);

  // ── 暗色：主色（accent / accent-dark；暗色无 accentLight） ──
  /// `.dark --color-accent` — 暗色主色（在暗色模式下变为浅版淡紫）
  static const Color darkAccent = Color(0xFFC4B0FF);

  /// `.dark --color-accent-dark` — 暗色主色深版（与浅色 `accent` 同值）
  static const Color darkAccentDark = Color(0xFF9B7CF0);

  // ── 暗色：表面 ──
  /// `.dark --color-surface` — 暗色基础表面
  static const Color darkSurface = Color(0xFF1F192D);

  /// `.dark --color-surface-raised` — 暗色抬升表面
  static const Color darkSurfaceRaised = Color(0xFF29203A);

  // ── 暗色：文字 ──
  /// `.dark --color-text-primary` — 暗色主文字
  static const Color darkTextPrimary = Color(0xFFF3EFFC);

  /// `.dark --color-text-secondary` — 暗色次级文字
  static const Color darkTextSecondary = Color(0xFFBBB2CF);

  /// `.dark --color-text-muted` — 暗色弱化文字
  static const Color darkTextMuted = Color(0xFF8F86A4);

  // ── 暗色：边框 ──
  /// `.dark --color-border` — 暗色标准边框
  static const Color darkBorder = Color(0xFF3A304F);

  /// `.dark --color-border-light` — 暗色浅色边框
  static const Color darkBorderLight = Color(0xFF2F2643);
}
