// 对话视图（ChatView）槽位基准声明 —— UI 布局唯一基准（任务 2.2）
//
// 本文件除 [ChatView] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A3.2 完全对齐的槽位基准列表
// （toolbarDesktopLeft / toolbarDesktopRight / toolbarMobileCompact /
// toolbarMobileExpanded / messageHeader / messageList / chatInput）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由各
// 子 widget 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:drift/drift.dart' as drift;
import '../../core/database/database.dart';
import '../../core/providers/character_provider.dart';
import '../../core/providers/chat_provider.dart';
import '../../core/providers/conversation_provider.dart';
import '../../core/providers/database_provider.dart';
import '../../core/providers/memory_provider.dart';
import '../../core/providers/message_provider.dart';
import '../../core/providers/selection_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/utils/i18n.dart';
import '../../core/services/llm_service.dart';
import '../../core/services/memory_engine.dart';
import '../../core/services/memory_extraction_service.dart';
import '../../theme/app_breakpoints.dart';
import '../../theme/app_spacing.dart';
import '../../theme/app_theme.dart';
import '../../theme/app_widgets.dart';
import '../../theme/lumi_scrollbar.dart';
import '../../theme/page_region.dart';
import '../../theme/surfaces.dart';
import 'widgets/chat_actions.dart';
import 'widgets/chat_decorations.dart';
import 'widgets/chat_dialogs.dart';
import 'widgets/chat_header.dart';
import 'widgets/chat_input.dart';
import 'widgets/chat_list_items.dart';
import 'widgets/chat_toast.dart';
import 'widgets/conversation_drawer.dart';
import 'widgets/conversation_settings_sheet.dart';
import 'widgets/message_animation.dart';
import 'widgets/message_bubble.dart';
import 'widgets/message_header.dart';
import 'widgets/quick_resume_panel.dart';
import 'widgets/reset_extraction_dialog.dart';
import 'package:flutter_animate/flutter_animate.dart';

/// 聊天视图 — 作为 Widget 嵌入 HomePage 右侧
/// 完整复刻原版 ChatView.tsx 的视觉与交互
class ChatView extends ConsumerStatefulWidget {
  /// 移动端打开侧栏抽屉的回调
  final VoidCallback? onOpenSidebar;

  const ChatView({super.key, this.onOpenSidebar});

  /// 槽位基准 —— 与 requirements.md §A3.2 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
    // §A3.2.2 PC 端工具栏左半区（角色身份）
    PageRegion(
      name: 'toolbarDesktopLeft',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'avatar',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'nameAndChips',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.2 PC 端工具栏右半区（操作按钮组，6 枚按钮顺序锁定）
    PageRegion(
      name: 'toolbarDesktopRight',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.end,
          id: 'newChat',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.end,
          id: 'rename',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.end,
          id: 'summary',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 4,
          anchor: SlotAnchor.end,
          id: 'duplicate',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 5,
          anchor: SlotAnchor.end,
          id: 'image',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 6,
          anchor: SlotAnchor.end,
          id: 'delete',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.3 移动端紧凑工具栏（收起状态下单行）
    PageRegion(
      name: 'toolbarMobileCompact',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'menu',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'avatar',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.start,
          id: 'name',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 4,
          anchor: SlotAnchor.end,
          id: 'listIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 5,
          anchor: SlotAnchor.end,
          id: 'plusIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 6,
          anchor: SlotAnchor.end,
          id: 'searchIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 7,
          anchor: SlotAnchor.end,
          id: 'chevronDown',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.4 移动端展开拉片（toolbarExpanded === true 时第二行）
    PageRegion(
      name: 'toolbarMobileExpanded',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'continueChip',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'memoryChip',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.end,
          id: 'pencilIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 4,
          anchor: SlotAnchor.end,
          id: 'summaryIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 5,
          anchor: SlotAnchor.end,
          id: 'duplicateIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 6,
          anchor: SlotAnchor.end,
          id: 'imageIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 7,
          anchor: SlotAnchor.end,
          id: 'trashIcon',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.5 消息区副标题栏（左：spark + 标题；右：可选 chips + token chip）
    PageRegion(
      name: 'messageHeader',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'sparkIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.start,
          id: 'title',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.end,
          id: 'chips',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.6 消息列表（surface-panel 主体内容）
    PageRegion(
      name: 'messageList',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'list',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
    // §A3.2.7 输入栏 ChatInput（三槽位顺序锁定：附件 → textarea → 发送/停止）
    PageRegion(
      name: 'chatInput',
      slots: [
        PageSlot(
          order: 1,
          anchor: SlotAnchor.start,
          id: 'paperclipIcon',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 2,
          anchor: SlotAnchor.center,
          id: 'textarea',
          build: (_) => const SizedBox.shrink(),
        ),
        PageSlot(
          order: 3,
          anchor: SlotAnchor.end,
          id: 'sendOrStopButton',
          build: (_) => const SizedBox.shrink(),
        ),
      ],
    ),
  ];

  @override
  ConsumerState<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends ConsumerState<ChatView> {
  final _scrollController = ScrollController();
  final _chatToast = ChatToastController();
  late final ChatActions _actions;

  /// 读取当前语言并查 i18n 表的便捷方法
  ///
  /// - 不带 [args]：等价于 `I18n.t(key, lang: lang)`
  /// - 带 [args]：等价于 `I18n.tArgs(key, args, lang: lang)`，用于含 `{name}` 占位符的键
  String _i18n(String key, [Map<String, Object?>? args]) {
    final String lang = ref.watch(localeProvider).languageCode;
    if (args == null) return I18n.t(key, lang: lang);
    return I18n.tArgs(key, args, lang: lang);
  }

  /// 已见过的消息 ID 集合 — 用于区分新消息和历史消息
  /// 初始加载的消息不触发动画，后续新增的消息触发动画
  final Set<String> _seenMessageIds = {};

  /// 标记初始加载是否完成（首次收到消息列表后标记为 true）
  bool _initialLoadDone = false;

  /// 当前活跃对话 ID — 来自选中态，或本地兜底（取该角色最近一条 / 新建）
  String? _resolvedConversationId;

  // ───────── 长对话分页懒加载 ─────────

  /// 每页消息数量
  static const int _pageSize = 50;

  /// 当前可见消息数量（从最新消息往前数）
  int _visibleMessageCount = _pageSize;

  /// 是否还有更多历史消息可加载
  ///
  /// 由 build 内基于 totalMessages 与 _visibleMessageCount 计算（getter 形式），
  /// 不再以可变字段直接保存，避免 build 内部修改 state 字段。
  /// 在 build 中会同步更新 _lastTotalMessages，使本 getter 返回与 build 一致的结果。
  bool get _hasMoreMessages => _lastTotalMessages > _visibleMessageCount;

  /// build 中观察到的最近一次消息总数，仅用于支撑 _hasMoreMessages getter。
  int _lastTotalMessages = 0;

  /// 是否正在加载更多
  bool _loadingMore = false;

  /// 当前展开操作按钮的消息 ID — 用于移动端跨气泡协调
  /// 桌面端断点（>= 768px）下 hover 行为不受此状态影响，两套机制并存
  String? _activeActionMessageId;

  /// 切换 / 初次进入对话后，消息列表完成布局时滚到底部一次。
  bool _scrollToBottomOnLoad = false;

  /// 一帧内防重复滚动调度的标志位
  bool _scrollScheduled = false;

  /// 用户主动发送消息时强制跳到底部（不经过平滑动画）
  bool _forceScrollToBottom = false;

  /// 流式生成期间的"自动跟随"粘性标志。
  ///
  /// true（默认）：流式新 chunk 到达时自动滚到底部跟随。
  /// false：用户主动向上滚后置为 false，新 chunk 不再拽用户回底部；
  /// 用户重新滚动到接近底部时再翻回 true。
  bool _followingStream = true;

  /// 搜索跳转定位用：为可见消息建立稳定锚点，并短暂高亮目标消息。
  final Map<String, GlobalKey> _messageKeys = {};
  String? _highlightedMessageId;
  Timer? _highlightTimer;
  bool _targetScrollScheduled = false;
  bool _targetExpandScheduled = false;

  /// token 计数缓存 — 避免每次 build 遍历全部消息
  String _cachedTokenConvId = '';
  int _cachedTokenMsgCount = 0;
  int _cachedTokenCount = 0;

  /// 记忆任务订阅本地状态 — 用于检测「processing → done」边沿
  /// 与 mergeCount Toast 的去重；taskId 变化时重置 _lastSeenStatus，
  /// 处理同对话连续多任务场景。
  int? _lastSeenTaskId;
  String? _lastSeenStatus;

  /// 前端记忆提取状态 — 对照主项目 memoryExtractStatus
  /// 'idle' | 'extracting' | 'done' | 'failed'
  /// 只在提取触发时显示，完成/失败后 3 秒自动回到 idle
  String _memoryExtractStatus = 'idle';
  Timer? _extractStatusTimer;

  /// 重置记忆任务订阅本地状态（角色 / 对话切换时调用）
  void _resetMemoryTaskSeen() {
    _lastSeenTaskId = null;
    _lastSeenStatus = null;
    _extractStatusTimer?.cancel();
    _memoryExtractStatus = 'idle';
  }

  /// 统一更新 _resolvedConversationId 并同步到 _actions
  void _setConversationId(String? id) {
    final changed = _resolvedConversationId != id;
    setState(() {
      _resolvedConversationId = id;
      if (changed) {
        _scrollToBottomOnLoad = id != null;
        // 切换对话视为"重新打开"，重置流式跟随粘性
        _followingStream = true;
      }
    });
    _actions.conversationId = id;
    final characterId = ref.read(selectionProvider).characterId;
    if (id != null && characterId != null) {
      unawaited(
        rememberLastConversation(
          ref,
          characterId: characterId,
          conversationId: id,
        ),
      );
    }
  }

  /// 重置动画追踪状态（角色切换 / 新建对话时调用）
  void _resetAnimationState() {
    _seenMessageIds.clear();
    _activeActionMessageId = null;
    _initialLoadDone = false;
    _visibleMessageCount = _pageSize;
    _lastTotalMessages = 0;
    _loadingMore = false;
  }

  /// 加载更多历史消息 — 向上滚动到顶部时触发
  void _loadMoreMessages() {
    if (_loadingMore || !_hasMoreMessages) return;

    _loadingMore = true;

    // 记录当前距离底部的偏移，用于加载后恢复滚动位置
    final maxScroll = _scrollController.position.maxScrollExtent;
    final currentOffset = _scrollController.offset;
    final distanceToBottom = maxScroll - currentOffset;

    setState(() {
      _visibleMessageCount += _pageSize;
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        final newMaxScroll = _scrollController.position.maxScrollExtent;
        _scrollController.jumpTo(
          (newMaxScroll - distanceToBottom).clamp(
            _scrollController.position.minScrollExtent,
            _scrollController.position.maxScrollExtent,
          ),
        );
      }
      _loadingMore = false;
    });
  }

  /// 移动端：点击某条消息切换操作按钮显示
  /// - 当前等于 id → 置 null（再次点击隐藏）
  /// - 否则 → 置 id（切换到新气泡）
  void _toggleMessageActions(String id) {
    setState(() {
      _activeActionMessageId = (_activeActionMessageId == id) ? null : id;
    });
  }

  Future<void> _deleteAttachment(String messageId, int attachmentIndex) async {
    await ref
        .read(messageActionsProvider)
        .deleteAttachment(messageId, attachmentIndex);
  }

  @override
  void initState() {
    super.initState();
    final selection = ref.read(selectionProvider);
    _resolvedConversationId = selection.conversationId;
    _actions = ChatActions(
      ref: ref,
      conversationId: _resolvedConversationId,
      showToast: _showToast,
      refreshMessages: () => setState(() {}),
      requestScrollToBottom: () {
        _forceScrollToBottom = true;
        // 用户主动发送新消息时，强制重新开启流式跟随
        _followingStream = true;
        _scrollToBottom(animate: false);
      },
      isMounted: () => mounted,
      resetAnimationState: _resetAnimationState,
      resetMemoryTaskSeen: _resetMemoryTaskSeen,
      onConversationChanged: (id) {
        _setConversationId(id);
      },
    );
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _chatToast.dispose();
    _highlightTimer?.cancel();
    _extractStatusTimer?.cancel();
    super.dispose();
  }

  /// 由调用方统一使用的 toast 入口：等价于 TSX 第 156 行 `showToast(message, type)`。
  /// 默认 type 为 error，与 TSX 一致。
  void _showToast(String message, {ChatToastType type = ChatToastType.error}) {
    _chatToast.show(message, type: type);
  }

  /// 角色切换或对话被清空时，找一个合适的对话 ID
  Future<void> _resolveConversation(String characterId) async {
    // 角色切换时重置动画追踪和分页状态
    _resetAnimationState();
    _resetMemoryTaskSeen();

    final selection = ref.read(selectionProvider);
    final selectionConv = selection.conversationId;
    if (selectionConv != null) {
      if (selection.characterId != characterId) return;
      _setConversationId(selectionConv);
      return;
    }

    final list = await ref.read(conversationListProvider(characterId).future);
    if (!mounted) return;
    if (ref.read(selectionProvider).characterId != characterId) return;
    if (list.isNotEmpty) {
      _setConversationId(list.first.id);
    } else {
      _setConversationId(null);
    }
  }

  bool _isNearBottom() {
    if (!_scrollController.hasClients) return true;
    final maxScroll = _scrollController.position.maxScrollExtent;
    final currentScroll = _scrollController.offset;
    final isGenerating =
        _resolvedConversationId != null &&
        ref.read(chatControllerProvider(_resolvedConversationId!)).isGenerating;
    final threshold = isGenerating ? 250.0 : 120.0;
    return (maxScroll - currentScroll) <= threshold;
  }

  void _scrollToBottom({bool animate = true}) {
    final isGenerating =
        _resolvedConversationId != null &&
        ref.read(chatControllerProvider(_resolvedConversationId!)).isGenerating;
    final finalAnimate = isGenerating ? false : animate;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      if (finalAnimate) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 280),
          curve: Curves.easeOut,
        );
      } else {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  void _scheduleTargetMessageScroll({
    required String messageId,
    required int itemIndex,
    required int itemCount,
  }) {
    if (_targetScrollScheduled) return;
    _targetScrollScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_scrollToTargetMessage(messageId, itemIndex, itemCount));
    });
  }

  Future<void> _scrollToTargetMessage(
    String messageId,
    int itemIndex,
    int itemCount,
  ) async {
    try {
      if (!mounted) return;
      if (!await _ensureTargetVisible(messageId)) {
        if (!_scrollController.hasClients) return;
        final maxScroll = _scrollController.position.maxScrollExtent;
        final ratio = itemCount <= 1 ? 1.0 : itemIndex / (itemCount - 1);
        await _scrollController.animateTo(
          (maxScroll * ratio).clamp(
            _scrollController.position.minScrollExtent,
            _scrollController.position.maxScrollExtent,
          ),
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
        await SchedulerBinding.instance.endOfFrame;
        if (!mounted) return;
        if (!await _ensureTargetVisible(messageId)) return;
      }
      ref.read(selectionProvider.notifier).clearTargetMessage();
    } finally {
      _targetScrollScheduled = false;
    }
  }

  Future<bool> _ensureTargetVisible(String messageId) async {
    final targetContext = _messageKeys[messageId]?.currentContext;
    if (targetContext == null) return false;
    await Scrollable.ensureVisible(
      targetContext,
      duration: const Duration(milliseconds: 360),
      curve: Curves.easeOutCubic,
      alignment: 0.35,
    );
    if (!mounted) return true;
    _highlightTimer?.cancel();
    setState(() => _highlightedMessageId = messageId);
    _highlightTimer = Timer(const Duration(milliseconds: 1400), () {
      if (mounted && _highlightedMessageId == messageId) {
        setState(() => _highlightedMessageId = null);
      }
    });
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final selection = ref.watch(selectionProvider);

    // 订阅当前对话最近一条记忆任务，检测「processing → done」边沿
    // 并在 mergeCount > 0 时弹出「已合并/更新 N 条记忆」Toast
    // 注：ref.listen 必须在 build 顶部、所有提前 return 之前无条件调用，
    //     未选中对话时传入空串 key，对应 Drift 查询永远返回空集
    ref.listen<AsyncValue<MemoryTaskStatus?>>(
      latestMemoryTaskProvider(_resolvedConversationId ?? ''),
      (prev, next) {
        final snap = next.valueOrNull;
        if (snap == null) {
          _lastSeenTaskId = null;
          _lastSeenStatus = null;
          return;
        }
        // taskId 切换：视为新任务，仅记录初始状态，不触发 toast
        if (_lastSeenTaskId != snap.taskId) {
          _lastSeenTaskId = snap.taskId;
          _lastSeenStatus = snap.status;
          // 新任务如果是 processing/pending，显示提取中
          if (snap.status == 'processing' || snap.status == 'pending') {
            _extractStatusTimer?.cancel();
            setState(() => _memoryExtractStatus = 'extracting');
          }
          return;
        }
        // 同一任务的状态推进：检测 processing → done 边沿
        final prevStatus = _lastSeenStatus;
        _lastSeenStatus = snap.status;

        // 更新前端提取状态
        if (snap.status == 'processing' || snap.status == 'pending') {
          _extractStatusTimer?.cancel();
          if (_memoryExtractStatus != 'extracting') {
            setState(() => _memoryExtractStatus = 'extracting');
          }
        } else if (snap.status == 'done') {
          _extractStatusTimer?.cancel();
          setState(() {
            _memoryExtractStatus = snap.mergeCount > 0 ? 'done' : 'idle';
          });
          // 刷新记忆列表（提取完成后新记忆应该立即可见）
          ref.invalidate(memoryListProvider);
          if (snap.mergeCount > 0) {
            // 3 秒后自动回到 idle
            _extractStatusTimer = Timer(const Duration(seconds: 3), () {
              if (mounted) setState(() => _memoryExtractStatus = 'idle');
            });
          }
        } else if (snap.status == 'failed') {
          _extractStatusTimer?.cancel();
          setState(() => _memoryExtractStatus = 'failed');
          // 3 秒后自动回到 idle
          _extractStatusTimer = Timer(const Duration(seconds: 3), () {
            if (mounted) setState(() => _memoryExtractStatus = 'idle');
          });
        }

        if (prevStatus == 'processing' &&
            snap.status == 'done' &&
            snap.mergeCount > 0 &&
            mounted) {
          // 对照 TSX 第 656 行 `showToast('TA 更新了关于你的 N 条记忆', 'info')`
          _showToast(
            // TODO(parity): 主项目缺失 'chat.memoryMergedCount' 键，硬编码兜底
            'TA 更新了关于你的 ${snap.mergeCount} 条记忆',
            type: ChatToastType.info,
          );
        }
      },
    );

    // 监听选中态变化：角色切换 / 对话切换
    // 注：ref.listen 必须在 build 顶部、所有提前 return 之前无条件调用
    ref.listen(selectionProvider, (prev, next) {
      final prevCharId = prev?.characterId;
      final nextCharId = next.characterId;

      if (nextCharId != prevCharId) {
        if (nextCharId != null) {
          _resolveConversation(nextCharId);
        } else {
          _setConversationId(null);
          _resetAnimationState();
          _resetMemoryTaskSeen();
        }
        return;
      }

      if (next.conversationId != null &&
          next.conversationId != _resolvedConversationId) {
        _setConversationId(next.conversationId);
        _resetAnimationState();
        _resetMemoryTaskSeen();
      }
    });

    // 监听 chat 错误状态，弹 toast 通知用户
    ref.listen<ChatState>(
      chatControllerProvider(_resolvedConversationId ?? ''),
      (prev, next) {
        if (next.error != null && next.error != prev?.error && mounted) {
          _showToast(next.error!, type: ChatToastType.error);
        }
      },
    );

    final characterId = selection.characterId;

    if (characterId == null) {
      return _buildEmptyState(context, isDark);
    }

    final characterAsync = ref.watch(characterProvider(characterId));

    return characterAsync.when(
      loading: () => _buildLoading(context, isDark),
      error: (e, _) => Center(child: Text('$e')),
      data: (character) {
        if (character == null) {
          return _buildEmptyState(context, isDark);
        }
        // 阶段 2C：主体严格对照 ChatView.tsx 第 1597~1958 行结构。
        // - 顶部 surface-hero 工具栏（PC 端 6 按钮 / 移动端紧凑可展开）
        // - 中部 grid：左 surface-panel 主面板 / 右 PC 端 aside 对话快捷面板（lg+ 才显示）
        return Stack(
          children: [
            _buildBody(context, character, isDark),
            // 全局 Toast 浮层（对照 TSX 第 35~54 行 + 行末 `<Toast .../>`）
            // 外层 IgnorePointer(ignoring: true) 让 toast 容器整体不拦截下层手势；
            // 单条 toast 内部用 IgnorePointer(ignoring: false) 恢复点击（如关闭按钮）。
            Positioned.fill(
              child: IgnorePointer(
                ignoring: true,
                child: AnimatedBuilder(
                  animation: _chatToast,
                  builder: (context, _) => ChatToast(
                    items: _chatToast.items,
                    onDismiss: _chatToast.dismiss,
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  /// 主体（hero 工具栏 + grid）
  ///
  /// 对照 TSX 第 1597 行起：
  /// `<div className="flex h-full min-h-0 flex-1 flex-col gap-2 px-2 py-2`
  /// ` md:gap-4 md:px-4 md:py-4">`
  Widget _buildBody(BuildContext context, Character character, bool isDark) {
    final width = MediaQuery.sizeOf(context).width;
    final isLargeDesktop = width >= 1024; // lg 断点

    final convCount =
        ref.watch(conversationListProvider(character.id)).valueOrNull?.length ??
        0;
    final memoryCount =
        ref
            .watch(
              memoryListProvider(MemoryListParams(characterId: character.id)),
            )
            .valueOrNull
            ?.total ??
        0;

    final isStreaming = _resolvedConversationId != null
        ? ref
              .watch(chatControllerProvider(_resolvedConversationId!))
              .isGenerating
        : false;

    return Padding(
      // 对照主项目 app-shell px-4 py-4 — 但顶部和底部贴边
      padding: EdgeInsets.symmetric(
        horizontal: AppBreakpoints.isMobile(width) ? 8 : 16,
        vertical: 0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 顶部小间距（对照主项目 py-4 的上半部分）
          SizedBox(height: AppBreakpoints.isMobile(width) ? 8 : 16),
          // ── surface-hero 顶部工具栏 ──
          ChatHeader(
            character: character,
            conversationCount: convCount,
            memoryCount: memoryCount,
            isStreaming: isStreaming,
            isSummarizing: false,
            isDuplicating: false,
            hasActiveConversation: _resolvedConversationId != null,
            // FIX(i18n)：把当前语言透传给 ChatHeader（StatefulWidget），
            // 让其内部静态/带参数文案统一走 I18n.t / I18n.tArgs。
            lang: ref.watch(localeProvider).languageCode,
            onOpenSidebar: widget.onOpenSidebar,
            onNewChat: _actions.createNewConversation,
            onShowConversationList: () => _showConversationList(context),
            onRename: _showRenameDialog,
            onSummarize: _actions.summarize,
            onDuplicate: _actions.duplicateConversation,
            onImageManager: _openImageManager,
            onDelete: _deleteCurrentConversation,
          ),
          SizedBox(
            height: AppBreakpoints.isMobile(width) ? 8 : 16,
          ), // gap-2 / md:gap-4
          // ── 主区 grid：左主面板 + 右对话快捷面板（lg+） ──
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 左侧 surface-panel 主面板
                Expanded(child: _buildMainPanel(context, character, isDark)),
                if (isLargeDesktop) ...[
                  const SizedBox(width: 16), // md:gap-4
                  // 右侧 22rem ≈ 352 对话快捷面板
                  SizedBox(
                    width: 352,
                    child: QuickResumePanel(
                      conversations:
                          ref
                              .watch(conversationListProvider(character.id))
                              .valueOrNull ??
                          [],
                      activeConversationId: _resolvedConversationId,
                      // FIX(i18n)：把当前语言传给 QuickResumePanel。
                      lang: ref.watch(localeProvider).languageCode,
                      onSelect: (id) {
                        _setConversationId(id);
                        ref
                            .read(selectionProvider.notifier)
                            .setActiveConversation(id);
                      },
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 左侧主面板：surface-panel 包裹 messageHeader → 消息列表 → streaming → input
  Widget _buildMainPanel(
    BuildContext context,
    Character character,
    bool isDark,
  ) {
    return AppSurfaces.panelBox(
      context: context,
      isDark: isDark,
      child: Column(
        children: [
          // ── messageHeader 副标题栏 ──
          _buildMessageHeader(character),
          // ── 消息列表主体 ──
          Expanded(child: _buildMessageList(character)),
          // ── 输入栏 ──
          _buildInputArea(context, isDark),
        ],
      ),
    );
  }

  /// messageHeader 副标题栏 — 对照 ChatView.tsx 第 1750~1791 行
  ///
  /// 注：阶段 2C 暂未接入未提取计数 / 提取状态机（需要等 watchLatestTaskStatus
  /// 闭环），先按"提取管理 + token chip"两项展示，后续 2D 阶段补齐。
  Widget _buildMessageHeader(Character character) {
    final convId = _resolvedConversationId;
    final conv = convId == null
        ? null
        : ref
              .watch(conversationListProvider(character.id))
              .valueOrNull
              ?.cast<Conversation?>()
              .firstWhere((c) => c?.id == convId, orElse: () => null);

    final tokenCount = _estimateTokenCount(character);
    final ignoreMemory = (conv?.ignoreMemory ?? 0) == 1;
    final unextractedCount = convId == null
        ? 0
        : (ref
                  .watch(conversationUnextractedCountProvider(convId))
                  .valueOrNull ??
              0);

    // 提取状态：使用前端状态（3 秒后自动回到 idle），不直接读数据库
    final memoryStatus = _memoryExtractStatus;

    return MessageHeader(
      title: conv?.title,
      // TODO(parity): 主项目缺失 'chat.noConversationTitle' 默认文案直写
      fallbackTitle: '还没有开始这段关系',
      ignoreMemory: ignoreMemory,
      // TODO(2D)：未提取计数需要查 messages 表中 role='user' AND
      unextractedCount: unextractedCount,
      memoryExtractStatus: memoryStatus,
      tokenCount: tokenCount,
      onOpenExtractionManager: _openResetExtractionDialog,
    );
  }

  /// 弹出重置提取面板 — 对照 TSX 第 1998~2122 行 `resetExtractionOpen`
  void _openResetExtractionDialog() {
    final convId = _resolvedConversationId;
    if (convId == null) {
      _showToast('请先开始一段对话', type: ChatToastType.info);
      return;
    }
    final selection = ref.read(selectionProvider);
    final characterId = selection.characterId;
    if (characterId == null) return;
    final list =
        ref.read(conversationListProvider(characterId)).valueOrNull ?? [];
    final conv = list.cast<Conversation?>().firstWhere(
      (c) => c?.id == convId,
      orElse: () => null,
    );
    final ignoreMemory = (conv?.ignoreMemory ?? 0) == 1;

    final extractStatus = ref
        .read(latestMemoryTaskProvider(convId))
        .valueOrNull
        ?.status;
    final isExtracting =
        extractStatus == 'processing' || extractStatus == 'pending';

    // 读取真实未提取计数
    final unextractedCount =
        ref.read(conversationUnextractedCountProvider(convId)).valueOrNull ?? 0;

    showResetExtractionDialog(
      context,
      conversationId: convId,
      currentIgnoreMemory: ignoreMemory,
      unextractedCount: unextractedCount,
      isExtracting: isExtracting,
      onToggleIgnore: (next) async {
        await ref
            .read(conversationActionsProvider)
            .toggleIgnoreMemory(convId, next);
        if (mounted) {
          _showToast(
            next ? '已忽略本对话的记忆提取' : '已恢复记忆提取',
            type: ChatToastType.info,
          );
        }
      },
      onManualExtract: () {
        _triggerManualExtraction(convId);
      },
      onToast: (msg, info) {
        _showToast(msg, type: info ? ChatToastType.info : ChatToastType.error);
      },
    );
  }

  /// 手动触发记忆提取 — 收集当前对话中未提取的用户消息 ID，入队提取任务
  Future<void> _triggerManualExtraction(String convId) async {
    try {
      final selection = ref.read(selectionProvider);
      final characterId = selection.characterId;
      if (characterId == null) return;

      final db = ref.read(databaseProvider);
      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(convId))
                ..orderBy([
                  (t) => drift.OrderingTerm.asc(t.createdAt),
                  (t) => drift.OrderingTerm.asc(t.seq),
                ]))
              .get();

      final extractionIds = MemoryExtractionService.selectExtractionMessageIds(
        messages,
      );

      if (extractionIds.isEmpty) {
        _showToast('没有待提取的消息', type: ChatToastType.info);
        return;
      }

      // 入队提取任务
      final llm = LlmService();
      final extractionService = MemoryExtractionService(
        db,
        llm,
        MemoryEngine(db, llm),
      );
      await extractionService.enqueueExtraction(
        characterId: characterId,
        conversationId: convId,
        messageIds: extractionIds,
      );
      // 设置前端提取状态为 extracting
      _extractStatusTimer?.cancel();
      setState(() => _memoryExtractStatus = 'extracting');
      _showToast(
        '已触发记忆提取（${extractionIds.length} 条消息）',
        type: ChatToastType.info,
      );
    } catch (e) {
      _showToast('手动提取失败: $e', type: ChatToastType.error);
    }
  }

  /// 估算 token：粗略按字符数 ÷ 2 估算，避免引入 token-counter 依赖。
  /// 带缓存避免每次 build 遍历全部消息（Bug #8）。
  int _estimateTokenCount(Character character) {
    if (_resolvedConversationId == null) return 0;
    final convId = _resolvedConversationId!;
    final messagesAsync = ref.watch(messageListProvider(convId));
    final msgs = messagesAsync.valueOrNull ?? const [];

    // 消息总数变化时自动失效（流式内容变化不触发重算）
    final msgCount = msgs.length;
    if (_cachedTokenConvId == convId && _cachedTokenMsgCount == msgCount) {
      return _cachedTokenCount;
    }

    int sum = 0;
    for (final m in msgs) {
      sum += (m.content.length / 2).round();
    }
    sum += (character.systemPrompt.length / 2).round();
    _cachedTokenConvId = convId;
    _cachedTokenMsgCount = msgCount;
    _cachedTokenCount = sum;
    return sum;
  }

  /// 删除当前对话（带二次确认）— 对照 TSX `handleDeleteConv`
  Future<void> _deleteCurrentConversation() async {
    final id = _resolvedConversationId;
    if (id == null) return;

    // 阶段 2E：用 surface-panel 风格的 confirm dialog 替代裸 AlertDialog
    final ok = await showDeleteConversationDialog(
      context,
      title: _i18n('chat.deleteTitle'),
      body: _i18n('chat.deleteConfirm'),
      confirmLabel: _i18n('chat.deleteAction'),
      cancelLabel: _i18n('chat.cancel'),
    );

    if (ok != true || !mounted) return;

    try {
      await ref.read(conversationActionsProvider).delete(id);
      if (!mounted) return;
      // 切到下一条对话（如果有）
      final selection = ref.read(selectionProvider);
      if (selection.characterId != null) {
        final list = await ref.read(
          conversationListProvider(selection.characterId!).future,
        );
        if (!mounted) return;
        final next = list.isNotEmpty ? list.first.id : null;
        _setConversationId(next);
        ref.read(selectionProvider.notifier).setActiveConversation(next);
      }
    } catch (e) {
      _showToast('删除失败: $e');
    }
  }

  /// 打开图片管理 — 路由到独立全屏页 CharacterImagesPage
  ///
  /// 主项目 ChatView.tsx 把图片管理实现为内嵌弹窗（第 2186~2342 行 surface-panel
  /// 弹层）。Flutter 端早已实现的 [CharacterImagesPage] 是独立全屏页（含
  /// hero 头 + 网格 + 多选 + Lightbox），功能完全对齐，视觉只是从「模态弹窗」
  /// 改成了「全屏路由」，与图片管理这种「需要大量空间展示+操作」的场景更搭，
  /// 也避免重复实现 600+ 行已稳定的代码。
  void _openImageManager() {
    final selection = ref.read(selectionProvider);
    final characterId = selection.characterId;
    if (characterId == null) return;
    // 已有路由：见 lumimuse_flutter/lib/router.dart
    // GoRoute(path: '/characters/:id/images', ...)
    context.push('/characters/$characterId/images');
  }

  // ─── 空态（未选角色） ───
  Widget _buildEmptyState(BuildContext context, bool isDark) {
    final lang = ref.watch(localeProvider).languageCode;
    return AppSurfaces.panelBox(
      context: context,
      isDark: isDark,
      child: Stack(
        children: [
          const Center(child: HomeGlow()),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                EmptyBreathe(
                  child: Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: isDark
                            ? [
                                AppTheme.darkAccent.withValues(alpha: 0.15),
                                AppTheme.darkAccent.withValues(alpha: 0.25),
                              ]
                            : [
                                AppTheme.accent.withValues(alpha: 0.15),
                                AppTheme.accentLight.withValues(alpha: 0.25),
                              ],
                      ),
                      borderRadius: BorderRadius.circular(22),
                    ),
                    child: Icon(
                      Icons.auto_awesome_rounded,
                      size: 28,
                      color: isDark
                          ? AppTheme.darkAccentDark
                          : AppTheme.accentDark,
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'LumiMuse',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 1.2,
                    color: isDark
                        ? AppTheme.darkAccentDark
                        : AppTheme.accentDark,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  I18n.t('chat.welcomeTitle', lang: lang),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                    height: 1.35,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                ),
              ],
            ),
          ),
          // 移动端兜底：左上角菜单按钮
          if (widget.onOpenSidebar != null)
            Positioned(
              top: 12,
              left: 12,
              child: LumiChip.icon(
                icon: Icons.menu,
                onTap: widget.onOpenSidebar!,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildLoading(BuildContext context, bool isDark) {
    return AppSurfaces.panelBox(
      context: context,
      isDark: isDark,
      child: const Center(child: CircularProgressIndicator()),
    );
  }

  // ─── 顶部 Hero Header（旧版，已被 ChatHeader widget 替代） ───
  // ignore: unused_element
  Widget _buildHeader(BuildContext context, Character character, bool isDark) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
      child: Container(
        decoration: AppSurfaces.hero(isDark: isDark),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            // 移动端菜单
            if (widget.onOpenSidebar != null) ...[
              LumiChip.icon(icon: Icons.menu, onTap: widget.onOpenSidebar!),
              const SizedBox(width: 8),
            ],
            // 角色头像
            CharacterAvatar(character: character, size: 40),
            const SizedBox(width: 12),
            // 角色名
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    character.name,
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (character.personality.isNotEmpty)
                    Text(
                      character.personality,
                      style: TextStyle(
                        fontSize: 11,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
            ),
            // 工具按钮组
            LumiChip.icon(
              icon: Icons.add_comment_outlined,
              tooltip: _i18n('chat.newChat'),
              onTap: _actions.createNewConversation,
            ),
            const SizedBox(width: 6),
            LumiChip.icon(
              icon: Icons.list_alt_outlined,
              tooltip: _i18n('chat.conversations'),
              onTap: () => _showConversationList(context),
            ),
            const SizedBox(width: 6),
            LumiChip.icon(
              icon: Icons.more_horiz,
              tooltip: '更多',
              onTap: () => _showMoreMenu(context),
            ),
          ],
        ),
      ),
    );
  }

  // ─── 消息列表 ───
  Widget _buildMessageList(Character character) {
    final showTimestamps = ref.watch(
      settingsProvider.select((s) => s.valueOrNull?.showTimestamps ?? true),
    );

    if (_resolvedConversationId == null) {
      return _buildEmptyChat(character);
    }

    final messagesAsync = ref.watch(
      messageListProvider(_resolvedConversationId!),
    );

    return messagesAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
      data: (messages) {
        if (messages.isEmpty) {
          return _buildEmptyChat(character);
        }

        final selection = ref.watch(selectionProvider);
        final targetMessageId =
            selection.conversationId == _resolvedConversationId
            ? selection.targetMessageId
            : null;

        if (!_scrollScheduled && targetMessageId == null) {
          _scrollScheduled = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _scrollScheduled = false;

            if (_forceScrollToBottom && _scrollController.hasClients) {
              _forceScrollToBottom = false;
              _scrollController.jumpTo(
                _scrollController.position.maxScrollExtent,
              );
              setState(() => _scrollToBottomOnLoad = false);
            } else if (_scrollToBottomOnLoad) {
              _scrollToBottom(animate: false);
              if (mounted) {
                setState(() => _scrollToBottomOnLoad = false);
              }
            } else if (_followingStream && _isNearBottom()) {
              // 仅当用户未上滑（仍处于"跟随"状态）时，新 chunk 才把视图拽到底部
              _scrollToBottom(animate: true);
            }
          });
        }

        // ── 长对话分页：只显示最新的 _visibleMessageCount 条 ──
        final totalMessages = messages.length;
        final targetMessageIndex = targetMessageId == null
            ? -1
            : messages.indexWhere((m) => m.id == targetMessageId);
        if (targetMessageIndex >= 0 &&
            totalMessages - targetMessageIndex > _visibleMessageCount &&
            !_targetExpandScheduled) {
          _targetExpandScheduled = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            setState(() {
              _visibleMessageCount = totalMessages - targetMessageIndex;
              _targetExpandScheduled = false;
            });
          });
        }
        final displayMessages = totalMessages > _visibleMessageCount
            ? messages.sublist(totalMessages - _visibleMessageCount)
            : messages;
        // 仅记录最近一次观察到的消息总数，使 _hasMoreMessages getter 与本帧一致；
        // 不在 build 内修改其他可变状态字段。
        // FIX(Q4)：本字段是"派生缓存"，只在同一 build 帧内被 _hasMoreMessages
        // getter 消费，不属于驱动 UI 的真正状态。即便 hot reload / 父级重 build
        // 反复改它也是无害的。真正具有副作用语义的状态写入（_seenMessageIds.add
        // 与 _initialLoadDone）已挪到下方 post-frame 回调。
        _lastTotalMessages = totalMessages;

        final items = _buildItemsWithDateDividers(displayMessages);
        final targetItemIndex = targetMessageId == null
            ? -1
            : items.indexWhere(
                (item) =>
                    item is MessageItem && item.message.id == targetMessageId,
              );
        if (targetMessageId != null && targetMessageIndex == -1) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              ref.read(selectionProvider.notifier).clearTargetMessage();
            }
          });
        } else if (targetMessageId != null &&
            targetItemIndex >= 0 &&
            !_targetExpandScheduled) {
          _scheduleTargetMessageScroll(
            messageId: targetMessageId,
            itemIndex: targetItemIndex,
            itemCount: items.length,
          );
        }
        // FIX(Q4)：build 阶段只读 _seenMessageIds 推导本帧的 stagger 索引；
        // 不再在 build 内修改集合本身。具有副作用语义的写入（把"新见到的消息 id"
        // 加入集合 + 把 _initialLoadDone 翻为 true）统一挪到 addPostFrameCallback
        // 中执行，避免 hot reload / 父级重 build 反复修改实例字段。
        final newMessageStagger = <String, int>{};
        final List<String> pendingSeenAdds = <String>[];
        if (!_initialLoadDone) {
          // 初始加载：把已有消息全部视为"已见"，不触发动画。
          for (final item in items) {
            if (item is MessageItem) {
              pendingSeenAdds.add(item.message.id);
            }
          }
        } else {
          // 后续帧：基于"未在 _seenMessageIds 中"的条件即时计算 stagger 索引，
          // 命中的 id 累积到 pendingSeenAdds，post-frame 一次性写回集合。
          int staggerIdx = 0;
          for (final item in items) {
            if (item is MessageItem) {
              final msgId = item.message.id;
              if (!_seenMessageIds.contains(msgId)) {
                newMessageStagger[msgId] = staggerIdx++;
                pendingSeenAdds.add(msgId);
              }
            }
          }
        }
        if (pendingSeenAdds.isNotEmpty || !_initialLoadDone) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            // 直接写实例字段、不调用 setState：本帧已经基于"未见"判定生成 stagger，
            // 下一帧依赖更新后的 _seenMessageIds 即可避免重复触发动画；
            // 强制 setState 反而会让消息列表多一次无意义重 build。
            _seenMessageIds.addAll(pendingSeenAdds);
            _initialLoadDone = true;
          });
        }

        final chatState = _resolvedConversationId == null
            ? null
            : ref.watch(chatControllerProvider(_resolvedConversationId!));
        // 回归脚本检查 chatState.streamingTargetMessageId 字面量，防止目标流退回末尾气泡。
        final streamingTargetMessageId = chatState?.streamingTargetMessageId;
        final isStreamingHere = chatState?.isGenerating ?? false;
        final showNewMessageStreamBubble =
            isStreamingHere && streamingTargetMessageId == null;

        return LumiScrollbar(
          controller: _scrollController,
          child: NotificationListener<ScrollNotification>(
            onNotification: (notification) {
              if (notification is UserScrollNotification) {
                // ListView 非 reverse：手指向下滑（看历史）= ScrollDirection.forward
                // 手指向上滑（往新消息看）= ScrollDirection.reverse
                final dir = notification.direction;
                if (dir == ScrollDirection.forward) {
                  // 用户主动上滑，停止跟随
                  if (_followingStream) _followingStream = false;
                } else if (dir == ScrollDirection.reverse) {
                  // 用户朝底部方向滑且回到接近底部时，重新开启跟随
                  if (!_followingStream && _isNearBottom()) {
                    _followingStream = true;
                  }
                }
              }
              if (notification is ScrollUpdateNotification) {
                final metrics = notification.metrics;
                if (metrics.pixels <= metrics.minScrollExtent + 60) {
                  _loadMoreMessages();
                }
              }
              // 仅在确实有 active action 时才 setState，避免每次 ScrollUpdate
              // 都触发整个 build，造成滚动卡顿。
              if (_activeActionMessageId != null) {
                setState(() => _activeActionMessageId = null);
              }
              return false;
            },
            child: ScrollConfiguration(
              behavior: ScrollConfiguration.of(
                context,
              ).copyWith(scrollbars: false),
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: items.length + (showNewMessageStreamBubble ? 1 : 0),
                itemBuilder: (context, index) {
                  if (index == items.length && showNewMessageStreamBubble) {
                    return _buildStreamingMessage(character);
                  }
                  final item = items[index];
                  if (item is LoadMoreItem) {
                    return _buildLoadMoreIndicator();
                  }
                  if (item is DateDividerItem) {
                    return _buildDateDivider(item.date);
                  }
                  final msg = (item as MessageItem).message;

                  final stagger = newMessageStagger[msg.id];
                  final isNewMessage = stagger != null;

                  final isStreamingTarget =
                      isStreamingHere && streamingTargetMessageId == msg.id;

                  final bubble = MessageBubble(
                    key: ValueKey('msg_${msg.id}'),
                    message: msg,
                    characterName: character.name,
                    characterAvatarUrl: character.avatarUrl,
                    showTimestamps: showTimestamps,
                    onRegenerate: msg.role == 'assistant'
                        ? () => _actions.regenerate(msg.id)
                        : null,
                    onRegenerateFromHere: msg.role == 'user'
                        ? () => _actions.regenerateFromHere(msg.id)
                        : null,
                    onGenerateImage: msg.role == 'assistant'
                        ? ({String? prompt, String? replaceImageId}) =>
                              _actions.generateImageForMessage(
                                msg.id,
                                existingPrompt: prompt,
                                replaceImageId: replaceImageId,
                              )
                        : null,
                    onCopy: () => _actions.copyMessage(msg.content),
                    onDelete: () async {
                      // TODO(parity): i18n — 主项目暂无对应 key，硬编码兜底
                      final confirmed = await showDeleteConversationDialog(
                        context,
                        title: '删除消息？',
                        body: '此消息将被永久删除，无法恢复。',
                        confirmLabel: '删除',
                        cancelLabel: '取消',
                      );
                      if (!mounted) return;
                      if (confirmed != true) return;
                      await _actions.deleteMessage(msg.id);
                    },
                    onSwitchVersion: (v) => _actions.switchVersion(msg.id, v),
                    onEdit: msg.role != 'system'
                        ? () => _showEditDialog(msg)
                        : null,
                    onRegenerateImage: (path, {prompt}) =>
                        _actions.regenerateImage(msg.id, path, prompt: prompt),
                    onDeleteGeneratedImage: (imageId) =>
                        _actions.deleteGeneratedImage(msg.id, imageId),
                    onDeleteGeneratedImageVersion:
                        (imageId, versionLocalPath) =>
                            _actions.deleteGeneratedImageVersion(
                              msg.id,
                              imageId,
                              versionLocalPath,
                            ),
                    onEditImagePrompt: (imageId, newPrompt) =>
                        _actions.editImagePrompt(msg.id, imageId, newPrompt),
                    onSetPrimaryImage: (imageId, versionIndex) =>
                        _actions.setPrimaryImage(msg.id, imageId, versionIndex),
                    onDeleteAttachment: msg.role == 'user'
                        ? (index) => _deleteAttachment(msg.id, index)
                        : null,
                    activeMessageId: _activeActionMessageId,
                    onToggleActions: _toggleMessageActions,
                  );

                  final targetKey = _messageKeys.putIfAbsent(
                    msg.id,
                    () => GlobalKey(),
                  );
                  final isHighlighted = _highlightedMessageId == msg.id;
                  final messageContent = MessageAnimationWrapper(
                    key: isStreamingTarget
                        ? ValueKey('streaming_${msg.id}')
                        : ValueKey('anim_${msg.id}'),
                    shouldAnimate: isNewMessage,
                    staggerIndex: stagger ?? 0,
                    child: isStreamingTarget
                        ? _buildRegenerateStreamingBubble(character)
                        : bubble,
                  );

                  return KeyedSubtree(
                    key: targetKey,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 220),
                      curve: Curves.easeOut,
                      decoration: BoxDecoration(
                        color: isHighlighted
                            ? AppTheme.accent.withValues(alpha: 0.10)
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: messageContent,
                    ),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }

  /// 角色已选 / 对话尚无消息时的提示
  Widget _buildEmptyChat(Character character) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 圆形头像光晕
          Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      AppTheme.accent.withValues(alpha: 0.20),
                      AppTheme.accentLight.withValues(alpha: 0.30),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(32),
                  border: Border.all(
                    color: AppTheme.accent.withValues(alpha: 0.16),
                  ),
                ),
                clipBehavior: Clip.antiAlias,
                child:
                    character.avatarUrl != null &&
                        character.avatarUrl!.isNotEmpty
                    ? LumiNetworkImage(
                        url: character.avatarUrl!,
                        fit: BoxFit.cover,
                      )
                    : _emptyAvatarInitial(character),
              )
              .animate(onPlay: (controller) => controller.repeat(reverse: true))
              .scale(
                begin: const Offset(1.0, 1.0),
                end: const Offset(1.05, 1.05),
                duration: 2.seconds,
                curve: Curves.easeInOut,
              )
              .shimmer(
                delay: 1500.milliseconds,
                duration: 1500.milliseconds,
                color: Colors.white.withValues(alpha: 0.2),
              ),
          const SizedBox(height: 20),
          Text(
            character.name,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
          if (character.greeting.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              constraints: const BoxConstraints(maxWidth: 480),
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkSurface.withValues(alpha: 0.6)
                    : Colors.white.withValues(alpha: 0.6),
                border: Border.all(
                  color: isDark
                      ? AppTheme.darkBorderLight
                      : AppTheme.borderLight,
                ),
                borderRadius: AppRadius.lgBorder,
              ),
              child: Text(
                character.greeting,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.7,
                  color: isDark
                      ? AppTheme.darkTextSecondary
                      : AppTheme.textSecondary,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ],
          const SizedBox(height: 12),
          Text(
            _i18n('chat.start'),
            style: TextStyle(
              fontSize: 12,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _emptyAvatarInitial(Character character) {
    return Center(
      child: Text(
        character.name.isNotEmpty ? character.name[0] : '?',
        style: const TextStyle(
          fontSize: 36,
          fontWeight: FontWeight.w600,
          color: AppTheme.accentDark,
        ),
      ),
    );
  }

  List<ChatListItem> _buildItemsWithDateDividers(List<Message> messages) {
    final items = <ChatListItem>[];
    // 长对话分页：顶部插入加载更多指示器
    if (_hasMoreMessages) {
      items.add(LoadMoreItem());
    }
    DateTime? lastDate;
    for (final msg in messages) {
      final d = DateTime(
        msg.createdAt.year,
        msg.createdAt.month,
        msg.createdAt.day,
      );
      if (lastDate == null || d != lastDate) {
        items.add(DateDividerItem(d));
        lastDate = d;
      }
      items.add(MessageItem(msg));
    }
    return items;
  }

  /// 加载更多历史消息指示器
  Widget _buildLoadMoreIndicator() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.6)
                : Colors.white.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 1.5,
                  valueColor: AlwaysStoppedAnimation(
                    isDark ? AppTheme.darkAccent : AppTheme.accent,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '加载更多历史消息…',
                style: TextStyle(
                  fontSize: 12,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDateDivider(DateTime date) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    String label;
    if (date == today) {
      label = '今天';
    } else if (date == yesterday) {
      label = '昨天';
    } else if (date.year == now.year) {
      label = '${date.month}月${date.day}日';
    } else {
      label = '${date.year}年${date.month}月${date.day}日';
    }
    // 暗色模式适配：日期分隔线颜色
    final dividerColor = (isDark ? AppTheme.darkAccent : AppTheme.accent)
        .withValues(alpha: 0.12);
    final labelColor = (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
        .withValues(alpha: 0.7);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(
        children: [
          Expanded(child: Container(height: 1, color: dividerColor)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              label,
              style: TextStyle(fontSize: 11, color: labelColor),
            ),
          ),
          Expanded(child: Container(height: 1, color: dividerColor)),
        ],
      ),
    );
  }

  // ─── 流式消息 ───
  /// 流式消息气泡 — 改为轻量委托给独立 ConsumerWidget，避免 chunk 触发整树重建
  Widget _buildStreamingMessage(Character character) {
    if (_resolvedConversationId == null) return const SizedBox.shrink();
    return _StreamingBubble(
      character: character,
      conversationId: _resolvedConversationId!,
    );
  }

  /// 重新生成原位占位气泡 — 对照主项目 ChatView.tsx `isStreamingTarget ? streamingBubble : ...`
  ///
  /// 主项目：重新生成时，原消息被 `hiddenMessageId` 隐藏，目标位置直接渲染
  /// `streamingBubble`（即标准流式占位气泡）—— 无文本时三点跳动，有文本时显示流式内容。
  /// 不再显示原消息内容，避免视觉上"先看见旧的再被替换"的违和感。
  Widget _buildRegenerateStreamingBubble(Character character) {
    return _buildStreamingMessage(character);
  }

  // ─── 记忆提取指示器 ───
  /// 当前对话存在 status == 'processing' 的记忆任务时，
  /// 在消息列表底部显示一条柔和的「记忆提取中」提示条；
  /// done / failed / 无任务时折叠为空。
  ///
  /// 阶段 2B：本 widget 已不再被调用 — TSX 中没有此组件，提取状态以 chip 形式
  /// 显示在 messageHeader 右侧（待 2C 阶段补齐）。函数体保留以备后续参考，
  /// 添加 ignore 注释屏蔽 unused 警告。
  // ignore: unused_element
  Widget _buildMemoryExtractionIndicator(bool isDark) {
    if (_resolvedConversationId == null) return const SizedBox.shrink();

    final snapAsync = ref.watch(
      latestMemoryTaskProvider(_resolvedConversationId!),
    );
    final snap = snapAsync.valueOrNull;
    if (snap == null || snap.status != 'processing') {
      return const SizedBox.shrink();
    }

    final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: accent.withValues(alpha: isDark ? 0.16 : 0.10),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: accent.withValues(alpha: 0.24)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.6,
                    valueColor: AlwaysStoppedAnimation(accent),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  // TODO(parity): 主项目缺失 'chat.memoryExtracting' 键，硬编码兜底
                  '记忆提取中',
                  style: TextStyle(
                    fontSize: 12,
                    color: accent,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ─── 输入区 ───
  Widget _buildInputArea(BuildContext context, bool isDark) {
    final isGenerating = _resolvedConversationId != null
        ? ref
              .watch(chatControllerProvider(_resolvedConversationId!))
              .isGenerating
        : false;

    return ChatInput(
      onSend: _actions.sendFromInput,
      onStop: _actions.stopGeneration,
      disabled: isGenerating,
      isGenerating: isGenerating,
      currentModel: ref.watch(
        settingsProvider.select((s) => s.valueOrNull?.model ?? ''),
      ),
      onModelChange: (model) async {
        final notifier = ref.read(settingsProvider.notifier);
        final current = ref.read(settingsProvider).valueOrNull;
        if (current != null) {
          await notifier.updateSettings(current.copyWith(model: model));
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 保留在 ChatView 中的 UI 弹窗方法
  // ═══════════════════════════════════════════════════════════════

  Future<void> _showEditDialog(Message message) async {
    final ctrl = TextEditingController(text: message.content);
    String? result;
    try {
      result = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(_i18n('message.edit')),
          content: TextField(
            controller: ctrl,
            maxLines: 8,
            minLines: 3,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              // TODO(parity): 主项目缺失 'message.editPlaceholder' 键，硬编码兜底
              hintText: '编辑消息内容...',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(_i18n('chat.cancel')),
            ),
            ElevatedButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text),
              // 'common.save' 属 common.* 命名空间，留待任务 6.6 替换
              child: const Text('保存'),
            ),
          ],
        ),
      );
    } finally {
      // 任何退出路径（含异常 / Navigator.pop / 系统返回）都释放 controller
      ctrl.dispose();
    }
    if (result != null &&
        result.trim().isNotEmpty &&
        result != message.content) {
      await ref
          .read(messageActionsProvider)
          .editContent(message.id, result.trim());
    }
  }

  Future<void> _showConversationList(BuildContext context) async {
    final selection = ref.read(selectionProvider);
    if (selection.characterId == null) return;
    final conversations =
        ref
            .read(conversationListProvider(selection.characterId!))
            .valueOrNull ??
        [];
    // 阶段 2E：用对照 TSX 第 2127~2178 行的 surface-panel 圆角抽屉替代裸
    // ListTile + showModalBottomSheet
    showConversationDrawer(
      context,
      conversations: conversations,
      activeConversationId: _resolvedConversationId,
      // FIX(i18n)：把当前语言传入，让抽屉内"最近对话"标题与空态文案使用 i18n。
      lang: ref.read(localeProvider).languageCode,
      onSelect: (id) {
        _setConversationId(id);
        ref.read(selectionProvider.notifier).setActiveConversation(id);
      },
    );
  }

  void _showMoreMenu(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.auto_awesome),
              title: Text(_i18n('chat.summarize')),
              onTap: () {
                Navigator.pop(ctx);
                _actions.summarize();
              },
            ),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: Text(_i18n('chat.renameTitle')),
              onTap: () {
                Navigator.pop(ctx);
                _showRenameDialog();
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_outlined),
              title: Text(_i18n('chat.duplicate')),
              onTap: () {
                Navigator.pop(ctx);
                _actions.duplicateConversation();
              },
            ),
            // 对话设置：忽略记忆提取等开关
            ListTile(
              leading: const Icon(Icons.tune_outlined),
              // TODO(parity): 主项目缺失 'chat.conversationSettings' 键，硬编码兜底
              title: const Text('对话设置'),
              onTap: () {
                Navigator.pop(ctx);
                _showConversationSettings();
              },
            ),
          ],
        ),
      ),
    );
  }

  /// 弹出对话设置浮层（含「忽略记忆提取」开关等）
  void _showConversationSettings() {
    final id = _resolvedConversationId;
    if (id == null) {
      // TODO(parity): 主项目缺失 'chat.startConversationFirst' 键，硬编码兜底
      _showToast('请先开始一段对话');
      return;
    }
    ConversationSettingsSheet.show(context, id);
  }

  Future<void> _showRenameDialog() async {
    final id = _resolvedConversationId;
    if (id == null) return;
    // 阶段 2E：用对照 TSX 视觉契约的 surface-panel 弹窗替代裸 AlertDialog
    final selection = ref.read(selectionProvider);
    final characterId = selection.characterId;
    String initial = '';
    if (characterId != null) {
      final list =
          ref.read(conversationListProvider(characterId)).valueOrNull ?? [];
      final conv = list.cast<Conversation?>().firstWhere(
        (c) => c?.id == id,
        orElse: () => null,
      );
      if (conv != null) initial = conv.title;
    }
    final result = await showRenameConversationDialog(
      context,
      initialValue: initial,
      // FIX(i18n)：把当前语言传给对话框，使内部文案走 I18n.t。
      lang: ref.read(localeProvider).languageCode,
    );
    if (result != null && result.isNotEmpty) {
      await ref.read(conversationActionsProvider).rename(id, result);
    }
  }

  // ignore: unused_element
  Future<void> _showImageGenDialog() async {
    if (_resolvedConversationId == null) {
      _showToast('请先开始一段对话');
      return;
    }
    final ctrl = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        // 'imageGen.title' 属 imageGen.* 命名空间，留待任务 6.5 替换
        title: const Text('生成图片'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              // TODO(parity): 主项目缺失 'chat.imageGenContextHint' 键，硬编码兜底
              '将根据对话上下文自动生成图片提示词',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              maxLines: 3,
              minLines: 1,
              decoration: const InputDecoration(
                // 'imageGen.aiHintPlaceholder' 属 imageGen.* 命名空间，留待任务 6.5 替换
                hintText: '额外提示（可选，如：特写、全身、微笑...）',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(_i18n('chat.cancel')),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            // 'imageGen.generate' 属 imageGen.* 命名空间，留待任务 6.5 替换
            child: const Text('生成'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (result != null) {
      await _actions.generateImage(result);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 独立流式气泡 — 只 watch chatControllerProvider，不拖累整树
// ═══════════════════════════════════════════════════════════════

class _StreamingBubble extends ConsumerWidget {
  final Character character;
  final String conversationId;

  const _StreamingBubble({
    required this.character,
    required this.conversationId,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chatState = ref.watch(chatControllerProvider(conversationId));
    if (!chatState.isGenerating) return const SizedBox.shrink();

    final isDark = Theme.of(context).brightness == Brightness.dark;
    final hasText = chatState.currentStreamText.isNotEmpty;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _StreamingAvatar(character: character),
          const SizedBox(width: 12),
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: (MediaQuery.of(context).size.width * 0.65).clamp(
                  0.0,
                  680.0,
                ),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkSurface.withValues(alpha: 0.88)
                    : Colors.white.withValues(alpha: 0.88),
                border: Border.all(
                  color: isDark
                      ? AppTheme.darkBorderLight
                      : AppTheme.borderLight,
                ),
                borderRadius: AppRadius.xlBorder,
                boxShadow: const [AppSurfaces.softCardShadow],
              ),
              child: hasText
                  ? Text(
                      '${chatState.currentStreamText}▍',
                      style: TextStyle(
                        fontSize: 15,
                        height: 1.75,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    )
                  : const _TypingDots(),
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 流式响应小头像（与 MessageBubble 内头像视觉一致）
// ═══════════════════════════════════════════════════════════════

class _StreamingAvatar extends StatelessWidget {
  final Character character;
  const _StreamingAvatar({required this.character});

  @override
  Widget build(BuildContext context) {
    final hasAvatar =
        character.avatarUrl != null && character.avatarUrl!.isNotEmpty;
    return Container(
      margin: const EdgeInsets.only(top: 2),
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            AppTheme.accent.withValues(alpha: 0.18),
            AppTheme.accentLight.withValues(alpha: 0.28),
          ],
        ),
        borderRadius: AppRadius.mdBorder,
        border: Border.all(color: AppTheme.accent.withValues(alpha: 0.10)),
      ),
      clipBehavior: Clip.antiAlias,
      child: hasAvatar
          ? LumiNetworkImage(url: character.avatarUrl!, fit: BoxFit.cover)
          : _initial(),
    );
  }

  Widget _initial() {
    return Center(
      child: Text(
        character.name.isNotEmpty ? character.name[0] : '?',
        style: const TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: AppTheme.accentDark,
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 三点跳动 — 等待 LLM 第一个 chunk 时显示
// ═══════════════════════════════════════════════════════════════

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 22,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(3, (i) {
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2.5),
            child: AnimatedBuilder(
              animation: _controller,
              builder: (context, _) {
                // 0..1，错峰
                final t = (_controller.value - i * 0.16).clamp(0.0, 1.0);
                // 一个简单的 0..1..0 弹跳
                final phase = t < 0.3
                    ? (t / 0.3)
                    : t < 0.6
                    ? (1 - (t - 0.3) / 0.3)
                    : 0.0;
                return Transform.translate(
                  offset: Offset(0, -4 * phase),
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AppTheme.accent.withValues(
                        alpha: 0.4 + 0.6 * phase,
                      ),
                    ),
                  ),
                );
              },
            ),
          );
        }),
      ),
    );
  }
}
