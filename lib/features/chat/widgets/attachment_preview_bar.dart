import 'dart:io';
import 'package:flutter/material.dart';
import '../../../core/models/attachment_item.dart';
import '../../../theme/app_theme.dart';

/// 附件预览栏 — 显示在输入框上方，展示已选附件的缩略图/文件名
///
/// 图片附件显示 48×48 缩略图，文本附件显示文件名标签。
/// 每个附件右上角带移除按钮。
class AttachmentPreviewBar extends StatelessWidget {
  /// 当前附件列表
  final List<AttachmentItem> attachments;

  /// 移除附件回调（传入索引）
  final ValueChanged<int> onRemove;

  const AttachmentPreviewBar({
    super.key,
    required this.attachments,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    if (attachments.isEmpty) return const SizedBox.shrink();

    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: List.generate(attachments.length, (index) {
          final item = attachments[index];
          return item.type == AttachmentType.image
              ? _ImagePreview(item: item, onRemove: () => onRemove(index), isDark: isDark)
              : _TextFilePreview(item: item, onRemove: () => onRemove(index), isDark: isDark);
        }),
      ),
    );
  }
}

/// 图片附件预览 — 48×48 缩略图 + 移除按钮
class _ImagePreview extends StatelessWidget {
  final AttachmentItem item;
  final VoidCallback onRemove;
  final bool isDark;

  const _ImagePreview({
    required this.item,
    required this.onRemove,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: item.thumbnailBytes != null
              ? Image.memory(
                  item.thumbnailBytes!,
                  fit: BoxFit.cover,
                  width: 48,
                  height: 48,
                )
              : Image.file(
                  File(item.filePath),
                  fit: BoxFit.cover,
                  width: 48,
                  height: 48,
                  errorBuilder: (_, __, ___) => const Icon(Icons.broken_image, size: 24),
                ),
        ),
        // 移除按钮
        Positioned(
          top: -6,
          right: -6,
          child: _RemoveButton(onTap: onRemove),
        ),
      ],
    );
  }
}

/// 文本文件预览 — 文件名标签 + 移除按钮
class _TextFilePreview extends StatelessWidget {
  final AttachmentItem item;
  final VoidCallback onRemove;
  final bool isDark;

  const _TextFilePreview({
    required this.item,
    required this.onRemove,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.6)
                : Colors.white.withValues(alpha: 0.8),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.description_outlined,
                size: 16,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
              const SizedBox(width: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 100),
                child: Text(
                  item.fileName,
                  style: TextStyle(
                    fontSize: 12,
                    color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
        // 移除按钮
        Positioned(
          top: -6,
          right: -6,
          child: _RemoveButton(onTap: onRemove),
        ),
      ],
    );
  }
}

/// 移除按钮 — 小圆形 × 按钮
class _RemoveButton extends StatelessWidget {
  final VoidCallback onTap;

  const _RemoveButton({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 18,
        height: 18,
        decoration: BoxDecoration(
          color: Colors.red[400],
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.close,
          size: 12,
          color: Colors.white,
        ),
      ),
    );
  }
}
