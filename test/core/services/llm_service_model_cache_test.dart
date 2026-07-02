import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/llm_service.dart';

Future<HttpServer> _serveModels(List<Object> data) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'data': data}));
      await request.response.close();
    }),
  );
  return server;
}

/// 内存 ModelCacheBackend，记录读写次数与可注入的缓存内容。
class _FakeCache implements ModelCacheBackend {
  String? readApiBase;
  String? writeApiBase;
  List<String>? writtenModels;
  DateTime? writtenAt;
  int readCount = 0;
  int writeCount = 0;

  /// 预置缓存条目；null 表示无缓存。`cachedAt` 由测试控制以模拟过期。
  final ({List<String> models, DateTime cachedAt})? preloaded;

  _FakeCache({this.preloaded});

  @override
  Future<({List<String> models, DateTime cachedAt})?> read(String apiBase) async {
    readApiBase = apiBase;
    readCount++;
    return preloaded;
  }

  @override
  Future<void> write(
    String apiBase,
    List<String> models,
    DateTime cachedAt,
  ) async {
    writeApiBase = apiBase;
    writtenModels = models;
    writtenAt = cachedAt;
    writeCount++;
  }
}

void main() {
  group('LlmService.fetchModels 缓存', () {
    test('命中：缓存未过期 → 不发 HTTP，返回缓存', () async {
      final fake = _FakeCache(
        preloaded: (
          models: const ['alpha', 'beta'],
          cachedAt: DateTime.now(),
        ),
      );
      final service = LlmService(modelCache: fake);
      addTearDown(service.dispose);

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:1',
        apiKey: 'sk-test',
      );

      expect(models, equals(<String>['alpha', 'beta']));
      expect(fake.readCount, 1);
      expect(fake.writeCount, 0);
    });

    test('过期：缓存超 30min → 发 HTTP，更新缓存', () async {
      final server = await _serveModels([
        {'id': 'zeta'},
        {'id': 'alpha'},
      ]);
      final fake = _FakeCache(
        preloaded: (
          models: const ['old'],
          // 31 分钟前，已过期
          cachedAt: DateTime.now().subtract(const Duration(minutes: 31)),
        ),
      );
      final service = LlmService(modelCache: fake);
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test',
      );

      expect(models, equals(<String>['alpha', 'zeta']));
      expect(fake.writeCount, 1);
      expect(fake.writtenModels, equals(<String>['alpha', 'zeta']));
    });

    test('forceRefresh：即使未过期也发 HTTP', () async {
      final server = await _serveModels([{'id': 'fresh'}]);
      final fake = _FakeCache(
        preloaded: (
          models: const ['cached-but-fresh'],
          cachedAt: DateTime.now(),
        ),
      );
      final service = LlmService(modelCache: fake);
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test',
        forceRefresh: true,
      );

      expect(models, equals(<String>['fresh']));
      expect(fake.writeCount, 1);
      expect(fake.writtenModels, equals(<String>['fresh']));
    });

    test('失败回退：HTTP 抛错 + 有旧缓存 → 返回旧缓存不抛', () async {
      final fake = _FakeCache(
        preloaded: (
          models: const ['stale-cache'],
          // 旧缓存（不管多旧都用）
          cachedAt: DateTime.now().subtract(const Duration(hours: 5)),
        ),
      );
      final service = LlmService(modelCache: fake);
      addTearDown(service.dispose);

      final models = await service.fetchModels(
        apiBase: 'http://127.0.0.1:1', // 不可达端口 → 网络错误
        apiKey: 'sk-test',
      );

      expect(models, equals(<String>['stale-cache']));
    });

    test('失败回退：HTTP 抛错 + 无旧缓存 → 抛 FetchModelsException', () async {
      final fake = _FakeCache(preloaded: null);
      final service = LlmService(modelCache: fake);
      addTearDown(service.dispose);

      expect(
        () => service.fetchModels(
          apiBase: 'http://127.0.0.1:1',
          apiKey: 'sk-secret-abcdef',
        ),
        throwsA(isA<FetchModelsException>()),
      );
    });

    test('无 cache backend（null）：每次 HTTP，失败抛错（行为同旧）', () async {
      final server = await _serveJsonTwice([
        {'id': 'a'},
      ]);
      final service = LlmService(); // modelCache 默认 null
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });

      // 第一次拉取
      final m1 = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test',
      );
      // 第二次拉取（无缓存应再次发 HTTP）
      final m2 = await service.fetchModels(
        apiBase: 'http://127.0.0.1:${server.port}',
        apiKey: 'sk-test',
      );
      expect(m1, equals(<String>['a']));
      expect(m2, equals(<String>['a']));
    });

    test('无 cache backend 失败时抛 FetchModelsException', () async {
      final service = LlmService();
      addTearDown(service.dispose);

      expect(
        () => service.fetchModels(
          apiBase: 'http://127.0.0.1:1',
          apiKey: 'sk-test',
        ),
        throwsA(isA<FetchModelsException>()),
      );
    });
  });
}

/// 双次服务的 helper（无缓存场景验证每次都发 HTTP）。
Future<HttpServer> _serveJsonTwice(List<Object> data) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'data': data}));
      await request.response.close();
    }),
  );
  return server;
}
