import 'package:flutter/material.dart';

/// 响应式断点常量 — 替代散布各处的 768 硬编码
///
/// 对应主项目 Tailwind CSS 的 md: / lg: 断点，
/// 但在 Flutter 中统一通过 LayoutBuilder 或 MediaQuery 使用。
class AppBreakpoints {
  AppBreakpoints._();

  /// 对应 Tailwind `md:` 断点 — 侧栏显隐、输入栏 PC/移动切换
  static const double md = 768;

  /// 对应 Tailwind `lg:` 断点 — 右侧面板显隐
  static const double lg = 1024;

  /// 对应 Tailwind `sm:` 断点
  static const double sm = 640;

  /// 判断当前是否为移动端布局
  static bool isMobile(double width) => width < md;

  /// 判断当前是否为桌面端布局
  static bool isDesktop(double width) => width >= md;

  /// 判断是否有右侧面板空间
  static bool hasSidePanel(double width) => width >= lg;

  /// 从 BuildContext 获取宽度
  static double widthOf(BuildContext context) =>
      MediaQuery.sizeOf(context).width;

  /// 从 BuildContext 判断是否移动端
  static bool isMobileOf(BuildContext context) =>
      isMobile(widthOf(context));

  /// 从 BuildContext 判断是否桌面端
  static bool isDesktopOf(BuildContext context) =>
      isDesktop(widthOf(context));
}
