import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import '../../../core/models/attachment_item.dart';
import '../../../core/utils/attachment_processor.dart';
import '../../../theme/app_theme.dart';

/// 附件选择按钮 — 点击后打开文件选择器
///
/// 支持选择图片（JPEG/PNG/GIF/WebP）和文本文件（TXT/MD/JSON/CSV）。
/// 单个文件大小不超过 10MB，每条消息最多 5 个附件。
class AttachmentPickerButton extends StatelessWidget {
  /// 当前已选附件数量（用于判断是否达到上限）
  final int currentCount;

  /// 选择文件后的回调
  final ValueChanged<AttachmentItem> onPicked;

  /// 文件超出大小限制时的回调
  final VoidCallback? onSizeExceeded;

  /// 是否禁用（生成中时禁用）
  final bool disabled;

  /// 是否暗色模式
  final bool isDark;

  const AttachmentPickerButton({
    super.key,
    required this.currentCount,
    required this.onPicked,
    this.onSizeExceeded,
    this.disabled = false,
    this.isDark = false,
  });

  /// 允许的文件扩展名
  static const _allowedExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', // 图片
    'txt', 'md', 'json', 'csv', // 文本
  ];

  /// 图片扩展名集合
  static const _imageExtensions = {'jpg', 'jpeg', 'png', 'gif', 'webp'};

  /// 最大附件数量
  static const maxAttachments = 5;

  Future<void> _pickFile(BuildContext context) async {
    if (currentCount >= maxAttachments) {
      _showMaxAttachmentsSnackBar(context);
      return;
    }

    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: _allowedExtensions,
    );

    if (result == null || result.files.isEmpty) return;

    final file = result.files.first;
    final filePath = file.path;
    if (filePath == null) return;

    // 验证文件大小
    final fileSize = file.size;
    if (!AttachmentProcessor.validateFileSize(fileSize)) {
      onSizeExceeded?.call();
      return;
    }

    // 判断附件类型
    final ext = file.extension?.toLowerCase() ?? '';
    final isImage = _imageExtensions.contains(ext);
    final type = isImage ? AttachmentType.image : AttachmentType.text;

    // 确定 MIME 类型
    final mimeType = _getMimeType(ext);

    // 读取缩略图（仅图片）
    final thumbnailBytes = isImage ? await File(filePath).readAsBytes() : null;

    final attachment = AttachmentItem(
      fileName: file.name,
      filePath: filePath,
      mimeType: mimeType,
      type: type,
      fileSize: fileSize,
      thumbnailBytes: thumbnailBytes,
    );

    onPicked(attachment);
  }

  void _showMaxAttachmentsSnackBar(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      // TODO(parity): 主项目缺失 'chat.attachmentMaxCount' 键，硬编码兜底
      const SnackBar(content: Text('最多附带 5 个附件')),
    );
  }

  String _getMimeType(String ext) {
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'txt':
        return 'text/plain';
      case 'md':
        return 'text/markdown';
      case 'json':
        return 'application/json';
      case 'csv':
        return 'text/csv';
      default:
        return 'application/octet-stream';
    }
  }

  @override
  Widget build(BuildContext context) {
    final isAtMaxAttachments = currentCount >= maxAttachments;
    final isDisabled = disabled || isAtMaxAttachments;

    return Tooltip(
      // TODO(parity): 主项目缺失 'chat.attachment' 键，硬编码兜底
      message: isAtMaxAttachments ? '最多附带 5 个附件' : '附件',
      child: MouseRegion(
        cursor: isDisabled
            ? SystemMouseCursors.basic
            : SystemMouseCursors.click,
        child: GestureDetector(
          onTap: disabled
              ? null
              : isAtMaxAttachments
              ? () => _showMaxAttachmentsSnackBar(context)
              : () => _pickFile(context),
          child: Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: isDark
                  ? AppTheme.darkSurface.withValues(alpha: 0.5)
                  : Colors.white.withValues(alpha: 0.6),
              border: Border.all(
                color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
              ),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              Icons.attach_file,
              size: 18,
              color: isDisabled
                  ? (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                  : (isDark
                        ? AppTheme.darkTextSecondary
                        : AppTheme.textSecondary),
            ),
          ),
        ),
      ),
    );
  }
}
