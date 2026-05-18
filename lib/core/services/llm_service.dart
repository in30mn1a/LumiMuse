import 'dart:async';
import 'package:dio/dio.dart';
import '../models/app_settings.dart';
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

/// LLM 服务 — 负责与 OpenAI 兼容 API 通信
class LlmService {
  final Dio _dio;

  LlmService() : _dio = Dio();

  /// 流式聊天补全
  Future<void> chatCompletionStream({
    required AppSettings settings,
    required List<ChatMessage> messages,
    required OnChunkCallback onChunk,
    required OnDoneCallback onDone,
    required OnErrorCallback onError,
    CancelToken? cancelToken,
  }) async {
    try {
      final response = await _dio.post(
        '${settings.apiBase}/chat/completions',
        data: {
          'model': settings.model,
          'messages': messages.map((m) => m.toJson()).toList(),
          'max_tokens': settings.maxTokens,
          'temperature': settings.temperature,
          'stream': true,
        },
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
      String fullText = '';

      await for (final chunk in stream) {
        if (cancelToken?.isCancelled ?? false) return;

        for (final json in parser.parseChunk(chunk)) {
          final choices = json['choices'] as List?;
          if (choices == null || choices.isEmpty) continue;
          final delta = choices[0]?['delta']?['content'] as String?;
          if (delta != null && delta.isNotEmpty) {
            fullText += delta;
            onChunk(delta);
          }
        }
      }

      for (final json in parser.flush()) {
        final choices = json['choices'] as List?;
        if (choices == null || choices.isEmpty) continue;
        final delta = choices[0]?['delta']?['content'] as String?;
        if (delta != null && delta.isNotEmpty) {
          fullText += delta;
          onChunk(delta);
        }
      }

      if (!(cancelToken?.isCancelled ?? false)) {
        await onDone(fullText);
      }
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) return;
      onError(e.message ?? '网络请求失败');
    } catch (e) {
      onError(e.toString());
    }
  }

  /// 非流式聊天补全
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
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

      return response.data['choices']?[0]?['message']?['content'] as String? ?? '';
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) return '';
      throw Exception('API 错误: ${e.response?.statusCode ?? "网络失败"} - ${e.message}');
    }
  }

  /// 获取可用模型列表
  Future<List<String>> fetchModels({
    required String apiBase,
    required String apiKey,
  }) async {
    try {
      final response = await _dio.get(
        '$apiBase/models',
        options: Options(
          headers: {'Authorization': 'Bearer $apiKey'},
        ),
      );

      final data = response.data['data'] as List?;
      if (data == null) return [];

      return data
          .map((m) => m['id'] as String? ?? '')
          .where((id) => id.isNotEmpty)
          .toList()
        ..sort();
    } catch (_) {
      return [];
    }
  }

  void dispose() {
    _dio.close();
  }
}
