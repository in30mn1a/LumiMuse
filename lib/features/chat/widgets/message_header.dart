import 'package:flutter/material.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';

/// 消息区副标题栏（surface-panel 顶部边框下） — 严格 1:1 对照
/// src/components/chat/ChatView.tsx 第 1750~1791 行。
///
/// 视觉契约：
/// - 外层 `flex items-center justify-between border-b border-border-light`
///   `px-3 py-2.5 text-sm text-text-secondary md:px-5 md:py-4`
/// - 左：`SparkIcon h-4 w-4 text-accent` + 对话标题（truncate text-xs md:text-sm）
/// - 右：可选 chips（顺序锁定）：
///   1. 未提取计数 / 已忽略提取 / 提取管理（三选一互斥）
///   2. 提取状态 chip（idle 时不显示）
///   3. token chip 始终显示
class MessageHeader extends StatelessWidget {
  /// 对话标题（无对话时显示 fallback）
  final String? title;
  final String fallbackTitle;

  /// 是否已忽略记忆提取（true 时左侧 chip 显示「已忽略提取」）
  final bool ignoreMemory;

  /// 未提取的用户消息数（>0 时左侧 chip 显示 "{n} 条待提取"）
  final int unextractedCount;

  /// 当前提取状态：'idle' | 'extracting' | 'done' | 'failed'
  final String memoryExtractStatus;

  /// 估算 token 数（始终显示在最右）
  final int tokenCount;

  /// 点击「未提取计数 / 已忽略 / 提取管理」chip 时弹出重置提取面板
  final VoidCallback onOpenExtractionManager;

  /// 点击 token chip 时弹出 token 占比拆分弹窗（可为 null，null 时 chip 不可点击）
  final VoidCallback? onOpenTokenBreakdown;

  /// 当前语言（用于 i18n 文案）。父级从 localeProvider 取后传入，避免本组件直接订阅 Provider。
  final String lang;

  const MessageHeader({
    super.key,
    required this.title,
    required this.fallbackTitle,
    required this.ignoreMemory,
    required this.unextractedCount,
    required this.memoryExtractStatus,
    required this.tokenCount,
    required this.onOpenExtractionManager,
    required this.lang,
    this.onOpenTokenBreakdown,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final width = MediaQuery.sizeOf(context).width;
    final isMobile = width < 768;

    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;

    return Container(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: borderLight)),
      ),
      // px-3 py-2.5 / md:px-5 md:py-4
      padding: EdgeInsets.symmetric(
        horizontal: isMobile ? 12 : 20,
        vertical: isMobile ? 10 : 16,
      ),
      child: Row(
        children: [
          // ── 左：spark icon + 标题 ──
          Icon(
            Icons.auto_awesome,
            size: 16,
            color: isDark ? AppTheme.darkAccent : AppTheme.accent,
          ),
          const SizedBox(width: 8), // gap-2
          Expanded(
            child: Text(
              (title?.isNotEmpty ?? false) ? title! : fallbackTitle,
              style: TextStyle(
                fontSize: isMobile ? 12 : 14, // text-xs / text-sm
                color: isDark
                    ? AppTheme.darkTextSecondary
                    : AppTheme.textSecondary,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),

          // ── 右：chips ──
          const SizedBox(width: 8),
          Wrap(
            spacing: isMobile ? 6 : 8, // gap-1.5 / md:gap-2
            crossAxisAlignment: WrapCrossAlignment.center,
            children: _buildRightChips(context, isDark, isMobile),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildRightChips(
      BuildContext context, bool isDark, bool isMobile) {
    final chips = <Widget>[];

    // ── chip 1：未提取 / 已忽略 / 提取管理（三选一互斥） ──
    if (ignoreMemory) {
      // 已忽略：text-text-muted opacity-60 hover:opacity-90
      chips.add(_ManageChip(
        label: I18n.t('chat.ignoredHint', lang: lang),
        kind: _ManageChipKind.muted,
        isDark: isDark,
        isMobile: isMobile,
        onTap: onOpenExtractionManager,
      ));
    } else if (unextractedCount > 0) {
      // 未提取计数：text-amber-600 border-amber-200 bg-amber-50/80
      chips.add(_ManageChip(
        label: '$unextractedCount ${I18n.t('chat.unextracted', lang: lang)}',
        kind: _ManageChipKind.warn,
        isDark: isDark,
        isMobile: isMobile,
        onTap: onOpenExtractionManager,
      ));
    } else {
      // 提取管理：opacity-50 hover:opacity-80
      chips.add(_ManageChip(
        label: I18n.t('chat.manageExtraction', lang: lang),
        kind: _ManageChipKind.faint,
        isDark: isDark,
        isMobile: isMobile,
        onTap: onOpenExtractionManager,
      ));
    }

    // ── chip 2：提取状态（idle 时不显示） ──
    if (memoryExtractStatus != 'idle') {
      _ManageChipKind kind;
      String label;
      switch (memoryExtractStatus) {
        case 'extracting':
          kind = _ManageChipKind.extracting;
          label = I18n.t('chat.extracting', lang: lang);
          break;
        case 'done':
          kind = _ManageChipKind.done;
          label = I18n.t('chat.extractDone', lang: lang);
          break;
        case 'failed':
          kind = _ManageChipKind.failed;
          label = I18n.t('chat.extractFailed', lang: lang);
          break;
        default:
          kind = _ManageChipKind.faint;
          label = memoryExtractStatus;
      }
      chips.add(_ManageChip(
        label: label,
        kind: kind,
        isDark: isDark,
        isMobile: isMobile,
        onTap: null, // 提取状态 chip 不可点击
      ));
    }

    // ── chip 3：token 数 始终显示（点击弹出 token 占比拆分弹窗） ──
    // 对照 ChatToolbar.tsx 第 79~86 行 `<button onClick={onOpenTokenBreakdown}>`。
    chips.add(_ManageChip(
      label: '≈$tokenCount ${I18n.t('status.tokens', lang: lang)}',
      kind: _ManageChipKind.normal,
      isDark: isDark,
      isMobile: isMobile,
      onTap: onOpenTokenBreakdown,
    ));

    return chips;
  }
}

enum _ManageChipKind {
  /// 默认 chip：白底灰文（bg-white/72 border-border-light text-text-secondary）
  normal,

  /// 已忽略：透明度更低，灰色调（border-border-light text-text-muted opacity-60）
  muted,

  /// 提取管理：透明度极低（opacity-50 hover:opacity-80）
  faint,

  /// 待提取告警（amber-600 / amber-200 / amber-50/80）
  warn,

  /// 提取中：紫色脉冲（purple-600 / purple-200 / purple-50/80）
  extracting,

  /// 提取完成（green-600 / green-200 / green-50/80）
  done,

  /// 提取失败（red-500 / red-200 / red-50/80）
  failed,
}

class _ManageChip extends StatefulWidget {
  final String label;
  final _ManageChipKind kind;
  final bool isDark;
  final bool isMobile;
  final VoidCallback? onTap;

  const _ManageChip({
    required this.label,
    required this.kind,
    required this.isDark,
    required this.isMobile,
    required this.onTap,
  });

  @override
  State<_ManageChip> createState() => _ManageChipState();
}

class _ManageChipState extends State<_ManageChip>
    with SingleTickerProviderStateMixin {
  bool _hover = false;
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final clickable = widget.onTap != null;

    Color bg;
    Color textColor;
    Color border;
    double opacity = 1.0;

    switch (widget.kind) {
      case _ManageChipKind.normal:
        bg = isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.5)
            : Colors.white.withValues(alpha: 0.72);
        textColor =
            isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
        border = isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
        break;
      case _ManageChipKind.muted:
        bg = isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6);
        textColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
        border = isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
        opacity = _hover ? 0.9 : 0.6;
        break;
      case _ManageChipKind.faint:
        bg = isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.3)
            : Colors.white.withValues(alpha: 0.5);
        textColor =
            isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
        border = isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
        opacity = _hover ? 0.8 : 0.5;
        break;
      case _ManageChipKind.warn:
        // amber-50/80 text-amber-600 border-amber-200
        bg = const Color(0xFFFFFBEB).withValues(alpha: 0.80);
        textColor = const Color(0xFFD97706);
        border = const Color(0xFFFDE68A);
        if (_hover) bg = const Color(0xFFFEF3C7).withValues(alpha: 0.80);
        break;
      case _ManageChipKind.extracting:
        // purple-50/80 text-purple-600 border-purple-200，带 pulse
        bg = const Color(0xFFFAF5FF).withValues(alpha: 0.80);
        textColor = const Color(0xFF9333EA);
        border = const Color(0xFFE9D5FF);
        break;
      case _ManageChipKind.done:
        bg = const Color(0xFFF0FDF4).withValues(alpha: 0.80);
        textColor = const Color(0xFF16A34A);
        border = const Color(0xFFBBF7D0);
        break;
      case _ManageChipKind.failed:
        bg = const Color(0xFFFEF2F2).withValues(alpha: 0.80);
        textColor = const Color(0xFFEF4444);
        border = const Color(0xFFFECACA);
        break;
    }

    Widget chip = Container(
      constraints: BoxConstraints(minHeight: widget.isMobile ? 22 : 26),
      padding: EdgeInsets.symmetric(
        horizontal: widget.isMobile ? 8 : 12,
        vertical: 4,
      ),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        widget.label,
        style: TextStyle(
          fontSize: widget.isMobile ? 10 : 12, // text-[10px] / text-xs
          color: textColor,
          height: 1,
        ),
      ),
    );

    // 提取中状态：pulse 动画（透明度 0.6 ↔ 1.0 循环）
    if (widget.kind == _ManageChipKind.extracting) {
      chip = FadeTransition(
        opacity: Tween<double>(begin: 0.55, end: 1.0).animate(_pulse),
        child: chip,
      );
    }

    chip = Opacity(opacity: opacity, child: chip);

    if (!clickable) return chip;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: chip,
      ),
    );
  }
}
