// 导入对话框（ImportDialog）槽位基准声明 —— UI 布局唯一基准（任务 2.3）
//
// 本文件除 [ImportDialog] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A7.3 完全对齐的弹层槽位基准列表
// （title / hintText / filenamePreview / checkboxes / footerActions）。
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

/// 导入选项对话框 — 文件名显示 + 五个 checkbox + 确认/取消按钮
class ImportDialog extends ConsumerStatefulWidget {
  /// 槽位基准 —— 与 requirements.md §A7.3 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A7.3 标题区（导入备份数据）
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
        // §A7.3 副标题/提示文案区
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
        // §A7.3 待导入文件名预览区
        PageRegion(
          name: 'filenamePreview',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'filename',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A7.3 五勾选项区，顺序锁定：角色资料 → 角色记忆 → 角色对话 → 角色画像 → 向量索引
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
            PageSlot(
              order: 4,
              anchor: SlotAnchor.start,
              id: 'characterProfiles',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 5,
              anchor: SlotAnchor.start,
              id: 'characterEmbeddings',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A7.3 底部按钮组：取消（左）→ 应用/确认导入（右）
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
              id: 'apply',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
      ];

  final String fileName;
  final VoidCallback onCancel;
  final void Function(ImportOptions options) onConfirm;

  const ImportDialog({
    super.key,
    required this.fileName,
    required this.onCancel,
    required this.onConfirm,
  });

  @override
  ConsumerState<ImportDialog> createState() => _ImportDialogState();
}

class _ImportDialogState extends ConsumerState<ImportDialog> {
  bool _includeCharacter = true;
  bool _includeMemories = true;
  bool _includeConversations = true;
  // 角色画像（含版本历史）— 对齐主项目 include_profiles 默认 1
  bool _includeProfiles = true;
  // 向量索引（可重建）— 对齐主项目 include_embeddings 默认 0；依赖 memories
  bool _includeEmbeddings = false;

  bool get _hasSelection =>
      _includeCharacter || _includeMemories || _includeConversations ||
      _includeProfiles || _includeEmbeddings;

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
              I18n.t('editor.importTitle', lang: lang),
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: isDark
                    ? AppTheme.darkTextPrimary
                    : AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),

            // 文件名显示
            Container(
              padding: const EdgeInsets.symmetric(
                  horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkWarm200.withValues(alpha: 0.5)
                    : AppTheme.warm100.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.description_outlined,
                    size: 16,
                    color: isDark
                        ? AppTheme.darkTextMuted
                        : AppTheme.textMuted,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      widget.fileName,
                      style: TextStyle(
                        fontSize: 12,
                        color: isDark
                            ? AppTheme.darkTextSecondary
                            : AppTheme.textSecondary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
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
              onChanged: (v) {
                setState(() {
                  _includeMemories = v ?? false;
                  // memories 取消勾选时，依赖它的 embeddings 自动取消勾选
                  if (!_includeMemories) {
                    _includeEmbeddings = false;
                  }
                });
              },
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
            const SizedBox(height: 8),
            _buildCheckbox(
              label: I18n.t('import.includeProfiles', lang: lang),
              value: _includeProfiles,
              onChanged: (v) =>
                  setState(() => _includeProfiles = v ?? false),
              isDark: isDark,
            ),
            const SizedBox(height: 8),
            _buildCheckbox(
              label: I18n.t('import.includeEmbeddings', lang: lang),
              value: _includeEmbeddings,
              // 禁用条件：依赖 memories（memories 未勾选时不可勾选 embeddings）
              onChanged: !_includeMemories
                  ? null
                  : (v) =>
                      setState(() => _includeEmbeddings = v ?? false),
              isDark: isDark,
            ),
            // embeddings 说明文案：解释默认不导入的原因
            Padding(
              padding: const EdgeInsets.only(left: 34, top: 4),
              child: Text(
                I18n.t('export.includeEmbeddingsHint', lang: lang),
                style: TextStyle(
                  fontSize: 11,
                  color: isDark
                      ? AppTheme.darkTextMuted
                      : AppTheme.textMuted,
                ),
              ),
            ),
            const SizedBox(height: 24),

            // 按钮行
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppSecondaryButton(
                  label: I18n.t('common.cancel', lang: lang),
                  onPressed: widget.onCancel,
                ),
                const SizedBox(width: 12),
                AppPrimaryButton(
                  label: I18n.t('import.apply', lang: lang),
                  icon: Icons.file_download_outlined,
                  onPressed: _hasSelection
                      ? () => widget.onConfirm(ImportOptions(
                            includeCharacter: _includeCharacter,
                            includeMemories: _includeMemories,
                            includeConversations: _includeConversations,
                            includeProfiles: _includeProfiles,
                            includeEmbeddings: _includeEmbeddings,
                          ))
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
    required ValueChanged<bool?>? onChanged,
    required bool isDark,
  }) {
    // onChanged 为 null 表示该选项被禁用（如 embeddings 依赖 memories）
    final disabled = onChanged == null;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: disabled ? null : () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
        child: Row(
          children: [
            SizedBox(
              width: 22,
              height: 22,
              child: Checkbox(
                value: value,
                onChanged: disabled ? null : onChanged,
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
                color: disabled
                    ? (isDark
                        ? AppTheme.darkTextMuted
                        : AppTheme.textMuted)
                    : (isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
