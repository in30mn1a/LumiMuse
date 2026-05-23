import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../theme/app_breakpoints.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import 'image_version_viewer.dart';

/// 图片附件组件 — 对照主项目 MessageBubble.tsx ImageGenCard（ready 状态）
///
/// 桌面端：hover 时右上角显示 3 个操作按钮（编辑提示词 / 重新生成 / 删除）
/// 移动端：按钮常显示在右上角
///
/// 本 widget 仅负责 UI 与回调透传，不直接调用 `ImageGenService`。
class ImageAttachment extends ConsumerWidget {
  final String imagePath;
  final VoidCallback? onRegenerate;
  final VoidCallback? onEditPrompt;
  final VoidCallback? onDelete;

  /// 图片版本路径列表（可选，无版本时为 null）
  final List<String>? versionPaths;

  /// 当前激活的版本索引（可选）
  final int? activeVersion;

  /// 在 lightbox 中点击「删除当前图片」时触发的回调（可空）。
  final void Function(String currentLocalPath)? onDeleteCurrentVersion;

  /// 在 lightbox 中点击「确认使用」时触发的回调（可空）。
  final void Function(int versionIndex)? onConfirmVersion;

  const ImageAttachment({
    super.key,
    required this.imagePath,
    this.onRegenerate,
    this.onEditPrompt,
    this.onDelete,
    this.versionPaths,
    this.activeVersion,
    this.onDeleteCurrentVersion,
    this.onConfirmVersion,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final file = File(imagePath);
    final exists = file.existsSync();
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isMobile = AppBreakpoints.isMobile(MediaQuery.of(context).size.width);

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: HoverBuilder(
        builder: (isHovering) {
          // 桌面端 hover 时显示按钮，移动端常显示
          final showButtons = isMobile || isHovering;

          return GestureDetector(
            onTap: exists ? () => _showFullScreen(context) : null,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Stack(
                children: [
                  // 图片主体
                  exists
                      ? SizedBox(
                          width: 320,
                          height: 240,
                          child: Image.file(
                            file,
                            width: 320,
                            height: 240,
                            cacheWidth: 640,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Center(
                              child: _buildErrorPlaceholder(isDark),
                            ),
                          ),
                        )
                      : _buildErrorPlaceholder(isDark),

                  // 右上角操作按钮组 — 对照主项目 `absolute right-2 top-2 flex gap-1`
                  if (showButtons && _hasAnyAction)
                    Positioned(
                      right: 8,
                      top: 8,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (onEditPrompt != null)
                            _ImageActionButton(
                              icon: Icons.edit_outlined,
                              tooltip: '编辑提示词',
                              onTap: onEditPrompt!,
                            ),
                          if (onRegenerate != null) ...[
                            const SizedBox(width: 4),
                            _ImageActionButton(
                              icon: Icons.refresh,
                              tooltip: '重新生成',
                              onTap: onRegenerate!,
                            ),
                          ],
                          if (onDelete != null) ...[
                            const SizedBox(width: 4),
                            _ImageActionButton(
                              icon: Icons.delete_outline,
                              tooltip: '删除图片',
                              onTap: onDelete!,
                              isDanger: true,
                            ),
                          ],
                        ],
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  bool get _hasAnyAction =>
      onEditPrompt != null || onRegenerate != null || onDelete != null;

  /// 暗色模式适配：错误占位图颜色
  Widget _buildErrorPlaceholder(bool isDark) {
    final iconColor = isDark ? AppTheme.darkAccent : AppTheme.accent;
    final textColor =
        isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
    return Container(
      width: 220,
      height: 160,
      decoration: BoxDecoration(
        color: iconColor.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: iconColor.withValues(alpha: 0.2),
        ),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.broken_image_outlined, size: 32, color: iconColor),
          const SizedBox(height: 8),
          Text('图片不可用',
              style: TextStyle(fontSize: 12, color: textColor)),
        ],
      ),
    );
  }

  /// 全屏查看图片（使用版本查看器）
  void _showFullScreen(BuildContext context) {
    final List<String> paths;
    final int initialIndex;

    if (versionPaths != null && versionPaths!.isNotEmpty) {
      paths = versionPaths!;
      initialIndex = (activeVersion ?? 0).clamp(0, paths.length - 1);
    } else {
      paths = [imagePath];
      initialIndex = 0;
    }

    ImageVersionViewer.show(
      context,
      imagePaths: paths,
      initialIndex: initialIndex,
      onDeleteCurrent: onDeleteCurrentVersion == null
          ? null
          : (currentPath) {
              Navigator.of(context).pop();
              onDeleteCurrentVersion!(currentPath);
            },
      onConfirmVersion: onConfirmVersion,
    );
  }
}

/// 图片右上角小操作按钮 — 对照主项目 `rounded-lg bg-black/50 p-1.5 text-white/80`
class _ImageActionButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool isDanger;

  const _ImageActionButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.isDanger = false,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.black.withValues(alpha: 0.5),
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        hoverColor: isDanger
            ? Colors.red.withValues(alpha: 0.6)
            : Colors.black.withValues(alpha: 0.7),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(
            icon,
            size: 14,
            color: Colors.white.withValues(alpha: 0.8),
          ),
        ),
      ),
    );
  }
}
