// 对话内大图（ChatLightbox）槽位基准声明 —— UI 布局唯一基准（任务 2.3）
//
// 本文件除 [ImageVersionViewer] 现有渲染逻辑外，还以 `static List<PageRegion>
// get baselineRegions` 暴露与 requirements.md §A7.5 / C2.2 完全对齐的弹层
// 槽位基准列表（lightboxToolbar：上一张 → 下一张 → 确认 → 关闭 → 删除）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由
// Lightbox 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/settings_provider.dart';
import '../../../core/services/gallery_saver_service.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/page_region.dart';

/// 全屏图片版本查看器 — Lightbox 模式
///
/// 支持多版本图片浏览、手势缩放/拖拽、水平滑动切换版本。
/// 单版本时隐藏版本指示器和切换按钮。
class ImageVersionViewer extends ConsumerStatefulWidget {
  /// 槽位基准 —— 与 requirements.md §A7.5 / C2.2 严格对齐，
  /// 工具组顺序锁定为「上一张 → 下一张 → 确认 → 关闭 → 删除」，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A7.5 / C2.2 Lightbox 右上角工具组（5 枚按钮顺序锁定）
        PageRegion(
          name: 'lightboxToolbar',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.end,
              id: 'prevImage',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.end,
              id: 'nextImage',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 3,
              anchor: SlotAnchor.end,
              id: 'confirm',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 4,
              anchor: SlotAnchor.end,
              id: 'close',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 5,
              anchor: SlotAnchor.end,
              id: 'delete',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
      ];


  /// 所有版本的图片路径列表
  final List<String> imagePaths;

  /// 初始显示的版本索引
  final int initialIndex;

  /// 删除当前展示版本回调（可空）
  ///
  /// 仅当此回调不为 null 时，右上角才会显示删除按钮。点击删除按钮会先弹出
  /// 二次确认对话框，用户确认后才会调用本回调，回调入参为「当前展示版本」
  /// 对应的本地图片路径（[imagePaths] 中的当前条目）。
  ///
  /// 调用方负责：
  /// 1. 在回调内更新消息 metadata（移除该版本）；
  /// 2. 调用 ImageGenService.deleteImage 做本地文件清理；
  /// 3. 必要时关闭 lightbox（本组件不会自动 [Navigator.pop]）。
  ///
  /// 为 null 时按钮不显示，向前兼容现有调用点。
  final void Function(String currentLocalPath)? onDeleteCurrent;

  /// 确认使用当前版本回调（可空）— 对照主项目 Lightbox onConfirm
  /// 入参为当前展示版本的索引，调用方负责更新 activeVersion
  final void Function(int versionIndex)? onConfirmVersion;

  const ImageVersionViewer({
    super.key,
    required this.imagePaths,
    this.initialIndex = 0,
    this.onDeleteCurrent,
    this.onConfirmVersion,
  });

  /// 以全屏路由方式打开查看器
  static void show(
    BuildContext context, {
    required List<String> imagePaths,
    int initialIndex = 0,
    void Function(String currentLocalPath)? onDeleteCurrent,
    void Function(int versionIndex)? onConfirmVersion,
  }) {
    Navigator.of(context).push(
      PageRouteBuilder(
        opaque: false,
        barrierDismissible: true,
        barrierColor: Colors.transparent,
        pageBuilder: (context, animation, secondaryAnimation) {
          return ImageVersionViewer(
            imagePaths: imagePaths,
            initialIndex: initialIndex,
            onDeleteCurrent: onDeleteCurrent,
            onConfirmVersion: onConfirmVersion,
          );
        },
        transitionsBuilder: (context, animation, secondaryAnimation, child) {
          return FadeTransition(opacity: animation, child: child);
        },
        transitionDuration: const Duration(milliseconds: 200),
        reverseTransitionDuration: const Duration(milliseconds: 150),
      ),
    );
  }

  @override
  ConsumerState<ImageVersionViewer> createState() => _ImageVersionViewerState();
}

class _ImageVersionViewerState extends ConsumerState<ImageVersionViewer> {
  /// 当前显示的版本索引
  late int _currentIndex;

  /// 水平滑动起始位置（用于判断滑动方向和距离）
  double _horizontalDragStart = 0;

  /// 水平滑动当前位置
  double _horizontalDragCurrent = 0;

  /// 缩放控制器重置 key（切换版本时重置缩放状态）
  Key _interactiveViewerKey = UniqueKey();

  /// 是否处于缩放状态（缩放时禁用水平滑动切换）
  bool _isScaled = false;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex.clamp(0, _maxIndex);
  }

  /// 总版本数
  int get _total => widget.imagePaths.length;

  /// 最大索引
  int get _maxIndex => (_total - 1).clamp(0, _total);

  /// 是否为多版本模式
  bool get _hasMultipleVersions => _total > 1;

  /// 是否可以切换到上一版
  bool get _canGoPrevious => _currentIndex > 0;

  /// 是否可以切换到下一版
  bool get _canGoNext => _currentIndex < _maxIndex;

  /// 切换到上一版
  void _goPrevious() {
    if (!_canGoPrevious) return;
    setState(() {
      _currentIndex--;
      _interactiveViewerKey = UniqueKey();
      _isScaled = false;
    });
  }

  /// 切换到下一版
  void _goNext() {
    if (!_canGoNext) return;
    setState(() {
      _currentIndex++;
      _interactiveViewerKey = UniqueKey();
      _isScaled = false;
    });
  }

  /// 关闭查看器
  void _close() {
    Navigator.of(context).pop();
  }

  /// 触发删除当前展示版本：先弹二次确认对话框，确认后回传当前路径给调用方
  ///
  /// 注意：本组件不会自己 [Navigator.pop] 关闭 lightbox，关闭时机由调用方决定，
  /// 避免在调用方还未完成 metadata 写库时就把页面收掉。
  Future<void> _handleDeleteCurrent() async {
    final onDelete = widget.onDeleteCurrent;
    if (onDelete == null) return;
    if (_currentIndex < 0 || _currentIndex >= widget.imagePaths.length) return;
    final currentPath = widget.imagePaths[_currentIndex];

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final lang = ref.read(localeProvider).languageCode;
        return AlertDialog(
          // TODO(parity): 主项目缺失 'image.deleteCurrent' 键，硬编码兜底
          title: const Text('删除当前图片'),
          // TODO(parity): 主项目缺失 'image.deleteCurrentConfirm' 键，硬编码兜底
          content: const Text('将从对话和本地存储中移除这张图片，确定继续？'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(I18n.t('chat.cancel', lang: lang)),
            ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              // 'common.delete' 属 common.* 命名空间，留待任务 6.6 替换
              child: const Text('删除'),
            ),
          ],
        );
      },
    );

    if (confirmed == true) {
      onDelete(currentPath);
    }
  }

  Future<void> _showSaveMenu() async {
    if (_currentIndex < 0 || _currentIndex >= widget.imagePaths.length) return;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.black.withValues(alpha: 0.88),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(
                  Icons.save_alt_rounded,
                  color: Colors.white,
                ),
                title: const Text(
                  '保存到本地相册',
                  style: TextStyle(color: Colors.white),
                ),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _saveCurrentImageToGallery();
                },
              ),
              ListTile(
                leading: Icon(
                  Icons.close_rounded,
                  color: Colors.white.withValues(alpha: 0.72),
                ),
                title: Text(
                  '取消',
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.72)),
                ),
                onTap: () => Navigator.of(ctx).pop(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _saveCurrentImageToGallery() async {
    if (_currentIndex < 0 || _currentIndex >= widget.imagePaths.length) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await GallerySaverService.saveImageToGallery(widget.imagePaths[_currentIndex]);
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(
          content: Text('已保存到本地相册'),
          behavior: SnackBarBehavior.floating,
          backgroundColor: AppTheme.accentDark,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text('保存失败: $e'),
          behavior: SnackBarBehavior.floating,
          backgroundColor: Colors.red.shade400,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    // 图片最大尺寸：宽度 90% 视口，高度 85% 视口
    final maxImageWidth = size.width * 0.9;
    final maxImageHeight = size.height * 0.85;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Stack(
        children: [
          // 黑色半透明背景（点击关闭）
          GestureDetector(
            onTap: _close,
            child: Container(
              color: Colors.black.withValues(alpha: 0.9),
            ),
          ),

          // 图片区域（居中）
          Center(
            child: GestureDetector(
              onLongPress: _showSaveMenu,
              // 水平滑动手势（仅在未缩放时生效）
              onHorizontalDragStart: _isScaled
                  ? null
                  : (details) {
                      _horizontalDragStart = details.globalPosition.dx;
                      _horizontalDragCurrent = details.globalPosition.dx;
                    },
              onHorizontalDragUpdate: _isScaled
                  ? null
                  : (details) {
                      _horizontalDragCurrent = details.globalPosition.dx;
                    },
              onHorizontalDragEnd: _isScaled
                  ? null
                  : (details) {
                      final delta = _horizontalDragCurrent - _horizontalDragStart;
                      // 滑动超过 45px 触发切换
                      if (delta.abs() > 45) {
                        if (delta > 0) {
                          _goPrevious(); // 右滑 → 上一版
                        } else {
                          _goNext(); // 左滑 → 下一版
                        }
                      }
                    },
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: maxImageWidth,
                  maxHeight: maxImageHeight,
                ),
                // 200ms 淡入淡出切换动画
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 200),
                  switchInCurve: Curves.easeIn,
                  switchOutCurve: Curves.easeOut,
                  child: _buildImageView(
                    key: ValueKey(_currentIndex),
                    maxWidth: maxImageWidth,
                    maxHeight: maxImageHeight,
                  ),
                ),
              ),
            ),
          ),

          // 右上角工具区：删除按钮（可选）+ 关闭按钮
          // 删除按钮仅在调用方传入 onDeleteCurrent 时显示，与关闭按钮同处一栈
          Positioned(
            top: MediaQuery.of(context).padding.top + 16,
            right: 16,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.onConfirmVersion != null && _hasMultipleVersions) ...[
                  _buildConfirmButton(),
                  const SizedBox(width: 12),
                ],
                if (widget.onDeleteCurrent != null) ...[
                  _buildDeleteButton(),
                  const SizedBox(width: 12),
                ],
                _buildCloseButton(),
              ],
            ),
          ),

          // 版本指示器（底部居中，多版本时显示）
          if (_hasMultipleVersions)
            Positioned(
              bottom: MediaQuery.of(context).padding.bottom + 32,
              left: 0,
              right: 0,
              child: Center(child: _buildVersionIndicator()),
            ),

          // 上一版按钮（左侧居中，多版本时显示）
          if (_hasMultipleVersions)
            Positioned(
              left: 12,
              top: 0,
              bottom: 0,
              child: Center(
                child: _buildNavigationButton(
                  icon: Icons.chevron_left,
                  onPressed: _canGoPrevious ? _goPrevious : null,
                ),
              ),
            ),

          // 下一版按钮（右侧居中，多版本时显示）
          if (_hasMultipleVersions)
            Positioned(
              right: 12,
              top: 0,
              bottom: 0,
              child: Center(
                child: _buildNavigationButton(
                  icon: Icons.chevron_right,
                  onPressed: _canGoNext ? _goNext : null,
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 构建图片视图（支持双指缩放和单指拖拽）
  Widget _buildImageView({
    required Key key,
    required double maxWidth,
    required double maxHeight,
  }) {
    final path = widget.imagePaths[_currentIndex];
    final file = File(path);
    final exists = file.existsSync();

    if (!exists) {
      return _buildErrorPlaceholder(key: key);
    }

    return InteractiveViewer(
      key: _interactiveViewerKey,
      minScale: 1.0,
      maxScale: 4.0,
      onInteractionUpdate: (details) {
        // 检测是否处于缩放状态
        if (details.scale != 1.0) {
          if (!_isScaled) {
            setState(() => _isScaled = true);
          }
        }
      },
      onInteractionEnd: (details) {
        // 缩放回 1x 时恢复滑动切换
        // 通过 pointerCount 判断：如果缩放结束且回到原始大小
      },
      child: Image.file(
        file,
        key: key,
        fit: BoxFit.contain,
        width: maxWidth,
        height: maxHeight,
        errorBuilder: (_, __, ___) => _buildErrorPlaceholder(key: key),
      ),
    );
  }

  /// 构建图片加载失败占位
  Widget _buildErrorPlaceholder({required Key key}) {
    return Container(
      key: key,
      width: 200,
      height: 200,
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.1),
        ),
      ),
      child: const Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.broken_image_outlined,
            size: 48,
            color: Colors.white54,
          ),
          SizedBox(height: 12),
          // TODO(parity): 主项目缺失 'image.unavailable' 键，硬编码兜底
          Text(
            '图片不可用',
            style: TextStyle(
              color: Colors.white54,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  /// 构建关闭按钮
  Widget _buildCloseButton() {
    return Material(
      color: Colors.black54,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: _close,
        customBorder: const CircleBorder(),
        child: const Padding(
          padding: EdgeInsets.all(10),
          child: Icon(
            Icons.close,
            color: Colors.white,
            size: 22,
          ),
        ),
      ),
    );
  }

  /// 构建"确认使用"按钮（lightbox 右上角，对照主项目 onConfirm）
  Widget _buildConfirmButton() {
    return Material(
      color: AppTheme.accent.withValues(alpha: 0.85),
      shape: const CircleBorder(),
      child: InkWell(
        onTap: () {
          widget.onConfirmVersion?.call(_currentIndex);
          _close();
        },
        customBorder: const CircleBorder(),
        child: const Padding(
          padding: EdgeInsets.all(10),
          child: Icon(
            Icons.check,
            color: Colors.white,
            size: 22,
          ),
        ),
      ),
    );
  }

  /// 构建删除按钮（lightbox 右上角，与关闭按钮同栈）
  Widget _buildDeleteButton() {
    return Material(
      color: Colors.black54,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: _handleDeleteCurrent,
        customBorder: const CircleBorder(),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Icon(
            Icons.delete_outline,
            color: Colors.white.withValues(alpha: 0.9),
            size: 22,
            // TODO(parity): 主项目缺失 'image.deleteCurrent' 键，硬编码兜底
            semanticLabel: '删除当前图片',
          ),
        ),
      ),
    );
  }

  /// 构建版本指示器 "{current} / {total}"
  Widget _buildVersionIndicator() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        '${_currentIndex + 1} / $_total',
        style: const TextStyle(
          color: Colors.white,
          fontSize: 14,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  /// 构建导航切换按钮
  Widget _buildNavigationButton({
    required IconData icon,
    required VoidCallback? onPressed,
  }) {
    final isDisabled = onPressed == null;

    return Material(
      color: Colors.black54,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: onPressed,
        customBorder: const CircleBorder(),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Icon(
            icon,
            color: isDisabled
                ? Colors.white.withValues(alpha: 0.3)
                : Colors.white,
            size: 28,
          ),
        ),
      ),
    );
  }
}
