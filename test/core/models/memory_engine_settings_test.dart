// 记忆引擎设置属性测试
// Wave 13.1: MemoryEngineSettings 数据层
// 验证：toJson/fromJson 往返一致性、默认值构造、copyWith、嵌套在 AppSettings 里的序列化

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/models/app_settings.dart';

void main() {
  group('MemoryEngineSettings: 默认值构造', () {
    test('默认构造与主项目 DEFAULT_MEMORY_ENGINE_SETTINGS 一致', () {
      const defaults = MemoryEngineSettings();

      expect(defaults.enabled, false);
      expect(defaults.allowMemoryContextInChat, true);
      expect(defaults.allowExternalMemoryPayloads, true);
      expect(defaults.retrievalMode, 'local');
      expect(defaults.embeddingEnabled, false);
      expect(defaults.embeddingApiBase, '');
      expect(defaults.embeddingApiKey, '');
      expect(defaults.embeddingModel, '');
      expect(defaults.embeddingDimension, 0);
      expect(defaults.rerankerEnabled, false);
      expect(defaults.rerankerApiBase, '');
      expect(defaults.rerankerApiKey, '');
      expect(defaults.rerankerModel, '');
      expect(defaults.fallbackLocalEnabled, true);
      expect(defaults.memoryPackageTokenBudget, 12000);
      expect(defaults.retrievalTokenBudget, 8000);
      expect(defaults.vectorTopK, 80);
      expect(defaults.keywordTopK, 20);
      expect(defaults.rerankerTopK, 40);
      expect(defaults.finalTopK, 30);
      expect(defaults.embeddingTimeoutMs, 1500);
      expect(defaults.rerankerTimeoutMs, 2000);
      expect(defaults.totalRetrievalTimeoutMs, 2500);
    });

    test('toJson 的 key 全部为 snake_case（对齐主项目 DB key）', () {
      const settings = MemoryEngineSettings();
      final json = settings.toJson();

      // 抽查几个 snake_case key 是否存在
      expect(json.containsKey('allow_memory_context_in_chat'), isTrue);
      expect(json.containsKey('allow_external_memory_payloads'), isTrue);
      expect(json.containsKey('retrieval_mode'), isTrue);
      expect(json.containsKey('embedding_api_base'), isTrue);
      expect(json.containsKey('embedding_api_key'), isTrue);
      expect(json.containsKey('reranker_api_base'), isTrue);
      expect(json.containsKey('reranker_api_key'), isTrue);
      expect(json.containsKey('memory_package_token_budget'), isTrue);
      expect(json.containsKey('retrieval_token_budget'), isTrue);
      expect(json.containsKey('vector_top_k'), isTrue);
      expect(json.containsKey('keyword_top_k'), isTrue);
      expect(json.containsKey('reranker_top_k'), isTrue);
      expect(json.containsKey('final_top_k'), isTrue);
      expect(json.containsKey('embedding_timeout_ms'), isTrue);
      expect(json.containsKey('reranker_timeout_ms'), isTrue);
      expect(json.containsKey('total_retrieval_timeout_ms'), isTrue);
      expect(json.containsKey('fallback_local_enabled'), isTrue);
      // 确认 camelCase key 不存在
      expect(json.containsKey('allowMemoryContextInChat'), isFalse);
      expect(json.containsKey('retrievalMode'), isFalse);
      expect(json.containsKey('memoryPackageTokenBudget'), isFalse);
    });

    test('fromJson 对空 Map 使用全部默认值', () {
      final restored = MemoryEngineSettings.fromJson({});
      const defaults = MemoryEngineSettings();

      expect(restored.enabled, defaults.enabled);
      expect(restored.allowMemoryContextInChat, defaults.allowMemoryContextInChat);
      expect(restored.allowExternalMemoryPayloads,
          defaults.allowExternalMemoryPayloads);
      expect(restored.retrievalMode, defaults.retrievalMode);
      expect(restored.embeddingEnabled, defaults.embeddingEnabled);
      expect(restored.embeddingApiBase, defaults.embeddingApiBase);
      expect(restored.embeddingApiKey, defaults.embeddingApiKey);
      expect(restored.embeddingModel, defaults.embeddingModel);
      expect(restored.embeddingDimension, defaults.embeddingDimension);
      expect(restored.rerankerEnabled, defaults.rerankerEnabled);
      expect(restored.rerankerApiBase, defaults.rerankerApiBase);
      expect(restored.rerankerApiKey, defaults.rerankerApiKey);
      expect(restored.rerankerModel, defaults.rerankerModel);
      expect(restored.fallbackLocalEnabled, defaults.fallbackLocalEnabled);
      expect(restored.memoryPackageTokenBudget,
          defaults.memoryPackageTokenBudget);
      expect(restored.retrievalTokenBudget, defaults.retrievalTokenBudget);
      expect(restored.vectorTopK, defaults.vectorTopK);
      expect(restored.keywordTopK, defaults.keywordTopK);
      expect(restored.rerankerTopK, defaults.rerankerTopK);
      expect(restored.finalTopK, defaults.finalTopK);
      expect(restored.embeddingTimeoutMs, defaults.embeddingTimeoutMs);
      expect(restored.rerankerTimeoutMs, defaults.rerankerTimeoutMs);
      expect(restored.totalRetrievalTimeoutMs, defaults.totalRetrievalTimeoutMs);
    });
  });

  group('MemoryEngineSettings: toJson/fromJson 往返一致性', () {
    test('完整对象往返保持所有字段一致', () {
      const original = MemoryEngineSettings(
        enabled: true,
        allowMemoryContextInChat: false,
        allowExternalMemoryPayloads: false,
        retrievalMode: 'hybrid',
        embeddingEnabled: true,
        embeddingApiBase: 'https://embed.example.com/v1',
        embeddingApiKey: 'sk-embed-key',
        embeddingModel: 'text-embedding-3-large',
        embeddingDimension: 3072,
        rerankerEnabled: true,
        rerankerApiBase: 'https://rerank.example.com/v1',
        rerankerApiKey: 'sk-rerank-key',
        rerankerModel: 'rerank-v1',
        fallbackLocalEnabled: false,
        memoryPackageTokenBudget: 20000,
        retrievalTokenBudget: 6000,
        vectorTopK: 100,
        keywordTopK: 30,
        rerankerTopK: 50,
        finalTopK: 25,
        embeddingTimeoutMs: 2500,
        rerankerTimeoutMs: 3500,
        totalRetrievalTimeoutMs: 5000,
      );

      final json = original.toJson();
      final restored = MemoryEngineSettings.fromJson(json);

      expect(restored.enabled, original.enabled);
      expect(restored.allowMemoryContextInChat, original.allowMemoryContextInChat);
      expect(restored.allowExternalMemoryPayloads,
          original.allowExternalMemoryPayloads);
      expect(restored.retrievalMode, original.retrievalMode);
      expect(restored.embeddingEnabled, original.embeddingEnabled);
      expect(restored.embeddingApiBase, original.embeddingApiBase);
      expect(restored.embeddingApiKey, original.embeddingApiKey);
      expect(restored.embeddingModel, original.embeddingModel);
      expect(restored.embeddingDimension, original.embeddingDimension);
      expect(restored.rerankerEnabled, original.rerankerEnabled);
      expect(restored.rerankerApiBase, original.rerankerApiBase);
      expect(restored.rerankerApiKey, original.rerankerApiKey);
      expect(restored.rerankerModel, original.rerankerModel);
      expect(restored.fallbackLocalEnabled, original.fallbackLocalEnabled);
      expect(restored.memoryPackageTokenBudget,
          original.memoryPackageTokenBudget);
      expect(restored.retrievalTokenBudget, original.retrievalTokenBudget);
      expect(restored.vectorTopK, original.vectorTopK);
      expect(restored.keywordTopK, original.keywordTopK);
      expect(restored.rerankerTopK, original.rerankerTopK);
      expect(restored.finalTopK, original.finalTopK);
      expect(restored.embeddingTimeoutMs, original.embeddingTimeoutMs);
      expect(restored.rerankerTimeoutMs, original.rerankerTimeoutMs);
      expect(restored.totalRetrievalTimeoutMs,
          original.totalRetrievalTimeoutMs);
    });

    Glados<String>(any.choose(['local', 'hybrid', 'vector'])).test(
      '任意 retrieval_mode 值：toJson → fromJson 往返保持一致',
      (mode) {
        final original = MemoryEngineSettings(retrievalMode: mode);
        final json = original.toJson();
        final restored = MemoryEngineSettings.fromJson(json);
        expect(restored.retrievalMode, original.retrievalMode);
      },
    );

    Glados<bool>(any.bool).test(
      '任意 enabled 值：toJson → fromJson 往返保持一致',
      (enabled) {
        final original = MemoryEngineSettings(enabled: enabled);
        final json = original.toJson();
        final restored = MemoryEngineSettings.fromJson(json);
        expect(restored.enabled, original.enabled);
      },
    );

    Glados<int>(any.intInRange(1000, 32000)).test(
      '任意 memory_package_token_budget 值：toJson → fromJson 往返保持一致',
      (budget) {
        final original =
            MemoryEngineSettings(memoryPackageTokenBudget: budget);
        final json = original.toJson();
        final restored = MemoryEngineSettings.fromJson(json);
        expect(restored.memoryPackageTokenBudget,
            original.memoryPackageTokenBudget);
      },
    );

    Glados<int>(any.intInRange(0, 100000)).test(
      '任意 embedding_dimension 值：toJson → fromJson 往返保持一致',
      (dim) {
        final original = MemoryEngineSettings(embeddingDimension: dim);
        final json = original.toJson();
        final restored = MemoryEngineSettings.fromJson(json);
        expect(restored.embeddingDimension, original.embeddingDimension);
      },
    );
  });

  group('MemoryEngineSettings: copyWith', () {
    test('copyWith 只修改指定字段，其余保持不变', () {
      const original = MemoryEngineSettings(
        enabled: true,
        retrievalMode: 'hybrid',
        embeddingEnabled: true,
        embeddingModel: 'embed-3',
        rerankerEnabled: true,
        memoryPackageTokenBudget: 20000,
      );

      final modified = original.copyWith(
        retrievalMode: 'vector',
        memoryPackageTokenBudget: 8000,
      );

      expect(modified.retrievalMode, 'vector');
      expect(modified.memoryPackageTokenBudget, 8000);
      // 未修改字段保持不变
      expect(modified.enabled, true);
      expect(modified.embeddingEnabled, true);
      expect(modified.embeddingModel, 'embed-3');
      expect(modified.rerankerEnabled, true);
    });

    test('copyWith 不传参返回值相等的副本（除引用外字段一致）', () {
      const original = MemoryEngineSettings(
        enabled: true,
        embeddingApiKey: 'sk-foo',
        retrievalMode: 'hybrid',
      );
      final copy = original.copyWith();

      expect(copy.enabled, original.enabled);
      expect(copy.embeddingApiKey, original.embeddingApiKey);
      expect(copy.retrievalMode, original.retrievalMode);
    });

    test('连续多次 copyWith 不丢失数据', () {
      const original = MemoryEngineSettings();

      final step1 = original.copyWith(enabled: true);
      final step2 = step1.copyWith(retrievalMode: 'hybrid');
      final step3 = step2.copyWith(embeddingEnabled: true);
      final step4 = step3.copyWith(rerankerEnabled: true);

      expect(step4.enabled, true);
      expect(step4.retrievalMode, 'hybrid');
      expect(step4.embeddingEnabled, true);
      expect(step4.rerankerEnabled, true);
    });
  });

  group('MemoryEngineSettings: 嵌套在 AppSettings 里的序列化', () {
    test('AppSettings 默认值含默认 MemoryEngineSettings', () {
      const settings = AppSettings();
      expect(settings.memoryEngine, const MemoryEngineSettings());
      expect(settings.memoryBackgroundModel, '');
      expect(settings.memoryBackgroundProviderId, '');
      expect(settings.disableDeepseekThinkingForBackground, false);
    });

    test('AppSettings.copyWith 可整体替换 memoryEngine', () {
      const original = AppSettings();
      const newEngine = MemoryEngineSettings(
        enabled: true,
        retrievalMode: 'hybrid',
        embeddingEnabled: true,
      );

      final modified = original.copyWith(
        memoryEngine: newEngine,
        memoryBackgroundModel: 'gpt-4o-mini',
        memoryBackgroundProviderId: 'prov-1',
        disableDeepseekThinkingForBackground: true,
      );

      expect(modified.memoryEngine.enabled, true);
      expect(modified.memoryEngine.retrievalMode, 'hybrid');
      expect(modified.memoryEngine.embeddingEnabled, true);
      expect(modified.memoryBackgroundModel, 'gpt-4o-mini');
      expect(modified.memoryBackgroundProviderId, 'prov-1');
      expect(modified.disableDeepseekThinkingForBackground, true);
      // 其他字段保持默认
      expect(modified.memoryEngine.rerankerEnabled, false);
      expect(modified.memoryEngine.memoryPackageTokenBudget, 12000);
    });

    test('AppSettings.memoryEngine.toJson 嵌套对象可被 fromJson 还原', () {
      const engine = MemoryEngineSettings(
        enabled: true,
        retrievalMode: 'vector',
        embeddingApiKey: 'sk-embed',
        rerankerApiKey: 'sk-rerank',
        memoryPackageTokenBudget: 16000,
      );
      const settings = AppSettings(memoryEngine: engine);

      // 模拟 _settingsToMap 写入 DB 的形态
      final map = <String, dynamic>{
        'memory_engine': settings.memoryEngine.toJson(),
        'memory_background_model': settings.memoryBackgroundModel,
        'memory_background_provider_id': settings.memoryBackgroundProviderId,
        'disable_deepseek_thinking_for_background':
            settings.disableDeepseekThinkingForBackground,
      };

      // 模拟 _mapToSettings 读回
      final restoredEngine = MemoryEngineSettings.fromJson(
        map['memory_engine'] as Map<String, dynamic>,
      );

      expect(restoredEngine.enabled, engine.enabled);
      expect(restoredEngine.retrievalMode, engine.retrievalMode);
      expect(restoredEngine.embeddingApiKey, engine.embeddingApiKey);
      expect(restoredEngine.rerankerApiKey, engine.rerankerApiKey);
      expect(
        restoredEngine.memoryPackageTokenBudget,
        engine.memoryPackageTokenBudget,
      );
    });
  });
}
