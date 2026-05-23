import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/database/database.dart';
import '../../../core/providers/character_provider.dart';
import '../../../core/providers/selection_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import '../../../theme/lumi_scrollbar.dart';
import '../../../theme/surfaces.dart';

/// 侧栏角色列表 — 严格 1:1 对照 src/components/sidebar/CharacterList.tsx 复刻。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - 外层 `flex h-full flex-col`
/// - 顶部「新建角色」按钮区：`px-4 pb-4`
///   - 按钮：soft-button-primary w-full justify-center
///     - min-height 2.8rem≈45、padding 0.72rem 1rem≈11.5×16
///     - 渐变 accent→accentDark、圆角 16、阴影 0 14px 30px rgba(111,82,197,0.22)
///     - PlusIcon h-4 w-4 + text-sm font-semibold
/// - 列表区：`min-h-0 flex-1 overflow-y-auto px-3 pb-4`
/// - 空态：`surface-panel-quiet mx-1 px-4 py-8 text-center`
///   - 内含 `h-12 w-12 rounded-2xl(16) bg-white/80 shadow-sm` SparkIcon h-5 w-5
///   - 文案：`text-sm font-medium text-text-primary`
/// - 角色卡片（SortableCharacterCard）：
///   - `group flex items-center gap-3 rounded-[1.25rem](20) border px-3 py-3`
///   - 选中：`border-accent/26 bg-[rgba(155,124,240,0.10)] shadow-sm`
///   - 默认：`border-transparent bg-white/48`
///   - hover：`hover:border-border-light hover:bg-white/78`
///   - 头像：`h-11 w-11(=44) rounded-2xl(16) ring-1 overflow-hidden`
///     - 选中无头像：渐变 accent→accentDark + ring-accent/20
///     - 默认：bg-warm-100 text-text-secondary ring-border-light
///   - 名字：`truncate text-sm font-medium text-text-primary`
///   - 编辑按钮：`rounded-full p-2 text-text-muted`
///     - hover:bg-warm-100 hover:text-accent
///     - 桌面端 opacity-0 group-hover:opacity-100；移动端 opacity-60 始终可见
class SidebarCharacterList extends ConsumerStatefulWidget {
  final void Function(String id) onSelectCharacter;

  const SidebarCharacterList({super.key, required this.onSelectCharacter});

  @override
  ConsumerState<SidebarCharacterList> createState() =>
      _SidebarCharacterListState();
}

class _SidebarCharacterListState extends ConsumerState<SidebarCharacterList> {
  /// 本地缓存的排序（拖拽时乐观更新）
  List<Character>? _localOrder;

  /// 角色列表滚动控制器
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _createCharacter(BuildContext context) async {
    final actions = ref.read(characterActionsProvider);
    final id = await actions.create();
    if (!context.mounted) return;
    ref.read(selectionProvider.notifier).selectCharacter(id);
    context.push('/characters/$id/edit');
  }

  Future<void> _onReorder(
    int oldIndex,
    int newIndex,
    List<Character> list,
  ) async {
    if (newIndex > oldIndex) newIndex -= 1;
    if (oldIndex == newIndex) return;

    final next = List<Character>.from(list);
    final moved = next.removeAt(oldIndex);
    next.insert(newIndex, moved);

    setState(() => _localOrder = next);

    try {
      final actions = ref.read(characterActionsProvider);
      await actions.reorder(next.map((c) => c.id).toList());
    } catch (_) {
      // 失败回滚
      if (mounted) setState(() => _localOrder = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final selectedId = ref.watch(selectionProvider).characterId;
    final charactersAsync = ref.watch(characterListProvider);
    final String lang = ref.watch(localeProvider).languageCode;

    return charactersAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      // TODO(parity): 主项目缺失 'common.loadFailed' 键，硬编码兜底
      error: (e, _) => Center(child: Text('加载失败: $e')),
      data: (loaded) {
        // 如果数据库变化（增删），丢弃本地排序缓存
        if (_localOrder != null) {
          final localIds = _localOrder!.map((c) => c.id).toSet();
          final dbIds = loaded.map((c) => c.id).toSet();
          if (localIds.length != dbIds.length ||
              !localIds.containsAll(dbIds)) {
            _localOrder = null;
          }
        }
        final list = _localOrder ?? loaded;

        return Column(
          children: [
            // ── 顶部「新建角色」按钮 px-4 pb-4 ──
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: _PrimaryButton(
                onTap: () => _createCharacter(context),
                isDark: isDark,
                label: I18n.t('sidebar.create', lang: lang),
              ),
            ),
            // ── 列表区 px-3 pb-4 ──
            Expanded(
              child: list.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                      child: _buildEmpty(context, isDark, lang),
                    )
                  : _buildList(list, selectedId, isDark),
            ),
          ],
        );
      },
    );
  }

  Widget _buildEmpty(BuildContext context, bool isDark, String lang) {
    // 与顶部「新建角色」按钮使用同一水平边距，卡片高度随内容收缩。
    return Align(
      alignment: Alignment.topCenter,
      child: Container(
        width: double.infinity,
        decoration: AppSurfaces.panelQuiet(isDark: isDark),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkSurface.withValues(alpha: 0.8)
                    : Colors.white.withValues(alpha: 0.8),
                borderRadius: BorderRadius.circular(14),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x0D000000),
                    blurRadius: 2,
                    offset: Offset(0, 1),
                  ),
                ],
              ),
              child: Icon(
                Icons.auto_awesome,
                size: 20,
                color: isDark
                    ? AppTheme.darkAccentDark
                    : AppTheme.accentDark,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              I18n.t('sidebar.empty', lang: lang),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: isDark
                    ? AppTheme.darkTextPrimary
                    : AppTheme.textPrimary,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList(
    List<Character> list,
    String? selectedId,
    bool isDark,
  ) {
    return LumiScrollbar(
      controller: _scrollController,
      child: ReorderableListView.builder(
        scrollController: _scrollController,
        buildDefaultDragHandles: false,
        // px-3 pb-4
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
        itemCount: list.length,
        proxyDecorator: (child, index, animation) {
          // 拖拽中：opacity 0.6 + zIndex 5（视觉上提到顶层）
          return Material(
            color: Colors.transparent,
            child: Opacity(opacity: 0.6, child: child),
          );
        },
        onReorder: (oldIndex, newIndex) =>
            _onReorder(oldIndex, newIndex, list),
        itemBuilder: (context, index) {
          final character = list[index];
          return _CharacterCard(
            key: ValueKey(character.id),
            index: index,
            character: character,
            selected: character.id == selectedId,
            isDark: isDark,
            onTap: () => widget.onSelectCharacter(character.id),
            onEdit: () => context.push('/characters/${character.id}/edit'),
          );
        },
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════
// 「新建角色」soft-button-primary 按钮
// 对照 globals.css `.soft-button` + `.soft-button-primary`：
//   inline-flex justify-center items-center gap-2 white-space-nowrap
//   min-height 2.8rem (≈45) padding 0.72rem 1rem rounded-2xl(16)
//   text-sm(14) font-semibold(600)
//   gradient accent → accentDark
//   shadow 0 14px 30px rgba(111, 82, 197, 0.22)
//   hover: translateY(-1px)
// ═════════════════════════════════════════════════════════════════
class _PrimaryButton extends StatefulWidget {
  final VoidCallback onTap;
  final bool isDark;
  final String label;

  const _PrimaryButton({
    required this.onTap,
    required this.isDark,
    required this.label,
  });

  @override
  State<_PrimaryButton> createState() => _PrimaryButtonState();
}

class _PrimaryButtonState extends State<_PrimaryButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedScale(
        scale: _hover ? 1.02 : 1.0,
        duration: const Duration(milliseconds: 150),
        curve: Curves.easeOutCubic,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          transform: Matrix4.translationValues(0, _hover ? -1 : 0, 0),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.md),
            boxShadow: _hover
                ? [
                    BoxShadow(
                      color: AppTheme.accent.withValues(alpha: 0.35),
                      blurRadius: 16,
                      offset: const Offset(0, 6),
                    )
                  ]
                : null,
          ),
          child: Material(
            borderRadius: BorderRadius.circular(AppRadius.md),
            clipBehavior: Clip.antiAlias,
            color: Colors.transparent,
            child: Ink(
              decoration: AppSurfaces.buttonPrimary(isDark: widget.isDark),
              child: InkWell(
                onTap: widget.onTap,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  constraints: const BoxConstraints(minHeight: 45), // 2.8rem
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.add, color: Colors.white, size: 16),
                      const SizedBox(width: 8), // gap-2
                      Text(
                        widget.label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14, // text-sm
                          fontWeight: FontWeight.w600, // font-semibold
                          height: 1, // 与原版按钮内文本基线一致
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════
// 单张角色卡片
// 对照 CharacterList.tsx 第 53~111 行 SortableCharacterCard：
//   group flex items-center gap-3 rounded-[1.25rem](20) border
//   px-3 py-3 text-left transition-colors duration-200
// 选中：border-accent/26 bg-[rgba(155,124,240,0.10)] shadow-sm
// 默认：border-transparent bg-white/48 hover:border-border-light hover:bg-white/78
// 头像：h-11 w-11 rounded-2xl(16) ring-1 (1px solid 描边)
// 名字：truncate text-sm font-medium text-text-primary
// 编辑按钮：rounded-full p-2 text-text-muted
//   hover: bg-warm-100 text-accent
//   桌面端 opacity-0 md:opacity-0 md:group-hover:opacity-100
//   移动端 opacity-60
// ═════════════════════════════════════════════════════════════════
class _CharacterCard extends StatefulWidget {
  final Character character;
  final bool selected;
  final bool isDark;
  final VoidCallback onTap;
  final VoidCallback onEdit;
  final int index;

  const _CharacterCard({
    super.key,
    required this.character,
    required this.selected,
    required this.isDark,
    required this.onTap,
    required this.onEdit,
    required this.index,
  });

  @override
  State<_CharacterCard> createState() => _CharacterCardState();
}

class _CharacterCardState extends State<_CharacterCard> {
  bool _cardHover = false;
  bool _editHover = false;

  Widget _buildSelectedIndicator(bool selected) {
    final accentColor = widget.isDark ? AppTheme.darkAccent : AppTheme.accent;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOutCubic,
      width: selected ? 4 : 0,
      height: selected ? 24 : 0,
      margin: EdgeInsets.only(right: selected ? 8 : 0),
      decoration: BoxDecoration(
        color: accentColor,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final selected = widget.selected;
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    // bg-[rgba(155,124,240,0.10)]
    final selectedBg = AppTheme.accent.withValues(alpha: 0.10);
    // bg-white/48 / bg-white/78
    final defaultBg = isDark
        ? AppTheme.darkSurface.withValues(alpha: 0.4)
        : Colors.white.withValues(alpha: 0.48);
    final hoverBg = isDark
        ? AppTheme.darkSurface.withValues(alpha: 0.78)
        : Colors.white.withValues(alpha: 0.78);
    // border-accent/26
    final selectedBorder = AppTheme.accent.withValues(alpha: 0.26);

    return Padding(
      // ReorderableListView 在每个 item 之间无间距，TSX 是 space-y-2
      // 所以这里加 4 上 / 4 下 = 8（gap-2）
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _cardHover = true),
        onExit: (_) => setState(() => _cardHover = false),
        child: AnimatedScale(
          scale: _cardHover ? 1.02 : 1.0,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            decoration: BoxDecoration(
              color: selected
                  ? selectedBg
                  : (_cardHover ? hoverBg : defaultBg),
              border: Border.all(
                color: selected
                    ? selectedBorder
                    : (_cardHover ? borderLight : Colors.transparent),
              ),
              borderRadius: BorderRadius.circular(20), // 1.25rem
              boxShadow: _cardHover || selected
                  ? [
                      BoxShadow(
                        color: isDark ? Colors.black38 : const Color(0x0A000000),
                        blurRadius: _cardHover ? 8 : 4,
                        offset: Offset(0, _cardHover ? 4 : 2),
                      ),
                    ]
                  : null,
            ),
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: widget.onTap,
                borderRadius: BorderRadius.circular(20),
                child: Padding(
                  // px-3 py-3
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 12,
                  ),
                  child: Row(
                    children: [
                      _buildSelectedIndicator(selected),
                      // 拖动把手 — 禁用默认 drag handle 后手动放置，避免与编辑按钮重叠
                      AnimatedOpacity(
                        duration: const Duration(milliseconds: 200),
                        opacity: _cardHover || selected ? 0.7 : 0.2,
                        child: ReorderableDragStartListener(
                          index: widget.index,
                          child: MouseRegion(
                            cursor: SystemMouseCursors.grab,
                            child: Padding(
                              padding: const EdgeInsets.only(right: 8),
                              child: Icon(
                                Icons.drag_indicator,
                                size: 18,
                                color: selected
                                    ? AppTheme.accent
                                    : (isDark
                                        ? AppTheme.darkTextMuted
                                        : AppTheme.textMuted),
                              ),
                            ),
                          ),
                        ),
                      ),
                      _buildAvatar(),
                      const SizedBox(width: 12), // gap-3
                      Expanded(
                        child: Text(
                          widget.character.name,
                          style: TextStyle(
                            fontSize: 14, // text-sm
                            fontWeight: FontWeight.w500,
                            color: isDark
                                ? AppTheme.darkTextPrimary
                                : AppTheme.textPrimary,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      _buildEditButton(),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 头像：h-11 w-11 rounded-2xl(16) ring-1 overflow-hidden
  Widget _buildAvatar() {
    final isDark = widget.isDark;
    final selected = widget.selected;
    final hasAvatar = widget.character.avatarUrl != null &&
        widget.character.avatarUrl!.isNotEmpty;
    // ring-accent/20 vs ring-border-light
    final ringColor = selected
        ? AppTheme.accent.withValues(alpha: 0.20)
        : (isDark ? AppTheme.darkBorderLight : AppTheme.borderLight);

    return Container(
      width: 44, // h-11 w-11
      height: 44,
      decoration: BoxDecoration(
        gradient: selected && !hasAvatar
            ? LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: isDark
                    ? [AppTheme.darkAccent, AppTheme.darkAccentDark]
                    : [AppTheme.accent, AppTheme.accentDark],
              )
            : null,
        color: (selected || hasAvatar)
            ? null
            : (isDark ? AppTheme.darkWarm100 : AppTheme.warm100),
        borderRadius: BorderRadius.circular(16), // rounded-2xl
        // ring-1 实现：使用 1px solid border
        border: Border.all(color: ringColor, width: 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: hasAvatar
          ? LumiNetworkImage(
              url: widget.character.avatarUrl!,
              fit: BoxFit.cover,
              errorWidget: _initialAvatar(),
            )
          : _initialAvatar(),
    );
  }

  Widget _initialAvatar() {
    final selected = widget.selected;
    final isDark = widget.isDark;
    return Center(
      child: Text(
        widget.character.name.isNotEmpty
            ? widget.character.name[0]
            : '?',
        style: TextStyle(
          fontSize: 14, // text-sm
          fontWeight: FontWeight.w600,
          color: selected
              ? Colors.white
              : (isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary),
        ),
      ),
    );
  }

  /// 编辑按钮 — 桌面端 hover 时显示，移动端永远 60% 透明度可见
  Widget _buildEditButton() {
    // 桌面端断点 ≥ 768：opacity 取决于 _cardHover
    // 移动端 < 768：固定 0.6（按 globals.css 的 hover:none 媒体查询）
    final width = MediaQuery.sizeOf(context).width;
    final isDesktop = width >= 768;
    final visible = isDesktop ? _cardHover : true;
    final opacity = isDesktop ? (_cardHover ? 1.0 : 0.0) : 0.6;
    final isDark = widget.isDark;

    final iconColor = _editHover
        ? AppTheme.accent
        : (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted);
    // hover:bg-warm-100
    final bgColor = _editHover
        ? (isDark ? AppTheme.darkWarm100 : AppTheme.warm100)
        : Colors.transparent;

    final double targetWidth = isDesktop ? (_cardHover ? 32.0 : 0.0) : 32.0;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      width: targetWidth,
      clipBehavior: Clip.antiAlias,
      decoration: const BoxDecoration(),
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 200),
        opacity: opacity,
        child: IgnorePointer(
          ignoring: !visible,
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            onEnter: (_) => setState(() => _editHover = true),
            onExit: (_) => setState(() => _editHover = false),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onEdit,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                padding: const EdgeInsets.all(8), // p-2
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: bgColor,
                ),
                child: Icon(
                  Icons.edit_outlined, // PencilIcon
                  size: 16, // h-4 w-4
                  color: iconColor,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
