import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/chat/widgets/chat_input.dart';

Widget _buildTestApp({required Future<void> Function(String text) onSend}) {
  return ProviderScope(
    child: MaterialApp(
      home: Scaffold(
        body: ChatInput(
          disabled: false,
          isGenerating: false,
          onSend: (text, attachments) => onSend(text),
        ),
      ),
    ),
  );
}

void main() {
  group('ChatInput 桌面键盘发送', () {
    testWidgets('TextField 聚焦时按 Enter 会发送消息', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        _buildTestApp(onSend: (text) async => sent.add(text)),
      );

      await tester.enterText(find.byType(TextField), '你好');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(sent, ['你好']);
    });

    testWidgets('TextField 聚焦时按 Shift+Enter 不发送消息', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        _buildTestApp(onSend: (text) async => sent.add(text)),
      );

      await tester.enterText(find.byType(TextField), '你好');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pump();

      expect(sent, isEmpty);
    });
  });
}
