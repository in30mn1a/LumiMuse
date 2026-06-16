import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../services/llm_service.dart';

/// 全局复用的 LLM 服务实例。
final llmServiceProvider = Provider<LlmService>((ref) {
  final service = LlmService();
  ref.onDispose(service.dispose);
  return service;
});
