import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:drift/drift.dart' as drift;
import '../../../core/database/database.dart';
import '../../../core/models/message_metadata.dart';
import '../../../core/providers/conversation_provider.dart';
import '../../../core/providers/database_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/lumi_scrollbar.dart';
import '../../../theme/surfaces.dart';
import 'chat_dialogs.dart';

/// 重置提取状态弹窗 — 严格 1:1 对照
/// src/components/chat/ChatView.tsx 第 1998~2122 行 `resetExtractionOpen`。
///
/// 视觉契约：
/// - 外层 surface-panel max-w-md p-5
/// - 标题 section-title text-xl 「切换提取状态」
/// - 副文案 mt-2 section-copy
/// - 多选状态行：左 "已选 N 条" / "点击消息多选"，右 全选 / 取消全选
/// - 消息列表 max-h-64 rounded-xl border border-border-light，含勾选框 + 内容预览 + 时间 + 状态徽标
/// - 操作行（4 按钮 + 1 开关 + 手动提取）
class ResetExtractionDialog extends ConsumerStatefulWidget {
  final String conversationId;
  final bool currentIgnoreMemory;
  final int unextractedCount;
  final bool isExtracting;

  /// 切换忽略记忆开关（onTap 后由调用方自己刷新）
  final ValueChanged<bool> onToggleIgnore;

  /// 手动提取按钮回调
  final VoidCallback onManualExtract;

  /// 操作完成后的提示回调（msg + 是否 info）
  final void Function(String message, bool info) onToast;

  const ResetExtractionDialog({
    super.key,
    required this.conversationId,
    required this.currentIgnoreMemory,
    required this.unextractedCount,
    required this.isExtracting,
    required this.onToggleIgnore,
    required this.onManualExtract,
    required this.onToast,
  });

  @override
  ConsumerState<ResetExtractionDialog> createState() =>
      _ResetExtractionDialogState();
}

class _ResetExtractionDialogState
    extends ConsumerState<ResetExtractionDialog> {
  /// 全部用户消息（按时间倒序）；null = 加载中，[] = 已加载且为空
  List<Message>? _allUserMessages;

  /// 当前选中的消息 ID 集合
  final Set<String> _selected = {};

  /// 分页可见数量（首屏 30，点「加载更多」翻倍）
  static const int _pageSize = 30;
  int _visibleCount = _pageSize;

  bool _ignoreMemory = false;

  @override
  void initState() {
    super.initState();
    _ignoreMemory = widget.currentIgnoreMemory;
    _loadMessages();
  }

  Future<void> _loadMessages() async {
    final db = ref.read(databaseProvider);
    // Drift 端在 select 表达式上用 `&` 需要导入 drift 类型；这里用两个 where
    // 链式调用避免与 Riverpod 的 valueOrNull 类型推导歧义。
    final list = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(widget.conversationId))
          ..where((t) => t.role.equals('user'))
          ..orderBy([(t) => drift.OrderingTerm.desc(t.createdAt)]))
        .get();
    if (!mounted) return;
    setState(() {
      _allUserMessages = list;
    });
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final lang = ref.watch(localeProvider).languageCode;
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final accentDark =
        isDark ? AppTheme.darkAccentDark : AppTheme.accentDark;

    return SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 448), // max-w-md
            child: Material(
              color: Colors.transparent,
              child: Container(
                decoration: AppSurfaces.dialogPanel(isDark: isDark),
                padding: const EdgeInsets.all(20), // p-5
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // ── 标题 ──
                    Text(
                      I18n.t('chat.resetExtractionTitle', lang: lang),
                      style: TextStyle(
                        fontSize: 20,
                        height: 1.18,
                        fontWeight: FontWeight.w600,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8), // mt-2
                    // 副文案
                    Text(
                      I18n.t('chat.resetExtractionDesc', lang: lang),
                      style: TextStyle(
                        fontSize: 15,
                        height: 1.65,
                        color: isDark
                            ? AppTheme.darkTextSecondary
                            : AppTheme.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 12), // mt-3

                    // ── 全选 / 已选计数行 ──
                    _buildSelectionBar(muted, accentDark, lang),
                    const SizedBox(height: 8), // mt-2

                    // ── 消息列表 ──
                    Container(
                      constraints: const BoxConstraints(maxHeight: 256),
                      decoration: BoxDecoration(
                        border: Border.all(color: borderLight),
                        borderRadius: BorderRadius.circular(12), // rounded-xl
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: _buildMessageList(isDark, borderLight, lang),
                    ),
                    const SizedBox(height: 16), // mt-4

                    // ── 操作行 ──
                    _buildActionsBar(isDark, lang),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSelectionBar(Color muted, Color accentDark, String lang) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          _selected.isEmpty
              ? I18n.t('chat.resetClickHint', lang: lang)
              : I18n.tArgs(
                  'chat.resetSelectedHint',
                  {'count': _selected.length},
                  lang: lang,
                ),
          style: TextStyle(fontSize: 14, color: muted),
        ),
        Row(
          children: [
            _LinkBtn(
              label: I18n.t('chat.resetSelectAll', lang: lang),
              color: accentDark,
              onTap: () {
                final all = _allUserMessages ?? [];
                setState(() {
                  _selected
                    ..clear()
                    ..addAll(all.map((m) => m.id));
                });
              },
            ),
            const SizedBox(width: 8),
            _LinkBtn(
              label: I18n.t('chat.resetDeselectAll', lang: lang),
              color: muted,
              onTap: () => setState(() => _selected.clear()),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildMessageList(bool isDark, Color borderLight, String lang) {
    final list = _allUserMessages;
    if (list == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Center(
          child: Text(I18n.t('chat.resetLoading', lang: lang),
              style: const TextStyle(fontSize: 14, color: AppTheme.textMuted)),
        ),
      );
    }
    if (list.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Center(
          child: Text(I18n.t('chat.resetEmpty', lang: lang),
              style: const TextStyle(fontSize: 14, color: AppTheme.textMuted)),
        ),
      );
    }

    final visible = list.take(_visibleCount).toList();
    final hasMore = list.length > _visibleCount;
    final remaining = list.length - _visibleCount;

    return LumiScrollbar(
      child: ListView.builder(
        shrinkWrap: true,
        itemCount: visible.length + (hasMore ? 1 : 0),
        itemBuilder: (ctx, index) {
          if (index >= visible.length) {
            // 「加载更多」按钮
            return InkWell(
              onTap: () => setState(() => _visibleCount += _pageSize),
              child: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 16, vertical: 12),
                color: AppTheme.accent.withValues(alpha: 0.05),
                child: Center(
                  child: Text(
                    I18n.tArgs(
                      'chat.resetLoadMore',
                      {'count': remaining},
                      lang: lang,
                    ),
                    style: TextStyle(
                      fontSize: 12,
                      color: isDark
                          ? AppTheme.darkAccentDark
                          : AppTheme.accentDark,
                    ),
                  ),
                ),
              ),
            );
          }
          final msg = visible[index];
          final isLast = index == visible.length - 1 && !hasMore;
          return _MessageRow(
            message: msg,
            selected: _selected.contains(msg.id),
            isLast: isLast,
            isDark: isDark,
            borderLight: borderLight,
            onTap: () {
              setState(() {
                if (_selected.contains(msg.id)) {
                  _selected.remove(msg.id);
                } else {
                  _selected.add(msg.id);
                }
              });
            },
          );
        },
      ),
    );
  }

  Widget _buildActionsBar(bool isDark, String lang) {
    final canManualExtract =
        !widget.isExtracting && widget.unextractedCount > 0;

    // FIX(ux)：按钮按"取消 → 普通操作 → 破坏性操作（隔开）"重新排序。
    // 取消放最显眼的最左；标记已提取 / 重置选中 / 忽略提取 / 手动提取归一组；
    // 「全部重置」属于破坏性，单独放在最右，与其他按钮以 SizedBox 隔开。
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      alignment: WrapAlignment.end,
      children: [
        // 取消（最显眼，放最左）
        _SmallBtn(
          label: I18n.t('chat.resetCancel', lang: lang),
          kind: _SmallBtnKind.secondary,
          isDark: isDark,
          onTap: () => Navigator.of(context).pop(),
        ),
        // 忽略提取开关
        _SmallBtn(
          label: _ignoreMemory
              ? I18n.t('chat.resetIgnoredOn', lang: lang)
              : I18n.t('chat.resetIgnoredOff', lang: lang),
          kind: _ignoreMemory ? _SmallBtnKind.primary : _SmallBtnKind.secondary,
          isDark: isDark,
          onTap: () {
            setState(() => _ignoreMemory = !_ignoreMemory);
            widget.onToggleIgnore(_ignoreMemory);
          },
        ),
        // 标记已提取（选中）
        _SmallBtn(
          label: I18n.tArgs(
            'chat.resetMarkExtracted',
            {'count': _selected.length},
            lang: lang,
          ),
          kind: _SmallBtnKind.secondary,
          isDark: isDark,
          onTap: _selected.isEmpty
              ? null
              : () => _execute(action: ExtractionAction.mark, allTargets: false),
        ),
        // 重置选中
        _SmallBtn(
          label: I18n.tArgs(
            'chat.resetSelected',
            {'count': _selected.length},
            lang: lang,
          ),
          kind: _SmallBtnKind.primary,
          isDark: isDark,
          onTap: _selected.isEmpty
              ? null
              : () => _execute(action: ExtractionAction.reset, allTargets: false),
        ),
        // 手动提取
        _SmallBtn(
          label: widget.isExtracting
              ? I18n.t('chat.extracting', lang: lang)
              : I18n.t('chat.manualExtract', lang: lang),
          kind: _SmallBtnKind.primary,
          isDark: isDark,
          onTap: canManualExtract
              ? () {
                  Navigator.of(context).pop();
                  widget.onManualExtract();
                }
              : null,
        ),
        // ── 与破坏性操作之间留出额外间距 ──
        const SizedBox(width: 12),
        // 全部重置：破坏性操作单独放最右
        _SmallBtn(
          label: I18n.t('chat.resetAll', lang: lang),
          kind: _SmallBtnKind.secondary,
          isDark: isDark,
          onTap: () async {
            final confirmed = await showDeleteConversationDialog(
              context,
              title: I18n.t('chat.resetAllConfirmTitle', lang: lang),
              body: I18n.t('chat.resetAllConfirmBody', lang: lang),
              confirmLabel: I18n.t('chat.resetAllConfirmAction', lang: lang),
              cancelLabel: I18n.t('chat.resetCancel', lang: lang),
            );
            if (!mounted) return;
            if (confirmed != true) return;
            await _execute(
              action: ExtractionAction.reset,
              allTargets: true,
            );
          },
        ),
      ],
    );
  }

  Future<void> _execute({
    required ExtractionAction action,
    required bool allTargets,
  }) async {
    final lang = ref.read(localeProvider).languageCode;
    try {
      final actions = ref.read(conversationActionsProvider);
      final result = await actions.resetExtraction(
        widget.conversationId,
        messageIds: allTargets ? null : _selected.toList(),
        action: action,
      );
      if (!mounted) return;
      Navigator.of(context).pop();
      final actionText = action == ExtractionAction.mark
          ? I18n.t('chat.resetActionMark', lang: lang)
          : I18n.t('chat.resetActionReset', lang: lang);
      widget.onToast(
        I18n.tArgs(
          'chat.resetActionDone',
          {'action': actionText, 'count': result.affectedCount},
          lang: lang,
        ),
        true,
      );
    } catch (e) {
      if (!mounted) return;
      widget.onToast(
        '${I18n.t('chat.resetExtractionFail', lang: lang)}: $e',
        false,
      );
    }
  }
}

class _MessageRow extends StatelessWidget {
  final Message message;
  final bool selected;
  final bool isLast;
  final bool isDark;
  final Color borderLight;
  final VoidCallback onTap;

  const _MessageRow({
    required this.message,
    required this.selected,
    required this.isLast,
    required this.isDark,
    required this.borderLight,
    required this.onTap,
  });

  bool get _extracted {
    // 通过 MessageMetadata 正式反序列化判断，避免依赖精确文本格式
    // （旧实现 contains('"memory_extracted":true') 在字段顺序、空白、嵌套
    // 中含同名字符串等情况下都会失效或误判）。
    try {
      final meta = MessageMetadata.fromJsonString(message.metadata);
      return meta.memoryExtracted;
    } catch (_) {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final primary =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final selectedBg = AppTheme.accent.withValues(alpha: 0.08);
    final hoverBg = AppTheme.accent.withValues(alpha: 0.05);

    return InkWell(
      onTap: onTap,
      hoverColor: hoverBg,
      child: Container(
        decoration: BoxDecoration(
          color: selected ? selectedBg : null,
          border: isLast
              ? null
              : Border(bottom: BorderSide(color: borderLight)),
        ),
        padding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 复选框
            _Checkbox(checked: selected, isDark: isDark),
            const SizedBox(width: 12),
            // 内容
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _previewText(message.content),
                    style: TextStyle(fontSize: 14, color: primary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _formatDateTime(message.createdAt),
                    style: TextStyle(fontSize: 12, color: muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // 状态徽标 ✓ / ○
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                _extracted ? '✓' : '○',
                style: TextStyle(
                  fontSize: 12,
                  color: _extracted
                      ? const Color(0xFF22C55E) // green-500
                      : const Color(0xFFF59E0B), // amber-500
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _previewText(String content) {
    if (content.length <= 60) return content;
    return content.substring(0, 60);
  }
}

class _Checkbox extends StatelessWidget {
  final bool checked;
  final bool isDark;

  const _Checkbox({required this.checked, required this.isDark});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 16,
      height: 16,
      margin: const EdgeInsets.only(top: 2), // mt-0.5
      decoration: BoxDecoration(
        color: checked
            ? AppTheme.accent
            : (isDark
                ? AppTheme.darkSurface
                : Colors.white),
        border: Border.all(
          color: checked
              ? AppTheme.accent
              : (isDark
                  ? AppTheme.darkBorderLight
                  : AppTheme.borderLight),
        ),
        borderRadius: BorderRadius.circular(4),
      ),
      child: checked
          ? const Icon(Icons.check, size: 12, color: Colors.white)
          : null,
    );
  }
}

class _LinkBtn extends StatefulWidget {
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _LinkBtn({
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  State<_LinkBtn> createState() => _LinkBtnState();
}

class _LinkBtnState extends State<_LinkBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Text(
          widget.label,
          style: TextStyle(
            fontSize: 12,
            color: widget.color,
            decoration: _hover ? TextDecoration.underline : null,
          ),
        ),
      ),
    );
  }
}

enum _SmallBtnKind { primary, secondary }

class _SmallBtn extends StatefulWidget {
  final String label;
  final _SmallBtnKind kind;
  final bool isDark;
  final VoidCallback? onTap;

  const _SmallBtn({
    required this.label,
    required this.kind,
    required this.isDark,
    required this.onTap,
  });

  @override
  State<_SmallBtn> createState() => _SmallBtnState();
}

class _SmallBtnState extends State<_SmallBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final enabled = widget.onTap != null;
    BoxDecoration deco;
    Color textColor;
    if (widget.kind == _SmallBtnKind.primary) {
      deco = AppSurfaces.buttonPrimary(isDark: isDark);
      textColor = Colors.white;
    } else {
      deco = BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.6)
            : Colors.white.withValues(alpha: 0.72),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(16),
      );
      textColor = isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    }
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) {
        if (enabled) setState(() => _hover = true);
      },
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          transform: Matrix4.translationValues(0, _hover ? -1 : 0, 0),
          padding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: deco,
          child: Opacity(
            opacity: enabled ? 1 : 0.5,
            child: Text(
              widget.label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: textColor,
                height: 1.1,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String _formatDateTime(DateTime dt) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
}

/// 顶层入口：弹出重置提取状态对话框
Future<void> showResetExtractionDialog(
  BuildContext context, {
  required String conversationId,
  required bool currentIgnoreMemory,
  required int unextractedCount,
  required bool isExtracting,
  required ValueChanged<bool> onToggleIgnore,
  required VoidCallback onManualExtract,
  required void Function(String message, bool info) onToast,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: const Color(0x59000000),
    transitionDuration: const Duration(milliseconds: 200),
    pageBuilder: (ctx, animation, secondary) {
      return ResetExtractionDialog(
        conversationId: conversationId,
        currentIgnoreMemory: currentIgnoreMemory,
        unextractedCount: unextractedCount,
        isExtracting: isExtracting,
        onToggleIgnore: onToggleIgnore,
        onManualExtract: onManualExtract,
        onToast: onToast,
      );
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          ),
          child: child,
        ),
      );
    },
  );
}
