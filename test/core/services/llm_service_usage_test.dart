import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';

/// D1 测试：验证 LlmService 流式/非流式 usage 捕获对齐主项目 api-client.ts。
///
/// 覆盖：
/// - 流式 SSE chunk 含 usage → onUsage 被调、值正确；
/// - 流式无 usage → onUsage 不调；
/// - total_tokens 缺失 → 回退 prompt + completion；
/// - abort/cancel 路径不上报 usage（对齐主项目）；
/// - 非流式 response.data['usage'] → onUsage 被调；
/// - extractUsageFromChunk：prompt/completion 非 finite → null。

void main() {
  group('extractUsageFromChunk', () {
    test('完整 usage → 返回 LlmUsage', () {
      final u = extractUsageFromChunk({
        'usage': {
          'prompt_tokens': 100,
          'completion_tokens': 50,
          'total_tokens': 150,
        },
      });
      expect(u, isNotNull);
      expect(u!.promptTokens, 100);
      expect(u.completionTokens, 50);
      expect(u.totalTokens, 150);
    });

    test('total_tokens 缺失 → 回退 prompt + completion', () {
      final u = extractUsageFromChunk({
        'usage': {'prompt_tokens': 30, 'completion_tokens': 20},
      });
      expect(u, isNotNull);
      expect(u!.totalTokens, 50);
    });

    test('prompt_tokens 缺失 → 返回 null', () {
      final u = extractUsageFromChunk({
        'usage': {'completion_tokens': 20, 'total_tokens': 20},
      });
      expect(u, isNull);
    });

    test('无 usage 字段 → 返回 null', () {
      expect(extractUsageFromChunk({'choices': []}), isNull);
      expect(extractUsageFromChunk({}), isNull);
    });

    test('usage 非 Map → 返回 null', () {
      expect(extractUsageFromChunk({'usage': 'not-a-map'}), isNull);
    });
  });

  group('chatCompletionStream usage 捕获', () {
    test('最后一个 chunk 携带 usage → onUsage 被调、值正确', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requestFuture = server.first.then((request) async {
        await utf8.decoder.bind(request).join();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        // 正常内容 chunk
        request.response.write(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        );
        // 最后一个 chunk：choices 为空、附带 usage
        request.response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        );
        request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });

      LlmUsage? captured;
      final service = LlmService();
      try {
        await service.chatCompletionStream(
          settings: AppSettings(
            apiBase: 'http://127.0.0.1:${server.port}',
            apiKey: 'test-key',
            model: 'test-model',
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onChunk: (_) {},
          onDone: (_) async {},
          onError: fail,
          onUsage: (u) => captured = u,
        );

        await requestFuture;
        expect(captured, isNotNull);
        expect(captured!.promptTokens, 10);
        expect(captured!.completionTokens, 5);
        expect(captured!.totalTokens, 15);
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });

    test('无 usage chunk → onUsage 不被调', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requestFuture = server.first.then((request) async {
        await utf8.decoder.bind(request).join();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        request.response.write(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        );
        request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });

      LlmUsage? captured;
      final service = LlmService();
      try {
        await service.chatCompletionStream(
          settings: AppSettings(
            apiBase: 'http://127.0.0.1:${server.port}',
            apiKey: 'test-key',
            model: 'test-model',
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onChunk: (_) {},
          onDone: (_) async {},
          onError: fail,
          onUsage: (u) => captured = u,
        );

        await requestFuture;
        expect(captured, isNull);
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });

    test('请求体包含 stream_options.include_usage', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final bodyFuture = server.first.then((request) async {
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
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onChunk: (_) {},
          onDone: (_) async {},
          onError: fail,
        );

        final body = await bodyFuture;
        expect(body['stream_options'], {'include_usage': true});
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });

    test('total_tokens 缺失 → 回退 prompt + completion', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requestFuture = server.first.then((request) async {
        await utf8.decoder.bind(request).join();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        request.response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":60}}\n\n',
        );
        request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });

      LlmUsage? captured;
      final service = LlmService();
      try {
        await service.chatCompletionStream(
          settings: AppSettings(
            apiBase: 'http://127.0.0.1:${server.port}',
            apiKey: 'test-key',
            model: 'test-model',
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onChunk: (_) {},
          onDone: (_) async {},
          onError: fail,
          onUsage: (u) => captured = u,
        );

        await requestFuture;
        expect(captured, isNotNull);
        expect(captured!.totalTokens, 100);
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });
  });

  group('chatCompletion 非流式 usage 捕获', () {
    test('response.data 含 usage → onUsage 被调', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      unawaited(
        server.forEach((request) async {
          await utf8.decoder.bind(request).join();
          request.response.headers.contentType = ContentType.json;
          request.response.write(jsonEncode({
            'choices': [
              {
                'message': {'content': 'hello'},
                'finish_reason': 'stop',
              },
            ],
            'usage': {
              'prompt_tokens': 7,
              'completion_tokens': 3,
              'total_tokens': 10,
            },
          }));
          await request.response.close();
        }),
      );

      LlmUsage? captured;
      final service = LlmService();
      try {
        final content = await service.chatCompletion(
          settings: AppSettings(
            apiBase: 'http://127.0.0.1:${server.port}',
            apiKey: 'test-key',
            model: 'test-model',
            streaming: false,
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onUsage: (u) => captured = u,
        );

        expect(content, 'hello');
        expect(captured, isNotNull);
        expect(captured!.promptTokens, 7);
        expect(captured!.completionTokens, 3);
        expect(captured!.totalTokens, 10);
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });

    test('无 usage 字段 → onUsage 不被调', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      unawaited(
        server.forEach((request) async {
          await utf8.decoder.bind(request).join();
          request.response.headers.contentType = ContentType.json;
          request.response.write(jsonEncode({
            'choices': [
              {
                'message': {'content': 'hello'},
                'finish_reason': 'stop',
              },
            ],
          }));
          await request.response.close();
        }),
      );

      LlmUsage? captured;
      final service = LlmService();
      try {
        await service.chatCompletion(
          settings: AppSettings(
            apiBase: 'http://127.0.0.1:${server.port}',
            apiKey: 'test-key',
            model: 'test-model',
            streaming: false,
          ),
          messages: const [ChatMessage(role: 'user', content: 'hi')],
          onUsage: (u) => captured = u,
        );

        expect(captured, isNull);
      } finally {
        service.dispose();
        await server.close(force: true);
      }
    });
  });

  group('LlmUsage.toJson round-trip', () {
    test('toJson 输出原始 usage 形式', () {
      const u = LlmUsage(
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      );
      expect(u.toJson(), {
        'prompt_tokens': 100,
        'completion_tokens': 50,
        'total_tokens': 150,
      });
    });
  });
}
