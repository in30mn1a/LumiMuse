import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/database/database.dart';
import '../../../core/providers/conversation_provider.dart';
import '../../../core/providers/database_provider.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';

/// 对话设置浮层
///
/// 设计目标：沿用 `AppSurfaces.panel` 的温柔暖光视觉，与「更多」菜单
/// 整体观感保持一致。当前提供「忽略记忆提取」开关一项，调用
/// [ConversationActions.toggleIgnoreMemory] 持久化到 `conversations.ignore_memory`，
/// 与 design.md「P1 / R5」保持一致。
class ConversationSettingsSheet extends ConsumerWidget {
  /// 目标对话 ID
  final String conversationId;

  const ConversationSettingsSheet({
    super.key,
    required this.conversationId,
  });

  /// 通过 [showModalBottomSheet] 弹出对话设置浮层
  ///
  /// 透明背景 + `AppSurfaces.panel` 圆角面板，符合现有「更多」菜单的视觉。
  static Future<void> show(BuildContext context, String conversationId) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: false,
      builder: (ctx) =>
          ConversationSettingsSheet(conversationId: conversationId),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final db = ref.watch(databaseProvider);

    // 直接订阅当前对话单行，开关状态变化后立即反映
    final convStream = (db.select(db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .watchSingleOrNull();

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Container(
          decoration: AppSurfaces.panel(isDark: isDark),
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: StreamBuilder<Conversation?>(
            stream: convStream,
            builder: (context, snapshot) {
              final conv = snapshot.data;
              final ignore = (conv?.ignoreMemory ?? 0) == 1;
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 标题区
                  Text(
                    // TODO(parity): 主项目缺失 'chat.conversationSettings' 键，硬编码兜底
                    '对话设置',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  // 忽略记忆提取开关
                  _IgnoreMemoryTile(
                    isDark: isDark,
                    value: ignore,
                    onChanged: conv == null
                        ? null
                        : (v) async {
                            await ref
                                .read(conversationActionsProvider)
                                .toggleIgnoreMemory(conversationId, v);
                          },
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// 「忽略记忆提取」开关行
///
/// 视觉上沿用淡紫底色（`AppSurfaces.panelQuiet`）+ 主图标，避免与 panel 撞色。
class _IgnoreMemoryTile extends StatelessWidget {
  final bool isDark;
  final bool value;
  final ValueChanged<bool>? onChanged;

  const _IgnoreMemoryTile({
    required this.isDark,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
    final textPrimary =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final textSecondary =
        isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;

    return Container(
      decoration: AppSurfaces.panelQuiet(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              Icons.psychology_outlined,
              size: 20,
              color: accent,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  // TODO(parity): 主项目缺失 'chat.ignoreMemory' 键，硬编码兜底
                  '忽略记忆提取',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  // TODO(parity): 主项目缺失 'chat.ignoreMemoryDesc' 键，硬编码兜底
                  '开启后此对话不再自动触发记忆提取',
                  style: TextStyle(
                    fontSize: 12,
                    color: textSecondary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Switch.adaptive(
            value: value,
            onChanged: onChanged,
            activeThumbColor: accent,
          ),
        ],
      ),
    );
  }
}
