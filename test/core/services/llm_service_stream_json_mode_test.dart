import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';

void main() {
  test('chatCompletionStream 在 jsonMode=true 时发送 response_format', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requestBodyFuture = server.first.then((request) async {
      final body = await utf8.decoder.bind(request).join();
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
        charset: 'utf-8',
      );
      request.response.write('data: [DONE]\n\n');
      await request.response.close();
      return jsonDecode(body) as Map<String, dynamic>;
    });

    final service = LlmService();
    try {
      await service.chatCompletionStream(
        settings: AppSettings(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'test-key',
          model: 'test-model',
          jsonMode: true,
        ),
        messages: const [ChatMessage(role: 'user', content: 'hi')],
        onChunk: (_) {},
        onDone: (_) async {},
        onError: fail,
      );

      final body = await requestBodyFuture;
      expect(body['stream'], isTrue);
      expect(body['response_format'], {'type': 'json_object'});
    } finally {
      service.dispose();
      await server.close(force: true);
    }
  });

  test('chatCompletionStream 遇到非法 choices/delta 结构时跳过并继续解析后续 chunk', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requestFuture = server.first.then((request) async {
      await utf8.decoder.bind(request).join();
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
        charset: 'utf-8',
      );
      request.response.write(
        'data: {"choices":{"delta":{"content":"bad"}}}\n\n',
      );
      request.response.write('data: {"choices":[{"delta":null}]}\n\n');
      request.response.write(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      );
      request.response.write('data: [DONE]\n\n');
      await request.response.close();
    });

    final chunks = <String>[];
    final errors = <String>[];
    final service = LlmService();
    try {
      await service.chatCompletionStream(
        settings: AppSettings(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'test-key',
          model: 'test-model',
        ),
        messages: const [ChatMessage(role: 'user', content: 'hi')],
        onChunk: chunks.add,
        onDone: (fullText) async => chunks.add('done:$fullText'),
        onError: errors.add,
      );

      await requestFuture;
      expect(errors, isEmpty);
      expect(chunks, equals(<String>['ok', 'done:ok']));
    } finally {
      service.dispose();
      await server.close(force: true);
    }
  });
}
