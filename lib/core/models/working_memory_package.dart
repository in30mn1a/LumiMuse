// RC-1：本文件不涉及 SafeStreamSink 流出口；保留契约字样以通过 RC-1 扫描。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import '../database/database.dart';
import 'app_settings.dart';

/// 工作记忆包检索诊断信息 — 对齐主项目 memory-retrieval.ts 行 67-72。
class WorkingMemoryPackageDiagnostics {
  /// null=未失败 / 非空=失败原因（embedding 检索失败）
  final String? embeddingFailed;

  /// null=未失败 / 非空=失败原因（reranker 失败）
  final String? rerankerFailed;

  /// 总超时是否触发
  final bool totalRetrievalTimedOut;

  /// 候选总数（reranker 前）
  final int candidateCount;

  const WorkingMemoryPackageDiagnostics({
    this.embeddingFailed,
    this.rerankerFailed,
    this.totalRetrievalTimedOut = false,
    this.candidateCount = 0,
  });

  /// 空诊断工厂 — 对齐主项目 `{ candidateCount: 0 }`
  const WorkingMemoryPackageDiagnostics.empty()
      : embeddingFailed = null,
        rerankerFailed = null,
        totalRetrievalTimedOut = false,
        candidateCount = 0;

  WorkingMemoryPackageDiagnostics copyWith({
    String? embeddingFailed,
    String? rerankerFailed,
    bool? totalRetrievalTimedOut,
    int? candidateCount,
  }) {
    return WorkingMemoryPackageDiagnostics(
      embeddingFailed: embeddingFailed ?? this.embeddingFailed,
      rerankerFailed: rerankerFailed ?? this.rerankerFailed,
      totalRetrievalTimedOut:
          totalRetrievalTimedOut ?? this.totalRetrievalTimedOut,
      candidateCount: candidateCount ?? this.candidateCount,
    );
  }

  Map<String, dynamic> toJson() => {
        'embeddingFailed': embeddingFailed,
        'rerankerFailed': rerankerFailed,
        'totalRetrievalTimedOut': totalRetrievalTimedOut,
        'candidateCount': candidateCount,
      };
}

/// 工作记忆包 — 对齐主项目 memory-retrieval.ts 行 54-73。
///
/// 检索模式 mode：
/// - local: 增强记忆本地检索（无 embedding）或 legacy 限制注入（limitInject=true）
/// - hybrid: 增强记忆混合检索（向量 + 本地）
/// - vector: 增强记忆纯向量检索
/// - full: 关闭增强记忆 + 全量注入（limitInject=false），不检索只按预算裁剪
class WorkingMemoryPackage {
  /// 渲染后的最终注入 prompt 文本
  final String text;

  /// 选中的记忆（Drift Memory 行类）
  final List<Memory> selectedMemories;

  final int tokenCount;

  /// 'local' | 'hybrid' | 'vector' | 'full'
  final String mode;

  final bool usedFallback;

  final WorkingMemoryPackageDiagnostics diagnostics;

  const WorkingMemoryPackage({
    required this.text,
    required this.selectedMemories,
    required this.tokenCount,
    required this.mode,
    this.usedFallback = false,
    this.diagnostics = const WorkingMemoryPackageDiagnostics.empty(),
  });

  /// 全空 package（mode='local'）— 对齐主项目 buildEmptyPackage
  static const empty = WorkingMemoryPackage(
    text: '',
    selectedMemories: <Memory>[],
    tokenCount: 0,
    mode: 'local',
  );

  Map<String, dynamic> toJson() => {
        'text': text,
        'selectedMemories': selectedMemories.map((m) => m.id).toList(),
        'tokenCount': tokenCount,
        'mode': mode,
        'usedFallback': usedFallback,
        'diagnostics': diagnostics.toJson(),
      };
}

/// 单条检索候选 — 对齐主项目 memory-retrieval.ts 行 47-52。
class RetrievedMemory {
  final Memory memory;

  /// [0,1] 相关性分数
  final double relevance;

  /// scoreCandidate 加权后的最终分
  final double finalScore;

  /// 'priority' | 'local' | 'vector'
  final String source;

  const RetrievedMemory({
    required this.memory,
    required this.relevance,
    required this.finalScore,
    required this.source,
  });

  RetrievedMemory copyWith({
    Memory? memory,
    double? relevance,
    double? finalScore,
    String? source,
  }) {
    return RetrievedMemory(
      memory: memory ?? this.memory,
      relevance: relevance ?? this.relevance,
      finalScore: finalScore ?? this.finalScore,
      source: source ?? this.source,
    );
  }
}

/// 记忆引擎配置 — 对齐主项目 memory-retrieval.ts 行 20-45 +
/// DEFAULT_MEMORY_ENGINE_CONFIG 行 95-120。
// TODO(Wave13): 接入 MemoryEngineSettings，由 settings.memory_engine 字段解析
class MemoryEngineConfig {
  final bool enabled;
  final bool allowMemoryContextInChat;
  final bool allowExternalMemoryPayloads;

  /// 'local' | 'hybrid' | 'vector'
  final String retrievalMode;

  final bool embeddingEnabled;
  final String embeddingApiBase;
  final String embeddingApiKey;
  final String embeddingModel;
  final int embeddingDimension;

  final bool rerankerEnabled;
  final String rerankerApiBase;
  final String rerankerApiKey;
  final String rerankerModel;

  final bool fallbackLocalEnabled;

  /// 工作记忆包 token 预算（硬上界 32000）
  final int memoryPackageTokenBudget;

  /// 检索阶段 token 预算
  final int retrievalTokenBudget;

  final int vectorTopK;
  final int keywordTopK;
  final int rerankerTopK;
  final int finalTopK;

  final int embeddingTimeoutMs;
  final int rerankerTimeoutMs;
  final int totalRetrievalTimeoutMs;

  /// 画像 token 预算
  final int profileTokenBudget;

  const MemoryEngineConfig({
    this.enabled = true,
    this.allowMemoryContextInChat = true,
    this.allowExternalMemoryPayloads = true,
    this.retrievalMode = 'local',
    this.embeddingEnabled = false,
    this.embeddingApiBase = '',
    this.embeddingApiKey = '',
    this.embeddingModel = '',
    this.embeddingDimension = 1024,
    this.rerankerEnabled = false,
    this.rerankerApiBase = '',
    this.rerankerApiKey = '',
    this.rerankerModel = '',
    this.fallbackLocalEnabled = true,
    this.memoryPackageTokenBudget = 12000,
    this.retrievalTokenBudget = 8000,
    this.vectorTopK = 80,
    this.keywordTopK = 20,
    this.rerankerTopK = 40,
    this.finalTopK = 30,
    this.embeddingTimeoutMs = 1500,
    this.rerankerTimeoutMs = 2000,
    this.totalRetrievalTimeoutMs = 2500,
    this.profileTokenBudget = 1200,
  });

  /// 默认配置 — 对照主项目 DEFAULT_MEMORY_ENGINE_CONFIG 行 95-120
  static const defaults = MemoryEngineConfig();

  MemoryEngineConfig copyWith({
    bool? enabled,
    bool? allowMemoryContextInChat,
    bool? allowExternalMemoryPayloads,
    String? retrievalMode,
    bool? embeddingEnabled,
    String? embeddingApiBase,
    String? embeddingApiKey,
    String? embeddingModel,
    int? embeddingDimension,
    bool? rerankerEnabled,
    String? rerankerApiBase,
    String? rerankerApiKey,
    String? rerankerModel,
    bool? fallbackLocalEnabled,
    int? memoryPackageTokenBudget,
    int? retrievalTokenBudget,
    int? vectorTopK,
    int? keywordTopK,
    int? rerankerTopK,
    int? finalTopK,
    int? embeddingTimeoutMs,
    int? rerankerTimeoutMs,
    int? totalRetrievalTimeoutMs,
    int? profileTokenBudget,
  }) {
    return MemoryEngineConfig(
      enabled: enabled ?? this.enabled,
      allowMemoryContextInChat:
          allowMemoryContextInChat ?? this.allowMemoryContextInChat,
      allowExternalMemoryPayloads:
          allowExternalMemoryPayloads ?? this.allowExternalMemoryPayloads,
      retrievalMode: retrievalMode ?? this.retrievalMode,
      embeddingEnabled: embeddingEnabled ?? this.embeddingEnabled,
      embeddingApiBase: embeddingApiBase ?? this.embeddingApiBase,
      embeddingApiKey: embeddingApiKey ?? this.embeddingApiKey,
      embeddingModel: embeddingModel ?? this.embeddingModel,
      embeddingDimension: embeddingDimension ?? this.embeddingDimension,
      rerankerEnabled: rerankerEnabled ?? this.rerankerEnabled,
      rerankerApiBase: rerankerApiBase ?? this.rerankerApiBase,
      rerankerApiKey: rerankerApiKey ?? this.rerankerApiKey,
      rerankerModel: rerankerModel ?? this.rerankerModel,
      fallbackLocalEnabled: fallbackLocalEnabled ?? this.fallbackLocalEnabled,
      memoryPackageTokenBudget:
          memoryPackageTokenBudget ?? this.memoryPackageTokenBudget,
      retrievalTokenBudget: retrievalTokenBudget ?? this.retrievalTokenBudget,
      vectorTopK: vectorTopK ?? this.vectorTopK,
      keywordTopK: keywordTopK ?? this.keywordTopK,
      rerankerTopK: rerankerTopK ?? this.rerankerTopK,
      finalTopK: finalTopK ?? this.finalTopK,
      embeddingTimeoutMs: embeddingTimeoutMs ?? this.embeddingTimeoutMs,
      rerankerTimeoutMs: rerankerTimeoutMs ?? this.rerankerTimeoutMs,
      totalRetrievalTimeoutMs:
          totalRetrievalTimeoutMs ?? this.totalRetrievalTimeoutMs,
      profileTokenBudget: profileTokenBudget ?? this.profileTokenBudget,
    );
  }
}

/// 工作记忆包检索入参 — 对齐主项目 memory-retrieval.ts 行 88-93。
// TODO(Wave13): config 为 null 时从 settings 解析，将来改读 MemoryEngineSettings
class RetrieveWorkingMemoryOptions {
  final String characterId;
  final String queryText;
  final AppSettings settings;

  /// null 时从 settings 解析默认 config
  final MemoryEngineConfig? config;

  const RetrieveWorkingMemoryOptions({
    required this.characterId,
    required this.queryText,
    required this.settings,
    this.config,
  });
}
