// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:math' as math;

import 'package:dio/dio.dart';

import '../utils/sanitize.dart';

/// 重排适配器配置 — 对齐主项目 `RerankerAdapterConfig`（memory-reranker.ts:3-9）。
///
/// Dart 端不暴露 TS 的 `AbortSignal signal`（Dio 用 receiveTimeout/sendTimeout
/// 兜底超时，无对应 abort signal 注入点）；其余字段对齐。
class RerankerAdapterConfig {
  final String? apiBase;
  final String? apiKey;
  final String? model;
  final int? timeoutMs;

  const RerankerAdapterConfig({
    this.apiBase,
    this.apiKey,
    this.model,
    this.timeoutMs,
  });
}

/// 待重排文档 — 对齐主项目 `RerankDocument`（memory-reranker.ts:11-14）。
class RerankDocument {
  final String id;
  final String text;
  const RerankDocument({required this.id, required this.text});
}

/// 重排结果条目 — 对齐主项目 `RerankResult`（memory-reranker.ts:16-19）。
class RerankResult {
  final String id;
  final double score;
  const RerankResult({required this.id, required this.score});
}

/// 重排端点归一化：trim + 去尾 `/+` + 不以 `/rerank` 结尾则追加。
/// 对齐主项目 memory-reranker.ts:21-25 `normalizeRerankEndpoint`。
String normalizeRerankEndpoint(String apiBase) {
  final trimmed = apiBase.trim().replaceAll(RegExp(r'/+$'), '');
  if (trimmed.endsWith('/rerank')) return trimmed;
  return '$trimmed/rerank';
}

/// 解析分值为 double；非有限数返回 null。
/// 对齐主项目 memory-reranker.ts:27-30 `parseScore`（`Number.isFinite` 判定）。
double? _parseScore(dynamic value) {
  if (value is num) {
    final d = value.toDouble();
    return d.isFinite ? d : null;
  }
  return null;
}

/// 解析重排响应，对齐主项目 memory-reranker.ts:32-60 `parseRerankerResponse`。
///
/// 三种格式按优先级处理：
/// 1. `record.scores` 是数组 → 按 index 映射 `documents[index]?.id` + parseScore，
///    过滤 id 非空且 score 非 null；
/// 2. 否则 `rawResults = record.results ?? record.data ?? []`，逐项取
///    `index = Number(row.index ?? row.document_index)`，id 取 `row.id`（字符串）
///    或 `documents[index]?.id`，score 取 `row.relevance_score ?? row.score`，
///    id 与 score 均非空才收。
List<RerankResult> parseRerankerResponse(
  dynamic data,
  List<RerankDocument> documents,
) {
  final record = data is Map<String, dynamic> ? data : <String, dynamic>{};

  // 格式1：record.scores 数组
  final scores = record['scores'];
  if (scores is List) {
    final out = <RerankResult>[];
    for (var i = 0; i < scores.length; i += 1) {
      final id = i < documents.length ? documents[i].id : null;
      final score = _parseScore(scores[i]);
      if (id != null && id.isNotEmpty && score != null) {
        out.add(RerankResult(id: id, score: score));
      }
    }
    return out;
  }

  // 格式2/3：record.results 或 record.data 数组
  final rawResults = record['results'] is List
      ? record['results'] as List
      : (record['data'] is List ? record['data'] as List : const []);

  final results = <RerankResult>[];
  for (final item in rawResults) {
    if (item is! Map<String, dynamic>) continue;
    final row = item;
    final indexRaw = row['index'] ?? row['document_index'];
    final index = indexRaw is num ? indexRaw.toInt() : -1;
    final rawId = row['id'];
    final id = rawId is String
        ? rawId
        : (index >= 0 && index < documents.length ? documents[index].id : null);
    final score = _parseScore(row['relevance_score'] ?? row['score']);
    if (id != null && id.isNotEmpty && score != null) {
      results.add(RerankResult(id: id, score: score));
    }
  }
  return results;
}

/// 调用重排 API 对文档按与 query 的相关性重新排序。
/// 对齐主项目 memory-reranker.ts:62-110 `rerankDocuments`：
/// - 空 documents 直接返回空列表；
/// - apiBase/model 缺失抛错；
/// - timeout = max(1, timeoutMs ?? 2000)（Dio 用 receiveTimeout/sendTimeout 兜底，
///   对齐主项目 AbortController 超时）；
/// - POST normalizeRerankEndpoint(apiBase)，header `Content-Type: application/json`
///   + 可选 `Authorization: Bearer ${apiKey}`；
/// - body `{model, query, documents: documents.map(text)}`；
/// - 非 2xx 抛 `reranker API error <status>: <errorText 前 200 字符>`；
/// - 错误经 [sanitizeUpstreamError] 脱敏；返回 [parseRerankerResponse]。
///
/// Dio 注入便于测试 mock（对齐项目 Service 依赖注入约定）。
Future<List<RerankResult>> rerankDocuments(
  String query,
  List<RerankDocument> documents,
  RerankerAdapterConfig config, {
  Dio? dio,
}) async {
  if (documents.isEmpty) return const <RerankResult>[];

  final apiBase = config.apiBase?.trim();
  final model = config.model?.trim();
  if (apiBase == null || apiBase.isEmpty) {
    throw Exception('reranker api_base is required');
  }
  if (model == null || model.isEmpty) {
    throw Exception('reranker model is required');
  }

  final timeoutMs = math.max(1, config.timeoutMs ?? 2000);
  final client = dio ??
      Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: Duration(milliseconds: timeoutMs),
        sendTimeout: Duration(milliseconds: timeoutMs),
      ));

  final headers = <String, dynamic>{
    'Content-Type': 'application/json',
  };
  if (config.apiKey != null && config.apiKey!.isNotEmpty) {
    headers['Authorization'] = 'Bearer ${config.apiKey}';
  }

  try {
    final response = await client.post(
      normalizeRerankEndpoint(apiBase),
      data: <String, dynamic>{
        'model': model,
        'query': query,
        'documents': documents.map((d) => d.text).toList(),
      },
      options: Options(
        headers: headers,
        sendTimeout: Duration(milliseconds: timeoutMs),
        receiveTimeout: Duration(milliseconds: timeoutMs),
      ),
    );
    final status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      final raw = response.data?.toString() ?? '';
      final snippet = raw.length > 200 ? raw.substring(0, 200) : raw;
      throw Exception(
          sanitizeUpstreamError('reranker API error $status: $snippet'));
    }
    return parseRerankerResponse(response.data, documents);
  } on DioException catch (e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        e.type == DioExceptionType.receiveTimeout) {
      throw Exception('reranker request timed out after ${timeoutMs}ms');
    }
    final status = e.response?.statusCode;
    if (status != null) {
      final raw = e.response?.data?.toString() ?? '';
      final snippet = raw.length > 200 ? raw.substring(0, 200) : raw;
      throw Exception(
          sanitizeUpstreamError('reranker API error $status: $snippet'));
    }
    throw Exception(sanitizeUpstreamError(e.toString()));
  }
}
