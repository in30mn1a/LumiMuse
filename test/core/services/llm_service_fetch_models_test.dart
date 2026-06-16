import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';

Future<HttpServer> _serveJson(Object body, {int statusCode = 200}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      request.response.statusCode = statusCode;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    }),
  );
  return server;
}

Future<HttpServer> _serveDelayedChat() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      await Future<void>.delayed(const Duration(seconds: 5));
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'choices': [
            {
              'message': {'content': 'late reply'},
            },
          ],
        }),
      );
      await request.response.close();
    }),
  );
  return server;
}

void main() {
  group('LlmService.fetchModels', () {
    test('返回正常模型列表时按字典序排序并过滤空 id', () async {
      final server = await _serveJson({
        'data': [
          {'id': 'zeta'},
          {'id': ''},
          {'id': 'alpha'},
        ],
      });
      final service = LlmService();
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test-key-should-not-leak',
      );

      expect(models, equals(<String>['alpha', 'zeta']));
    });

    test('服务真实返回空 data 时返回空列表', () async {
      final server = await _serveJson({'data': <Object>[]});
      final service = LlmService();
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test-key-should-not-leak',
      );

      expect(models, isEmpty);
    });

    test('网络失败时抛出脱敏 FetchModelsException', () async {
      final service = LlmService();
      addTearDown(service.dispose);

      expect(
        () => service.fetchModels(
          apiBase: 'http://127.0.0.1:1',
          apiKey: 'sk-secret-key-abcdefghijklmnopqrstuvwxyz',
        ),
        throwsA(
          isA<FetchModelsException>()
              .having((e) => e.toString(), 'message', contains('模型列表'))
              .having(
                (e) => e.toString(),
                'sanitized',
                isNot(contains('sk-secret-key-abcdefghijklmnopqrstuvwxyz')),
              ),
        ),
      );
    });

    test('API 返回非法结构时抛出脱敏 FetchModelsException', () async {
      final server = await _serveJson({
        'data': {'id': 'not-a-list'},
      });
      final service = LlmService();
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      expect(
        () => service.fetchModels(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'sk-secret-key-abcdefghijklmnopqrstuvwxyz',
        ),
        throwsA(
          isA<FetchModelsException>().having(
            (e) => e.toString(),
            'sanitized',
            isNot(contains('sk-secret-key-abcdefghijklmnopqrstuvwxyz')),
          ),
        ),
      );
    });
  });

  group('LlmService.chatCompletion', () {
    test('非流式 Dio cancel 抛出 LlmRequestCancelledException', () async {
      final server = await _serveDelayedChat();
      final service = LlmService(
        dio: Dio(
          BaseOptions(
            connectTimeout: const Duration(seconds: 2),
            receiveTimeout: const Duration(seconds: 10),
            sendTimeout: const Duration(seconds: 2),
          ),
        ),
      );
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      final cancelToken = CancelToken();
      final future = service.chatCompletion(
        settings: AppSettings(
          apiBase: 'http://127.0.0.1:${server.port}',
          apiKey: 'sk-test-key',
          model: 'test-model',
          streaming: false,
        ),
        messages: const [ChatMessage(role: 'user', content: 'hi')],
        cancelToken: cancelToken,
      );
      cancelToken.cancel('user cancelled');

      await expectLater(future, throwsA(isA<LlmRequestCancelledException>()));
    });
  });
}
