import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/features/chat/widgets/message_bubble.dart';

Message _assistantMessageWithImageMeta(Map<String, dynamic> meta) {
  return Message(
    id: 'msg-image-regenerate',
    conversationId: 'conv-image-regenerate',
    role: 'assistant',
    content: '',
    tokenCount: 0,
    seq: 1,
    createdAt: DateTime(2026, 1, 1, 10, 0),
    metadata: jsonEncode(meta),
  );
}

Widget _host({
  required Message message,
  required void Function(String imagePath, {String? prompt}) onRegenerateImage,
}) {
  return ProviderScope(
    child: MaterialApp(
      home: MediaQuery(
        data: const MediaQueryData(size: Size(375, 812)),
        child: Scaffold(
          body: MessageBubble(
            message: message,
            characterName: 'Mira',
            showTimestamps: false,
            onRegenerateImage: onRegenerateImage,
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('点击图片重新生成时传入当前激活版本 prompt，而不是顶层旧 prompt',
      (tester) async {
    const oldPath = '/local/widget-regenerate/old.png';
    const currentPath = '/local/widget-regenerate/current.png';
    const oldTopPrompt = 'old top prompt, red cloak';
    const activePrompt = 'active version prompt, silver cloak';
    final message = _assistantMessageWithImageMeta({
      'generatedImages': [
        {
          'id': 'img-ready',
          'url': currentPath,
          'path': currentPath,
          'prompt': oldTopPrompt,
          'status': 'ready',
          'activeVersion': 1,
          'versions': [
            {
              'id': 'v0',
              'url': oldPath,
              'path': oldPath,
              'prompt': oldTopPrompt,
            },
            {
              'id': 'v1',
              'url': currentPath,
              'path': currentPath,
              'prompt': activePrompt,
            },
          ],
        },
      ],
    });

    String? receivedPath;
    String? receivedPrompt;
    await tester.pumpWidget(_host(
      message: message,
      onRegenerateImage: (imagePath, {prompt}) {
        receivedPath = imagePath;
        receivedPrompt = prompt;
      },
    ));

    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();

    expect(receivedPath, currentPath);
    expect(receivedPrompt, activePrompt);
  });
}
