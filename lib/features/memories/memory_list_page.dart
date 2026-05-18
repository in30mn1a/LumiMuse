// 记忆管理页（MemoryListPage）槽位基准声明 —— UI 布局唯一基准（任务 2.2）
//
// 本文件除 [MemoryListPage] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A3.4 完全对齐的槽位基准列表
// （headerLeft / headerRight / filterBar / listHeader / memoryList /
// pagination）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由各
// 子 widget 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/database/database.dart';
import '../../core/providers/character_provider.dart';
import '../../core/providers/memory_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/utils/i18n.dart';
import '../../theme/app_spacing.dart';
import '../../theme/app_theme.dart';
import '../../theme/app_widgets.dart';
import '../../theme/page_region.dart';
import '../../theme/surfaces.dart';

/// 记忆管理页面 — 严格 1:1 对照 src/app/memories/page.tsx + components/memories/{MemoryList,MemoryCard}.tsx
class MemoryListPage extends ConsumerStatefulWidget {
  final String characterId;

  const MemoryListPage({super.key, required this.characterId});

  /// 槽位基准 —— 与 requirements.md §A3.4 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A3.4.1 头部左半区（返回 + 装饰方块 + 标题）
        PageRegion(
          name: 'headerLeft',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'back', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'decoration', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'title', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.4.1 头部右半区（角色 chip + 角色 select；禁止新增导入/导出）
        PageRegion(
          name: 'headerRight',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.end, id: 'characterChip', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.end, id: 'characterSelect', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.4.2 过滤栏（搜索 chip → 分类 select → 排序 select → 添加按钮）
        PageRegion(
          name: 'filterBar',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'searchChip', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'categorySelect', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'sortSelect', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.end, id: 'addButton', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.4.3 列表头部（label + 计数）
        PageRegion(
          name: 'listHeader',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'label', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.end, id: 'count', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.4.4 记忆列表
        PageRegion(
          name: 'memoryList',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'list', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.4.5 底部分页栏（页码状态 → spacer → 上一页 → 下一页）
        PageRegion(
          name: 'pagination',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'status', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.end, id: 'prevButton', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.end, id: 'nextButton', build: (_) => const SizedBox.shrink()),
          ],
        ),
      ];

  @override
  ConsumerState<MemoryListPage> createState() => _MemoryListPageState();
}

class _MemoryListPageState extends ConsumerState<MemoryListPage> {
  String? _selectedCategory;
  String _keyword = '';
  int _page = 0; // 0-based（TSX 是 1-based，显示时 +1）
  bool _oldestFirst = false;

  /// 添加记忆时记录新建条目的 ID，用于让 _MemoryCard 立即进入编辑态
  String? _editingMemoryId;

  static const int _pageSize = 20;

  late final TextEditingController _searchController;

  @override
  void initState() {
    super.initState();
    _searchController = TextEditingController();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  MemoryListParams get _params => MemoryListParams(
        characterId: widget.characterId,
        category: _selectedCategory,
        keyword: _keyword.isEmpty ? null : _keyword,
        page: _page,
        oldestFirst: _oldestFirst,
      );

  @override
  Widget build(BuildContext context) {
    final resultAsync = ref.watch(memoryListProvider(_params));
    final charactersAsync = ref.watch(characterListProvider);
    final lang = ref.watch(localeProvider).languageCode;

    // 严格 1:1 对照 src/app/memories/page.tsx 顶层结构：
    //   div.app-shell.min-h-screen.px-4.py-4
    //     └─ div.mx-auto.max-w-7xl.flex.flex-col.gap-4
    //         ├─ <header surface-hero>      （工具栏 + 角色 chip + 角色 select）
    //         └─ <main>                      （MemoryList = 过滤栏 panel + 列表 panel）
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.lg),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1280),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _buildHeader(lang, charactersAsync),
                  const SizedBox(height: AppSpacing.lg),
                  _buildFilterPanel(lang),
                  const SizedBox(height: AppSpacing.lg),
                  _buildListPanel(lang, resultAsync),
                  const SizedBox(height: AppSpacing.lg),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 顶部 surface-hero 工具栏
  // ═════════════════════════════════════════════════════════════
  Widget _buildHeader(String lang, AsyncValue<List<Character>> charactersAsync) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final characters = charactersAsync.valueOrNull ?? const [];

    return Container(
      decoration: AppSurfaces.hero(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final wide = constraints.maxWidth >= 900;
          final left = _buildHeaderLeft(lang, isDark);
          final right = _buildHeaderRight(lang, isDark, characters);
          if (wide) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [left, right],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [left, const SizedBox(height: AppSpacing.lg), right],
          );
        },
      ),
    );
  }

  Widget _buildHeaderLeft(String lang, bool isDark) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        LumiSoftButton(
          label: I18n.t('memories.back', lang: lang),
          icon: Icons.arrow_back_rounded,
          kind: LumiSoftButtonKind.secondary,
          onTap: () {
            if (Navigator.of(context).canPop()) {
              Navigator.of(context).pop();
            } else {
              context.go('/');
            }
          },
        ),
        const SizedBox(width: AppSpacing.lg),
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: AppTheme.accent.withValues(alpha: 0.12),
            borderRadius: AppRadius.mdBorder,
          ),
          child: Icon(
            Icons.psychology_outlined,
            size: 20,
            color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
          ),
        ),
        const SizedBox(width: AppSpacing.lg),
        Flexible(
          child: Text(
            I18n.t('memories.title', lang: lang),
            style: TextStyle(
              fontSize: 24,
              height: 1.18,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  Widget _buildHeaderRight(
    String lang,
    bool isDark,
    List<Character> characters,
  ) {
    return Wrap(
      spacing: AppSpacing.md,
      runSpacing: AppSpacing.sm,
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 224),
          child: _RichSelect<String>(
            value: widget.characterId,
            items: characters
                .map((c) => _RichSelectItem(value: c.id, label: c.name))
                .toList(),
            onChanged: (id) {
              if (id != widget.characterId) {
                setState(() => _editingMemoryId = null);
                context.replace('/memories/$id');
              }
            },
          ),
        ),
      ],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 过滤栏 panel — 搜索 + 分类 + 排序 + 添加按钮 + 计数 chip
  // ═════════════════════════════════════════════════════════════
  Widget _buildFilterPanel(String lang) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: AppSurfaces.panel(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LayoutBuilder(
            builder: (ctx, constraints) {
              final wide = constraints.maxWidth >= 900;
              final search = _SearchChip(
                controller: _searchController,
                hint: I18n.t('memory.search', lang: lang),
                onChanged: (v) => setState(() {
                  _keyword = v;
                  _page = 0;
                }),
              );
              final category = IntrinsicWidth(
                child: _RichSelect<String?>(
                  value: _selectedCategory,
                  items: [
                    _RichSelectItem<String?>(
                      value: null,
                      label: I18n.t('memory.allCategories', lang: lang),
                    ),
                    ...memoryCategories.map(
                      (c) => _RichSelectItem<String?>(value: c, label: c),
                    ),
                  ],
                  onChanged: (v) => setState(() {
                    _selectedCategory = v;
                    _page = 0;
                    _editingMemoryId = null;
                  }),
                ),
              );
              final sort = SizedBox(
                width: wide ? 144 : double.infinity, // lg:w-36 = 9rem
                child: _RichSelect<bool>(
                  value: _oldestFirst,
                  items: [
                    _RichSelectItem(
                      value: false,
                      label: I18n.t('memory.sortNewest', lang: lang),
                    ),
                    _RichSelectItem(
                      value: true,
                      label: I18n.t('memory.sortOldest', lang: lang),
                    ),
                  ],
                  onChanged: (v) => setState(() {
                    _oldestFirst = v;
                    _page = 0;
                    _editingMemoryId = null;
                  }),
                ),
              );
              final add = LumiSoftButton(
                label: I18n.t('memory.add', lang: lang),
                icon: Icons.add,
                kind: LumiSoftButtonKind.primary,
                onTap: _handleAdd,
              );
              if (wide) {
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(child: search),
                    const SizedBox(width: AppSpacing.md),
                    category,
                    const SizedBox(width: AppSpacing.md),
                    sort,
                    const SizedBox(width: AppSpacing.md),
                    add,
                  ],
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  search,
                  const SizedBox(height: AppSpacing.md),
                  category,
                  const SizedBox(height: AppSpacing.md),
                  sort,
                  const SizedBox(height: AppSpacing.md),
                  Align(alignment: Alignment.centerLeft, child: add),
                ],
              );
            },
          ),
          const SizedBox(height: AppSpacing.md),
          Consumer(
            builder: (context, ref, _) {
              final result = ref.watch(memoryListProvider(_params));
              final total = result.valueOrNull?.total ?? 0;
              return Align(
                alignment: Alignment.centerLeft,
                child: LumiChip(
                  active: true,
                  label: '${I18n.t('memory.summary', lang: lang)} $total',
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 列表 panel — 顶部 label + count，中间记忆行项，底部分页栏
  // ═════════════════════════════════════════════════════════════
  Widget _buildListPanel(String lang, AsyncValue<MemoryListResult> resultAsync) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;

    return Container(
      decoration: AppSurfaces.panel(isDark: isDark),
      clipBehavior: Clip.antiAlias,
      child: resultAsync.when(
        loading: () => const Padding(
          padding: EdgeInsets.symmetric(vertical: 60),
          child: Center(child: CircularProgressIndicator()),
        ),
        error: (e, _) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 60),
          child: Center(child: Text('$e')),
        ),
        data: (result) {
          final total = result.total;
          final memories = result.memories;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.lg,
                  vertical: AppSpacing.md,
                ),
                decoration: BoxDecoration(
                  border: Border(bottom: BorderSide(color: borderColor)),
                ),
                child: Row(
                  children: [
                    Text(
                      I18n.t('memory.title', lang: lang),
                      style: TextStyle(
                        fontSize: 12,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '$total ${I18n.t('memory.count', lang: lang)}',
                      style: TextStyle(
                        fontSize: 12,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              if (memories.isEmpty)
                _buildEmpty(lang, isDark)
              else ...[
                for (int i = 0; i < memories.length; i++)
                  _MemoryCard(
                    memory: memories[i],
                    isLast: i == memories.length - 1,
                    initialEditing: memories[i].id == _editingMemoryId,
                    lang: lang,
                    onUpdate: _handleUpdate,
                    onDelete: _handleDelete,
                  ),
                _buildPagination(lang, isDark, result),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _buildEmpty(String lang, bool isDark) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xxl, vertical: 48),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: AppTheme.accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(22), // rounded-[1.4rem]
            ),
            child: Icon(
              Icons.auto_awesome,
              size: 24,
              color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text(
            I18n.t('memory.emptyFiltered', lang: lang),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            I18n.t('memory.subtitle', lang: lang),
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPagination(
    String lang,
    bool isDark,
    MemoryListResult result,
  ) {
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    const pageSize = _pageSize;
    final totalPages = ((result.total / pageSize).ceil()).clamp(1, 1 << 30);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: borderColor)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              I18n.tArgs(
                'memory.pageStatus',
                {
                  'page': _page + 1,
                  'totalPages': totalPages,
                  'pageSize': pageSize,
                },
                lang: lang,
              ),
              style: TextStyle(
                fontSize: 12,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ),
          LumiSoftButton(
            label: I18n.t('memory.prevPage', lang: lang),
            icon: null,
            kind: LumiSoftButtonKind.secondary,
            tiny: true,
            onTap: _page > 0 ? () => setState(() => _page--) : null,
          ),
          const SizedBox(width: AppSpacing.sm),
          LumiSoftButton(
            label: I18n.t('memory.nextPage', lang: lang),
            icon: null,
            kind: LumiSoftButtonKind.secondary,
            tiny: true,
            onTap: result.hasMore ? () => setState(() => _page++) : null,
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 业务方法
  // ═════════════════════════════════════════════════════════════

  Future<void> _handleUpdate(String id, _MemoryUpdate updates) async {
    final actions = ref.read(memoryActionsProvider);
    await actions.update(
      id,
      category: updates.category,
      content: updates.content,
      tags: updates.tags,
    );
    setState(() => _editingMemoryId = null);
    ref.invalidate(memoryListProvider(_params));
  }

  Future<void> _handleDelete(String id) async {
    final actions = ref.read(memoryActionsProvider);
    await actions.delete(id);
    ref.invalidate(memoryListProvider(_params));
    final result = await ref.read(memoryListProvider(_params).future);
    if (result.memories.isEmpty && _page > 0) {
      setState(() => _page--);
    }
  }

  Future<void> _handleAdd() async {
    final lang = ref.read(localeProvider).languageCode;
    final actions = ref.read(memoryActionsProvider);
    final newId = await actions.create(
      characterId: widget.characterId,
      category: memoryCategories[1],
      content: I18n.t('memory.newContent', lang: lang),
      confidence: 0.9,
      tags: const <String>[],
    );
    setState(() {
      _oldestFirst = false;
      _page = 0;
      _editingMemoryId = newId;
    });
    ref.invalidate(memoryListProvider(_params));
  }
}

// ═══════════════════════════════════════════════════════════════
// 记忆行项 — 严格对照 src/components/memories/MemoryCard.tsx
// ═══════════════════════════════════════════════════════════════

class _MemoryUpdate {
  final String category;
  final String content;
  final List<String> tags;

  const _MemoryUpdate({
    required this.category,
    required this.content,
    required this.tags,
  });
}

class _MemoryCard extends StatefulWidget {
  final Memory memory;
  final bool isLast;
  final bool initialEditing;
  final String lang;
  final Future<void> Function(String id, _MemoryUpdate updates) onUpdate;
  final Future<void> Function(String id) onDelete;

  const _MemoryCard({
    required this.memory,
    required this.isLast,
    required this.initialEditing,
    required this.lang,
    required this.onUpdate,
    required this.onDelete,
  });

  @override
  State<_MemoryCard> createState() => _MemoryCardState();
}

class _MemoryCardState extends State<_MemoryCard> {
  late bool _editing;
  late TextEditingController _contentController;
  late TextEditingController _tagsController;
  late String _category;
  bool _expanded = false;
  bool _hover = false;

  @override
  void initState() {
    super.initState();
    _editing = widget.initialEditing;
    _contentController = TextEditingController(text: widget.memory.content);
    _tagsController =
        TextEditingController(text: _decodeTags(widget.memory.tags).join(' '));
    _category = widget.memory.category;
  }

  @override
  void didUpdateWidget(covariant _MemoryCard old) {
    super.didUpdateWidget(old);
    if (old.memory.id != widget.memory.id) {
      _contentController.text = widget.memory.content;
      _tagsController.text = _decodeTags(widget.memory.tags).join(' ');
      _category = widget.memory.category;
      _editing = widget.initialEditing;
      _expanded = false;
    }
  }

  @override
  void dispose() {
    _contentController.dispose();
    _tagsController.dispose();
    super.dispose();
  }

  List<String> _decodeTags(String raw) {
    if (raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) return decoded.cast<String>();
    } catch (_) {}
    return const [];
  }

  String _formatShortDate(DateTime t) =>
      '${t.year}/${t.month}/${t.day}';

  Future<void> _handleSave() async {
    final tags = _tagsController.text
        .split(RegExp(r'[\s,、，#]+'))
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    await widget.onUpdate(
      widget.memory.id,
      _MemoryUpdate(
        category: _category,
        content: _contentController.text,
        tags: tags,
      ),
    );
    if (!mounted) return;
    setState(() {
      _editing = false;
      _expanded = false;
    });
  }

  void _handleCancel() {
    setState(() {
      _contentController.text = widget.memory.content;
      _tagsController.text = _decodeTags(widget.memory.tags).join(' ');
      _category = widget.memory.category;
      _editing = false;
      _expanded = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final highlight = _editing || _hover;
    final bg = highlight
        ? (isDark
            ? AppTheme.darkWarm100
            : AppTheme.warm100)
        : (isDark
            ? AppTheme.darkWarm50.withValues(alpha: 0.0)
            : AppTheme.warm50.withValues(alpha: 0.0));

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: bg,
          border: Border(
            bottom: widget.isLast
                ? BorderSide.none
                : BorderSide(color: borderColor),
          ),
        ),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
        child: LayoutBuilder(
          builder: (ctx, constraints) {
            final wide = constraints.maxWidth >= 900;
            final body = _buildBody(isDark, wide);
            final desktopActions =
                wide ? _buildDesktopActions(isDark) : const SizedBox.shrink();
            if (wide) {
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: body),
                  const SizedBox(width: AppSpacing.md),
                  desktopActions,
                ],
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [body],
            );
          },
        ),
      ),
    );
  }

  Widget _buildBody(bool isDark, bool wide) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            if (_editing)
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: _RichSelect<String>(
                    value: memoryCategories.contains(_category)
                        ? _category
                        : memoryCategories[1],
                    items: memoryCategories
                        .map((c) => _RichSelectItem(value: c, label: c))
                        .toList(),
                    onChanged: (v) => setState(() => _category = v),
                  ),
                ),
              )
            else
              LumiChip(
                active: true,
                label: widget.memory.category,
              ),
            const SizedBox(width: AppSpacing.sm),
            Text(
              _formatShortDate(widget.memory.createdAt),
              style: TextStyle(
                fontSize: 11,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        if (_editing)
          _RichTextarea(
            controller: _contentController,
            minLines: 3,
            maxLines: 8,
          )
        else
          _buildContentText(isDark),
        const SizedBox(height: AppSpacing.sm),
        _buildTagsRow(isDark, wide),
      ],
    );
  }

  Widget _buildContentText(bool isDark) {
    final content = widget.memory.content;
    return LayoutBuilder(
      builder: (context, constraints) {
        final textStyle = TextStyle(
          fontSize: 14,
          height: 1.65,
          color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
        );
        final textSpan = TextSpan(text: content, style: textStyle);
        final textPainter = TextPainter(
          text: textSpan,
          maxLines: 2,
          textDirection: TextDirection.ltr,
        );
        textPainter.layout(maxWidth: constraints.maxWidth);
        final isTruncated = textPainter.didExceedMaxLines;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              content,
              style: textStyle,
              maxLines: _expanded ? null : 2,
              overflow:
                  _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
            ),
            if (isTruncated)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => setState(() => _expanded = !_expanded),
                  child: MouseRegion(
                    cursor: SystemMouseCursors.click,
                    child: Text(
                      _expanded ? '收起' : '展开全文',
                      style: TextStyle(
                        fontSize: 11,
                        color: (isDark
                                ? AppTheme.darkAccentDark
                                : AppTheme.accentDark)
                            .withValues(alpha: 0.7),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildTagsRow(bool isDark, bool wide) {
    final tags = _decodeTags(widget.memory.tags);
    if (_editing) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: _RichInput(
              controller: _tagsController,
              hint: '用空格或逗号分隔',
              compact: true,
              borderRadius: AppRadius.pillBorder,
            ),
          ),
          if (!wide) ...[
            const SizedBox(width: AppSpacing.sm),
            LumiSoftButton(
              label: I18n.t('memory.save', lang: widget.lang),
              icon: null,
              kind: LumiSoftButtonKind.primary,
              tiny: true,
              onTap: _handleSave,
            ),
            const SizedBox(width: 6),
            LumiSoftButton(
              label: I18n.t('memory.cancel', lang: widget.lang),
              icon: null,
              kind: LumiSoftButtonKind.secondary,
              tiny: true,
              onTap: _handleCancel,
            ),
          ],
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (tags.isNotEmpty)
          Expanded(
            child: Wrap(
              spacing: AppSpacing.xs,
              runSpacing: AppSpacing.xs,
              children: tags
                  .map(
                    (t) => LumiChip(
                      active: false,
                      label: '#$t',
                    ),
                  )
                  .toList(),
            ),
          )
        else
          const Spacer(),
        if (!wide) ...[
          const SizedBox(width: AppSpacing.sm),
          LumiChip.icon(
            icon: Icons.edit_outlined,
            onTap: () => setState(() => _editing = true),
          ),
          const SizedBox(width: 6),
          LumiChip.icon(
            icon: Icons.delete_outline,
            onTap: () => widget.onDelete(widget.memory.id),
          ),
        ],
      ],
    );
  }

  Widget _buildDesktopActions(bool isDark) {
    if (_editing) {
      return Wrap(
        spacing: AppSpacing.sm,
        runSpacing: AppSpacing.sm,
        alignment: WrapAlignment.end,
        children: [
          LumiSoftButton(
            label: I18n.t('memory.save', lang: widget.lang),
            icon: null,
            kind: LumiSoftButtonKind.primary,
            tiny: true,
            onTap: _handleSave,
          ),
          LumiSoftButton(
            label: I18n.t('memory.cancel', lang: widget.lang),
            icon: null,
            kind: LumiSoftButtonKind.secondary,
            tiny: true,
            onTap: _handleCancel,
          ),
        ],
      );
    }
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      alignment: WrapAlignment.end,
      children: [
        LumiSoftButton(
          label: I18n.t('memory.edit', lang: widget.lang),
          icon: Icons.edit_outlined,
          kind: LumiSoftButtonKind.secondary,
          tiny: true,
          onTap: () => setState(() => _editing = true),
        ),
        LumiSoftButton(
          label: I18n.t('memory.delete', lang: widget.lang),
          icon: Icons.delete_outline,
          kind: LumiSoftButtonKind.danger,
          tiny: true,
          onTap: () => widget.onDelete(widget.memory.id),
        ),
      ],
    );
  }
}


// ═══════════════════════════════════════════════════════════════
// 公共 widget — 搜索 chip / select / input / textarea
// ═══════════════════════════════════════════════════════════════

/// 搜索 chip — 严格对照 TSX 的 `label.chip flex-1 min-w-0`：
/// 1px 圆角 999 边框 + 半透明白底 + SearchIcon + 内嵌 input
class _SearchChip extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final ValueChanged<String> onChanged;

  const _SearchChip({
    required this.controller,
    required this.hint,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: 4),
      decoration: AppSurfaces.chip(active: false, isDark: isDark),
      child: Row(
        children: [
          Icon(
            Icons.search,
            size: 14,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onChanged,
              style: TextStyle(
                fontSize: 14,
                color:
                    isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: TextStyle(
                  fontSize: 14,
                  color: isDark
                      ? AppTheme.darkTextMuted
                      : AppTheme.textMuted,
                ),
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 6),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// select-rich：圆角 16 + 半透明白底 + 内嵌下拉
class _RichSelect<T> extends StatelessWidget {
  final T value;
  final List<_RichSelectItem<T>> items;
  final ValueChanged<T> onChanged;

  const _RichSelect({
    required this.value,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: 4),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.86),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: AppRadius.mdBorder,
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          isExpanded: true,
          value: value,
          items: [
            if (!items.any((it) => it.value == value))
              DropdownMenuItem<T>(
                value: value,
                enabled: false,
                child: Text(
                  '$value',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    color: isDark
                        ? AppTheme.darkTextMuted
                        : AppTheme.textMuted,
                  ),
                ),
              ),
            ...items.map((it) => DropdownMenuItem<T>(
                  value: it.value,
                  child: Text(
                    it.label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
                    ),
                  ),
                )),
          ],
          onChanged: (v) {
            if (v != null) onChanged(v);
          },
          icon: Icon(
            Icons.expand_more,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      ),
    );
  }
}

class _RichSelectItem<T> {
  final T value;
  final String label;
  const _RichSelectItem({required this.value, required this.label});
}

/// input-rich — 通用输入框（编辑态标签、其他场景）
class _RichInput extends StatelessWidget {
  final TextEditingController controller;
  final String? hint;
  final bool compact;
  final BorderRadius? borderRadius;

  const _RichInput({
    required this.controller,
    this.hint,
    this.compact = false,
    this.borderRadius,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.86),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: borderRadius ?? AppRadius.mdBorder,
      ),
      child: TextField(
        controller: controller,
        style: TextStyle(
          fontSize: compact ? 12 : 14,
          color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          height: 1.4,
        ),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(
            fontSize: compact ? 12 : 14,
            color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                .withValues(alpha: 0.7),
          ),
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          contentPadding: EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: compact ? AppSpacing.sm : AppSpacing.md,
          ),
          isDense: true,
        ),
      ),
    );
  }
}

/// textarea-rich — 编辑态内容多行输入
class _RichTextarea extends StatelessWidget {
  final TextEditingController controller;
  final int minLines;
  final int maxLines;

  const _RichTextarea({
    required this.controller,
    required this.minLines,
    required this.maxLines,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.86),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: AppRadius.mdBorder,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      constraints: const BoxConstraints(minHeight: 96),
      child: TextField(
        controller: controller,
        minLines: minLines,
        maxLines: maxLines,
        style: TextStyle(
          fontSize: 14,
          height: 1.65,
          color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
        ),
        decoration: const InputDecoration(
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          isDense: true,
          contentPadding: EdgeInsets.symmetric(vertical: AppSpacing.sm),
        ),
      ),
    );
  }
}
