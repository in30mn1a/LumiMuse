import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/character_images_actions.dart';
import '../../core/providers/character_provider.dart';
import '../../theme/app_form_fields.dart';
import '../../theme/app_page_scaffold.dart';
import '../../theme/app_theme.dart';
import '../../theme/lumi_scrollbar.dart';
import '../chat/widgets/image_version_viewer.dart';

/// 角色图片管理页（R11 / Task 12.4）
///
/// 视觉与温柔暖光体系一致：
/// - 整页用 `AppPageScaffold` 提供 hero 头 + 主面板（已包含 `AppSurfaces.panel`）
/// - 网格用 `LumiScrollbar` 包裹 `GridView.builder`，三列等宽
/// - 多选态在网格上方挂一条蓝紫色提示条，提供「全选 / 反选 / 取消选择」按钮
///
/// 功能：
/// - 进入页面后调用 [CharacterImagesActions.listImages] 加载该角色全部生图条目
///   （每个 version 展开成独立条目）。
/// - 默认态点击缩略图 → 全屏预览；长按 → 进入多选并选中该项。
/// - 多选态点击缩略图 → 切换选中；头部「批量删除」按钮触发
///   [CharacterImagesActions.deleteImages]，完成后通过 SnackBar 反馈实际删除版本数。
///
/// 路由接入与角色编辑页入口由 Task 12.5 负责，本任务只交付页面本身。
class CharacterImagesPage extends ConsumerStatefulWidget {
  /// 当前角色 ID
  final String characterId;

  const CharacterImagesPage({super.key, required this.characterId});

  @override
  ConsumerState<CharacterImagesPage> createState() =>
      _CharacterImagesPageState();
}

class _CharacterImagesPageState extends ConsumerState<CharacterImagesPage> {
  /// 网格滚动控制器（与 [LumiScrollbar] 共享）
  final ScrollController _scrollController = ScrollController();

  /// 已加载的图片条目，按 [CharacterImagesActions.listImages] 的排序原样保留
  List<CharacterImageItem> _items = const <CharacterImageItem>[];

  /// 是否首次加载中
  bool _loading = true;

  /// 加载错误信息（null 表示无错误）
  String? _loadError;

  /// 是否处于多选态
  bool _selectionMode = false;

  /// 已选中的条目 key 集合（key 由 [_keyOf] 生成）
  final Set<String> _selectedKeys = <String>{};

  /// 是否正在执行批量删除（避免重复点击）
  bool _deleting = false;

  // ───────────────────────── 生命周期 ─────────────────────────

  @override
  void initState() {
    super.initState();
    // 首帧后再加载，避免阻塞页面进入动画
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadImages());
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  // ───────────────────────── 数据加载 ─────────────────────────

  /// 重新加载图片列表（首次进入与批量删除完成后都会调用）
  Future<void> _loadImages() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final actions = ref.read(characterImagesActionsProvider);
      final list = await actions.listImages(widget.characterId);
      if (!mounted) return;
      setState(() {
        _items = list;
        _loading = false;
        // 重建选中集合：丢弃已不存在的条目
        final liveKeys = list.map(_keyOf).toSet();
        _selectedKeys.removeWhere((k) => !liveKeys.contains(k));
        if (_selectedKeys.isEmpty) {
          _selectionMode = false;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadError = '$e';
        _loading = false;
      });
    }
  }

  // ───────────────────────── 选择态控制 ─────────────────────────

  /// 生成条目稳定 key：`messageId|imageId|versionId`
  String _keyOf(CharacterImageItem item) =>
      '${item.messageId}|${item.imageId}|${item.versionId}';

  /// 切换某条目选中态
  void _toggleSelected(CharacterImageItem item) {
    final key = _keyOf(item);
    setState(() {
      if (_selectedKeys.contains(key)) {
        _selectedKeys.remove(key);
      } else {
        _selectedKeys.add(key);
      }
      // 对照主项目：不自动退出多选态，用户需要手动点"取消"退出
    });
  }

  /// 进入多选态并选中初始条目（长按触发）
  void _enterSelectionWith(CharacterImageItem item) {
    setState(() {
      _selectionMode = true;
      _selectedKeys.add(_keyOf(item));
    });
  }

  /// 进入 / 退出多选态（头部按钮触发）
  void _toggleSelectionMode() {
    setState(() {
      if (_selectionMode) {
        _selectionMode = false;
        _selectedKeys.clear();
      } else {
        _selectionMode = true;
      }
    });
  }

  /// 全选当前列表全部条目
  void _selectAll() {
    setState(() {
      _selectedKeys
        ..clear()
        ..addAll(_items.map(_keyOf));
    });
  }

  /// 反选：选中态条目变未选，未选条目变选中
  void _invertSelection() {
    setState(() {
      final allKeys = _items.map(_keyOf).toSet();
      final next = allKeys.difference(_selectedKeys);
      _selectedKeys
        ..clear()
        ..addAll(next);
      if (_selectedKeys.isEmpty) {
        _selectionMode = false;
      }
    });
  }

  /// 取消选择：清空选中并退出多选态
  void _cancelSelection() {
    setState(() {
      _selectedKeys.clear();
      _selectionMode = false;
    });
  }

  // ───────────────────────── 批量删除 ─────────────────────────

  /// 触发批量删除：先弹确认对话框，确认后调用 actions
  Future<void> _handleBatchDelete() async {
    if (_selectedKeys.isEmpty || _deleting) return;

    final count = _selectedKeys.length;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认删除'),
        content: Text('将删除选中的 $count 个图片版本，此操作不可撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('确认删除'),
          ),
        ],
      ),
    );
    if (confirm != true) return;

    setState(() => _deleting = true);
    try {
      final actions = ref.read(characterImagesActionsProvider);
      // 把当前选中的条目按三元组转换成 deleteImages 入参
      final selectedSet = Set<String>.from(_selectedKeys);
      final targets = _items
          .where((it) => selectedSet.contains(_keyOf(it)))
          .map(
            (it) => DeleteImageTarget(
              messageId: it.messageId,
              imageId: it.imageId,
              versionId: it.versionId,
            ),
          )
          .toList();

      final result = await actions.deleteImages(widget.characterId, targets);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已删除 ${result.deletedCount} 个图片版本'),
          duration: const Duration(seconds: 2),
        ),
      );

      // 删除完成后退出多选态并重新拉取列表
      setState(() {
        _selectedKeys.clear();
        _selectionMode = false;
      });
      await _loadImages();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('删除失败: $e')));
    } finally {
      if (mounted) setState(() => _deleting = false);
    }
  }

  // ───────────────────────── 预览 ─────────────────────────

  /// 全屏查看：把同 imageId 的所有版本作为一组传入 ImageVersionViewer
  void _previewItem(CharacterImageItem item) {
    final group = _items
        .where(
          (it) => it.messageId == item.messageId && it.imageId == item.imageId,
        )
        .toList();
    // 保持图片管理列表中的版本顺序，避免预览器左右切换与缩略图顺序相反。
    final sortedPaths = group.map((e) => e.localPath).toList();
    final initialIndex = sortedPaths.indexOf(item.localPath);
    ImageVersionViewer.show(
      context,
      imagePaths: sortedPaths,
      initialIndex: initialIndex < 0 ? 0 : initialIndex,
    );
  }

  // ───────────────────────── 构建 ─────────────────────────

  @override
  Widget build(BuildContext context) {
    // 用角色信息填充 subtitle，加载失败也不阻塞页面
    final characterAsync = ref.watch(characterProvider(widget.characterId));
    final subtitle = characterAsync.maybeWhen(
      data: (c) => c?.name,
      orElse: () => null,
    );

    return AppPageScaffold(
      title: '图片管理',
      subtitle: subtitle,
      actions: _buildHeaderActions(),
      bodyPadding: EdgeInsets.zero,
      child: Column(
        children: [
          if (_selectionMode) _buildSelectionBanner(),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  /// 头部右上角按钮：刷新 / 进入或退出多选 / 批量删除（仅多选态）
  List<Widget> _buildHeaderActions() {
    final canDelete = _selectionMode && _selectedKeys.isNotEmpty && !_deleting;
    return <Widget>[
      AppPageActionChip(
        icon: Icons.refresh_rounded,
        tooltip: '刷新',
        onTap: _loading ? null : _loadImages,
      ),
      AppPageActionChip(
        icon: _selectionMode ? Icons.cancel_outlined : Icons.checklist_rounded,
        tooltip: _selectionMode ? '退出多选' : '进入多选',
        activeColor: _selectionMode ? AppTheme.accentDark : null,
        onTap: _items.isEmpty ? null : _toggleSelectionMode,
      ),
      if (_selectionMode)
        AppPageActionChip(
          icon: Icons.delete_outline_rounded,
          tooltip: '批量删除',
          activeColor: canDelete ? Colors.red[400] : null,
          onTap: canDelete ? _handleBatchDelete : null,
        ),
    ];
  }

  /// 多选态顶部提示条 — 蓝紫色淡背景 + 行动按钮
  Widget _buildSelectionBanner() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
    final textPrimary = isDark
        ? AppTheme.darkTextPrimary
        : AppTheme.textPrimary;
    final allCount = _items.length;
    final selCount = _selectedKeys.length;

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
      child: Container(
        decoration: BoxDecoration(
          color: accent.withValues(alpha: 0.12),
          border: Border.all(color: accent.withValues(alpha: 0.26)),
          borderRadius: BorderRadius.circular(16),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.checklist_rounded, size: 18, color: accent),
            const SizedBox(width: 8),
            Text(
              '已选 $selCount / $allCount',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: textPrimary,
              ),
            ),
            const Spacer(),
            // 全选 / 反选 / 取消 — 沿用 AppSecondaryButton 的温柔暖光样式
            AppSecondaryButton(
              label: '全选',
              icon: Icons.select_all_rounded,
              onPressed: allCount == 0 || _selectedKeys.length == allCount
                  ? null
                  : _selectAll,
            ),
            const SizedBox(width: 8),
            AppSecondaryButton(
              label: '反选',
              icon: Icons.swap_horiz_rounded,
              onPressed: allCount == 0 ? null : _invertSelection,
            ),
            const SizedBox(width: 8),
            AppSecondaryButton(
              label: '取消',
              icon: Icons.close_rounded,
              onPressed: _cancelSelection,
            ),
          ],
        ),
      ),
    );
  }

  /// 主体：加载中 / 错误 / 空态 / 网格
  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_loadError != null) {
      return _buildPlaceholder(
        icon: Icons.error_outline,
        title: '加载图片失败',
        subtitle: _loadError,
      );
    }
    if (_items.isEmpty) {
      return _buildPlaceholder(
        icon: Icons.photo_library_outlined,
        title: '还没有生成的图片',
        subtitle: '在聊天里让 AI 生成图片，会自动收纳到这里',
      );
    }
    return LumiScrollbar(
      controller: _scrollController,
      child: GridView.builder(
        controller: _scrollController,
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
          // 偏竖图比例，贴近常见生图输出尺寸
          childAspectRatio: 0.72,
        ),
        itemCount: _items.length,
        itemBuilder: (context, index) {
          final item = _items[index];
          final selected = _selectedKeys.contains(_keyOf(item));
          return _ImageGridTile(
            item: item,
            selectionMode: _selectionMode,
            selected: selected,
            onTap: () {
              if (_selectionMode) {
                _toggleSelected(item);
              } else {
                _previewItem(item);
              }
            },
            onLongPress: () {
              if (!_selectionMode) {
                _enterSelectionWith(item);
              } else {
                _toggleSelected(item);
              }
            },
          );
        },
      ),
    );
  }

  /// 空态 / 错误占位
  Widget _buildPlaceholder({
    required IconData icon,
    required String title,
    String? subtitle,
  }) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final secondaryColor = isDark
        ? AppTheme.darkTextSecondary
        : AppTheme.textSecondary;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 36, color: mutedColor),
            const SizedBox(height: 12),
            Text(
              title,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: secondaryColor,
              ),
            ),
            if (subtitle != null && subtitle.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                subtitle,
                style: TextStyle(fontSize: 12, color: mutedColor),
                textAlign: TextAlign.center,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 网格单元
// ═══════════════════════════════════════════════════════════════

/// 单张图片缩略图 — 包含选中遮罩、勾选角标、来源对话标题
class _ImageGridTile extends StatelessWidget {
  final CharacterImageItem item;
  final bool selectionMode;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  const _ImageGridTile({
    required this.item,
    required this.selectionMode,
    required this.selected,
    required this.onTap,
    required this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final secondaryColor = isDark
        ? AppTheme.darkTextSecondary
        : AppTheme.textSecondary;

    final file = File(item.localPath);
    final exists = file.existsSync();

    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: isDark
              ? AppTheme.darkSurface.withValues(alpha: 0.6)
              : Colors.white.withValues(alpha: 0.86),
          border: Border.all(
            color: selected
                ? accent.withValues(alpha: 0.7)
                : (isDark ? AppTheme.darkBorderLight : AppTheme.borderLight),
            width: selected ? 1.6 : 1,
          ),
          borderRadius: BorderRadius.circular(16),
          boxShadow: selected
              ? [
                  BoxShadow(
                    color: accent.withValues(alpha: 0.22),
                    blurRadius: 18,
                    offset: const Offset(0, 8),
                  ),
                ]
              : null,
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 缩略图 + 选中遮罩 + 勾选角标
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (exists)
                    Image.file(
                      file,
                      fit: BoxFit.cover,
                      // 列表多张图同时绘制，缓存压一点尺寸避免内存压力
                      cacheWidth: 480,
                      errorBuilder: (_, __, ___) =>
                          _buildBrokenPlaceholder(accent, secondaryColor),
                    )
                  else
                    _buildBrokenPlaceholder(accent, secondaryColor),
                  // 选中遮罩
                  if (selected)
                    Container(color: accent.withValues(alpha: 0.18)),
                  // 选中态角标
                  if (selectionMode)
                    Positioned(
                      top: 6,
                      right: 6,
                      child: _SelectionBadge(
                        selected: selected,
                        accent: accent,
                      ),
                    ),
                ],
              ),
            ),
            // 底部说明：对话标题，让主人快速分辨来源
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Text(
                item.conversationTitle.isEmpty
                    ? '未命名对话'
                    : item.conversationTitle,
                style: TextStyle(fontSize: 11, color: mutedColor),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBrokenPlaceholder(Color accent, Color textColor) {
    return Container(
      color: accent.withValues(alpha: 0.08),
      alignment: Alignment.center,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.broken_image_outlined, size: 26, color: accent),
          const SizedBox(height: 4),
          Text('图片不可用', style: TextStyle(fontSize: 11, color: textColor)),
        ],
      ),
    );
  }
}

/// 多选态右上角的小勾选角标
class _SelectionBadge extends StatelessWidget {
  final bool selected;
  final Color accent;

  const _SelectionBadge({required this.selected, required this.accent});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        color: selected ? accent : Colors.white.withValues(alpha: 0.85),
        border: Border.all(color: selected ? accent : Colors.white, width: 1.4),
        borderRadius: BorderRadius.circular(11),
        boxShadow: const [
          BoxShadow(
            color: Color(0x33000000),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Icon(
        selected ? Icons.check_rounded : Icons.circle_outlined,
        size: 14,
        color: selected ? Colors.white : accent,
      ),
    );
  }
}
