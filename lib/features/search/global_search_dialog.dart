// 全局搜索弹窗 — 严格 1:1 对照 src/components/search/GlobalSearch.tsx
//
// 视觉契约（每处都对应 TSX 中的 className）：
// - 遮罩：`fixed inset-0 z-[70] flex items-start justify-center bg-black/35
//   px-4 pt-[12vh] backdrop-blur-sm`
//   - z-[70] 在 Toast（z-60）和普通弹窗（z-50）之上
//   - 顶部 12vh 留白让弹窗从屏幕上 1/3 位置开始
// - 弹窗容器：`surface-panel w-full max-w-xl overflow-hidden`（576px）
// - 顶部搜索栏：`flex items-center gap-3 border-b border-border-light px-4 py-3`
//   - SearchIcon h-4 w-4 text-text-muted
//   - 输入：bg-transparent text-sm text-text-primary outline-none
//   - 右侧 Esc kbd：rounded border border-border-light px-1.5 py-0.5 text-[10px]
// - 结果区：`max-h-[50vh] overflow-y-auto`
// - 结果项：`button flex w-full flex-col gap-1 border-b border-border-light
//   px-4 py-3 last:border-0 transition-colors`
//   - 选中：bg-accent/8（未 hover 时）
//   - 默认 hover：bg-warm-50
// - 第一行：ClockIcon + 角色名（accent-dark font-medium）+ `·` + 对话标题（默认色）
//   全部 11px
// - 第二行：line-clamp-2 text-xs leading-relaxed text-text-primary 消息片段
// - 「查看更多结果」：full-width 居中 12px font-medium accent-dark + hover:bg-warm-50

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/search_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/utils/i18n.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import 'widgets/highlighted_text.dart';

/// 弹出全局搜索弹窗。
///
/// [onSelect] 在主人选中某条搜索结果时回调，参数为 (characterId,
/// conversationId, messageId)。
Future<void> showGlobalSearchDialog(
  BuildContext context, {
  required void Function(
    String characterId,
    String conversationId,
    String messageId,
  )
      onSelect,
}) {
  return showGeneralDialog(
    context: context,
    barrierDismissible: true,
    barrierLabel: I18n.t(
      'common.close',
      lang: ProviderScope.containerOf(context).read(localeProvider).languageCode,
    ),
    // bg-black/35
    barrierColor: const Color(0x59000000),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (ctx, animation, secondary) {
      return _GlobalSearchDialog(onSelect: onSelect);
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      // 淡入 + 轻微缩放（fade + scale 0.98 → 1.0）
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.98, end: 1.0).animate(
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          ),
          child: child,
        ),
      );
    },
  );
}

class _GlobalSearchDialog extends ConsumerStatefulWidget {
  final void Function(String, String, String) onSelect;

  const _GlobalSearchDialog({required this.onSelect});

  @override
  ConsumerState<_GlobalSearchDialog> createState() =>
      _GlobalSearchDialogState();
}

class _GlobalSearchDialogState extends ConsumerState<_GlobalSearchDialog> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode();
  final _scrollController = ScrollController();

  Timer? _debounceTimer;
  List<SearchResult> _results = [];
  bool _isLoading = false;
  bool _hasMore = false;
  bool _loadingMore = false;
  String _lastQuery = '';
  int _activeIndex = 0;

  /// safeActiveIndex —— 与 TSX 一致：results 为空时回到 0；非空时不超过末尾
  int get _safeActiveIndex =>
      _results.isEmpty ? 0 : _activeIndex.clamp(0, _results.length - 1);

  @override
  void initState() {
    super.initState();
    // 与 TSX 同：打开时延后 50ms 聚焦输入框（让弹窗动画跑完）
    Future.delayed(const Duration(milliseconds: 50), () {
      if (mounted) _searchFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    _scrollController.dispose();
    _debounceTimer?.cancel();
    super.dispose();
  }

  void _onQueryChanged(String query) {
    _debounceTimer?.cancel();
    if (query.trim() != _lastQuery.trim()) {
      setState(() {
        _results = [];
        _hasMore = false;
        _activeIndex = 0;
      });
    }
    _debounceTimer = Timer(const Duration(milliseconds: 200), () {
      _performSearch(query);
    });
  }

  Future<void> _performSearch(String query) async {
    if (query.trim().isEmpty) {
      setState(() {
        _results = [];
        _hasMore = false;
        _lastQuery = '';
        _isLoading = false;
        _activeIndex = 0;
      });
      return;
    }
    if (query == _lastQuery) return;
    _lastQuery = query;
    setState(() => _isLoading = true);
    try {
      final searchActions = ref.read(searchActionsProvider);
      final pageResult = await searchActions.searchMessages(query, limit: 30);
      if (!mounted || query != _lastQuery) return;
      setState(() {
        _results = pageResult.results;
        _hasMore = pageResult.hasMore;
        _isLoading = false;
        _activeIndex = 0;
      });
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() => _loadingMore = true);
    try {
      final searchActions = ref.read(searchActionsProvider);
      final pageResult = await searchActions.searchMessages(
        _lastQuery,
        limit: 30,
        offset: _results.length,
      );
      if (!mounted) return;
      setState(() {
        _results = [..._results, ...pageResult.results];
        _hasMore = pageResult.hasMore;
        _loadingMore = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _handleSelect(SearchResult r) {
    Navigator.of(context).pop();
    widget.onSelect(r.characterId, r.conversationId, r.messageId);
  }

  void _scrollToActiveIndex() {
    if (!_scrollController.hasClients || _results.isEmpty) return;

    final index = _safeActiveIndex;
    const double itemHeight = 72.0; // Estimated height for each search result row

    final double top = index * itemHeight;
    final double bottom = (index + 1) * itemHeight;

    final double viewportHeight = _scrollController.position.viewportDimension;
    final double currentOffset = _scrollController.offset;

    if (top < currentOffset) {
      _scrollController.animateTo(
        top.clamp(0.0, _scrollController.position.maxScrollExtent),
        duration: const Duration(milliseconds: 100),
        curve: Curves.easeOut,
      );
    } else if (bottom > currentOffset + viewportHeight) {
      _scrollController.animateTo(
        (bottom - viewportHeight).clamp(0.0, _scrollController.position.maxScrollExtent),
        duration: const Duration(milliseconds: 100),
        curve: Curves.easeOut,
      );
    }
  }

  /// 键盘导航：↓↑ 移动 / Enter 选中 / Esc 关闭
  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() {
        _activeIndex =
            (_activeIndex + 1).clamp(0, (_results.length - 1).clamp(0, 1 << 30));
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollToActiveIndex();
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() {
        _activeIndex = (_activeIndex - 1).clamp(0, 1 << 30);
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollToActiveIndex();
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      if (_results.isNotEmpty) {
        _handleSelect(_results[_safeActiveIndex]);
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final lang = ref.watch(localeProvider).languageCode;
    final media = MediaQuery.of(context);

    // 12vh 顶部留白：屏幕高度的 12%
    final topPad = media.size.height * 0.12;

    return Focus(
      autofocus: true,
      onKeyEvent: _onKeyEvent,
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, topPad, 16, 16),
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            // max-w-xl = 576px
            constraints: const BoxConstraints(maxWidth: 576),
            child: AppSurfaces.panelBox(
              context: context,
              isDark: isDark,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _buildSearchBar(isDark, lang),
                  Flexible(child: _buildBody(isDark, lang)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 顶部搜索栏 — border-b border-border-light px-4 py-3
  // ═════════════════════════════════════════════════════════════
  Widget _buildSearchBar(bool isDark, String lang) {
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final mutedColor =
        isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: borderColor)),
      ),
      child: Row(
        children: [
          Icon(
            Icons.search, // SearchIcon
            size: 16, // h-4 w-4
            color: mutedColor,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              controller: _searchController,
              focusNode: _searchFocus,
              onChanged: _onQueryChanged,
              onSubmitted: (_) {
                if (_results.isNotEmpty) {
                  _handleSelect(_results[_safeActiveIndex]);
                }
              },
              style: TextStyle(
                fontSize: 14,
                color:
                    isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: I18n.t('search.placeholder', lang: lang),
                hintStyle: TextStyle(fontSize: 14, color: mutedColor),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                isDense: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
          ),
          const SizedBox(width: 12),
          // Esc kbd 标签 — sm:block 仅 PC 端显示
          if (MediaQuery.sizeOf(context).width >= 640)
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                border: Border.all(color: borderColor),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                'Esc',
                style: TextStyle(
                  fontSize: 10,
                  color: mutedColor,
                  height: 1,
                ),
              ),
            ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════
  // 结果区 — max-h-[50vh] overflow-y-auto
  // ═════════════════════════════════════════════════════════════
  Widget _buildBody(bool isDark, String lang) {
    final maxHeight = MediaQuery.sizeOf(context).height * 0.50;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: SingleChildScrollView(
        controller: _scrollController,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── 三种空态文案 ──
            if (_isLoading)
              _buildEmptyText(I18n.t('common.loading', lang: lang), isDark),
            if (!_isLoading && _lastQuery.isNotEmpty && _results.isEmpty)
              _buildEmptyText(I18n.t('search.noResults', lang: lang), isDark),
            if (!_isLoading && _lastQuery.isEmpty)
              _buildEmptyText(I18n.t('search.hint', lang: lang), isDark),

            // ── 结果列表 ──
            for (int i = 0; i < _results.length; i++)
              _ResultRow(
                result: _results[i],
                query: _lastQuery,
                active: i == _safeActiveIndex,
                isLast: i == _results.length - 1 && !_hasMore,
                onTap: () => _handleSelect(_results[i]),
                onHover: () => setState(() => _activeIndex = i),
              ),

            // ── 「查看更多结果」按钮 ──
            if (!_isLoading && _hasMore) _buildLoadMore(isDark, lang),
          ],
        ),
      ),
    );
  }

  Widget _buildEmptyText(String text, bool isDark) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: Center(
        child: Text(
          text,
          style: TextStyle(
            fontSize: 14,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      ),
    );
  }

  Widget _buildLoadMore(bool isDark, String lang) {
    return _LoadMoreButton(
      isDark: isDark,
      label: _loadingMore
          ? I18n.t('common.loading', lang: lang)
          // TODO(parity): 主项目缺失 'search.loadMore' 键，硬编码兜底
          : '查看更多结果',
      disabled: _loadingMore,
      onTap: _loadMore,
    );
  }
}

/// 单条搜索结果 —— 严格对照 TSX 第 102~120 行 `<button>` 块
class _ResultRow extends StatefulWidget {
  final SearchResult result;
  final String query;
  final bool active;
  final bool isLast;
  final VoidCallback onTap;
  final VoidCallback onHover;

  const _ResultRow({
    required this.result,
    required this.query,
    required this.active,
    required this.isLast,
    required this.onTap,
    required this.onHover,
  });

  @override
  State<_ResultRow> createState() => _ResultRowState();
}

class _ResultRowState extends State<_ResultRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final r = widget.result;
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final mutedColor =
        isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    // 选中 vs hover vs 默认背景
    Color bg;
    if (widget.active) {
      // bg-accent/8
      bg = (isDark ? AppTheme.darkAccent : AppTheme.accent)
          .withValues(alpha: 0.08);
    } else if (_hover) {
      // hover:bg-warm-50
      bg = isDark
          ? AppTheme.darkWarm50.withValues(alpha: 0.5)
          : AppTheme.warm50;
    } else {
      bg = Colors.transparent;
    }

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) {
        setState(() => _hover = true);
        widget.onHover();
      },
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        decoration: BoxDecoration(
          color: bg,
          border: Border(
            bottom: widget.isLast
                ? BorderSide.none
                : BorderSide(color: borderColor),
          ),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: widget.onTap,
            child: Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // ── 第一行：ClockIcon + 角色名 + · + 对话标题（11px） ──
                  Row(
                    children: [
                      Icon(
                        Icons.access_time, // ClockIcon
                        size: 12, // h-3 w-3
                        color: mutedColor,
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          r.characterName,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                            color: isDark
                                ? AppTheme.darkAccentDark
                                : AppTheme.accentDark,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        '·',
                        style: TextStyle(fontSize: 11, color: mutedColor),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          r.conversationTitle,
                          style: TextStyle(fontSize: 11, color: mutedColor),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  // ── 第二行：消息片段 line-clamp-2 text-xs leading-relaxed ──
                  HighlightedText(
                    text: r.snippet,
                    query: widget.query,
                    baseStyle: TextStyle(
                      fontSize: 12, // text-xs
                      height: 1.65, // leading-relaxed
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
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

class _LoadMoreButton extends StatefulWidget {
  final bool isDark;
  final String label;
  final bool disabled;
  final VoidCallback onTap;

  const _LoadMoreButton({
    required this.isDark,
    required this.label,
    required this.disabled,
    required this.onTap,
  });

  @override
  State<_LoadMoreButton> createState() => _LoadMoreButtonState();
}

class _LoadMoreButtonState extends State<_LoadMoreButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    final accentColor = isDark
        ? AppTheme.darkAccentDark
        : AppTheme.accentDark;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    return MouseRegion(
      cursor: widget.disabled
          ? SystemMouseCursors.basic
          : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = !widget.disabled),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.disabled ? null : widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          width: double.infinity,
          padding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: _hover
                ? (isDark
                    ? AppTheme.darkWarm50.withValues(alpha: 0.5)
                    : AppTheme.warm50)
                : Colors.transparent,
          ),
          alignment: Alignment.center,
          child: Text(
            widget.label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: widget.disabled ? mutedColor : accentColor,
            ),
          ),
        ),
      ),
    );
  }
}
