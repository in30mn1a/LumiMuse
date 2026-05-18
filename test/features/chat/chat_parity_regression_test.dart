import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('聊天区主项目行为对齐回归', () {
    test('消息列表不再额外居中限宽', () {
      final chatView = File('lib/features/chat/chat_view.dart').readAsStringSync();
      expect(chatView, isNot(contains('maxWidth: isWide ? 880 : double.infinity')));
    });

    test('消息气泡不再强制最小宽度', () {
      final bubble = File('lib/features/chat/widgets/message_bubble.dart').readAsStringSync();
      expect(bubble, isNot(contains('minWidth: 180')));
    });

    test('消息头读取真实待提取计数', () {
      final view = File('lib/features/chat/chat_view.dart').readAsStringSync();
      final memory = File('lib/core/providers/memory_provider.dart').readAsStringSync();
      expect(view, contains('conversationUnextractedCountProvider'));
      expect(memory, contains('allMessages.where'));
      expect(memory, contains('!meta.memoryExtracted'));
    });

    test('重新生成显式记录流式目标消息 ID', () {
      final provider = File('lib/core/providers/chat_provider.dart').readAsStringSync();
      expect(provider, contains('final String? streamingTargetMessageId;'));
      expect(provider, contains('this.streamingTargetMessageId,'));
      expect(provider, contains('streamingTargetMessageId: null'));
      expect(provider, contains('clearStreamingTargetMessageId'));
    });

    test('聊天视图按目标消息原地渲染重生成流', () {
      final view = File('lib/features/chat/chat_view.dart').readAsStringSync();
      expect(view, contains('chatState.streamingTargetMessageId'));
      expect(view, contains('final isStreamingTarget ='));
      expect(view, contains('isStreamingTarget ?'));
      expect(view, contains('_buildStreamingMessage(character)'));
    });

    test('切换对话后会触发一次首帧滚底', () {
      final view = File('lib/features/chat/chat_view.dart').readAsStringSync();
      expect(view, contains('_scrollToBottomOnLoad'));
      expect(view, contains('if (_scrollToBottomOnLoad)'));
      expect(view, contains('_scrollToBottom(animate: false)'));
      expect(view, contains('_scrollToBottomOnLoad = false'));
    });

    test('发送消息前先请求强制滚底，避免移动端等待 AI 完成后才滚动', () {
      final actions =
          File('lib/features/chat/widgets/chat_actions.dart').readAsStringSync();
      final methodStart = actions.indexOf('Future<void> sendFromInput(');
      final controllerIndex = actions.indexOf(
        'final controller =',
        methodStart,
      );
      final requestIndex = actions.indexOf(
        'requestScrollToBottom();',
        methodStart,
      );

      expect(methodStart, isNonNegative);
      expect(controllerIndex, isNonNegative);
      expect(
        requestIndex,
        allOf(isNonNegative, lessThan(controllerIndex)),
        reason: '发送后滚底必须在等待 LLM 回复前请求，否则移动端会停在旧位置',
      );
    });
  });
}
