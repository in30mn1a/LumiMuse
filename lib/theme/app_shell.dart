import 'package:flutter/material.dart';
import 'app_theme.dart';

// ════════════════════════════════════════════════════════════════════
// 应用外壳契约常量
//
// 与主项目 src/app/globals.css 中 .app-shell / ::before / ::after 与
// .dark body 段一一对应，禁止子 spec 在 widget 内就地写颜色或几何值。
// 任务 1.3 / 需求 A1.4 / A4.3 / A5.3 的回归校验依赖这些命名常量。
// ════════════════════════════════════════════════════════════════════

/// 桌面端 .app-shell::after 的 inset（1rem = 16px）。
const double kAppShellDesktopInset = 16;

/// 桌面端 .app-shell::after 的 border-radius（28px）。
const double kAppShellDesktopRadius = 28;

/// 移动端（屏宽 < 768）.app-shell::after 的 inset（0.5rem = 8px）。
const double kAppShellMobileInset = 8;

/// 移动端 .app-shell::after 的 border-radius（20px）。
const double kAppShellMobileRadius = 20;

/// 紫色网格底纹的间距（72×72，与原版 background-size 一致）。
const double kAppShellGridSpacing = 72;

/// 紫框透明度：rgba(155, 124, 240, 0.14)（亮 / 暗共用，颜色由当前模式 accent 注入）。
const double kAppShellBorderAlpha = 0.14;

/// 网格线在亮色模式下的不透明度：rgba(155, 124, 240, 0.08)。
const double kAppShellLightGridAlpha = 0.08;

/// 网格线在暗色模式下的不透明度：rgba(196, 176, 255, 0.06)。
const double kAppShellDarkGridAlpha = 0.06;

/// 亮色模式底层渐变（180deg）— rgba(250, 247, 255, 0.98) → rgba(244, 238, 255, 1)。
const Color _kLightBgTop = Color(0xFFFAF7FF); // alpha 由 0.98 在使用处叠加
const Color _kLightBgBottom = Color(0xFFF4EEFF);
const double _kLightBgTopAlpha = 0.98;

/// 暗色模式底层渐变（180deg）— rgba(23, 19, 33, 0.98) → rgba(17, 14, 25, 1)。
/// 对应主项目 .dark body 的第一组 linear-gradient。
const Color _kDarkBgTop = Color(0xFF171321); // alpha 由 0.98 在使用处叠加
const Color _kDarkBgBottom = Color(0xFF110E19);
const double _kDarkBgTopAlpha = 0.98;

/// 暗色模式网格线颜色：rgba(196, 176, 255, 0.06)。
/// 对应 .dark body 的第二、三组 linear-gradient（横竖向网格线）。
const Color kAppShellDarkGridLineBase = Color(0xFFC4B0FF);

/// 亮色模式网格线颜色：rgba(155, 124, 240, 0.08)（即 accent 配 0.08 alpha）。
const Color kAppShellLightGridLineBase = Color(0xFF9B7CF0);

/// 应用外壳背景 — 复刻 globals.css 中 .app-shell / ::before / ::after 与
/// .dark body 的多层渐变 + 紫色网格 + 内边距细紫框。
///
/// 渲染层次（自底向上）：
/// 1. 基础 180deg 渐变（亮 / 暗模式分支）
/// 2. 72×72 紫色网格底纹（CustomPainter）
/// 3. 左上角斜光高光（::before 等价物）
/// 4. 业务内容
/// 5. 内边距细紫框（::after 等价物，桌面 16px inset + 28px 圆角，
///    移动端 8px inset + 20px 圆角，并叠加安全区 padding 防刘海遮挡）
class AppShell extends StatelessWidget {
  final Widget child;

  const AppShell({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final isDark = brightness == Brightness.dark;
    final screenWidth = MediaQuery.of(context).size.width;
    final isMobile = screenWidth < 768;
    // 移动端：装饰边框需考虑安全区域，避免被刘海屏 / 手势条遮挡。
    // 桌面端 .app-shell::after 直接 1rem inset；移动端在 8px inset 之上再叠 viewPadding。
    final safePadding = isMobile ? MediaQuery.of(context).padding : EdgeInsets.zero;

    // 紫框边线颜色：与主项目一致使用当前模式下的 accent，alpha 0.14。
    final frameColor = (isDark ? AppTheme.darkAccent : AppTheme.accent)
        .withValues(alpha: kAppShellBorderAlpha);

    // 网格线颜色：亮色用 accent·0.08，暗色用 darkAccent·0.06（INV 对照 .dark body）。
    final gridLineColor = isDark
        ? kAppShellDarkGridLineBase.withValues(alpha: kAppShellDarkGridAlpha)
        : kAppShellLightGridLineBase.withValues(alpha: kAppShellLightGridAlpha);

    return Stack(
      fit: StackFit.expand,
      children: [
        // 第一层：基础 180deg 渐变背景。
        // 暗色：linear-gradient(180deg, rgba(23,19,33,0.98) 0%, rgba(17,14,25,1) 100%)
        // 亮色：linear-gradient(180deg, rgba(250,247,255,0.98) 0%, rgba(244,238,255,1) 100%)
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: isDark
                  ? [
                      _kDarkBgTop.withValues(alpha: _kDarkBgTopAlpha),
                      _kDarkBgBottom,
                    ]
                  : [
                      _kLightBgTop.withValues(alpha: _kLightBgTopAlpha),
                      _kLightBgBottom,
                    ],
            ),
          ),
        ),
        // 第二层：72×72 紫色网格底纹（横竖向各一组等距细线）。
        Positioned.fill(
          child: IgnorePointer(
            child: CustomPaint(
              painter: _GridPainter(
                color: gridLineColor,
                spacing: kAppShellGridSpacing,
              ),
            ),
          ),
        ),
        // 第三层：左上角斜光高光（::before 等价物）。
        Positioned.fill(
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: const Alignment(0.4, 0.4),
                  colors: [
                    Colors.white.withValues(alpha: isDark ? 0.04 : 0.42),
                    Colors.transparent,
                  ],
                ),
              ),
            ),
          ),
        ),
        // 第四层：实际业务内容。
        child,
        // 第五层：内边距细紫框（::after 等价物）。
        // 桌面：16px inset + 28px 圆角；移动端：8px inset + 20px 圆角，并叠加安全区。
        Positioned.fill(
          child: IgnorePointer(
            child: Padding(
              padding: isMobile
                  ? EdgeInsets.fromLTRB(
                      kAppShellMobileInset,
                      safePadding.top + kAppShellMobileInset,
                      kAppShellMobileInset,
                      safePadding.bottom + kAppShellMobileInset,
                    )
                  : const EdgeInsets.all(kAppShellDesktopInset),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(
                    isMobile ? kAppShellMobileRadius : kAppShellDesktopRadius,
                  ),
                  border: Border.all(color: frameColor),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 紫色网格底纹画笔 — 一组等距细线（横向 + 纵向）。
class _GridPainter extends CustomPainter {
  final Color color;
  final double spacing;

  _GridPainter({required this.color, required this.spacing});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;

    for (double x = 0; x < size.width; x += spacing) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += spacing) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _GridPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.spacing != spacing;
}
