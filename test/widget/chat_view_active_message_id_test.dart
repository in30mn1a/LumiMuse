// Feature: flutter-parity-completion, Property 16: activeMessageId 状态机不变量
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**
//
// 用 `testWidgets` 在最小 ChatView 行为之上验证 `_activeActionMessageId`
// 状态机：渲染若干 `MessageBubble`，外层用 `GestureDetector` 捕获空白点击。
//
// - 移动端断点（< 768）：点击气泡触发 toggle 状态切换；点击空白归零。
// - 桌面端断点（>= 768）：hover 只更新气泡内部 `_hover`，不会触发
//   `onToggleActions`，因此 `_activeActionMessageId` 始终保持初始 null
//   （9.5 两套机制并存）。
//
// 测试不依赖数据库 / Riverpod，仅复用真实 `MessageBubble` 与状态机骨架。

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/features/chat/widgets/message_bubble.dart';

/// 最小 ChatView 行为：维护 `_activeActionMessageId`，渲染若干 `MessageBubble`，
/// 外层用 `GestureDetector` 捕获空白点击 —— 与 `lib/features/chat/chat_view.dart`
/// 中的状态机骨架等价。
class _MinimalChatHost extends StatefulWidget {
  final List<Message> messages;
  const _MinimalChatHost({required this.messages});

  @override
  State<_MinimalChatHost> createState() => _MinimalChatHostState();
}

class _MinimalChatHostState extends State<_MinimalChatHost> {
  String? activeActionMessageId;

  void toggle(String id) {
    setState(() {
      activeActionMessageId =
          (activeActionMessageId == id) ? null : id;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // 空白区域用顶层 GestureDetector + opaque 行为捕获点击。
      // 子节点已经处理过的点击不会冒泡到这里，因此 hit-testing 只命中真正的空白。
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          if (activeActionMessageId != null) {
            setState(() => activeActionMessageId = null);
          }
        },
        // 用 Column 而不是 ListView：避免在小尺寸 testWidgets 下被裁剪。
        child: SingleChildScrollView(
          // 顶部留出空白区域用于「点击空白」断言。
          padding: const EdgeInsets.only(top: 200),
          child: Column(
            children: [
              for (final msg in widget.messages)
                MessageBubble(
                  key: ValueKey('msg_${msg.id}'),
                  message: msg,
                  characterName: 'Mira',
                  showTimestamps: false,
                  activeMessageId: activeActionMessageId,
                  onToggleActions: toggle,
                  onCopy: () {},
                  onDelete: () {},
                ),
            ],
          ),
        ),
      ),
    );
  }
}

Message _msg(String id, {String role = 'assistant'}) {
  return Message(
    id: id,
    conversationId: 'conv-1',
    role: role,
    // content 故意置空：避免 MarkdownBody / SelectableText 拦截 tap，
    // 让 testWidgets 的 tap 中心落在 metaRow 的 Spacer 区域，
    // 由 MessageBubble 主 GestureDetector 的 onTap 接管。
    content: '',
    tokenCount: 0,
    seq: 0,
    createdAt: DateTime(2026, 1, 1, 10, 0),
    metadata: '{}',
  );
}

/// 用指定屏幕宽度构建 host，便于切换移动/桌面断点。
Widget _hostWith({
  required List<Message> messages,
  required double screenWidth,
}) {
  // i18n 替换后 MessageBubble 会 watch localeProvider，所以最小测试外壳必须
  // 套一层 ProviderScope；其它行为保持不变。
  return ProviderScope(
    child: MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(size: Size(screenWidth, 812)),
        child: _MinimalChatHost(messages: messages),
      ),
    ),
  );
}

/// 点击指定 key 对应消息气泡的实际可点击区域。
///
/// 注意：MessageBubble 外层是 Row（assistant 默认左对齐），Row 会被父级撑满全宽，
/// 因此 `tester.tap(find.byKey(...))` 默认击中 Row 中心（落在右侧空白处），
/// 无法触发气泡内的 GestureDetector。这里用 `tapAt(topLeft + offset)` 精准命中
/// 头像右侧、气泡 metaRow 顶部的可点击区域。
Future<void> _tapBubble(WidgetTester tester, String id) async {
  final origin = tester.getTopLeft(find.byKey(ValueKey('msg_$id')));
  // x ≈ 24(外层 padding) + 40(avatar) + 12(spacing) + 16(气泡 padding) ≈ 92
  // 取 120 留余量；y=30 落在 metaRow 中部（避开外层 vertical:6 的 padding）。
  await tester.tapAt(origin + const Offset(120, 30));
  await tester.pump();
}

void main() {
  group('Widget · activeMessageId 状态机不变量（移动端）', () {
    testWidgets('初始 activeMessageId 为 null（9.1）', (tester) async {
      final messages = [_msg('a'), _msg('b')];
      await tester.pumpWidget(_hostWith(messages: messages, screenWidth: 375));
      await tester.pump();

      final state = tester.state<_MinimalChatHostState>(
        find.byType(_MinimalChatHost),
      );
      expect(state.activeActionMessageId, isNull);
    });

    testWidgets('点击不同气泡：null → A → B（9.2、9.4）', (tester) async {
      final messages = [_msg('a'), _msg('b')];
      await tester.pumpWidget(_hostWith(messages: messages, screenWidth: 375));
      await tester.pump();

      final state = tester.state<_MinimalChatHostState>(
        find.byType(_MinimalChatHost),
      );

      // 点击 A：null → 'a'
      await _tapBubble(tester, 'a');
      expect(state.activeActionMessageId, 'a');

      // 点击 B：'a' → 'b'
      await _tapBubble(tester, 'b');
      expect(state.activeActionMessageId, 'b');
    });

    testWidgets('再次点击同一气泡归零（9.3）', (tester) async {
      final messages = [_msg('a')];
      await tester.pumpWidget(_hostWith(messages: messages, screenWidth: 375));
      await tester.pump();

      final state = tester.state<_MinimalChatHostState>(
        find.byType(_MinimalChatHost),
      );

      await _tapBubble(tester, 'a');
      expect(state.activeActionMessageId, 'a');

      await _tapBubble(tester, 'a');
      expect(state.activeActionMessageId, isNull);
    });

    testWidgets('点击空白区域归零（9.6）', (tester) async {
      final messages = [_msg('a')];
      await tester.pumpWidget(_hostWith(messages: messages, screenWidth: 375));
      await tester.pump();

      final state = tester.state<_MinimalChatHostState>(
        find.byType(_MinimalChatHost),
      );

      // 先把状态切到 'a'
      await _tapBubble(tester, 'a');
      expect(state.activeActionMessageId, 'a');

      // 点击顶部空白区域（y=20，避开气泡）
      await tester.tapAt(const Offset(180, 20));
      await tester.pump();
      expect(state.activeActionMessageId, isNull);
    });
  });

  group('Widget · 桌面端 hover 不影响 activeMessageId（9.5）', () {
    testWidgets('桌面断点下 hover 不调用 toggle，状态保持 null', (tester) async {
      final messages = [_msg('a'), _msg('b')];
      // 桌面断点：宽度 1024 >= 768
      await tester.pumpWidget(
        _hostWith(messages: messages, screenWidth: 1024),
      );
      await tester.pump();

      final state = tester.state<_MinimalChatHostState>(
        find.byType(_MinimalChatHost),
      );
      expect(state.activeActionMessageId, isNull);

      // 模拟鼠标 hover 到气泡 A 的中心
      final gesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(gesture.removePointer);
      await gesture.addPointer(location: Offset.zero);
      await gesture.moveTo(tester.getCenter(find.byKey(const ValueKey('msg_a'))));
      await tester.pump();

      // 桌面端 hover 仅触发 MessageBubble 内部 _hover，不调用 onToggleActions。
      expect(state.activeActionMessageId, isNull,
          reason: '桌面端 hover 不应改变 activeActionMessageId');

      // 即使 hover 着 A，再 hover 到 B，状态依然为 null。
      await gesture.moveTo(tester.getCenter(find.byKey(const ValueKey('msg_b'))));
      await tester.pump();
      expect(state.activeActionMessageId, isNull);
    });
  });
}
