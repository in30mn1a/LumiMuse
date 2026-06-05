import 'package:flutter/material.dart';
import '../../../core/database/database.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/lumi_scrollbar.dart';
import '../../../theme/surfaces.dart';

/// 移动端对话列表抽屉 — 严格 1:1 对照
/// src/components/chat/ChatView.tsx 第 2127~2178 行 `convDrawerOpen` 区段。
///
/// 视觉契约：
/// - 遮罩 `fixed inset-0 z-50 bg-black/35`
/// - 底部抽屉 `surface-panel rounded-b-none rounded-t-[28px]`
///   `px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4`
/// - 拖拽把手 `mx-auto mb-4 h-1 w-10 rounded-full bg-border-light`
/// - 标题行 `mb-3 flex items-center justify-between`
///   - 左：`text-sm font-semibold text-text-primary` 「最近对话」
///   - 右：关闭按钮 `rounded-full p-1.5 hover:bg-warm-100`（× icon h-4 w-4）
/// - 列表 `max-h-[55dvh] space-y-2 overflow-y-auto pb-1`
/// - 单条按钮 `w-full rounded-2xl(16) border px-3 py-3 text-left transition-all duration-200`
///   - 当前对话 `border-accent/25 bg-[rgba(155,124,240,0.10)]`
///   - 默认 `border-border-light bg-white/75 hover:bg-white`
/// - 空态 `rounded-2xl border border-dashed border-border-light px-4 py-8 text-center`
///
/// 通过 `showConversationDrawer` 顶层入口打开，使用 `showGeneralDialog`
/// 提供从底部滑入动画与背景半透明遮罩。
Future<void> showConversationDrawer(
  BuildContext context, {
  required List<Conversation> conversations,
  required String? activeConversationId,
  required ValueChanged<String> onSelect,
  // FIX(i18n)：调用方需把当前语言传入；保持参数必填，避免遗漏导致默认 zh。
  required String lang,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: I18n.t('chat.dialog.close', lang: lang),
    barrierColor: const Color(0x59000000), // bg-black/35 ≈ 0.35
    transitionDuration: const Duration(milliseconds: 240),
    pageBuilder: (ctx, animation, secondary) {
      return _ConversationDrawer(
        conversations: conversations,
        activeConversationId: activeConversationId,
        lang: lang,
        onSelect: (id) {
          Navigator.of(ctx).pop();
          onSelect(id);
        },
      );
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      // 从底部滑入：translateY 100% → 0
      return SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 1),
          end: Offset.zero,
        ).animate(CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
        )),
        child: child,
      );
    },
  );
}

class _ConversationDrawer extends StatelessWidget {
  final List<Conversation> conversations;
  final String? activeConversationId;
  final ValueChanged<String> onSelect;
  final String lang;

  const _ConversationDrawer({
    required this.conversations,
    required this.activeConversationId,
    required this.onSelect,
    required this.lang,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final mediaQuery = MediaQuery.of(context);
    final safeBottom = mediaQuery.padding.bottom;

    return Align(
      alignment: Alignment.bottomCenter,
      child: Material(
        color: Colors.transparent,
        child: Container(
          width: double.infinity,
          decoration: AppSurfaces.panel(isDark: isDark).copyWith(
            // rounded-b-none rounded-t-[28px]
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(28),
              topRight: Radius.circular(28),
            ),
          ),
          // px-4 pb-[calc(1.5rem+safe-area-bottom)] pt-4
          padding: EdgeInsets.fromLTRB(16, 16, 16, 24 + safeBottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // ── 拖拽把手 ──
              Center(
                child: Container(
                  width: 40, // w-10
                  height: 4, // h-1
                  margin: const EdgeInsets.only(bottom: 16), // mb-4
                  decoration: BoxDecoration(
                    color: isDark
                        ? AppTheme.darkBorderLight
                        : AppTheme.borderLight,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),

              // ── 标题行 ──
              _buildHeader(context, isDark),
              const SizedBox(height: 12), // mb-3

              // ── 列表（max-h-55dvh） ──
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: mediaQuery.size.height * 0.55,
                ),
                child: conversations.isEmpty
                    ? _buildEmpty(isDark)
                    : _buildList(context, isDark),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, bool isDark) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          // FIX(i18n)：抽屉标题改走 I18n.t（chat.drawer.recentTitle）。
          I18n.t('chat.drawer.recentTitle', lang: lang),
          style: TextStyle(
            fontSize: 14, // text-sm
            fontWeight: FontWeight.w600,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
        ),
        _CloseButton(
          isDark: isDark,
          onTap: () => Navigator.of(context).pop(),
        ),
      ],
    );
  }

  Widget _buildList(BuildContext context, bool isDark) {
    return LumiScrollbar(
      child: ListView.separated(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 4), // pb-1
        itemCount: conversations.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8), // space-y-2
        itemBuilder: (ctx, index) {
          final conv = conversations[index];
          final selected = conv.id == activeConversationId;
          return _DrawerRow(
            conversation: conv,
            selected: selected,
            isDark: isDark,
            onTap: () => onSelect(conv.id),
          );
        },
      ),
    );
  }

  Widget _buildEmpty(bool isDark) {
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Container(
        padding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 32),
        decoration: BoxDecoration(
          border: Border.all(color: borderLight),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          // FIX(i18n)：空态提示改走 I18n.t（chat.drawer.empty）。
          I18n.t('chat.drawer.empty', lang: lang),
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14, color: muted),
        ),
      ),
    );
  }
}

class _DrawerRow extends StatefulWidget {
  final Conversation conversation;
  final bool selected;
  final bool isDark;
  final VoidCallback onTap;

  const _DrawerRow({
    required this.conversation,
    required this.selected,
    required this.isDark,
    required this.onTap,
  });

  @override
  State<_DrawerRow> createState() => _DrawerRowState();
}

class _DrawerRowState extends State<_DrawerRow> {
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
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

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
              color: selected ? selectedBorder : borderLight,
            ),
            borderRadius: BorderRadius.circular(16),
          ),
          padding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.conversation.title,
                      style: TextStyle(
                        fontSize: 14,
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
                      fontSize: 11,
                      color: muted,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4), // mt-1
              Row(
                children: [
                  Icon(Icons.access_time, size: 14, color: muted),
                  const SizedBox(width: 6), // gap-1.5
                  Expanded(
                    child: Text(
                      _formatDateTime(widget.conversation.updatedAt),
                      style: TextStyle(fontSize: 12, color: muted),
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

class _CloseButton extends StatefulWidget {
  final bool isDark;
  final VoidCallback onTap;

  const _CloseButton({required this.isDark, required this.onTap});

  @override
  State<_CloseButton> createState() => _CloseButtonState();
}

class _CloseButtonState extends State<_CloseButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          padding: const EdgeInsets.all(6), // p-1.5
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: _hover
                ? (isDark ? AppTheme.darkWarm100 : AppTheme.warm100)
                : Colors.transparent,
          ),
          child: Icon(
            Icons.close,
            size: 16, // h-4 w-4
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      ),
    );
  }
}

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

String _formatDateTime(DateTime dt) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
}
