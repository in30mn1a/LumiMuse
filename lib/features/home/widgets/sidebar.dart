import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../../core/providers/character_provider.dart';
import '../../../theme/font_config.dart';
import '../../../core/providers/search_provider.dart';
import '../../../core/providers/selection_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_breakpoints.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';
import '../../search/widgets/highlighted_text.dart';
import 'sidebar_character_list.dart';

/// 主侧栏 — 严格 1:1 对照 src/components/sidebar/Sidebar.tsx 复刻。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - 容器：`surface-panel`，宽度 21rem（桌面）/ 72vw（移动）；高度由父容器控制
/// - Hero 区：外层 `border-b border-border-light p-4`；内层 `surface-hero p-4`
///   - Logo 方块 48×48，圆角 1.1rem≈18，渐变 accent→accentDark，含 SparkIcon 20×20
///   - 标题 'LumiMuse'：1.5rem (=24)、font-semibold、tracking-tight、纯色 text-primary
///     品牌名 LumiMuse 用 Quicksand（英文标题），其余走主题正文文楷。**绝不**用渐变 ShaderMask
/// - 搜索框：外层 `relative border-b border-border-light px-4 py-3`
///   - 内层 `rounded-2xl border bg-white/60 px-3 py-2`，focus 时切换边框 / 背景
///   - placeholder = "搜索对话内容..."（TSX 硬编码，i18n 表中亦同值）
///   - 清除符号是 `×` 字符，**不**使用 Icons.close
/// - 搜索结果浮层：`absolute left-4 right-4 top-full mt-1` 紧贴搜索框下方
///   - `rounded-2xl border border-border-light bg-white shadow-lg`，max-h 60vh
///   - 每条 `border-b border-border-light px-4 py-3`，hover 时 `bg-accent/5`
///   - 「查看更多结果」按钮文案硬编码（TSX 同）
/// - section 标签：外层 `border-b border-border-light px-4 py-4`
///   - 内层 `surface-panel-quiet p-4`，文案使用 `.label-small` 风格
///   - .label-small：0.78rem (~12.48)、letter-spacing 0.04em、uppercase、text-muted
/// - 角色列表区：`min-h-0 flex-1 overflow-hidden pt-1`
/// - 底部 footer：外层 `border-t border-border-light p-4`，内层 `grid gap-2`
///   - 每条 `rounded-2xl border-transparent bg-white/70 px-4 py-3 gap-3 text-sm`
///   - hover 时 `border-border-light bg-white text-text-primary`
///   - icon 始终 accent-dark，**不**随 hover 变色
class Sidebar extends ConsumerStatefulWidget {
  /// 关闭抽屉的回调（移动端使用，桌面端为 null）
  ///
  /// 返回的 Future 在抽屉关闭动画完成后才 complete，
  /// 这样调用方可以安全地在 await 之后执行路由切换，
  /// 避免抽屉滑出期间底层页面闪现。
  final Future<void> Function()? onCloseDrawer;

  const Sidebar({super.key, this.onCloseDrawer});

  @override
  ConsumerState<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends ConsumerState<Sidebar> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode();
  Timer? _searchDebounce;
  List<SearchResult> _searchResults = [];
  bool _searchLoading = false;
  bool _searchFocused = false;
  bool _loadingMore = false;
  bool _hasMore = false;
  String _lastQuery = '';

  @override
  void initState() {
    super.initState();
    _searchFocus.addListener(_handleFocusChange);
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    _searchDebounce?.cancel();
    super.dispose();
  }

  void _handleFocusChange() {
    setState(() => _searchFocused = _searchFocus.hasFocus);
  }

  void _onQueryChanged(String query) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 250), () {
      _runSearch(query);
    });
  }

  Future<void> _runSearch(String query) async {
    if (query.trim().isEmpty) {
      setState(() {
        _searchResults = [];
        _lastQuery = '';
        _searchLoading = false;
        _hasMore = false;
      });
      return;
    }
    if (query == _lastQuery) return;
    _lastQuery = query;
    setState(() => _searchLoading = true);

    try {
      final actions = ref.read(searchActionsProvider);
      final pageResult = await actions.searchMessages(query, limit: 30);
      if (mounted && query == _lastQuery) {
        setState(() {
          _searchResults = pageResult.results;
          _hasMore = pageResult.hasMore;
          _searchLoading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _searchLoading = false);
    }
  }

  /// 「查看更多结果」按钮：以当前结果数作为 offset，追加下一页
  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore || _lastQuery.isEmpty) return;
    setState(() => _loadingMore = true);
    try {
      final actions = ref.read(searchActionsProvider);
      final pageResult = await actions.searchMessages(
        _lastQuery,
        limit: 30,
        offset: _searchResults.length,
      );
      if (mounted) {
        setState(() {
          _searchResults = [..._searchResults, ...pageResult.results];
          _hasMore = pageResult.hasMore;
          _loadingMore = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _clearSearch() {
    _searchController.clear();
    _searchDebounce?.cancel();
    setState(() {
      _searchResults = [];
      _lastQuery = '';
      _searchLoading = false;
      _hasMore = false;
    });
  }

  void _onSelectResult(SearchResult result) {
    ref
        .read(selectionProvider.notifier)
        .selectConversation(
          characterId: result.characterId,
          conversationId: result.conversationId,
          targetMessageId: result.messageId,
        );
    _clearSearch();
    _searchFocus.unfocus();
    widget.onCloseDrawer?.call();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final showSearchPanel = _searchFocused && _lastQuery.trim().isNotEmpty;
    final String lang = ref.watch(localeProvider).languageCode;
    final borderLight = isDark
        ? AppTheme.darkBorderLight
        : AppTheme.borderLight;

    final width = AppBreakpoints.isMobileOf(context)
        ? MediaQuery.sizeOf(context).width *
                AppBreakpoints.mobileDrawerWidthRatio -
            12
        : 336.0; // 21rem

    return AppSurfaces.panelBox(
      context: context,
      isDark: isDark,
      width: width,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          // ── 主内容层 ──
          Column(
            children: [
              // ── Hero（border-b border-border-light p-4） ──
              _buildHeroBlock(context, isDark, borderLight),

              // ── 搜索框（border-b border-border-light px-4 py-3） ──
              _buildSearchInputBlock(context, isDark, lang, borderLight),

              // ── 角色列表主体（min-h-0 flex-1 overflow-hidden pt-1） ──
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: SidebarCharacterList(
                    onCloseDrawer: widget.onCloseDrawer,
                    onSelectCharacter: (id) {
                      ref.read(selectionProvider.notifier).selectCharacter(id);
                      widget.onCloseDrawer?.call();
                    },
                  ),
                ),
              ),

              // ── footer：记忆 / 设置（border-t border-border-light p-4） ──
              _buildFooterBlock(context, isDark, lang, borderLight),
            ],
          ),

          // ── 搜索结果浮层：覆盖在主内容层之上 ──
          if (showSearchPanel)
            Positioned(
              left: 16,
              right: 16,
              // hero 高度 + 搜索框高度（padding 12*2 + input ~36 = ~60）+ 间距
              top: 172,
              child: _buildSearchPanel(context, isDark, lang, borderLight),
            ),
        ],
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Hero 块：外层 border-b border-border-light p-4 + 内层 surface-hero p-4
  // ─────────────────────────────────────────────────────────────
  Widget _buildHeroBlock(BuildContext context, bool isDark, Color borderLight) {
    return Container(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: borderLight)),
      ),
      padding: const EdgeInsets.all(16),
      child: Container(
        decoration: AppSurfaces.hero(isDark: isDark, context: context),
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            // Logo 方块：h-12 w-12, rounded-[1.1rem]≈18, gradient accent→accentDark
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: isDark
                      ? [AppTheme.darkAccent, AppTheme.darkAccentDark]
                      : [AppTheme.accent, AppTheme.accentDark],
                ),
                borderRadius: BorderRadius.circular(17.6), // 1.1rem
                boxShadow: const [
                  // shadow-sm: 0 1px 2px rgba(0,0,0,0.05)
                  BoxShadow(
                    color: Color(0x0D000000),
                    blurRadius: 2,
                    offset: Offset(0, 1),
                  ),
                ],
              ),
              child: const Icon(
                Icons.auto_awesome, // SparkIcon
                color: Colors.white,
                size: 20, // h-5 w-5
              ),
            ),
            const SizedBox(width: 12), // gap-3
            // 标题：英文品牌名 → Quicksand（--font-display）
            Text(
              'LumiMuse',
              style: FontConfig.withDisplayFontStack(
                GoogleFonts.quicksand(
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.6,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 搜索输入框：外层 relative border-b border-border-light px-4 py-3
  // 内层 rounded-2xl(16) border bg-white/60 px-3 py-2
  // ─────────────────────────────────────────────────────────────
  Widget _buildSearchInputBlock(
    BuildContext context,
    bool isDark,
    String lang,
    Color borderLight,
  ) {
    return Container(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: borderLight)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: _buildSearchInput(context, isDark, lang, borderLight),
    );
  }

  Widget _buildSearchInput(
    BuildContext context,
    bool isDark,
    String lang,
    Color borderLight,
  ) {
    final focused = _searchFocused;
    // border 颜色：focus → accent/30；default → border-light（hover 由 MouseRegion 接管）
    final borderColor = focused
        ? AppTheme.accent.withValues(alpha: 0.30)
        : borderLight;
    // 背景：focus → 纯白；default → white/0.6
    final bgColor = focused
        ? (isDark ? AppTheme.darkSurface : Colors.white)
        : (isDark
              ? AppTheme.darkSurface.withValues(alpha: 0.4)
              : Colors.white.withValues(alpha: 0.6));

    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
      decoration: BoxDecoration(
        color: bgColor,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.circular(16), // rounded-2xl
        boxShadow: focused
            ? [
                BoxShadow(
                  color: AppTheme.accent.withValues(alpha: 0.15),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ]
            : null,
      ),
      // px-3 py-2
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          // SearchIcon h-3.5 w-3.5 (=14) text-text-muted
          Icon(
            Icons.search,
            size: 14,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
          const SizedBox(width: 8), // gap-2
          Expanded(
            child: TextField(
              controller: _searchController,
              focusNode: _searchFocus,
              onChanged: _onQueryChanged,
              style: TextStyle(
                fontSize: 14, // text-sm
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                // TSX 硬编码 placeholder='搜索对话内容...'，i18n 表中亦同值
                hintText: I18n.t('search.placeholder', lang: lang),
                hintStyle: TextStyle(
                  fontSize: 14,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
                border: InputBorder.none,
                isDense: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
          ),
          // 清除按钮：TSX 用 `×` 文本字符，**不**使用 close icon
          if (_searchController.text.isNotEmpty)
            GestureDetector(
              onTap: _clearSearch,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  '×',
                  style: TextStyle(
                    fontSize: 18,
                    height: 1,
                    color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 搜索结果浮层：rounded-2xl border border-border-light bg-white shadow-lg
  Widget _buildSearchPanel(
    BuildContext context,
    bool isDark,
    String lang,
    Color borderLight,
  ) {
    return Material(
      color: Colors.transparent,
      // 浮层在 search 容器内，需要置顶以覆盖下方控件
      elevation: 0,
      child: Container(
        decoration: BoxDecoration(
          color: isDark ? AppTheme.darkSurface : Colors.white,
          border: Border.all(color: borderLight),
          borderRadius: BorderRadius.circular(16), // rounded-2xl
          boxShadow: const [
            // shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)
            BoxShadow(
              color: Color(0x1A000000),
              blurRadius: 15,
              spreadRadius: -3,
              offset: Offset(0, 10),
            ),
            BoxShadow(
              color: Color(0x1A000000),
              blurRadius: 6,
              spreadRadius: -4,
              offset: Offset(0, 4),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        // max-h-[60vh] 由父容器约束，这里给一个安全上限
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.6,
        ),
        child: _buildSearchPanelBody(context, isDark, lang, borderLight),
      ),
    );
  }

  Widget _buildSearchPanelBody(
    BuildContext context,
    bool isDark,
    String lang,
    Color borderLight,
  ) {
    if (_searchLoading) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Text(
          I18n.t('common.loading', lang: lang),
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 12, // text-xs
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      );
    }
    if (_searchResults.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Text(
          I18n.t('search.noResults', lang: lang),
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 12,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      );
    }

    // overflow-y-auto + 「查看更多」追加按钮
    return SingleChildScrollView(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (int i = 0; i < _searchResults.length; i++)
            _SearchResultRow(
              result: _searchResults[i],
              query: _lastQuery,
              isDark: isDark,
              isLast: i == _searchResults.length - 1 && !_hasMore,
              borderLight: borderLight,
              onTap: () => _onSelectResult(_searchResults[i]),
            ),
          if (_hasMore)
            _LoadMoreButton(
              loading: _loadingMore,
              isDark: isDark,
              loadingText: I18n.t('common.loading', lang: lang),
              // TSX 中硬编码 '查看更多结果'，i18n 表里没有此键，保持硬编码
              normalText: '查看更多结果',
              onTap: _loadMore,
            ),
        ],
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // footer 块：border-t border-border-light p-4 + grid gap-2
  // 每条 rounded-2xl(16) border-transparent bg-white/70 px-4 py-3 gap-3 text-sm
  // hover 时 border-border-light bg-white text-text-primary
  // ─────────────────────────────────────────────────────────────
  Widget _buildFooterBlock(
    BuildContext context,
    bool isDark,
    String lang,
    Color borderLight,
  ) {
    return Container(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: borderLight)),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          _FooterLink(
            icon: Icons.psychology_outlined, // MemoryIcon
            label: I18n.t('sidebar.memories', lang: lang),
            onTap: () => _openMemories(context),
            isDark: isDark,
            borderLight: borderLight,
          ),
          const SizedBox(height: 8), // gap-2
          _FooterLink(
            icon: Icons.settings_outlined, // SettingsIcon
            label: I18n.t('sidebar.settings', lang: lang),
            onTap: () => _openRoute(context, '/settings'),
            isDark: isDark,
            borderLight: borderLight,
          ),
        ],
      ),
    );
  }

  /// 记忆管理需要先选角色（与桌面端早先实现一致）
  void _openMemories(BuildContext context) {
    final selection = ref.read(selectionProvider);
    if (selection.characterId != null) {
      _openRoute(context, '/memories/${selection.characterId}');
      return;
    }

    final lang = ref.read(localeProvider).languageCode;
    final charactersAsync = ref.read(characterListProvider);
    charactersAsync.whenData((characters) {
      if (characters.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(I18n.t('char.empty', lang: lang))),
        );
        return;
      }
      showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          // TODO(parity): 主项目缺失 'sidebar.pickCharacterForMemories' 键，硬编码兜底
          title: const Text('选择角色查看记忆'),
          content: SizedBox(
            width: 300,
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: characters.length,
              itemBuilder: (ctx, index) {
                final char = characters[index];
                return ListTile(
                  leading: CircleAvatar(
                    backgroundColor: AppTheme.accent.withValues(alpha: 0.16),
                    child: Text(
                      char.name.isNotEmpty ? char.name[0] : '?',
                      style: const TextStyle(color: AppTheme.accentDark),
                    ),
                  ),
                  title: Text(char.name),
                  onTap: () {
                    Navigator.pop(ctx);
                    _openRoute(context, '/memories/${char.id}');
                  },
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(I18n.t('common.cancel', lang: lang)),
            ),
          ],
        ),
      );
    });
  }

  void _openRoute(BuildContext context, String location) async {
    final router = GoRouter.of(context);
    final closeDrawer = widget.onCloseDrawer;
    if (closeDrawer == null) {
      router.push(location);
      return;
    }

    // 先关闭抽屉并等待动画完成，再 push 新路由。
    // 这样不会出现抽屉滑出时底层页面短暂闪现的问题。
    await closeDrawer();
    if (!mounted) return;
    router.push(location);
  }
}

// ═════════════════════════════════════════════════════════════════
// 单条搜索结果行
// 对照 Sidebar.tsx 第 116~135 行 button 块：
// `flex w-full flex-col gap-1 border-b border-border-light px-4 py-3`
// `text-left last:border-0 hover:bg-accent/5 transition-colors`
// 第一行：`flex items-center gap-1.5 text-[11px] text-text-muted`
//   ClockIcon h-3 w-3 + characterName(font-medium accent-dark)
//   + '·' + conversationTitle
// 第二行：`line-clamp-2 text-xs leading-relaxed text-text-primary`
//   prefix(text-text-muted)：role==user → '你：' / 否则 `${characterName}：`
//   后续：snippet（HighlightedText 高亮命中关键字）
// ═════════════════════════════════════════════════════════════════
class _SearchResultRow extends StatefulWidget {
  final SearchResult result;
  final String query;
  final bool isDark;
  final bool isLast;
  final Color borderLight;
  final VoidCallback onTap;

  const _SearchResultRow({
    required this.result,
    required this.query,
    required this.isDark,
    required this.isLast,
    required this.borderLight,
    required this.onTap,
  });

  @override
  State<_SearchResultRow> createState() => _SearchResultRowState();
}

class _SearchResultRowState extends State<_SearchResultRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final r = widget.result;
    final muted = widget.isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final accentDark = widget.isDark
        ? AppTheme.darkAccentDark
        : AppTheme.accentDark;
    final primary = widget.isDark
        ? AppTheme.darkTextPrimary
        : AppTheme.textPrimary;
    // hover:bg-accent/5
    final hoverBg = AppTheme.accent.withValues(alpha: 0.05);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: _hover ? hoverBg : Colors.transparent,
          border: widget.isLast
              ? null
              : Border(bottom: BorderSide(color: widget.borderLight)),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: widget.onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 第一行 gap-1.5(=6) text-[11px] text-text-muted
                  Row(
                    children: [
                      Icon(Icons.access_time, size: 12, color: muted),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          r.characterName,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                            color: accentDark,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text('·', style: TextStyle(fontSize: 11, color: muted)),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          r.conversationTitle,
                          style: TextStyle(fontSize: 11, color: muted),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4), // gap-1
                  // 第二行 line-clamp-2 text-xs leading-relaxed text-text-primary
                  HighlightedText(
                    text: r.snippet,
                    query: widget.query,
                    // TSX 模板字面量 `你：` / `${characterName}：`
                    prefix: r.role == 'user' ? '你：' : '${r.characterName}：',
                    prefixStyle: TextStyle(
                      fontSize: 12, // text-xs
                      color: muted,
                    ),
                    baseStyle: TextStyle(
                      fontSize: 12,
                      height: 1.625, // leading-relaxed
                      color: primary,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════
// 「查看更多结果」按钮
// 对照 Sidebar.tsx 第 137~146 行：
// `w-full px-4 py-3 text-center text-xs font-medium text-accent-dark`
// `transition-colors hover:bg-accent/5 disabled:cursor-not-allowed disabled:text-text-muted`
// ═════════════════════════════════════════════════════════════════
class _LoadMoreButton extends StatefulWidget {
  final bool loading;
  final bool isDark;
  final String loadingText;
  final String normalText;
  final VoidCallback onTap;

  const _LoadMoreButton({
    required this.loading,
    required this.isDark,
    required this.loadingText,
    required this.normalText,
    required this.onTap,
  });

  @override
  State<_LoadMoreButton> createState() => _LoadMoreButtonState();
}

class _LoadMoreButtonState extends State<_LoadMoreButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final muted = widget.isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final accentDark = widget.isDark
        ? AppTheme.darkAccentDark
        : AppTheme.accentDark;
    final hoverBg = AppTheme.accent.withValues(alpha: 0.05);

    return MouseRegion(
      cursor: widget.loading
          ? SystemMouseCursors.forbidden
          : SystemMouseCursors.click,
      onEnter: (_) {
        if (!widget.loading) setState(() => _hover = true);
      },
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.loading ? null : widget.onTap,
        child: Container(
          width: double.infinity,
          color: _hover ? hoverBg : Colors.transparent,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          alignment: Alignment.center,
          child: Text(
            widget.loading ? widget.loadingText : widget.normalText,
            style: TextStyle(
              fontSize: 12, // text-xs
              fontWeight: FontWeight.w500,
              color: widget.loading ? muted : accentDark,
            ),
          ),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════
// 底部链接按钮（记忆管理 / 设置）
// 对照 Sidebar.tsx 第 158~178 行 Link 块：
// `flex items-center gap-3 rounded-2xl border border-transparent`
// `bg-white/70 px-4 py-3 text-sm text-text-secondary transition-all duration-200`
// `hover:border-border-light hover:bg-white hover:text-text-primary`
// icon 始终 `text-accent-dark`，**不**随 hover 变色
// ═════════════════════════════════════════════════════════════════
class _FooterLink extends StatefulWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool isDark;
  final Color borderLight;

  const _FooterLink({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.isDark,
    required this.borderLight,
  });

  @override
  State<_FooterLink> createState() => _FooterLinkState();
}

class _FooterLinkState extends State<_FooterLink> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    // bg-white/70 → hover:bg-white
    final base = widget.isDark
        ? AppTheme.darkSurface.withValues(alpha: 0.5)
        : Colors.white.withValues(alpha: 0.7);
    final hover = widget.isDark ? AppTheme.darkSurface : Colors.white;
    // text-text-secondary → hover:text-text-primary
    final textColor = _hover
        ? (widget.isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary)
        : (widget.isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary);
    final iconColor = widget.isDark
        ? AppTheme.darkAccentDark
        : AppTheme.accentDark;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedScale(
        scale: _hover ? 1.01 : 1.0,
        duration: const Duration(milliseconds: 150),
        curve: Curves.easeOutCubic,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          decoration: BoxDecoration(
            color: _hover ? hover : base,
            border: Border.all(
              color: _hover ? widget.borderLight : Colors.transparent,
            ),
            borderRadius: BorderRadius.circular(16), // rounded-2xl
            boxShadow: _hover
                ? [
                    BoxShadow(
                      color: widget.isDark
                          ? Colors.black38
                          : const Color(0x0A000000),
                      blurRadius: 6,
                      offset: const Offset(0, 3),
                    ),
                  ]
                : null,
          ),
          clipBehavior: Clip.antiAlias,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: widget.onTap,
              borderRadius: BorderRadius.circular(16),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOutCubic,
                  transform: Matrix4.translationValues(_hover ? 2 : 0, 0, 0),
                  child: Row(
                    children: [
                      // h-4 w-4 shrink-0 text-accent-dark
                      Icon(widget.icon, size: 16, color: iconColor),
                      const SizedBox(width: 12), // gap-3
                      Expanded(
                        child: Text(
                          widget.label,
                          style: TextStyle(
                            fontSize: 14, // text-sm
                            color: textColor,
                          ),
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
