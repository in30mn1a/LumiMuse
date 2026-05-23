// 导出对话框（ExportDialog）槽位基准声明 —— UI 布局唯一基准（任务 2.3）
//
// 本文件除 [ExportDialog] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A7.3 完全对齐的弹层槽位基准列表
// （title / hintText / checkboxes / footerActions）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由对话框
// 自行渲染，本字段不参与运行期 UI 布局。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/services/backup_service.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_form_fields.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/page_region.dart';
import '../../../theme/surfaces.dart';

/// 导出选项对话框 — 三个 checkbox + 确认/取消按钮
class ExportDialog extends ConsumerStatefulWidget {
  /// 槽位基准 —— 与 requirements.md §A7.3 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A7.3 标题区（导出角色数据）
        PageRegion(
          name: 'title',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'title',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A7.3 副标题/角色名提示区
        PageRegion(
          name: 'hintText',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'hint',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A7.3 三勾选项区，顺序锁定：角色资料 → 角色记忆 → 角色对话
        PageRegion(
          name: 'checkboxes',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'characterData',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.start,
              id: 'characterMemories',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 3,
              anchor: SlotAnchor.start,
              id: 'characterConversations',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A7.3 底部按钮组：取消（左）→ 导出/下载（右）
        PageRegion(
          name: 'footerActions',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'cancel',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.end,
              id: 'download',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
      ];

  final String characterId;
  final String characterName;
  final VoidCallback onClose;
  final Future<void> Function(ExportOptions options) onExport;

  const ExportDialog({
    super.key,
    required this.characterId,
    required this.characterName,
    required this.onClose,
    required this.onExport,
  });

  @override
  ConsumerState<ExportDialog> createState() => _ExportDialogState();
}

class _ExportDialogState extends ConsumerState<ExportDialog> {
  bool _includeCharacter = true;
  bool _includeMemories = true;
  bool _includeConversations = true;
  bool _isExporting = false;

  bool get _hasSelection =>
      _includeCharacter || _includeMemories || _includeConversations;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final lang = ref.watch(localeProvider).languageCode;

    return Dialog(
      backgroundColor: Colors.transparent,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 380),
        decoration: AppSurfaces.panel(isDark: isDark),
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 标题
            Text(
              I18n.t('export.characterTitle', lang: lang),
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: isDark
                    ? AppTheme.darkTextPrimary
                    : AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              widget.characterName,
              style: TextStyle(
                fontSize: 13,
                color: isDark
                    ? AppTheme.darkTextMuted
                    : AppTheme.textMuted,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 20),

            // 勾选项
            _buildCheckbox(
              label: I18n.t('export.includeCharacters', lang: lang),
              value: _includeCharacter,
              onChanged: (v) =>
                  setState(() => _includeCharacter = v ?? false),
              isDark: isDark,
            ),
            const SizedBox(height: 8),
            _buildCheckbox(
              label: I18n.t('export.includeMemories', lang: lang),
              value: _includeMemories,
              onChanged: (v) =>
                  setState(() => _includeMemories = v ?? false),
              isDark: isDark,
            ),
            const SizedBox(height: 8),
            _buildCheckbox(
              label: I18n.t('export.includeConversations', lang: lang),
              value: _includeConversations,
              onChanged: (v) =>
                  setState(() => _includeConversations = v ?? false),
              isDark: isDark,
            ),
            const SizedBox(height: 24),

            // 按钮行
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppSecondaryButton(
                  label: I18n.t('common.cancel', lang: lang),
                  onPressed: _isExporting ? null : widget.onClose,
                ),
                const SizedBox(width: 12),
                AppPrimaryButton(
                  label: I18n.t('export.download', lang: lang),
                  icon: Icons.file_upload_outlined,
                  loading: _isExporting,
                  onPressed: _hasSelection && !_isExporting
                      ? _handleExport
                      : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCheckbox({
    required String label,
    required bool value,
    required ValueChanged<bool?> onChanged,
    required bool isDark,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: _isExporting ? null : () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
        child: Row(
          children: [
            SizedBox(
              width: 22,
              height: 22,
              child: Checkbox(
                value: value,
                onChanged: _isExporting ? null : onChanged,
                activeColor: isDark
                    ? AppTheme.darkAccentDark
                    : AppTheme.accentDark,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(5),
                ),
                side: BorderSide(
                  color: isDark
                      ? AppTheme.darkBorder
                      : AppTheme.border,
                  width: 1.5,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              label,
              style: TextStyle(
                fontSize: 14,
                color: isDark
                    ? AppTheme.darkTextPrimary
                    : AppTheme.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _handleExport() async {
    setState(() => _isExporting = true);
    try {
      await widget.onExport(ExportOptions(
        includeCharacter: _includeCharacter,
        includeMemories: _includeMemories,
        includeConversations: _includeConversations,
      ));
    } finally {
      if (mounted) {
        setState(() => _isExporting = false);
      }
    }
  }
}
