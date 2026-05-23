// Feature: flutter-pixel-perfect-parity, Scenario 7.2: 集成场景 B4 — 版本归档
// Validates: Requirements B4.1, B4.2
//
// 目标
// ────
// 对一条单版本 AI 消息触发首次 regenerate 后，断言：
//   1. metadata.versions[0].content == 原 content（首次重生必须把当前 content
//      归档为版本 0，对应 INV-2「首次重新生成 +2」语义）；
//   2. metadata.versions.length == 2；
//   3. metadata.activeVersion == 1（指向新版本）。
//
// 实施策略（与 spec 任务说明一致）：
// - 本 spec 只提供 `ChatProviderContract` 抽象；具体实现由子 spec 完成。
//   因此本测试用一个最小 fake `_FakeChatProvider implements ChatProviderContract`
//   演示「首次重生归档」契约行为；
// - 用 `testWidgets` 渲染一个最小消息气泡 widget（自带 IconButton 触发
//   regenerate），点击后断言 versions 数组与 activeVersion；
// - 整个测试不依赖真实 ChatView / 网络 / 数据库。

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:lumimuse/core/database/database.dart' show Message;
import 'package:lumimuse/core/models/attachment_item.dart';
import 'package:lumimuse/core/providers/chat_provider_contract.dart';

// ─────────── fake ChatProvider：仅实现 regenerate 的归档契约 ───────────

/// 最小 fake：演示「首次重生归档」与「activeVersion 指向新版本」的契约。
/// 不实现网络与流式；regenerate 同步把版本数从 1 拉到 2。
class _FakeChatProvider extends ChangeNotifier
    implements ChatProviderContract {
  // 每个对话内的消息表；本测试只用一条对话 + 一条 AI 消息。
  final Map<String, List<Map<String, dynamic>>> _msgs = {};
  // 对应消息 id 的 metadata（key = msgId）
  final Map<String, Map<String, dynamic>> _meta = {};

  // 调用计数：辅助断言「首次重生只触发一次归档」。
  int regenerateCalls = 0;

  /// 测试种子：插入一条单版本 AI 消息，metadata 初始 versions 为空。
  void seedSingleAssistant({
    required String convId,
    required String msgId,
    required String content,
  }) {
    _msgs[convId] = [
      {'id': msgId, 'role': 'assistant', 'content': content},
    ];
    _meta[msgId] = <String, dynamic>{
      // 初始无 versions / activeVersion，与「单版本」消息状态一致
    };
  }

  /// 暴露给测试断言用：取某条消息的 metadata 快照（已是 Map，落实 INV-7）。
  Map<String, dynamic> metadataOf(String msgId) =>
      Map<String, dynamic>.from(_meta[msgId] ?? const <String, dynamic>{});

  String? contentOf(String convId, String msgId) {
    for (final m in (_msgs[convId] ?? const <Map<String, dynamic>>[])) {
      if (m['id'] == msgId) return m['content'] as String?;
    }
    return null;
  }

  // ─────────── ChatProviderContract 实现 ───────────

  @override
  Set<String> get activeStreams => const <String>{};

  @override
  Map<String, CancelToken> get abortControllers =>
      const <String, CancelToken>{};

  @override
  bool get forceScrollToBottom => false;

  @override
  bool get skipScroll => false;

  @override
  Map<String, List<Message>> get messagesByConv =>
      const <String, List<Message>>{};

  @override
  String? get activeConvId => _activeConvId;
  String? _activeConvId;
  set activeConvId(String? v) {
    _activeConvId = v;
    notifyListeners();
  }

  @override
  Future<void> send(
    String convId,
    String content, {
    List<AttachmentItem> attachments = const [],
  }) async {
    // 本测试无需 send 实际行为
  }

  @override
  Future<void> regenerate(String convId, String assistantMessageId) async {
    regenerateCalls++;
    final msgs = _msgs[convId];
    if (msgs == null) return;
    final idx = msgs.indexWhere((m) => m['id'] == assistantMessageId);
    if (idx < 0) return;
    final original = msgs[idx]['content'] as String;
    final meta = _meta[assistantMessageId] ??= <String, dynamic>{};

    // INV-2：首次重生时 versions 为空 → 一次性 +2（归档版本 0 + 新版本 1）。
    final List<dynamic> versions =
        (meta['versions'] as List<dynamic>?) ?? <dynamic>[];
    if (versions.isEmpty) {
      versions.add(<String, dynamic>{
        'index': 0,
        'content': original,
      });
    }
    final newContent = '$original [regenerated]';
    versions.add(<String, dynamic>{
      'index': versions.length,
      'content': newContent,
    });
    meta['versions'] = versions;
    meta['activeVersion'] = versions.length - 1;

    // 当前展示内容切换到新版本（与主项目「重新生成切到新版本」一致）。
    msgs[idx]['content'] = newContent;
    notifyListeners();
  }

  @override
  void stop(String convId) {}

  @override
  void switchVersion(String messageId, int versionIndex) {}

  @override
  Future<DeleteOutcome> smartDelete(String messageId) async =>
      DeleteOutcome.removedMessage;

  @override
  Future<void> refreshMessagesForConversation(String convId) async {}
}

// ─────────── 最小消息气泡 widget ───────────

/// 自带一个 IconButton 触发 regenerate；显示当前 content 与 versions 数量。
class _AssistantBubble extends StatefulWidget {
  final _FakeChatProvider provider;
  final String convId;
  final String msgId;
  const _AssistantBubble({
    required this.provider,
    required this.convId,
    required this.msgId,
  });

  @override
  State<_AssistantBubble> createState() => _AssistantBubbleState();
}

class _AssistantBubbleState extends State<_AssistantBubble> {
  @override
  void initState() {
    super.initState();
    widget.provider.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.provider.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final content =
        widget.provider.contentOf(widget.convId, widget.msgId) ?? '';
    final meta = widget.provider.metadataOf(widget.msgId);
    final vCount = (meta['versions'] as List<dynamic>?)?.length ?? 0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('content: $content', key: const ValueKey('content-text')),
        const SizedBox(width: 8),
        Text('vCount: $vCount', key: const ValueKey('versions-count-text')),
        const SizedBox(width: 8),
        IconButton(
          key: const ValueKey('regenerate-btn'),
          icon: const Icon(Icons.refresh),
          onPressed: () {
            widget.provider.regenerate(widget.convId, widget.msgId);
          },
        ),
      ],
    );
  }
}

void main() {
  testWidgets(
    '场景 B4：单版本 AI 消息首次 regenerate → versions[0]==原 content，'
    'versions.length==2，activeVersion==1',
    (tester) async {
      final provider = _FakeChatProvider();
      const convId = 'c1';
      const msgId = 'm1';
      const original = '原始 AI 回复';
      provider.seedSingleAssistant(
        convId: convId,
        msgId: msgId,
        content: original,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: _AssistantBubble(
              provider: provider,
              convId: convId,
              msgId: msgId,
            ),
          ),
        ),
      );

      // 初始：单版本，metadata 中 versions 为空（或不存在）
      expect(provider.metadataOf(msgId)['versions'], isNull);
      expect(provider.contentOf(convId, msgId), original);

      // 触发首次 regenerate
      await tester.tap(find.byKey(const ValueKey('regenerate-btn')));
      await tester.pumpAndSettle();

      // 断言契约（B4.1 + B4.2 / INV-2）
      expect(provider.regenerateCalls, 1);
      final meta = provider.metadataOf(msgId);
      final versions = meta['versions'] as List<dynamic>;
      expect(versions.length, 2, reason: '首次重生必须一次性 +2（归档+新版本）');
      expect(
        (versions[0] as Map<String, dynamic>)['content'],
        original,
        reason: 'versions[0] 必须等于原 content（B4.1 归档）',
      );
      expect(
        meta['activeVersion'],
        1,
        reason: 'activeVersion 必须指向新版本（B4.2）',
      );

      // 再次断言 UI 已经反映新内容
      expect(find.text('vCount: 2'), findsOneWidget);
      expect(find.text('content: $original [regenerated]'), findsOneWidget);
    },
  );
}
