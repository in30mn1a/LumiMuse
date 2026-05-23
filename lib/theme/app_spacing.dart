import 'package:flutter/material.dart';

/// 间距与圆角语义 token — 替代散布各处的 CSS rem/px 硬编码
///
/// 命名规则：与 Tailwind CSS 的间距阶梯对应，
/// 但值在 Flutter 逻辑像素体系下定义，不再机械换算 rem。
class AppSpacing {
  AppSpacing._();

  // ── 间距 ──
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 20;
  static const double xxl = 24;
  static const double xxxl = 32;

  // ── 常用组合 ──
  static const EdgeInsets paddingCard = EdgeInsets.all(lg);
  static const EdgeInsets paddingPanel = EdgeInsets.all(xxl);
  static const EdgeInsets paddingSection = EdgeInsets.all(lg);
  static const EdgeInsets paddingInput = EdgeInsets.symmetric(
    horizontal: 14,
    vertical: 10,
  );
  static const EdgeInsets paddingButton = EdgeInsets.symmetric(
    horizontal: lg,
    vertical: 10,
  );
  static const EdgeInsets paddingChip = EdgeInsets.symmetric(
    horizontal: 12,
    vertical: 6,
  );
}

/// 圆角语义 token
class AppRadius {
  AppRadius._();

  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 20;
  static const double xl = 22;
  static const double xxl = 24;
  static const double hero = 28;
  static const double pill = 999;

  // ── 常用 BorderRadius ──
  static BorderRadius get xsBorder => BorderRadius.circular(xs);
  static BorderRadius get smBorder => BorderRadius.circular(sm);
  static BorderRadius get mdBorder => BorderRadius.circular(md);
  static BorderRadius get lgBorder => BorderRadius.circular(lg);
  static BorderRadius get xlBorder => BorderRadius.circular(xl);
  static BorderRadius get xxlBorder => BorderRadius.circular(xxl);
  static BorderRadius get heroBorder => BorderRadius.circular(hero);
  static BorderRadius get pillBorder => BorderRadius.circular(pill);
}
