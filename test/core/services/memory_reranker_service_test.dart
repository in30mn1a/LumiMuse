// 重排服务测试 — 覆盖三格式解析、空 documents、apiBase/model 缺失抛错、
// 端点归一化、HTTP 2xx/非 2xx。对齐主项目 memory-reranker.ts 行为。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/memory_reranker_service.dart';

Future<HttpServer> _serveJson(
  Object body, {
  int statusCode = 200,
  void Function(HttpRequest)? onRequest,
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      if (onRequest != null) onRequest(request);
      request.response.statusCode = statusCode;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    }),
  );
  return server;
}

void main() {
  group('normalizeRerankEndpoint', () {
    test('不以 /rerank 结尾则追加', () {
      expect(normalizeRerankEndpoint('https://api.example.com'), 'https://api.example.com/rerank');
    });

    test('已以 /rerank 结尾则原样返回', () {
      expect(normalizeRerankEndpoint('https://api.example.com/rerank'), 'https://api.example.com/rerank');
    });

    test('去尾斜杠后再判定', () {
      expect(normalizeRerankEndpoint('https://api.example.com/rerank/'), 'https://api.example.com/rerank');
      expect(normalizeRerankEndpoint('https://api.example.com///'), 'https://api.example.com/rerank');
    });

    test('trim 前后空白', () {
      expect(normalizeRerankEndpoint('  https://api.example.com  '), 'https://api.example.com/rerank');
    });
  });

  group('parseRerankerResponse', () {
    const docs = <RerankDocument>[
      RerankDocument(id: 'a', text: '文本甲'),
      RerankDocument(id: 'b', text: '文本乙'),
      RerankDocument(id: 'c', text: '文本丙'),
    ];

    test('格式1：scores 数组按 index 映射 documents id', () {
      final result = parseRerankerResponse({
        'scores': [0.9, 0.5, 0.1],
      }, docs);
      expect(result.length, 3);
      expect(result[0].id, 'a');
      expect(result[0].score, closeTo(0.9, 1e-9));
      expect(result[1].id, 'b');
      expect(result[2].id, 'c');
    });

    test('格式1：scores 超出 documents 长度的项被过滤', () {
      final result = parseRerankerResponse({
        'scores': [0.9, 0.5, 0.1, 0.0],
      }, docs);
      expect(result.length, 3);
    });

    test('格式1：非有限分值（NaN）被过滤', () {
      final result = parseRerankerResponse({
        'scores': [0.9, double.nan, 0.1],
      }, docs);
      expect(result.length, 2);
      expect(result[0].id, 'a');
      expect(result[1].id, 'c');
    });

    test('格式2：results 数组带 index + relevance_score', () {
      final result = parseRerankerResponse({
        'results': [
          {'index': 1, 'relevance_score': 0.8},
          {'index': 0, 'relevance_score': 0.3},
        ],
      }, docs);
      expect(result.length, 2);
      // index=1 → documents[1].id='b'
      expect(result[0].id, 'b');
      expect(result[0].score, closeTo(0.8, 1e-9));
      expect(result[1].id, 'a');
    });

    test('格式3：data 数组带 document_index + score', () {
      final result = parseRerankerResponse({
        'data': [
          {'document_index': 2, 'score': 0.7},
        ],
      }, docs);
      expect(result.length, 1);
      expect(result[0].id, 'c');
      expect(result[0].score, closeTo(0.7, 1e-9));
    });

    test('results 中 row.id 为字符串时优先取 row.id', () {
      final result = parseRerankerResponse({
        'results': [
          {'id': 'custom-id', 'index': 0, 'relevance_score': 0.9},
        ],
      }, docs);
      expect(result.length, 1);
      expect(result[0].id, 'custom-id');
    });

    test('results 中 row.id 非字符串且 index 越界时跳过', () {
      final result = parseRerankerResponse({
        'results': [
          {'id': 123, 'index': 99, 'relevance_score': 0.9},
        ],
      }, docs);
      expect(result, isEmpty);
    });

    test('results 中 score 非数字时跳过', () {
      final result = parseRerankerResponse({
        'results': [
          {'index': 0, 'relevance_score': 'not a number'},
        ],
      }, docs);
      expect(result, isEmpty);
    });

    test('results 项非对象时跳过', () {
      final result = parseRerankerResponse({
        'results': ['not an object', 42, null],
      }, docs);
      expect(result, isEmpty);
    });

    test('无 scores/results/data 时返回空', () {
      expect(parseRerankerResponse({}, docs), isEmpty);
      expect(parseRerankerResponse(null, docs), isEmpty);
      expect(parseRerankerResponse('string', docs), isEmpty);
    });
  });

  group('rerankDocuments', () {
    test('空 documents 直接返回空列表（不发起请求）', () async {
      final result = await rerankDocuments(
        'query',
        const <RerankDocument>[],
        const RerankerAdapterConfig(apiBase: 'https://x', model: 'm'),
      );
      expect(result, isEmpty);
    });

    test('apiBase 缺失抛错', () async {
      await expectLater(
        rerankDocuments(
          'query',
          const [RerankDocument(id: 'a', text: 't')],
          const RerankerAdapterConfig(apiBase: '', model: 'm'),
        ),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('reranker api_base is required'),
        )),
      );
    });

    test('model 缺失抛错', () async {
      await expectLater(
        rerankDocuments(
          'query',
          const [RerankDocument(id: 'a', text: 't')],
          const RerankerAdapterConfig(apiBase: 'https://x', model: ''),
        ),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('reranker model is required'),
        )),
      );
    });

    test('2xx：返回 parseRerankerResponse 结果', () async {
      final server = await _serveJson({
        'results': [
          {'index': 0, 'relevance_score': 0.95},
        ],
      });
      addTearDown(() async => server.close(force: true));

      final result = await rerankDocuments(
        '查询',
        const [RerankDocument(id: 'a', text: '文本')],
        RerankerAdapterConfig(
          apiBase: 'http://127.0.0.1:${server.port}',
          model: 'rerank-model',
        ),
        dio: Dio(),
      );
      expect(result.length, 1);
      expect(result[0].id, 'a');
      expect(result[0].score, closeTo(0.95, 1e-9));
    });

    test('非 2xx：抛 reranker API error 且经脱敏', () async {
      final server = await _serveJson(
        {'error': 'bad request with api_key=sk-secretabcdef'},
        statusCode: 400,
      );
      addTearDown(() async => server.close(force: true));

      await expectLater(
        rerankDocuments(
          '查询',
          const [RerankDocument(id: 'a', text: '文本')],
          RerankerAdapterConfig(
            apiBase: 'http://127.0.0.1:${server.port}',
            model: 'rerank-model',
          ),
          dio: Dio(),
        ),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          allOf(contains('reranker API error 400'), contains('[REDACTED]')),
        )),
      );
    });

    test('scores 格式端到端：按 index 映射', () async {
      final server = await _serveJson({
        'scores': [0.1, 0.9],
      });
      addTearDown(() async => server.close(force: true));

      final result = await rerankDocuments(
        '查询',
        const [
          RerankDocument(id: 'a', text: '甲'),
          RerankDocument(id: 'b', text: '乙'),
        ],
        RerankerAdapterConfig(
          apiBase: 'http://127.0.0.1:${server.port}',
          model: 'rerank-model',
        ),
        dio: Dio(),
      );
      expect(result.length, 2);
      expect(result[0].id, 'a');
      expect(result[1].id, 'b');
      expect(result[1].score, closeTo(0.9, 1e-9));
    });
  });
}
