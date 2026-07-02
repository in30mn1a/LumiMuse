// RC-1：本文件涉及 SSE 转发/多订阅分支时必须能 grep 到 SafeStreamSink（预留）。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:dio/dio.dart';

import '../database/database.dart';
import '../utils/sanitize.dart';

/// 不可恢复 embedding 错误最多重试次数。
/// 对齐主项目 memory-embeddings.ts:65 `MAX_RECOVERABLE_EMBEDDING_ATTEMPTS`。
const int maxRecoverableEmbeddingAttempts = 3;

/// 可恢复 embedding 错误的重试退避时长（毫秒）。
/// 对齐主项目 memory-embeddings.ts:66 `RECOVERABLE_EMBEDDING_RETRY_DELAY_MS`。
const int recoverableEmbeddingRetryDelayMs = 30000;

/// 向量检索单批拉取上限。
/// 对齐主项目 memory-embeddings.ts:69 `VECTOR_RETRIEVAL_CANDIDATE_LIMIT`。
const int vectorRetrievalCandidateLimit = 500;

/// 向量检索总扫描上限。
/// 对齐主项目 memory-embeddings.ts:70 `VECTOR_RETRIEVAL_SCAN_LIMIT`。
const int vectorRetrievalScanLimit = 5000;

/// 嵌入适配器配置 — 对齐主项目 `EmbeddingAdapterConfig`（memory-embeddings.ts:12-20）。
class EmbeddingAdapterConfig {
  final String? apiBase;
  final String? apiKey;
  final String? model;
  final int? dimension;
  final int? timeoutMs;
  final String? provider;

  const EmbeddingAdapterConfig({
    this.apiBase,
    this.apiKey,
    this.model,
    this.dimension,
    this.timeoutMs,
    this.provider,
  });

  /// 便捷拷贝（不暴露每个字段的命名构造在测试里更好用）
  EmbeddingAdapterConfig copyWith({
    String? apiBase,
    String? apiKey,
    String? model,
    int? dimension,
    int? timeoutMs,
    String? provider,
  }) =>
      EmbeddingAdapterConfig(
        apiBase: apiBase ?? this.apiBase,
        apiKey: apiKey ?? this.apiKey,
        model: model ?? this.model,
        dimension: dimension ?? this.dimension,
        timeoutMs: timeoutMs ?? this.timeoutMs,
        provider: provider ?? this.provider,
      );
}

/// 一行 ready embedding，附带可读 blob 的抽象。
/// Dart 没有结构化接口，[rankEmbeddingRows] 通过该回调取 blob，
/// 对齐 TS 泛型 `T extends { embedding_blob: Buffer | Uint8Array }`。
typedef EmbeddingBlobExtractor<T> = Uint8List Function(T row);

/// 带相似度排序后的结果条目。
class RankedEmbeddingRow<T> {
  final T row;
  final double similarity;
  const RankedEmbeddingRow(this.row, this.similarity);
}

/// L2 归一化向量。
/// 对齐主项目 memory-embeddings.ts:122-142 `normalizeEmbedding`：
/// - 任一元素非 finite 抛错；
/// - norm=0 时原样返回（零向量归一化无定义，按原样返回避免 NaN）。
Float32List normalizeEmbedding(List<double> vector) {
  final result = Float32List(vector.length);
  double sumSquares = 0;
  for (var i = 0; i < vector.length; i += 1) {
    final value = vector[i];
    if (!value.isFinite) {
      throw StateError('embedding contains non-finite values');
    }
    result[i] = value;
    sumSquares += value * value;
  }
  final norm = math.sqrt(sumSquares);
  if (norm == 0) return result;
  for (var i = 0; i < result.length; i += 1) {
    result[i] = result[i] / norm;
  }
  return result;
}

/// 把向量序列化为 4 字节小端 float blob。
/// 对齐主项目 memory-embeddings.ts:144-150 `embeddingToBlob`。
Uint8List embeddingToBlob(List<double> vector) {
  final blob = Uint8List(vector.length * 4);
  final data = ByteData.view(blob.buffer);
  for (var i = 0; i < vector.length; i += 1) {
    data.setFloat32(i * 4, vector[i], Endian.little);
  }
  return blob;
}

/// 把 4 字节小端 float blob 反序列化为向量。
/// 对齐主项目 memory-embeddings.ts:152-165 `blobToEmbedding`：
/// - 字节数必须能被 4 整除，否则抛错。
Float32List blobToEmbedding(Uint8List blob) {
  if (blob.lengthInBytes % 4 != 0) {
    throw StateError('embedding blob byte length must be divisible by 4');
  }
  final data = ByteData.view(blob.buffer, blob.offsetInBytes, blob.lengthInBytes);
  final vector = Float32List(blob.lengthInBytes ~/ 4);
  for (var i = 0; i < vector.length; i += 1) {
    vector[i] = data.getFloat32(i * 4, Endian.little);
  }
  return vector;
}

/// 点积。维度不等抛错。
/// 对齐主项目 memory-embeddings.ts:167-177 `dotProduct`。
double dotProduct(List<double> a, List<double> b) {
  if (a.length != b.length) {
    throw StateError(
        'embedding dimension mismatch: ${a.length} vs ${b.length}');
  }
  double total = 0;
  for (var i = 0; i < a.length; i += 1) {
    total += a[i] * b[i];
  }
  return total;
}

/// 用查询向量对候选行排序，返回相似度降序前 [limit] 条。
/// 对齐主项目 memory-embeddings.ts:179-199 `rankEmbeddingRows`：
/// - normalize query；
/// - 每行 blobToEmbedding + 维度匹配过滤 + dotProduct 打分；
/// - 单行解析/打分抛错时跳过该行（不冒泡）；
/// - 按 similarity 降序取前 [limit] 条（limit<=0 返回空）。
List<RankedEmbeddingRow<T>> rankEmbeddingRows<T>(
  List<double> queryEmbedding,
  List<T> rows,
  int limit,
  EmbeddingBlobExtractor<T> extractBlob,
) {
  final normalizedQuery = normalizeEmbedding(queryEmbedding);
  final scored = <RankedEmbeddingRow<T>>[];
  for (final row in rows) {
    try {
      final embedding = blobToEmbedding(extractBlob(row));
      if (embedding.length != normalizedQuery.length) continue;
      // dotProduct 这里两向量长度已相等，不会抛维度错
      final sim = dotProduct(
        normalizedQuery.toList(),
        embedding.toList(),
      );
      scored.add(RankedEmbeddingRow(row, sim));
    } catch (_) {
      continue;
    }
  }
  scored.sort((a, b) => b.similarity.compareTo(a.similarity));
  final n = limit < 0 ? 0 : limit;
  if (scored.length <= n) return scored;
  return scored.sublist(0, n);
}

/// 构造送给嵌入模型的文本。
/// 对齐主项目 memory-embeddings.ts:201-208 `buildMemoryEmbeddingText`：
/// `分类：${category}\n内容：${content}\n标签：${tags.join('、')}`，
/// tags 为空时省略标签行（join 后空字符串等同空）。
String buildMemoryEmbeddingText(Memory memory) {
  final lines = <String>['分类：${memory.category}', '内容：${memory.content}'];
  final tags = _parseTags(memory.tags);
  final joined = tags.where((t) => t.isNotEmpty).join('、');
  if (joined.isNotEmpty) lines.add('标签：$joined');
  return lines.join('\n');
}

List<String> _parseTags(String tagsJson) {
  try {
    final decoded = jsonDecode(tagsJson);
    if (decoded is List) return decoded.whereType<String>().toList();
  } catch (_) {}
  return [];
}

/// SHA-256 hex。对齐主项目 memory-embeddings.ts:210-212 `hashEmbeddingText`。
String hashEmbeddingText(String text) {
  return crypto.sha256.convert(utf8.encode(text)).toString();
}

/// 嵌入端点归一化：去尾斜杠，不以 `/embeddings` 结尾则追加。
/// 对齐主项目 memory-embeddings.ts:214-218 `normalizeEmbeddingEndpoint`。
String normalizeEmbeddingEndpoint(String apiBase) {
  final trimmed = apiBase.trim().replaceAll(RegExp(r'/+$'), '');
  if (trimmed.endsWith('/embeddings')) return trimmed;
  return '$trimmed/embeddings';
}

/// 解析单条嵌入响应。
/// 对齐主项目 memory-embeddings.ts:220-228 `parseEmbeddingResponse`：
/// 取 `data[0].embedding ?? record.embedding`，逐元素 `Number` 化，缺数组抛错。
List<double> parseEmbeddingResponse(Object? data) {
  final record = data is Map<String, dynamic> ? data : <String, dynamic>{};
  final dataList = record['data'];
  Map<String, dynamic>? first;
  if (dataList is List && dataList.isNotEmpty) {
    final head = dataList.first;
    if (head is Map<String, dynamic>) first = head;
  }
  final embedding = first?['embedding'] ?? record['embedding'];
  if (embedding is! List) {
    throw StateError('embedding response missing data[0].embedding');
  }
  return embedding.map((e) => (e as num).toDouble()).toList();
}

/// 解析批量嵌入响应。
/// 对齐主项目 memory-embeddings.ts:230-249 `parseEmbeddingBatchResponse`：
/// - 无 `data` 数组且期望 1 条 → 退化为单条解析；
/// - 否则按 `index` 升序排序、数量校验；
/// - 每条 `embedding` 必须为数组，否则抛错。
List<List<double>> parseEmbeddingBatchResponse(Object? data, int expectedCount) {
  final record = data is Map<String, dynamic> ? data : <String, dynamic>{};
  final dataList = record['data'];
  if (dataList is! List) {
    if (expectedCount == 1) return <List<double>>[parseEmbeddingResponse(data)];
    throw StateError('embedding response missing data array');
  }
  final rows = dataList.whereType<Map<String, dynamic>>().toList();
  rows.sort((a, b) {
    final ai = a['index'];
    final bi = b['index'];
    final an = ai is num ? ai.toInt() : 0;
    final bn = bi is num ? bi.toInt() : 0;
    return an.compareTo(bn);
  });
  final embeddings = rows.map((row) => row['embedding']).toList();
  if (embeddings.length != expectedCount) {
    throw StateError(
        'embedding response count mismatch: expected $expectedCount, got ${embeddings.length}');
  }
  return embeddings.map((embedding) {
    if (embedding is! List) {
      throw StateError('embedding response missing data[].embedding');
    }
    return embedding.map((e) => (e as num).toDouble()).toList();
  }).toList();
}

/// 判断嵌入错误是否可恢复。
/// 对齐主项目 memory-embeddings.ts:76-85 `isRecoverableEmbeddingError`：
/// - timed out / aborted / fetch failed / network；
/// - `econnreset|etimedout|eai_again|und_err_`（大小写不敏感）；
/// - `embedding API error <status>` 中 status=429 或 5xx。
bool isRecoverableEmbeddingError(String message) {
  final lower = message.toLowerCase();
  if (lower.contains('timed out') || lower.contains('aborted')) return true;
  if (lower.contains('fetch failed') || lower.contains('network')) return true;
  if (RegExp(r'econnreset|etimedout|eai_again|und_err_', caseSensitive: false)
      .hasMatch(message)) {
    return true;
  }
  final statusMatch =
      RegExp(r'embedding API error\s+(\d{3})', caseSensitive: false)
          .firstMatch(message);
  if (statusMatch == null) return false;
  final code = int.tryParse(statusMatch.group(1) ?? '');
  if (code == null) return false;
  return code == 429 || code >= 500;
}

String _embeddingErrorMessage(Object error) =>
    error is Exception ? error.toString() : error.toString();

/// 嵌入服务 — 向量工具 + HTTP 嵌入入口。
///
/// 对齐主项目 src/lib/memory-embeddings.ts 的纯函数工具（normalize/blob/dot/rank）
/// 与 `embedText`/`embedTexts` HTTP 入口。Dio 注入便于测试 mock。
class MemoryEmbeddingsService {
  final Dio _dio;

  MemoryEmbeddingsService({Dio? dio})
      : _dio = dio ??
            Dio(BaseOptions(
              connectTimeout: const Duration(seconds: 30),
              receiveTimeout: const Duration(minutes: 5),
              sendTimeout: const Duration(seconds: 60),
            ));

  /// 嵌入单条文本。
  /// 对齐主项目 memory-embeddings.ts:251-311 + 305-311 `embedText`：
  /// - apiBase/model 缺失抛错；
  /// - timeout = max(1, timeoutMs ?? 1500)；
  /// - body `{model, input, encoding_format:'float', 可选 dimensions}`；
  /// - 错误经 [sanitizeUpstreamError] 脱敏；
  /// - 响应解析后归一化；dimension 校验（显式配置时）。
  Future<List<double>> embedText(
    String input,
    EmbeddingAdapterConfig config,
  ) async {
    final vector = normalizeEmbedding(
        parseEmbeddingResponse(await _requestEmbeddings(input, config)));
    if (config.dimension != null &&
        config.dimension! > 0 &&
        vector.length != config.dimension) {
      throw StateError(
          'embedding dimension mismatch: expected ${config.dimension}, got ${vector.length}');
    }
    return vector.toList();
  }

  /// 批量嵌入文本。
  /// 对齐主项目 memory-embeddings.ts:313-323 `embedTexts`：
  /// - 空输入返回空列表；
  /// - 解析后逐条归一化 + dimension 校验。
  Future<List<List<double>>> embedTexts(
    List<String> inputs,
    EmbeddingAdapterConfig config,
  ) async {
    if (inputs.isEmpty) return const <List<double>>[];
    final data = await _requestEmbeddings(inputs, config);
    final parsed = parseEmbeddingBatchResponse(data, inputs.length);
    final out = <List<double>>[];
    for (var i = 0; i < parsed.length; i += 1) {
      final vector = normalizeEmbedding(parsed[i]);
      if (config.dimension != null &&
          config.dimension! > 0 &&
          vector.length != config.dimension) {
        throw StateError(
            'embedding dimension mismatch at index $i: expected ${config.dimension}, got ${vector.length}');
      }
      out.add(vector.toList());
    }
    return out;
  }

  /// 统一的嵌入 HTTP 请求。对齐主项目 memory-embeddings.ts:251-303 `requestEmbeddings`。
  Future<Object?> _requestEmbeddings(
    Object input, // String 或 List<String>
    EmbeddingAdapterConfig config,
  ) async {
    final apiBase = config.apiBase?.trim();
    final model = config.model?.trim();
    if (apiBase == null || apiBase.isEmpty) {
      throw StateError('embedding api_base is required');
    }
    if (model == null || model.isEmpty) {
      throw StateError('embedding model is required');
    }
    final timeoutMs = math.max(1, config.timeoutMs ?? 1500);

    final body = <String, dynamic>{
      'model': model,
      'input': input,
      'encoding_format': 'float',
    };
    if (config.dimension != null && config.dimension! > 0) {
      body['dimensions'] = config.dimension;
    }

    final headers = <String, dynamic>{
      'Content-Type': 'application/json',
    };
    if (config.apiKey != null && config.apiKey!.isNotEmpty) {
      headers['Authorization'] = 'Bearer ${config.apiKey}';
    }

    try {
      final response = await _dio.post(
        normalizeEmbeddingEndpoint(apiBase),
        data: body,
        options: Options(
          headers: headers,
          sendTimeout: Duration(milliseconds: timeoutMs),
          receiveTimeout: Duration(milliseconds: timeoutMs),
        ),
      );
      final status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        final raw = response.data?.toString() ?? '';
        throw StateError(sanitizeUpstreamError(
            'embedding API error $status: ${raw.length > 200 ? raw.substring(0, 200) : raw}'));
      }
      return response.data;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.sendTimeout ||
          e.type == DioExceptionType.receiveTimeout) {
        throw StateError('embedding request timed out after ${timeoutMs}ms');
      }
      final status = e.response?.statusCode;
      if (status != null) {
        final raw = e.response?.data?.toString() ?? '';
        throw StateError(sanitizeUpstreamError(
            'embedding API error $status: ${raw.length > 200 ? raw.substring(0, 200) : raw}'));
      }
      throw StateError(sanitizeUpstreamError(_embeddingErrorMessage(e)));
    }
  }

  /// 关闭底层 Dio。仅在调用方持有实例时调用；Provider 单例由 ref.onDispose 触发。
  void dispose() => _dio.close();
}
