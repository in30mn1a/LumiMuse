import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/features/chat/widgets/chat_header.dart';

Character _character() {
  final now = DateTime(2026, 5, 29);
  return Character(
    id: 'char-1',
    name: '窄宽度测试角色',
    avatarUrl: null,
    personality: '',
    scenario: '',
    greeting: '',
    exampleDialogue: '',
    systemPrompt: '',
    basicInfo: '',
    otherInfo: '',
    imageTags: '',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  );
}

Widget _host() {
  return MaterialApp(
    home: Scaffold(
      body: SizedBox(
        width: 820,
        child: ChatHeader(
          character: _character(),
          conversationCount: 12,
          memoryCount: 34,
          isStreaming: false,
          isSummarizing: false,
          isDuplicating: false,
          hasActiveConversation: true,
          lang: 'zh',
          onOpenSidebar: null,
          onNewChat: () {},
          onShowConversationList: () {},
          onRename: () {},
          onSummarize: () {},
          onDuplicate: () {},
          onImageManager: () {},
          onDelete: () {},
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('ChatHeader 桌面窄宽下右侧按钮区不横向溢出', (tester) async {
    tester.view.physicalSize = const Size(820, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });
}
