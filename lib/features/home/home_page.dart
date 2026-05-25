// 首页（HomePage / Sidebar）槽位基准声明 —— UI 布局唯一基准（任务 2.2）
//
// 本文件除 [HomePage] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A3.1 完全对齐的槽位基准列表
// （sidebarBrand / sidebarSearch / sidebarCharacterGroupTitle /
// sidebarCharacterList / sidebarFooterNav / mobileMenuButton）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由各
// 子 widget 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:drift/drift.dart' as drift;
import '../../core/database/database.dart';
import '../../core/providers/database_provider.dart';
import '../../core/providers/character_provider.dart';
import '../../core/providers/selection_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/models/app_settings.dart';
import '../../theme/app_breakpoints.dart';
import '../../theme/page_region.dart';
import '../chat/chat_view.dart';
import '../search/global_search_dialog.dart';
import 'widgets/sidebar.dart';

/// 主屏 — 与原版 page.tsx 对应
/// 桌面端：左 Sidebar（21rem 常驻）+ 右 ChatView
/// 移动端：ChatView 全屏，Sidebar 通过 Drawer 拉出
class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  /// 槽位基准 —— 与 requirements.md §A3.1 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
    // §A3.1 区块 1：顶部品牌区（surface-hero 容器）
    PageRegion(
      name: 'sidebarBrand',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'logo',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'brandName',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.1 区块 2：搜索栏（圆角胶囊输入容器）
    PageRegion(
      name: 'sidebarSearch',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'searchIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'searchInput',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.end,
          id: 'clearButton',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.1 区块 3：角色分组标题（surface-panel-quiet 容器）
    PageRegion(
      name: 'sidebarCharacterGroupTitle',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'label',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.1 区块 4：角色列表（占用剩余高度的可滚动区域）
    PageRegion(
      name: 'sidebarCharacterList',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'characterList',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.1 区块 5：底部导航 —— 顺序固定「记忆库在上、设置在下」，禁止互换
    PageRegion(
      name: 'sidebarFooterNav',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'memoryNav',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'settingsNav',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.1.5 移动端浮按钮（仅在屏宽 < 768px 且侧栏关闭时显示）
    PageRegion(
      name: 'mobileMenuButton',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'menuButton',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
  ];

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  bool _resumeAttempted = false;
  bool _globalSearchOpen = false;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    final isWide = width >= 768;

    // 监听角色被删除：当前选中的 ID 不在数据库里时清空选中
    ref.listen(characterListProvider, (prev, next) {
      next.whenData((list) {
        final selected = ref.read(selectionProvider).characterId;
        if (selected != null && !list.any((c) => c.id == selected)) {
          ref.read(selectionProvider.notifier).clear();
        }
      });
    });

    ref.listen(settingsProvider, (prev, next) {
      next.whenData(_maybeAutoResumeLastConversation);
    });
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings != null) {
      _maybeAutoResumeLastConversation(settings);
    }

    final inner = isWide ? _buildDesktop(context) : _buildMobile(context);

    // Ctrl+K / Cmd+K 全局打开搜索弹窗 — 与 TSX page.tsx 第 57~67 行 keydown 监听一致
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyK, control: true):
            _openGlobalSearch,
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true):
            _openGlobalSearch,
      },
      child: Focus(autofocus: true, child: inner),
    );
  }

  void _maybeAutoResumeLastConversation(AppSettings settings) {
    if (!settings.autoResumeLastConversation) return;
    if (_resumeAttempted) return;
    if (ref.read(selectionProvider).characterId != null) return;
    _resumeAttempted = true;
    unawaited(_restoreLastConversation(settings));
  }

  Future<void> _restoreLastConversation(AppSettings settings) async {
    final db = ref.read(databaseProvider);
    Conversation? target;
    if (settings.lastConversationId.isNotEmpty) {
      target =
          await (db.select(db.conversations)
                ..where((t) => t.id.equals(settings.lastConversationId)))
              .getSingleOrNull();
    }
    if (target == null && settings.lastConversationCharacterId.isNotEmpty) {
      target =
          await (db.select(db.conversations)
                ..where(
                  (t) => t.characterId.equals(
                    settings.lastConversationCharacterId,
                  ),
                )
                ..orderBy([
                  (t) => drift.OrderingTerm(
                    expression: t.updatedAt,
                    mode: drift.OrderingMode.desc,
                  ),
                ])
                ..limit(1))
              .getSingleOrNull();
    }
    if (!mounted || target == null) return;
    if (ref.read(selectionProvider).characterId != null) return;
    ref
        .read(selectionProvider.notifier)
        .selectConversation(
          characterId: target.characterId,
          conversationId: target.id,
        );
  }

  /// 打开全局搜索弹窗，命中结果后写入 selectionProvider 并跳到主页
  void _openGlobalSearch() {
    if (_globalSearchOpen) return;
    _globalSearchOpen = true;
    showGlobalSearchDialog(
      context,
      onSelect: (characterId, conversationId, messageId) {
        ref
            .read(selectionProvider.notifier)
            .selectConversation(
              characterId: characterId,
              conversationId: conversationId,
              targetMessageId: messageId,
            );
      },
    ).whenComplete(() {
      _globalSearchOpen = false;
    });
  }

  Widget _buildDesktop(BuildContext context) {
    return const Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Padding(
          // 与原版 app-shell::after 内边距一致 + 侧栏圆角留白
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          child: Row(
            children: [
              Sidebar(),
              SizedBox(width: 16),
              Expanded(child: ChatView()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMobile(BuildContext context) {
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: Colors.transparent,
      // 禁用 Scaffold 自动调整，由 ChatView 手动响应键盘高度
      resizeToAvoidBottomInset: false,
      drawer: Drawer(
        backgroundColor: Colors.transparent,
        elevation: 0,
        width:
            MediaQuery.of(context).size.width *
            AppBreakpoints.mobileDrawerWidthRatio,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(6, 8, 6, 8),
            child: Sidebar(
              onCloseDrawer: () async {
                _scaffoldKey.currentState?.closeDrawer();
                // 引入“动画重叠黄金期”（让侧边栏关闭与新页面滑入两个动画部分重叠），
                // 仅等待 120 毫秒（此时侧边栏已滑回约一半），就立刻开始路由跳转。
                // 这样能让两个转场动画在视觉上完美衔接，完全消除先关再跳的迟滞感和卡顿感。
                await Future.delayed(const Duration(milliseconds: 120));
              },
            ),
          ),
        ),
      ),
      body: SafeArea(
        // 底部安全区域由 ChatView 输入框自行处理（结合键盘高度）
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
          child: ChatView(
            onOpenSidebar: () => _scaffoldKey.currentState?.openDrawer(),
          ),
        ),
      ),
    );
  }
}
