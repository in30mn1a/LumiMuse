import 'package:flutter/material.dart';
import '../../../core/database/database.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import '../../../theme/app_breakpoints.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/surfaces.dart';

/// 聊天顶部工具栏 — 严格 1:1 对照 src/components/chat/ChatView.tsx
/// 中 surface-hero 工具栏区段（PC 端 hidden md:block 与 移动端 md:hidden 两套）。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
///
/// PC 端（md ≥ 768）— TSX 第 1690~1746 行：
/// - 外层 `surface-hero hidden px-5 py-5 md:block`
/// - 内部 `flex items-center gap-3 lg:justify-between`
/// - 左半区 `flex min-w-0 flex-1 items-center gap-3`：
///   - 头像 14×14 (=56) `rounded-[1.35rem]≈22 bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10`
///   - 名字 `text-xl font-semibold text-text-primary`
///   - 三个 chips：profile (chip-active) / N quickResume / N memoryCount，文字 `text-[11px]`
/// - 右半区 6 枚按钮（顺序锁定）：
///   - 1. newChat：soft-button-primary px-4 py-2 + PlusIcon h-4 w-4 + "新对话"
///   - 2. rename：soft-button-secondary px-4 py-2 + PencilIcon + "编辑"
///   - 3. summary：soft-button-secondary + SummaryIcon + "总结上下文" / "正在总结..."
///   - 4. duplicate：soft-button-secondary + DuplicateIcon + "复制对话" / "复制中..."
///   - 5. image：soft-button-secondary + ImageIcon + "图片管理"
///   - 6. delete：soft-button-danger + TrashIcon + "删除"
///
/// 移动端（md < 768）— TSX 第 1604~1685 行：
/// - 外层 `surface-hero px-3 py-2 md:hidden`
/// - 第一行（始终显示）`flex items-center gap-2`：
///   - menuBtn (rounded-xl p-2)
///   - 7×7 (=28) 头像 `rounded-lg(8) bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10`
///   - 角色名 `text-sm font-semibold text-text-primary truncate`
///   - listBtn / newBtn (bg-accent rounded-xl) / chevronDown
/// - 第二行（toolbarExpanded === true 时显示）`mt-1.5 border-t border-border-light/60 pt-1.5`：
///   - chip：N quickResume / N memoryCount text-[10px]
///   - 5 枚图标按钮（pencil/summary/duplicate/image/trash）：rounded-xl p-2 text-text-secondary
class ChatHeader extends StatefulWidget {
  final Character character;
  final int conversationCount;
  final int memoryCount;
  final bool isStreaming;
  final bool isSummarizing;
  final bool isDuplicating;
  final bool hasActiveConversation;

  /// 移动端打开侧栏抽屉（PC 端为 null）
  final VoidCallback? onOpenSidebar;

  /// 操作回调
  final VoidCallback onNewChat;
  final VoidCallback onShowConversationList;
  final VoidCallback onRename;
  final VoidCallback onSummarize;
  final VoidCallback onDuplicate;
  final VoidCallback onImageManager;
  final VoidCallback onDelete;

  const ChatHeader({
    super.key,
    required this.character,
    required this.conversationCount,
    required this.memoryCount,
    required this.isStreaming,
    required this.isSummarizing,
    required this.isDuplicating,
    required this.hasActiveConversation,
    required this.onOpenSidebar,
    required this.onNewChat,
    required this.onShowConversationList,
    required this.onRename,
    required this.onSummarize,
    required this.onDuplicate,
    required this.onImageManager,
    required this.onDelete,
  });

  @override
  State<ChatHeader> createState() => _ChatHeaderState();
}

class _ChatHeaderState extends State<ChatHeader> {
  /// 移动端「展开拉片」状态
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final width = MediaQuery.sizeOf(context).width;
    final isMobile = AppBreakpoints.isMobile(width);

    if (isMobile) {
      return _buildMobile(context, isDark);
    } else {
      return _buildDesktop(context, isDark);
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // PC 端工具栏：surface-hero px-5 py-5
  // ═════════════════════════════════════════════════════════════════
  Widget _buildDesktop(BuildContext context, bool isDark) {
    final character = widget.character;

    return Container(
      decoration: AppSurfaces.hero(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // ── 左半区：头像 + 名字 + chips ──
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _buildAvatar(character, size: 56, radius: 21.6, isDark: isDark),
                const SizedBox(width: 12), // gap-3
                Expanded(
                  child: Wrap(
                    spacing: 8, // gap-2
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        character.name,
                        style: TextStyle(
                          fontSize: 20, // text-xl
                          fontWeight: FontWeight.w600,
                          color: isDark
                              ? AppTheme.darkTextPrimary
                              : AppTheme.textPrimary,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                      // 三个 chips
                      const LumiChip(
                        label: '角色卡片',
                        active: true,
                      ),
                      LumiChip(
                        label: '${widget.conversationCount} 最近对话',
                      ),
                      LumiChip(
                        label: '${widget.memoryCount} 条记忆',
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          // ── 右半区：6 枚按钮 ──
          const SizedBox(width: 12),
          Wrap(
            spacing: 8, // gap-2
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              LumiSoftButton(
                icon: Icons.add,
                label: '新对话',
                kind: LumiSoftButtonKind.primary,
                onTap: widget.onNewChat,
              ),
              LumiSoftButton(
                icon: Icons.edit_outlined,
                label: '编辑',
                kind: LumiSoftButtonKind.secondary,
                onTap: widget.hasActiveConversation ? widget.onRename : null,
              ),
              LumiSoftButton(
                icon: Icons.summarize_outlined,
                label: widget.isSummarizing ? '正在总结...' : '总结上下文',
                kind: LumiSoftButtonKind.secondary,
                onTap: (!widget.hasActiveConversation ||
                        widget.isStreaming ||
                        widget.isSummarizing)
                    ? null
                    : widget.onSummarize,
              ),
              LumiSoftButton(
                icon: Icons.copy_all_outlined,
                label: widget.isDuplicating ? '复制中...' : '复制对话',
                kind: LumiSoftButtonKind.secondary,
                onTap: (!widget.hasActiveConversation ||
                        widget.isDuplicating)
                    ? null
                    : widget.onDuplicate,
              ),
              LumiSoftButton(
                icon: Icons.image_outlined,
                label: '图片管理',
                kind: LumiSoftButtonKind.secondary,
                onTap: widget.onImageManager,
              ),
              LumiSoftButton(
                icon: Icons.delete_outline,
                label: '删除',
                kind: LumiSoftButtonKind.danger,
                onTap: widget.hasActiveConversation ? widget.onDelete : null,
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════
  // 移动端工具栏：surface-hero px-3 py-2，可收起拉片
  // ═════════════════════════════════════════════════════════════════
  Widget _buildMobile(BuildContext context, bool isDark) {
    final character = widget.character;

    return Container(
      decoration: AppSurfaces.hero(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── 第一行：始终显示 ──
          Row(
            children: [
              if (widget.onOpenSidebar != null)
                _IconBtn(
                  icon: Icons.menu,
                  isDark: isDark,
                  onTap: widget.onOpenSidebar,
                ),
              const SizedBox(width: 8), // gap-2
              _buildAvatar(character, size: 28, radius: 8, isDark: isDark),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  character.name,
                  style: TextStyle(
                    fontSize: 14, // text-sm
                    fontWeight: FontWeight.w600,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              _IconBtn(
                icon: Icons.format_list_bulleted, // ListIcon
                isDark: isDark,
                onTap: widget.onShowConversationList,
              ),
              const SizedBox(width: 2),
              // 新对话按钮：bg-accent rounded-xl p-2 text-white
              _IconBtn(
                icon: Icons.add,
                isDark: isDark,
                solid: true,
                onTap: widget.onNewChat,
              ),
              const SizedBox(width: 2),
              // 展开/收起拉片按钮
              _IconBtn(
                icon: Icons.expand_more,
                rotated: _expanded,
                isDark: isDark,
                onTap: () => setState(() => _expanded = !_expanded),
              ),
            ],
          ),

          // ── 第二行：toolbarExpanded === true 时显示 ──
          if (_expanded) _buildMobileExpanded(context, isDark),
        ],
      ),
    );
  }

  Widget _buildMobileExpanded(BuildContext context, bool isDark) {
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    return Container(
      margin: const EdgeInsets.only(top: 6), // mt-1.5
      padding: const EdgeInsets.only(top: 6), // pt-1.5
      decoration: BoxDecoration(
        border: Border(
          // border-t border-border-light/60
          top: BorderSide(color: borderLight.withValues(alpha: 0.6)),
        ),
      ),
      child: Row(
        children: [
          // chip 区域
          LumiChip(
            label: '${widget.conversationCount} 最近对话',
            tiny: true,
          ),
          const SizedBox(width: 6),
          LumiChip(
            label: '${widget.memoryCount} 条记忆',
            tiny: true,
          ),
          const Spacer(),
          // 5 枚图标按钮
          _IconBtn(
            icon: Icons.edit_outlined,
            isDark: isDark,
            disabled: !widget.hasActiveConversation,
            onTap: () {
              widget.onRename();
              setState(() => _expanded = false);
            },
          ),
          _IconBtn(
            icon: Icons.summarize_outlined,
            isDark: isDark,
            disabled: !widget.hasActiveConversation ||
                widget.isStreaming ||
                widget.isSummarizing,
            onTap: () {
              widget.onSummarize();
              setState(() => _expanded = false);
            },
          ),
          _IconBtn(
            icon: Icons.copy_all_outlined,
            isDark: isDark,
            disabled:
                !widget.hasActiveConversation || widget.isDuplicating,
            onTap: () {
              widget.onDuplicate();
              setState(() => _expanded = false);
            },
          ),
          _IconBtn(
            icon: Icons.image_outlined,
            isDark: isDark,
            onTap: () {
              widget.onImageManager();
              setState(() => _expanded = false);
            },
          ),
          _IconBtn(
            icon: Icons.delete_outline,
            isDark: isDark,
            danger: true,
            disabled: !widget.hasActiveConversation,
            onTap: () {
              widget.onDelete();
              setState(() => _expanded = false);
            },
          ),
        ],
      ),
    );
  }

  // ─── 头像（带渐变 ring 边框） ───
  Widget _buildAvatar(
    Character character, {
    required double size,
    required double radius,
    required bool isDark,
  }) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            AppTheme.accent.withValues(alpha: 0.18),
            AppTheme.accentLight.withValues(alpha: 0.28),
          ],
        ),
        borderRadius: BorderRadius.circular(radius),
        // ring-1 ring-accent/10
        border: Border.all(
          color: AppTheme.accent.withValues(alpha: 0.10),
          width: 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: character.avatarUrl != null && character.avatarUrl!.isNotEmpty
          ? LumiNetworkImage(
              url: character.avatarUrl!,
              fit: BoxFit.cover,
              errorWidget: _initial(character, size),
            )
          : _initial(character, size),
    );
  }

  Widget _initial(Character character, double size) {
    return Center(
      child: Text(
        character.name.isNotEmpty ? character.name[0] : '?',
        style: TextStyle(
          fontSize: size * 0.36,
          fontWeight: FontWeight.w600,
          color: AppTheme.accentDark,
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════
// 工具组件
// ═════════════════════════════════════════════════════════════════

/// 移动端常用的小图标按钮：rounded-xl(12) p-2 text-text-secondary
class _IconBtn extends StatefulWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final bool isDark;
  final bool solid; // bg-accent 实心款（移动端 + 按钮）
  final bool danger; // 红色（删除）
  final bool disabled;
  final bool rotated; // 展开拉片按钮 180° 翻转

  const _IconBtn({
    required this.icon,
    required this.isDark,
    this.onTap,
    this.solid = false,
    this.danger = false,
    this.disabled = false,
    this.rotated = false,
  });

  @override
  State<_IconBtn> createState() => _IconBtnState();
}

class _IconBtnState extends State<_IconBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final enabled = !widget.disabled && widget.onTap != null;

    Color iconColor;
    Color? bgColor;
    if (widget.solid) {
      bgColor = AppTheme.accent;
      iconColor = Colors.white;
    } else if (widget.danger) {
      iconColor = const Color(0xFFF87171); // red-400
      bgColor = _hover
          ? const Color(0xFFFEF2F2) // red-50
          : null;
    } else {
      iconColor =
          isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
      // hover:bg-warm-100
      bgColor =
          _hover ? (isDark ? AppTheme.darkWarm100 : AppTheme.warm100) : null;
    }

    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) {
        if (enabled) setState(() => _hover = true);
      },
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? widget.onTap : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.all(8), // p-2
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: AppRadius.smBorder,
          ),
          child: Opacity(
            opacity: enabled ? 1 : 0.4,
            child: AnimatedRotation(
              turns: widget.rotated ? 0.5 : 0,
              duration: const Duration(milliseconds: 200),
              child: Icon(widget.icon, size: 16, color: iconColor),
            ),
          ),
        ),
      ),
    );
  }
}
