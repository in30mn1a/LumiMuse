import 'package:flutter/material.dart';
import '../../../core/database/database.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/lumi_scrollbar.dart';
import '../../../theme/surfaces.dart';

/// PC 端右侧对话快捷面板（lg 以上显示） — 严格 1:1 对照
/// src/components/chat/ChatView.tsx 第 1923~1955 行 `<aside>`。
///
/// 视觉契约：
/// - 外层 `surface-panel flex min-h-0 flex-1 flex-col overflow-hidden`
/// - 顶部 section 标签 `border-b border-border-light px-4 py-4 .label-small`
/// - 列表 `min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4`
/// - 单条按钮 `w-full rounded-2xl(16) border px-3 py-3 text-left transition-all duration-200`
///   - 当前：`border-accent/25 bg-[rgba(155,124,240,0.10)]`
///   - 默认：`border-border-light bg-white/75 hover:bg-white`
/// - 行内：`flex items-center justify-between gap-2`
///   - 标题 truncate text-sm font-medium text-text-primary
///   - 短日期 text-[11px] text-text-muted
/// - 第二行：clock icon + 完整时间 mt-1 gap-2 text-xs text-text-muted
/// - 空态：`rounded-2xl border border-dashed border-border-light px-4 py-8 text-center`
class QuickResumePanel extends StatelessWidget {
  final List<Conversation> conversations;
  final String? activeConversationId;
  final ValueChanged<String> onSelect;

  const QuickResumePanel({
    super.key,
    required this.conversations,
    required this.activeConversationId,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    return Container(
      decoration: AppSurfaces.panel(isDark: isDark),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ── 顶部 section 标签 ──
          Container(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: borderLight)),
            ),
            padding: const EdgeInsets.all(16),
            child: Text(
              '最近对话',
              style: TextStyle(
                fontSize: 12.48,
                height: 1,
                letterSpacing: 0.5, // 0.04em ≈ 0.5
                color: muted,
              ),
            ),
          ),
          // ── 列表 ──
          Expanded(
            child: conversations.isEmpty
                ? _buildEmpty(isDark, borderLight, muted)
                : _buildList(isDark, borderLight, muted),
          ),
        ],
      ),
    );
  }

  Widget _buildList(bool isDark, Color borderLight, Color muted) {
    return LumiScrollbar(
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        itemCount: conversations.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final conv = conversations[index];
          final selected = conv.id == activeConversationId;
          return _ConversationRow(
            conversation: conv,
            selected: selected,
            isDark: isDark,
            borderLight: borderLight,
            muted: muted,
            onTap: () => onSelect(conv.id),
          );
        },
      ),
    );
  }

  Widget _buildEmpty(bool isDark, Color borderLight, Color muted) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Container(
        padding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 32),
        decoration: BoxDecoration(
          // border-dashed border-border-light
          color: Colors.transparent,
          border: Border.all(
            color: borderLight,
            width: 1,
            strokeAlign: BorderSide.strokeAlignInside,
          ),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          '新建一段对话，系统会自动为你保存上下文和记忆。',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 14, // text-sm
            color: muted,
          ),
        ),
      ),
    );
  }
}

class _ConversationRow extends StatefulWidget {
  final Conversation conversation;
  final bool selected;
  final bool isDark;
  final Color borderLight;
  final Color muted;
  final VoidCallback onTap;

  const _ConversationRow({
    required this.conversation,
    required this.selected,
    required this.isDark,
    required this.borderLight,
    required this.muted,
    required this.onTap,
  });

  @override
  State<_ConversationRow> createState() => _ConversationRowState();
}

class _ConversationRowState extends State<_ConversationRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final selected = widget.selected;

    final selectedBg = AppTheme.accent.withValues(alpha: 0.10);
    final selectedBorder = AppTheme.accent.withValues(alpha: 0.25);
    final defaultBg = isDark
        ? AppTheme.darkSurface.withValues(alpha: 0.6)
        : Colors.white.withValues(alpha: 0.75);
    final hoverBg = isDark ? AppTheme.darkSurface : Colors.white;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          decoration: BoxDecoration(
            color: selected
                ? selectedBg
                : (_hover ? hoverBg : defaultBg),
            border: Border.all(
              color: selected ? selectedBorder : widget.borderLight,
            ),
            borderRadius: BorderRadius.circular(16), // rounded-2xl
          ),
          // px-3 py-3
          padding: const EdgeInsets.symmetric(
              horizontal: 12, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 第一行：标题 + 短日期
              Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.conversation.title,
                      style: TextStyle(
                        fontSize: 14, // text-sm
                        fontWeight: FontWeight.w500,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    _formatShortDate(widget.conversation.updatedAt),
                    style: TextStyle(
                      fontSize: 11, // text-[11px]
                      color: widget.muted,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4), // mt-1
              // 第二行：clock icon + 完整时间
              Row(
                children: [
                  Icon(Icons.access_time, size: 14, color: widget.muted),
                  const SizedBox(width: 8), // gap-2
                  Expanded(
                    child: Text(
                      _formatDateTime(widget.conversation.updatedAt),
                      style: TextStyle(
                        fontSize: 12, // text-xs
                        color: widget.muted,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 短日期：今天显示 HH:mm，本年显示 M/D，跨年显示 YYYY/M/D
String _formatShortDate(DateTime dt) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final d = DateTime(dt.year, dt.month, dt.day);
  if (d == today) {
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
  if (dt.year == now.year) {
    return '${dt.month}/${dt.day}';
  }
  return '${dt.year}/${dt.month}/${dt.day}';
}

/// 完整日期时间：YYYY-MM-DD HH:mm
String _formatDateTime(DateTime dt) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
}
