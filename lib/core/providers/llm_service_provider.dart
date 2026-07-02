import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../services/llm_service.dart';
import '../services/model_cache_service.dart';

/// 全局复用的 LLM 服务实例。
///
/// 默认注入 `modelCacheBackendProvider`，让 `fetchModels` 启用 30min TTL 缓存 +
/// 失败回退旧缓存（对齐主项目 `api/models/route.ts`）。测试如需不缓存行为，
/// 直接 `LlmService()`（`modelCache` 默认 null）或 override 本 provider。
final llmServiceProvider = Provider<LlmService>((ref) {
  final service = LlmService(
    modelCache: ref.read(modelCacheBackendProvider),
  );
  ref.onDispose(service.dispose);
  return service;
});
