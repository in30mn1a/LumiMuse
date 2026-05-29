import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import 'app_breakpoints.dart';
import 'app_theme.dart';

/// LumiMuse 主题的「表面」装饰封装
///
/// 对应主项目 `src/app/globals.css` 中的四种 surface：
/// - `.surface-panel` ：白色磨砂大面板（圆角 24，强阴影）
/// - `.surface-panel-quiet` ：淡紫底次级面板（圆角 22，无阴影）
/// - `.surface-card` ：白色卡片（圆角 20，轻阴影）
/// - `.surface-hero` ：渐变 Hero 卡片（圆角 28，强阴影）
///
/// 设计约束（参见 `flutter-pixel-perfect-parity` design §1.1 与需求 A1.3 / A4.3 / A5.1）：
///
/// 1. 阴影 / 边框 / 背景透明度严格对齐 CSS 数值，禁止再次"接近"修订；
/// 2. 圆角值固定为 `24 / 22 / 20 / 28`，**不在本类内部判定断点**；
/// 3. 移动端响应式收缩规约通过 [heroCompactRadius] / [panelCompactRadius] 暴露，
///    由调用方根据自己的 `MediaQuery` 决定何时套用紧凑圆角。
///
/// 为保持向后兼容，所有方法同时接受 `bool isDark`（旧）与 `Brightness? mode`（新签名）。
/// 当二者同时提供时，`mode` 优先；任一未给出时回退到默认浅色。
class AppSurfaces {
  AppSurfaces._();

  /// 毛玻璃模糊强度 — 对齐主项目 `backdrop-filter: blur(18px)`，移动端略降以保流畅
  static const double kBackdropBlurDesktop = 18;
  static const double kBackdropBlurMobile = 14;

  static double backdropBlurFor(BuildContext context) =>
      AppBreakpoints.isMobileOf(context)
          ? kBackdropBlurMobile
          : kBackdropBlurDesktop;

  static double panelRadiusFor(BuildContext? context) =>
      context != null && AppBreakpoints.isMobileOf(context)
          ? panelCompactRadius
          : 24;

  static double heroRadiusFor(BuildContext? context) =>
      context != null && AppBreakpoints.isMobileOf(context) ? 20 : 28;

  static double cardRadiusFor(BuildContext? context) =>
      context != null && AppBreakpoints.isMobileOf(context) ? 16 : 20;

  static double quietRadiusFor(BuildContext? context) =>
      context != null && AppBreakpoints.isMobileOf(context) ? 16 : 22;

  // ─── 响应式收缩常量（移动端调用方按需套用）────────────────────────
  // 主项目 globals.css `@media (max-width: 760px)` 区块中：
  // `.surface-hero  { border-radius: 18px; }`
  // `.surface-panel { border-radius: 18px; }`
  // 调用方应自行通过 `MediaQuery.sizeOf(context).width < 760` 判定，并使用
  // [BoxDecoration.copyWith] 或重新构造 `BorderRadius.circular(...)`。
  /// surface-hero 在窄屏（< 760 像素）下的收缩圆角，单位：像素
  static const double heroCompactRadius = 18;

  /// surface-panel 在窄屏（< 760 像素）下的收缩圆角，单位：像素
  static const double panelCompactRadius = 18;

  // ─── 阴影（与 CSS box-shadow 字面量严格对齐）───────────────────────

  /// `box-shadow: 0 22px 54px rgba(92, 74, 139, 0.08)`
  static const BoxShadow softPanelShadow = BoxShadow(
    color: Color(0x145C4A8B), // rgba(92, 74, 139, 0.08)
    blurRadius: 54,
    offset: Offset(0, 22),
  );

  /// `box-shadow: 0 14px 28px rgba(92, 74, 139, 0.06)`
  static const BoxShadow softCardShadow = BoxShadow(
    color: Color(0x0F5C4A8B), // rgba(92, 74, 139, 0.06)
    blurRadius: 28,
    offset: Offset(0, 14),
  );

  /// `box-shadow: 0 24px 58px rgba(92, 74, 139, 0.10)`
  static const BoxShadow heroShadow = BoxShadow(
    color: Color(0x1A5C4A8B), // rgba(92, 74, 139, 0.10)
    blurRadius: 58,
    offset: Offset(0, 24),
  );

  /// 把外部传入的 `mode` / `isDark` 统一归一为 `bool isDark`
  /// （`mode` 提供时优先）
  static bool _resolveDark({Brightness? mode, bool isDark = false}) {
    if (mode != null) return mode == Brightness.dark;
    return isDark;
  }

  // ─── surface-panel ──────────────────────────────────────────────
  /// 主侧栏 / 主面板：白色磨砂、24 圆角、强阴影
  ///
  /// 对应 `.surface-panel`：
  /// `background: rgba(255, 255, 255, 0.82); border: 1px solid var(--color-border-light);`
  /// `border-radius: 24px; box-shadow: 0 22px 54px rgba(92, 74, 139, 0.08);`
  static BoxDecoration panel({
    bool isDark = false,
    Brightness? mode,
    BuildContext? context,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      color: dark
          ? AppTheme.darkSurface.withValues(alpha: 0.78)
          : Colors.white.withValues(alpha: 0.82),
      border: Border.all(
        color: dark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: BorderRadius.circular(panelRadiusFor(context)),
      boxShadow: const [softPanelShadow],
    );
  }

  /// 弹窗面板：沿用 surface-panel 的圆角 / 边框 / 阴影，但使用不透明底色。
  ///
  /// 常规页面面板保留主项目的磨砂透明度；模态弹窗已经有 barrier 负责遮罩，
  /// 面板自身再半透明会让底层正文穿透，影响可读性。
  static BoxDecoration dialogPanel({
    bool isDark = false,
    Brightness? mode,
    BuildContext? context,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return panel(
      isDark: dark,
      context: context,
    ).copyWith(color: dark ? AppTheme.darkSurface : AppTheme.surface);
  }

  // ─── surface-panel-quiet ────────────────────────────────────────
  /// 次级面板：淡紫底色、22 圆角、无阴影
  ///
  /// 对应 `.surface-panel-quiet`：
  /// `background: rgba(247, 243, 255, 0.84); border: 1px solid rgba(155, 124, 240, 0.12);`
  /// `border-radius: 22px;`（CSS 中无 box-shadow，本实现保持一致）
  static BoxDecoration panelQuiet({
    bool isDark = false,
    Brightness? mode,
    BuildContext? context,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      color: dark
          ? AppTheme.darkWarm100.withValues(alpha: 0.78)
          : const Color(0xFFF7F3FF).withValues(alpha: 0.84),
      border: Border.all(
        color: (dark ? AppTheme.darkAccent : AppTheme.accent)
            .withValues(alpha: 0.12),
      ),
      borderRadius: BorderRadius.circular(quietRadiusFor(context)),
    );
  }

  // ─── surface-card ───────────────────────────────────────────────
  /// 卡片：白色、20 圆角、轻阴影
  ///
  /// 对应 `.surface-card`：
  /// `background: rgba(255, 255, 255, 0.9); border: 1px solid var(--color-border-light);`
  /// `border-radius: 20px; box-shadow: 0 14px 28px rgba(92, 74, 139, 0.06);`
  static BoxDecoration card({
    bool isDark = false,
    Brightness? mode,
    BuildContext? context,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      color: dark
          ? AppTheme.darkSurface.withValues(alpha: 0.9)
          : Colors.white.withValues(alpha: 0.9),
      border: Border.all(
        color: dark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: BorderRadius.circular(cardRadiusFor(context)),
      boxShadow: const [softCardShadow],
    );
  }

  // ─── surface-hero ───────────────────────────────────────────────
  /// Hero 卡片：渐变 + 28 圆角 + 强阴影 — 用于侧栏 Logo / 聊天头部
  ///
  /// 对应 `.surface-hero`：
  /// `background: linear-gradient(135deg, rgba(155, 124, 240, 0.16) 0%,`
  /// `  rgba(255, 255, 255, 0.88) 58%, rgba(198, 177, 255, 0.1) 100%);`
  /// `border: 1px solid rgba(155, 124, 240, 0.16);`
  /// `border-radius: 28px; box-shadow: 0 24px 58px rgba(92, 74, 139, 0.1);`
  ///
  /// 注意：渐变第三色严格使用 `#C6B1FF`（即 `rgba(198, 177, 255)`），
  /// 与 [AppTheme.accentLight]（`#C4B0FF`）相差 2 / 1 / 0，**不要替换**。
  static BoxDecoration hero({
    bool isDark = false,
    Brightness? mode,
    BuildContext? context,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: dark
            ? [
                AppTheme.darkAccent.withValues(alpha: 0.14),
                AppTheme.darkSurface.withValues(alpha: 0.78),
                AppTheme.darkAccent.withValues(alpha: 0.10),
              ]
            : [
                // rgba(155, 124, 240, 0.16) — accent @ 0.16
                AppTheme.accent.withValues(alpha: 0.16),
                // rgba(255, 255, 255, 0.88)
                Colors.white.withValues(alpha: 0.88),
                // rgba(198, 177, 255, 0.10) — 严格 CSS 数值，非 accentLight
                const Color(0xFFC6B1FF).withValues(alpha: 0.10),
              ],
        stops: const [0.0, 0.58, 1.0],
      ),
      border: Border.all(
        color: (dark ? AppTheme.darkAccent : AppTheme.accent)
            .withValues(alpha: 0.16),
      ),
      borderRadius: BorderRadius.circular(heroRadiusFor(context)),
      boxShadow: const [heroShadow],
    );
  }

  /// 带毛玻璃的面板容器 — 全局表面统一入口
  static Widget glass({
    required BuildContext context,
    required BoxDecoration decoration,
    required Widget child,
    EdgeInsetsGeometry? padding,
    double? width,
    double? height,
    bool blur = true,
  }) {
    return LumiGlassBox(
      decoration: decoration,
      padding: padding,
      width: width,
      height: height,
      blur: blur,
      blurSigma: backdropBlurFor(context),
      child: child,
    );
  }

  static Widget panelBox({
    required BuildContext context,
    required Widget child,
    bool isDark = false,
    EdgeInsetsGeometry? padding,
    double? width,
    double? height,
  }) {
    return glass(
      context: context,
      decoration: panel(isDark: isDark, context: context),
      padding: padding,
      width: width,
      height: height,
      child: child,
    );
  }

  static Widget heroBox({
    required BuildContext context,
    required Widget child,
    bool isDark = false,
    EdgeInsetsGeometry? padding,
  }) {
    return glass(
      context: context,
      decoration: hero(isDark: isDark, context: context),
      padding: padding,
      child: child,
    );
  }

  // ─── 软按钮主样式（与四种 surface 同体系，保留供调用方使用）────────

  /// soft-button-primary — 渐变填充
  static BoxDecoration buttonPrimary({bool isDark = false, Brightness? mode}) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: dark
            ? [AppTheme.darkAccent, AppTheme.darkAccentDark]
            : [AppTheme.accent, AppTheme.accentDark],
      ),
      borderRadius: BorderRadius.circular(16),
      boxShadow: const [
        BoxShadow(
          color: Color(0x386F52C5), // rgba(111, 82, 197, 0.22)
          blurRadius: 30,
          offset: Offset(0, 14),
        ),
      ],
    );
  }

  /// soft-button-secondary — 半透明白底 + 边框
  static BoxDecoration buttonSecondary({
    bool isDark = false,
    Brightness? mode,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    return BoxDecoration(
      color: dark
          ? AppTheme.darkSurface.withValues(alpha: 0.6)
          : Colors.white.withValues(alpha: 0.72),
      border: Border.all(
        color: dark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: BorderRadius.circular(16),
    );
  }

  /// chip — 标签胶囊
  static BoxDecoration chip({
    bool active = false,
    bool isDark = false,
    Brightness? mode,
  }) {
    final dark = _resolveDark(mode: mode, isDark: isDark);
    if (active) {
      return BoxDecoration(
        color: (dark ? AppTheme.darkAccent : AppTheme.accent)
            .withValues(alpha: 0.12),
        border: Border.all(
          color: (dark ? AppTheme.darkAccent : AppTheme.accent)
              .withValues(alpha: 0.26),
        ),
        borderRadius: BorderRadius.circular(999),
      );
    }
    return BoxDecoration(
      color: dark
          ? AppTheme.darkSurface.withValues(alpha: 0.5)
          : Colors.white.withValues(alpha: 0.72),
      border: Border.all(
        color: dark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: BorderRadius.circular(999),
    );
  }
}

/// 毛玻璃装饰容器 — 对应主项目 `backdrop-filter: blur(...)`
class LumiGlassBox extends StatelessWidget {
  final BoxDecoration decoration;
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final double? width;
  final double? height;
  final bool blur;
  final double blurSigma;

  const LumiGlassBox({
    super.key,
    required this.decoration,
    required this.child,
    this.padding,
    this.width,
    this.height,
    this.blur = true,
    this.blurSigma = AppSurfaces.kBackdropBlurDesktop,
  });

  BorderRadius get _clipRadius {
    final radius = decoration.borderRadius;
    if (radius is BorderRadius) return radius;
    return BorderRadius.zero;
  }

  @override
  Widget build(BuildContext context) {
    Widget inner = Container(
      width: width,
      height: height,
      padding: padding,
      decoration: decoration,
      child: child,
    );

    if (!blur || blurSigma <= 0) {
      return ClipRRect(borderRadius: _clipRadius, child: inner);
    }

    return ClipRRect(
      borderRadius: _clipRadius,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
        child: inner,
      ),
    );
  }
}
