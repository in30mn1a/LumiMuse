import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../core/utils/local_asset_utils.dart';
import 'app_theme.dart';
import 'app_spacing.dart';
import 'surfaces.dart';

/// Hover 状态构建器 — 替代散布各处的 MouseRegion + setState(_hover) 模式
///
/// 内部使用 [MouseRegion] 检测悬停，通过 builder 回调暴露 isHovering，
/// 调用方无需自己管理 _hover 状态变量和 setState。
///
/// 触屏设备自动降级：MouseRegion 在触屏上不会触发 onEnter/onExit，
/// isHovering 始终为 false，不会触发不必要的 rebuild。
class HoverBuilder extends StatefulWidget {
  final Widget Function(bool isHovering) builder;
  final MouseCursor? cursor;

  const HoverBuilder({
    super.key,
    required this.builder,
    this.cursor,
  });

  @override
  State<HoverBuilder> createState() => _HoverBuilderState();
}

class _HoverBuilderState extends State<HoverBuilder> {
  bool _isHovering = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: widget.cursor ?? SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovering = true),
      onExit: (_) => setState(() => _isHovering = false),
      child: widget.builder(_isHovering),
    );
  }
}

/// LumiMuse 统一软按钮 — 替代各页面重复定义的 _SoftBtn / _SoftBtnKind
///
/// 三种风格：
/// - [LumiSoftButtonKind.primary]：渐变填充 + 白字 + 阴影（发送 / 新对话 / 保存）
/// - [LumiSoftButtonKind.secondary]：半透明白底 + 边框（取消 / 编辑 / 复制）
/// - [LumiSoftButtonKind.danger]：粉红底 + 红字（删除 / 确认清理）
///
/// 内置 hover 浮起效果（translateY -1px），无需外部管理 hover 状态。
/// 支持 [tiny] 紧凑模式（分页按钮 / 卡片内操作按钮）。
enum LumiSoftButtonKind { primary, secondary, danger }

class LumiSoftButton extends StatefulWidget {
  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;
  final LumiSoftButtonKind kind;
  final bool tiny;
  final bool loading;
  final EdgeInsetsGeometry? padding;
  final double? minWidth;

  const LumiSoftButton({
    super.key,
    this.label,
    this.icon,
    required this.onTap,
    this.kind = LumiSoftButtonKind.secondary,
    this.tiny = false,
    this.loading = false,
    this.padding,
    this.minWidth,
  });

  @override
  State<LumiSoftButton> createState() => _LumiSoftButtonState();
}

class _LumiSoftButtonState extends State<LumiSoftButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final disabled = widget.onTap == null || widget.loading;

    final colors = _resolveColors(isDark, disabled);
    final decoration = _resolveDecoration(colors, isDark, disabled);
    final textStyle = _resolveTextStyle(colors, isDark);
    final iconSize = widget.tiny ? 14.0 : 16.0;

    return GestureDetector(
      onTap: widget.onTap,
      behavior: HitTestBehavior.opaque,
      child: MouseRegion(
        cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        curve: Curves.easeOut,
        // 不使用 transform 避免 hover 抖动，颜色变化已提供足够反馈
        padding: widget.padding ??
            (widget.tiny
                ? const EdgeInsets.symmetric(horizontal: 10, vertical: 6)
                : AppSpacing.paddingButton),
        constraints: widget.minWidth != null
            ? BoxConstraints(minWidth: widget.minWidth!)
            : null,
        decoration: decoration,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.loading) ...[
              SizedBox(
                width: iconSize,
                height: iconSize,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.foreground,
                ),
              ),
              const SizedBox(width: 6),
            ] else if (widget.icon != null) ...[
              Icon(widget.icon, size: iconSize, color: colors.foreground),
              if (widget.label != null) const SizedBox(width: 6),
            ],
            if (widget.label != null)
              Text(widget.label!, style: textStyle),
          ],
        ),
      ),
      ),
    );
  }

  _ButtonColors _resolveColors(bool isDark, bool disabled) {
    switch (widget.kind) {
      case LumiSoftButtonKind.primary:
        return _ButtonColors(
          background: null,
          foreground: Colors.white,
          border: null,
          gradient: disabled
              ? [AppTheme.accent.withValues(alpha: 0.5), AppTheme.accentDark.withValues(alpha: 0.5)]
              : [AppTheme.accent, AppTheme.accentDark],
          shadow: disabled ? null : AppTheme.accent.withValues(alpha: 0.24),
        );
      case LumiSoftButtonKind.secondary:
        final bg = isDark
            ? (disabled ? AppTheme.darkSurface.withValues(alpha: 0.4) : (_hover ? AppTheme.darkSurface : AppTheme.darkSurface.withValues(alpha: 0.6)))
            : (disabled ? Colors.white.withValues(alpha: 0.5) : (_hover ? Colors.white : Colors.white.withValues(alpha: 0.72)));
        return _ButtonColors(
          background: bg,
          foreground: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          border: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        );
      case LumiSoftButtonKind.danger:
        final bg = isDark
            ? (_hover ? const Color(0xFF3A1A1A) : const Color(0xFF2A1414))
            : (_hover ? const Color(0xFFFFF0F0) : const Color(0xFFFFF5F5));
        return _ButtonColors(
          background: bg,
          foreground: isDark ? const Color(0xFFFF8A8A) : const Color(0xFFDC2626),
          border: isDark ? const Color(0xFF4A2020) : const Color(0xFFFECACA),
        );
    }
  }

  BoxDecoration _resolveDecoration(_ButtonColors colors, bool isDark, bool disabled) {
    if (colors.gradient != null) {
      return BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colors.gradient!,
        ),
        borderRadius: BorderRadius.circular(AppRadius.md),
        boxShadow: colors.shadow != null
            ? [BoxShadow(color: colors.shadow!, blurRadius: 24, offset: const Offset(0, 10))]
            : null,
      );
    }
    return BoxDecoration(
      color: colors.background,
      border: colors.border != null ? Border.all(color: colors.border!) : null,
      borderRadius: BorderRadius.circular(AppRadius.md),
    );
  }

  TextStyle _resolveTextStyle(_ButtonColors colors, bool isDark) {
    return TextStyle(
      fontSize: widget.tiny ? 12 : 13,
      fontWeight: widget.kind == LumiSoftButtonKind.primary ? FontWeight.w600 : FontWeight.w500,
      color: colors.foreground,
    );
  }
}

class _ButtonColors {
  final Color? background;
  final Color foreground;
  final Color? border;
  final List<Color>? gradient;
  final Color? shadow;

  const _ButtonColors({
    this.background,
    required this.foreground,
    this.border,
    this.gradient,
    this.shadow,
  });
}

/// LumiMuse 统一芯片/标签 — 替代各页面重复定义的 _Chip / _IconChip
///
/// 两种模式：
/// - [LumiChipMode.label]：文字标签（可选前缀图标）
/// - [LumiChipMode.icon]：纯图标按钮
///
/// 支持 active 高亮态和 hover 反馈。
enum LumiChipMode { label, icon }

class LumiChip extends StatefulWidget {
  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool active;
  final LumiChipMode mode;
  final String? tooltip;
  final Color? activeColor;
  final bool tiny;

  const LumiChip({
    super.key,
    this.label,
    this.icon,
    this.onTap,
    this.active = false,
    this.mode = LumiChipMode.label,
    this.tooltip,
    this.activeColor,
    this.tiny = false,
  });

  /// 纯图标按钮快捷构造
  const LumiChip.icon({
    super.key,
    required IconData this.icon,
    this.onTap,
    this.active = false,
    this.tooltip,
    this.activeColor,
    this.tiny = false,
  }) : label = null,
       mode = LumiChipMode.icon;

  @override
  State<LumiChip> createState() => _LumiChipState();
}

class _LumiChipState extends State<LumiChip> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final disabled = widget.onTap == null;

    if (widget.mode == LumiChipMode.icon) {
      return _buildIconChip(isDark, disabled);
    }
    return _buildLabelChip(isDark, disabled);
  }

  Widget _buildIconChip(bool isDark, bool disabled) {
    final size = widget.tiny ? 30.0 : 36.0;
    final iconSize = widget.tiny ? 14.0 : 18.0;
    final base = isDark ? AppTheme.darkSurface.withValues(alpha: 0.5) : Colors.white.withValues(alpha: 0.6);
    final hoverBg = isDark ? AppTheme.darkSurface : Colors.white;

    final child = MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: disabled ? base : (_hover ? hoverBg : base),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
            borderRadius: BorderRadius.circular(AppRadius.sm),
          ),
          child: Icon(
            widget.icon,
            size: iconSize,
            color: disabled
                ? (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                : widget.activeColor ?? (isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary),
          ),
        ),
      ),
    );

    if (widget.tooltip != null) {
      return Tooltip(message: widget.tooltip!, child: child);
    }
    return child;
  }

  Widget _buildLabelChip(bool isDark, bool disabled) {
    final bgColor = widget.active
        ? (isDark ? AppTheme.darkAccent : AppTheme.accent).withValues(alpha: 0.12)
        : (_hover && !disabled)
            ? (isDark ? AppTheme.darkWarm100 : AppTheme.warm100).withValues(alpha: 0.6)
            : (isDark ? AppTheme.darkSurface.withValues(alpha: 0.5) : Colors.white.withValues(alpha: 0.72));
    final borderColor = widget.active
        ? (isDark ? AppTheme.darkAccent : AppTheme.accent).withValues(alpha: 0.26)
        : (isDark ? AppTheme.darkBorderLight : AppTheme.borderLight);
    final textColor = widget.active
        ? (isDark ? AppTheme.darkAccent : AppTheme.accentDark)
        : (isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary);

    return MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          padding: widget.tiny
              ? const EdgeInsets.symmetric(horizontal: 8, vertical: 4)
              : AppSpacing.paddingChip,
          decoration: BoxDecoration(
            color: bgColor,
            border: Border.all(color: borderColor),
            borderRadius: BorderRadius.circular(AppRadius.pill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.icon != null) ...[
                Icon(widget.icon, size: widget.tiny ? 12 : 14, color: textColor),
                const SizedBox(width: 4),
              ],
              if (widget.label != null)
                Text(
                  widget.label!,
                  style: TextStyle(
                    fontSize: widget.tiny ? 11 : 12,
                    fontWeight: widget.active ? FontWeight.w600 : FontWeight.w500,
                    color: textColor,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// LumiMuse 统一面板区块 — 替代各页面重复定义的 _SectionPanel
///
/// 对应主项目 `.surface-panel p-5` + section 标题的视觉模式。
class LumiSectionPanel extends StatelessWidget {
  final String? title;
  final String? subtitle;
  final IconData? titleIcon;
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final List<Widget> actions;

  const LumiSectionPanel({
    super.key,
    this.title,
    this.subtitle,
    this.titleIcon,
    required this.child,
    this.padding,
    this.actions = const [],
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      width: double.infinity,
      decoration: AppSurfaces.panel(isDark: isDark),
      padding: padding ?? AppSpacing.paddingPanel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) ...[
            Row(
              children: [
                if (titleIcon != null) ...[
                  Icon(
                    titleIcon,
                    size: 18,
                    color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
                  ),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title!,
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
                        ),
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle!,
                          style: TextStyle(
                            fontSize: 12,
                            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                          ),
                        ),
                    ],
                  ),
                ),
                ...actions,
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
          ],
          child,
        ],
      ),
    );
  }
}

/// 统一网络图片组件 — 替代散布各处的 Image.network
///
/// 使用 Image.network 提供统一加载/错误占位符。
/// 对于本地文件路径（file://），直接使用 Image.file。
class LumiNetworkImage extends StatelessWidget {
  final String url;
  final double? width;
  final double? height;
  final BoxFit fit;
  final BorderRadius? borderRadius;
  final Widget? placeholder;
  final Widget? errorWidget;

  const LumiNetworkImage({
    super.key,
    required this.url,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.borderRadius,
    this.placeholder,
    this.errorWidget,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final defaultPlaceholder = Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: isDark ? AppTheme.darkWarm100 : AppTheme.warm100,
        borderRadius: borderRadius ?? BorderRadius.zero,
      ),
      child: Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: isDark ? AppTheme.darkAccent : AppTheme.accent,
          ),
        ),
      ),
    );

    final defaultError = Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: isDark ? AppTheme.darkWarm100 : AppTheme.warm100,
        borderRadius: borderRadius ?? BorderRadius.zero,
      ),
      child: Icon(
        Icons.broken_image_outlined,
        size: 24,
        color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
      ),
    );

    Widget image;
    if (!isLocalAssetPath(url)) {
      image = _buildNetworkImage(defaultPlaceholder, defaultError);
    } else {
      image = _buildLocalImage(defaultError);
    }

    if (borderRadius != null) {
      image = ClipRRect(borderRadius: borderRadius!, child: image);
    }
    return image;
  }

  Widget _buildNetworkImage(Widget defaultPlaceholder, Widget defaultError) {
    try {
      return Image.network(
        url,
        width: width,
        height: height,
        fit: fit,
        errorBuilder: (_, __, ___) => errorWidget ?? defaultError,
        loadingBuilder: (_, child, loadingProgress) {
          if (loadingProgress == null) return child;
          return placeholder ?? defaultPlaceholder;
        },
      );
    } catch (_) {
      return errorWidget ?? defaultError;
    }
  }

  Widget _buildLocalImage(Widget defaultError) {
    // 本地路径分支：
    // - 绝对文件系统路径（如头像 Documents/avatars/avatar_xxx.png 或生图 Documents/generated/...）
    //   → Image.file
    // - 以 'assets/' 开头的资源路径或相对路径 → Image.asset 兜底
    // 这里以「能否构造为有效 File」为判定依据，避免在桌面端把绝对路径当 asset 加载。
    if (kIsWeb) {
      // Web 端不能直接读文件，回退占位
      return errorWidget ?? defaultError;
    }
    final isAssetLike = url.startsWith('assets/') || url.startsWith('assets\\');
    if (isAssetLike) {
      try {
        return Image.asset(
          url,
          width: width,
          height: height,
          fit: fit,
          errorBuilder: (_, __, ___) => errorWidget ?? defaultError,
        );
      } catch (_) {
        return errorWidget ?? defaultError;
      }
    }
    try {
      final file = File(url);
      return Image.file(
        file,
        width: width,
        height: height,
        fit: fit,
        // 文件被删除 / 路径无效时降级为 errorWidget（默认占位 + 头像首字符可由 errorWidget 注入）
        errorBuilder: (_, __, ___) => errorWidget ?? defaultError,
      );
    } catch (_) {
      return errorWidget ?? defaultError;
    }
  }
}
