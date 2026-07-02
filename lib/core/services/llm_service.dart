import 'dart:async';
import 'package:dio/dio.dart';
import '../models/app_settings.dart';
import '../utils/sanitize.dart';
import 'sse_parser.dart';

/// LLM API 消息格式
class ChatMessage {
  final String role; // system / user / assistant
  final dynamic content; // String 或 List（多模态）

  const ChatMessage({required this.role, required this.content});

  Map<String, dynamic> toJson() => {'role': role, 'content': content};
}

/// 流式回调
typedef OnChunkCallback = void Function(String text);
typedef OnDoneCallback = Future<void> Function(String fullText);
typedef OnErrorCallback = void Function(String error);

/// usage 上报回调 — 上游返回 token 用量时触发。
///
/// 流式响应仅在最后一个 chunk 携带 usage（需请求体带
/// `stream_options.include_usage = true`）；非流式响应在 body.usage 返回。
/// 上游未返回 usage 时不会调用，调用方应保留原有 token 估算作为 fallback。
typedef OnUsageCallback = void Function(LlmUsage usage);

/// LLM 上游返回的 token 用量统计（对齐主项目 `api-client.ts` 的 `LlmUsage`）。
///
/// OpenAI 兼容协议下，非流式响应直接在 `body.usage` 返回；
/// 流式响应需要请求体带 `stream_options: { include_usage: true }`，
/// 上游会在最后一个 chunk（`choices` 为空数组）里附带 usage。
///
/// 不同上游可能额外返回 `prompt_cache_hit_tokens` 等字段，
/// 这里只保留跨上游通用的三个核心字段。
class LlmUsage {
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;

  const LlmUsage({
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
  });

  factory LlmUsage.fromJson(Map<String, dynamic> json) {
    return LlmUsage(
      promptTokens: json['prompt_tokens'] as int,
      completionTokens: json['completion_tokens'] as int,
      totalTokens: json['total_tokens'] as int,
    );
  }

  /// 序列化为原始 usage 形式，便于存入 MessageMetadata.lastUsage（解耦、不依赖本类）。
  Map<String, dynamic> toJson() => {
        'prompt_tokens': promptTokens,
        'completion_tokens': completionTokens,
        'total_tokens': totalTokens,
      };
}

/// 从 SSE chunk 的 raw JSON 中提取 usage 字段（若存在）。
///
/// 对齐主项目 `api-client.ts` 第 73-86 行 `extractUsageFromChunk`：
/// - `raw` 非 Map 或无 `usage` 字段 → 返回 null；
/// - `prompt_tokens` / `completion_tokens` 非 finite → 返回 null；
/// - `total_tokens` 非 finite → 回退为 `prompt + completion`。
LlmUsage? extractUsageFromChunk(Map<String, dynamic> raw) {
  final usage = raw['usage'];
  if (usage is! Map) return null;
  final promptRaw = usage['prompt_tokens'];
  final completionRaw = usage['completion_tokens'];
  final totalRaw = usage['total_tokens'];
  final prompt = promptRaw is num ? promptRaw.toDouble() : double.nan;
  final completion =
      completionRaw is num ? completionRaw.toDouble() : double.nan;
  if (!prompt.isFinite || !completion.isFinite) return null;
  final total = totalRaw is num ? totalRaw.toDouble() : double.nan;
  return LlmUsage(
    promptTokens: prompt.toInt(),
    completionTokens: completion.toInt(),
    totalTokens: total.isFinite ? total.toInt() : (prompt + completion).toInt(),
  );
}

/// 模型列表拉取失败。
class FetchModelsException implements Exception {
  final String message;

  const FetchModelsException(this.message);

  @override
  String toString() => message;
}

/// 模型列表缓存后端 — 便于测试替换为内存实现。
///
/// `LlmService` 是纯 Service，按架构约定不直接依赖 `AppDatabase`，
/// 故以该抽象隔离缓存读写。生产实现见 `DriftModelCacheBackend`，
/// 测试可注入内存版本。`null` 表示不启用缓存（行为同旧）。
abstract class ModelCacheBackend {
  /// 读取某 apiBase 的缓存条目；无缓存返回 null。
  Future<({List<String> models, DateTime cachedAt})?> read(String apiBase);

  /// 写入（upsert）某 apiBase 的模型列表与缓存时间。
  Future<void> write(String apiBase, List<String> models, DateTime cachedAt);
}

/// 用户或调用方主动取消 LLM 请求。
class LlmRequestCancelledException implements Exception {
  final String message;

  const LlmRequestCancelledException([this.message = 'LLM 请求已取消']);

  @override
  String toString() => message;
}

/// LLM 服务 — 负责与 OpenAI 兼容 API 通信
class LlmService {
  final Dio _dio;

  /// 模型列表缓存后端；null 表示不启用缓存（向后兼容旧调用方与测试）。
  final ModelCacheBackend? _modelCache;

  /// 模型列表缓存有效期，对齐主项目 `api/models/route.ts` 的 CACHE_TTL_MS。
  static const Duration _modelCacheTtl = Duration(minutes: 30);

  LlmService({Dio? dio, ModelCacheBackend? modelCache})
      : _dio = dio ?? Dio(_defaultOptions()),
        _modelCache = modelCache;

  static BaseOptions _defaultOptions() {
    return BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      // LLM 流式响应可能较长（思考链 / 长文本输出），给到 5 分钟
      receiveTimeout: const Duration(minutes: 5),
      sendTimeout: const Duration(seconds: 60),
    );
  }

  static String _sanitizeForDisplay(Object error) {
    if (error is DioException) {
      final status = error.response?.statusCode;
      final statusText = status == null ? '网络失败' : status.toString();
      final message = error.message == null
          ? ''
          : ': ${sanitizeUpstreamError(error.message!)}';
      return '$statusText$message';
    }
    return sanitizeUpstreamError(error.toString());
  }

  static String? _extractStreamDelta(Map<String, dynamic> json) {
    final choices = json['choices'];
    if (choices is! List || choices.isEmpty) return null;

    final firstChoice = choices.first;
    if (firstChoice is! Map) return null;

    final delta = firstChoice['delta'];
    if (delta is! Map) return null;

    final content = delta['content'];
    return content is String ? content : null;
  }

  /// 流式聊天补全
  Future<void> chatCompletionStream({
    required AppSettings settings,
    required List<ChatMessage> messages,
    required OnChunkCallback onChunk,
    required OnDoneCallback onDone,
    required OnErrorCallback onError,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    try {
      final body = <String, dynamic>{
        'model': settings.model,
        'messages': messages.map((m) => m.toJson()).toList(),
        'max_tokens': settings.maxTokens,
        'temperature': settings.temperature,
        'stream': true,
        // OpenAI 协议：流式默认不返回 usage，需显式开启。
        // 兼容上游会忽略未知字段，不支持的也不会报错；
        // 支持的上游会在最后一个 chunk（choices 为空数组）附带 usage。
        'stream_options': {'include_usage': true},
      };

      if (settings.jsonMode) {
        body['response_format'] = {'type': 'json_object'};
      }

      final response = await _dio.post(
        '${settings.apiBase}/chat/completions',
        data: body,
        options: Options(
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ${settings.apiKey}',
          },
          responseType: ResponseType.stream,
        ),
        cancelToken: cancelToken,
      );

      final stream = response.data.stream as Stream<List<int>>;
      final parser = SseParser();
      // 使用 StringBuffer 替代 += 拼接，避免 O(n²) 复杂度
      final fullTextBuffer = StringBuffer();
      // 捕获最后一个 chunk 的 usage；流正常结束时通过 onUsage 回调上报。
      // abort/cancel 路径不上报 usage（对齐主项目 api-client.ts 第 148/183 行）。
      LlmUsage? capturedUsage;

      await for (final chunk in stream) {
        if (cancelToken?.isCancelled ?? false) return;

        for (final json in parser.parseChunk(chunk)) {
          final delta = _extractStreamDelta(json);
          if (delta != null && delta.isNotEmpty) {
            fullTextBuffer.write(delta);
            onChunk(delta);
          }
          // usage 只在最后一个 chunk 出现，每次都尝试提取，后到的覆盖先到的
          final usage = extractUsageFromChunk(json);
          if (usage != null) {
            capturedUsage = usage;
          }
        }
      }

      for (final json in parser.flush()) {
        final delta = _extractStreamDelta(json);
        if (delta != null && delta.isNotEmpty) {
          fullTextBuffer.write(delta);
          onChunk(delta);
        }
        final usage = extractUsageFromChunk(json);
        if (usage != null) {
          capturedUsage = usage;
        }
      }

      if (!(cancelToken?.isCancelled ?? false)) {
        // 正常结束：先上报 usage（若有），再触发 onDone（对齐主项目第 186-193 行）
        if (capturedUsage != null && onUsage != null) {
          try {
            onUsage(capturedUsage);
          } catch (_) {
            // usage 上报失败不应影响主流程
          }
        }
        // FIX(Major-1): 把 onDone 回调单独包一层 try/catch，
        // 与流式接收阶段的网络/解析错误区分开。
        // 旧实现 onDone 抛业务异常会被外层泛型 `catch (e)` 捕获、
        // 用 `e.toString()` 上报，调用方无法分辨"流读完后保存消息失败"
        // 与"网络中途断开"两类语义。这里固定加上"完成回调失败:"前缀
        // 以便上层 UI / 日志做区分；同时显式 return 终止函数，避免
        // 异常继续冒泡到外层的网络分支再触发一次 onError。
        try {
          await onDone(fullTextBuffer.toString());
        } catch (e) {
          onError(sanitizeUpstreamError('完成回调失败: $e'));
          return;
        }
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) return;
      onError(sanitizeUpstreamError(e.message ?? '网络请求失败'));
    } catch (e) {
      onError(sanitizeUpstreamError(e.toString()));
    }
  }

  /// 非流式聊天补全
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    try {
      final body = <String, dynamic>{
        'model': settings.model,
        'messages': messages.map((m) => m.toJson()).toList(),
        'max_tokens': settings.maxTokens,
        'temperature': settings.temperature,
        'stream': false,
      };

      if (settings.jsonMode) {
        body['response_format'] = {'type': 'json_object'};
      }

      final response = await _dio.post(
        '${settings.apiBase}/chat/completions',
        data: body,
        options: Options(
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ${settings.apiKey}',
          },
        ),
        cancelToken: cancelToken,
      );

      final choice = response.data['choices']?[0];
      final content = choice?['message']?['content'] as String? ?? '';
      if (content.trim().isEmpty) {
        final reason = choice?['finish_reason'] as String?;
        final hasReasoning = choice?['message']?['reasoning_content'] != null;
        if (reason == 'length' && hasReasoning) {
          throw Exception(
            '推理模型思考消耗了全部 token，最终未生成内容。请增大 max_tokens（建议 ≥16384）',
          );
        }
        throw Exception('LLM 返回了空内容，请检查模型是否支持当前请求格式');
      }
      // 非流式响应直接在 body.usage 返回；提取后通过回调上报（对齐主项目第 247-256 行）
      if (onUsage != null) {
        final usage = extractUsageFromChunk(
          response.data as Map<String, dynamic>,
        );
        if (usage != null) {
          try {
            onUsage(usage);
          } catch (_) {
            // usage 上报失败不应影响主流程
          }
        }
      }
      return content;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        throw const LlmRequestCancelledException();
      }
      throw Exception('API 错误: ${_sanitizeForDisplay(e)}');
    }
  }

  /// 获取可用模型列表。
  ///
  /// 流程对齐主项目 `api/models/route.ts` 的 `handle`：
  /// 1. `!forceRefresh` 且启用缓存 → 先读缓存，命中（未过期）直接返回；
  /// 2. 未命中 / 无缓存 / `forceRefresh` → `GET {apiBase}/models` 拉取并排序；
  /// 3. 拉取成功且启用缓存 → upsert 写入缓存；
  /// 4. 拉取失败且启用缓存 → 尝试返回旧缓存（吞掉错误，对齐主项目
  ///    「网络错误，显示上次缓存」）；无旧缓存则抛 `FetchModelsException`。
  ///
  /// 未注入缓存后端（`modelCache == null`）时行为同旧：每次实时拉取，失败抛错。
  Future<List<String>> fetchModels({
    required String apiBase,
    required String apiKey,
    bool forceRefresh = false,
  }) async {
    // 1. 读缓存：命中且未过期直接返回，跳过网络请求。
    if (!forceRefresh && _modelCache != null) {
      final cache = _modelCache;
      try {
        final cached = await cache.read(apiBase);
        if (cached != null &&
            DateTime.now().difference(cached.cachedAt) < _modelCacheTtl) {
          return cached.models;
        }
      } catch (_) {
        // 缓存读异常不应阻塞拉取；按未命中处理。
      }
    }

    // 2. 拉取最新列表。
    try {
      final response = await _dio.get(
        '$apiBase/models',
        options: Options(headers: {'Authorization': 'Bearer $apiKey'}),
      );

      final responseData = response.data;
      if (responseData is! Map) {
        throw const FormatException('模型列表响应不是 JSON 对象');
      }

      // 兼容 OpenAI `data.data` 与部分上游的 `data.models` 两种结构。
      final data = responseData['data'] ?? responseData['models'];
      if (data == null) {
        // 上游 200 但 body 无 data/models 字段属异常格式，不应把空列表落库
        // 覆盖此前有效缓存（否则下次失败回退会返回空而非上次有效列表）。
        return const <String>[];
      }
      if (data is! List) {
        throw const FormatException('模型列表 data 字段不是数组');
      }

      final models = data
          .map((m) => m is Map ? (m['id'] as String? ?? '') : '')
          .where((id) => id.isNotEmpty)
          .toList()
        ..sort();

      // 3. 写缓存（拉取成功才写，避免把空/异常结果落库覆盖好缓存）。
      await _writeCacheSafe(apiBase, models);
      return models;
    } catch (e) {
      // 4. 失败回退：尝试旧缓存（无论多旧）。
      final cache = _modelCache;
      if (cache != null) {
        try {
          final stale = await cache.read(apiBase);
          if (stale != null) {
            // 吞掉错误，对齐主项目「网络错误，显示上次缓存」。
            return stale.models;
          }
        } catch (_) {
          // 旧缓存读异常也忽略，继续抛错。
        }
      }
      throw FetchModelsException('模型列表拉取失败: ${_sanitizeForDisplay(e)}');
    }
  }

  /// 安全写缓存：未注入后端或写异常时静默忽略，不阻塞主流程。
  Future<void> _writeCacheSafe(String apiBase, List<String> models) async {
    final cache = _modelCache;
    if (cache == null) return;
    try {
      await cache.write(apiBase, models, DateTime.now());
    } catch (_) {
      // 缓存写异常不影响拉取结果返回。
    }
  }

  void dispose() {
    _dio.close();
  }
}
