import 'package:flutter/material.dart';
import 'app_theme.dart';
import 'surfaces.dart';

/// 全屏页面统一外壳 — 替代 Scaffold + AppBar
///
/// 视觉与主屏一致：透明背景（由上层 AppShell 提供网格底纹）+ surface-panel 主面板
/// 顶部是 hero header（返回箭头 + 标题 + 操作按钮）
class AppPageScaffold extends StatelessWidget {
  final String title;
  final String? subtitle;

  /// 替代默认返回箭头（默认是返回上一级）
  final Widget? leading;

  /// 顶部右侧操作按钮组
  final List<Widget> actions;

  /// 主体（嵌入在 surface-panel 内部）
  final Widget child;

  /// 是否使用主面板包裹 child（默认 true）。
  /// 复杂页面如带筛选栏的，可以传 false 自己处理。
  final bool wrapInPanel;

  /// 主体内边距（默认 16）
  final EdgeInsetsGeometry? bodyPadding;

  /// 浮动按钮（沿用 Material）
  final Widget? floatingActionButton;

  const AppPageScaffold({
    super.key,
    required this.title,
    required this.child,
    this.subtitle,
    this.leading,
    this.actions = const [],
    this.wrapInPanel = true,
    this.bodyPadding,
    this.floatingActionButton,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final canPop = Navigator.of(context).canPop();

    return Scaffold(
      backgroundColor: Colors.transparent,
      floatingActionButton: floatingActionButton,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          child: Column(
            children: [
              _buildHeader(context, isDark, canPop),
              const SizedBox(height: 12),
              Expanded(
                child: wrapInPanel
                    ? Container(
                        decoration: AppSurfaces.panel(isDark: isDark),
                        clipBehavior: Clip.antiAlias,
                        padding: bodyPadding ?? const EdgeInsets.all(16),
                        child: child,
                      )
                    : child,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, bool isDark, bool canPop) {
    return Container(
      decoration: AppSurfaces.hero(isDark: isDark),
      padding:
          const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          if (leading != null)
            leading!
          else if (canPop) ...[
            _IconChip(
              icon: Icons.arrow_back_rounded,
              tooltip: '返回',
              onTap: () => Navigator.of(context).maybePop(),
              isDark: isDark,
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (subtitle != null && subtitle!.isNotEmpty)
                  Text(
                    subtitle!,
                    style: TextStyle(
                      fontSize: 11,
                      color: isDark
                          ? AppTheme.darkTextMuted
                          : AppTheme.textMuted,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
              ],
            ),
          ),
          if (actions.isNotEmpty) ...[
            for (int i = 0; i < actions.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              actions[i],
            ],
          ],
        ],
      ),
    );
  }
}

/// 头部小图标按钮 chip（与 ChatView 内的同款）
/// 公开让外部页面也能传同款 actions
class AppPageActionChip extends StatefulWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final String? tooltip;
  final Color? activeColor;

  const AppPageActionChip({
    super.key,
    required this.icon,
    required this.onTap,
    this.tooltip,
    this.activeColor,
  });

  @override
  State<AppPageActionChip> createState() => _AppPageActionChipState();
}

class _AppPageActionChipState extends State<AppPageActionChip> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return _IconChip(
      icon: widget.icon,
      onTap: widget.onTap,
      tooltip: widget.tooltip,
      isDark: Theme.of(context).brightness == Brightness.dark,
      activeColor: widget.activeColor,
      hover: _hover,
      onHoverChange: (h) => setState(() => _hover = h),
    );
  }
}

/// 内部统一 chip 实现（避免重复造轮子）
class _IconChip extends StatefulWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final String? tooltip;
  final bool isDark;
  final Color? activeColor;
  final bool? hover;
  final ValueChanged<bool>? onHoverChange;

  const _IconChip({
    required this.icon,
    required this.onTap,
    required this.isDark,
    this.tooltip,
    this.activeColor,
    this.hover,
    this.onHoverChange,
  });

  @override
  State<_IconChip> createState() => _IconChipState();
}

class _IconChipState extends State<_IconChip> {
  bool _hoverInternal = false;

  bool get _hover => widget.hover ?? _hoverInternal;

  void _setHover(bool v) {
    if (widget.onHoverChange != null) {
      widget.onHoverChange!(v);
    } else {
      setState(() => _hoverInternal = v);
    }
  }

  @override
  Widget build(BuildContext context) {
    final disabled = widget.onTap == null;
    final base = widget.isDark
        ? AppTheme.darkSurface.withValues(alpha: 0.5)
        : Colors.white.withValues(alpha: 0.6);
    final hover = widget.isDark
        ? AppTheme.darkSurface
        : Colors.white;

    final btn = MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: disabled ? base : (_hover ? hover : base),
            border: Border.all(
              color: widget.isDark
                  ? AppTheme.darkBorderLight
                  : AppTheme.borderLight,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(
            widget.icon,
            size: 18,
            color: disabled
                ? (widget.isDark
                    ? AppTheme.darkTextMuted
                    : AppTheme.textMuted)
                : widget.activeColor ??
                    (widget.isDark
                        ? AppTheme.darkTextSecondary
                        : AppTheme.textSecondary),
          ),
        ),
      ),
    );

    if (widget.tooltip != null) {
      return Tooltip(message: widget.tooltip!, child: btn);
    }
    return btn;
  }
}
