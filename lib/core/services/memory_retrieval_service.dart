// RC-1：本服务不涉及 SafeStreamSink 流出口；保留契约字样以通过 RC-1 扫描。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
//   addVectorCandidates 内 embedText 必须 await；applyReranker 内 rerankDocuments 必须 await。
//   markSelectedMemoriesUsed 是 fire-and-forget 但不是 LLM 调用，可用 unawaited。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:async';
import 'dart:math' as math;

import 'package:drift/drift.dart';

import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/working_memory_package.dart';
import '../utils/system_prompt_builder.dart';
import '../utils/token_counter.dart';
import 'memory_embedding_tasks_service.dart';
import 'memory_embeddings_service.dart';
import 'memory_engine.dart';
import 'memory_profile_service.dart';
import 'memory_reranker_service.dart';

/// 记忆工作包 token 上限的硬上界（与设置页 UI 的 max 一致）：
/// 防止越界配置架空「token 预算是硬上限」的设计。对齐主项目行 128。
const int memoryPackageTokenBudgetMax = 32000;

/// legacy 全量召回上限。对齐主项目行 129。
const int legacyMemoryCandidateLimit = 300;

/// 工作记忆包检索服务 — 对齐主项目 src/lib/memory-retrieval.ts（874 行）。
///
/// 完整移植主项目的分层检索 / 向量召回 / 重排 / token 预算裁剪 /
/// 画像注入 / 兜底包 / 超时控制 / 标记 used 机制。
///
/// 依赖通过构造函数注入：[MemoryEngine] 提供 localRetrieve（旧版 TF-IDF 召回），
/// [MemoryEmbeddingsService] 提供 embedText，[MemoryEmbeddingTasksService]
/// 提供 loadReadyMemoryEmbeddings，[MemoryProfileService] 提供 readMemoryProfile。
/// Reranker 是顶层函数 [rerankDocuments]，不需注入 service。
class MemoryRetrievalService {
  final AppDatabase _db;
  final MemoryEngine _memoryEngine;
  final MemoryEmbeddingsService _embeddingsService;
  final MemoryEmbeddingTasksService _embeddingTasks;
  final MemoryProfileService _profileService;

  MemoryRetrievalService(
    this._db,
    this._memoryEngine,
    this._embeddingsService,
    this._embeddingTasks,
    this._profileService,
  );

  // ═══════════════════════════════════════════════════════════════
  // 主入口 — 对齐主项目行 842-874
  // ═══════════════════════════════════════════════════════════════

  /// 检索工作记忆包。
  ///
  /// - engine.enabled=false → 走 buildLegacyFullMemoryPackage
  /// - 否则 withTotalTimeout(buildWorkingMemoryPackage, totalRetrievalTimeoutMs)，
  ///   超时走 buildLocalFallbackPackage
  /// - 末尾 markSelectedMemoriesUsed（fire-and-forget，不 await）
  Future<WorkingMemoryPackage> retrieveWorkingMemoryPackage({
    required String characterId,
    required String queryText,
    required AppSettings settings,
    MemoryEngineConfig? config,
  }) async {
    final resolved = resolveMemoryEngineConfig(settings, override: config);
    if (!resolved.allowMemoryContextInChat) {
      return buildEmptyPackage();
    }

    final options = RetrieveWorkingMemoryOptions(
      characterId: characterId,
      queryText: queryText,
      settings: settings,
      config: config,
    );

    if (!resolved.enabled) {
      final result = await buildLegacyFullMemoryPackage(
        options: options,
        config: resolved,
      );
      unawaited(markSelectedMemoriesUsed(result.selectedMemories));
      return result;
    }

    WorkingMemoryPackage result;
    try {
      result = await withTotalTimeout(
        () => buildWorkingMemoryPackage(options: options, config: resolved),
        resolved.totalRetrievalTimeoutMs,
      );
    } on TimeoutException catch (_) {
      result = await buildLocalFallbackPackage(
        options: options,
        config: resolved,
        diagnostics: const WorkingMemoryPackageDiagnostics(
          totalRetrievalTimedOut: true,
        ),
      );
    }

    unawaited(markSelectedMemoriesUsed(result.selectedMemories));
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // 配置解析 — 对齐主项目行 136-168
  // ═══════════════════════════════════════════════════════════════

  /// 合并默认值与 override；钳制 token budget ≤ 32000；finiteNumber 兜底非法值。
  /// final_top_k 受 settings.limitInject 影响。
  // TODO(Wave13): 当前从 AppSettings 简单字段构造，将来改读 MemoryEngineSettings
  MemoryEngineConfig resolveMemoryEngineConfig(
    AppSettings settings, {
    MemoryEngineConfig? override,
  }) {
    final base = override ?? MemoryEngineConfig.defaults;
    final legacyLimit = _finiteNumber(
      settings.memoryMaxInject.toDouble(),
      MemoryEngineConfig.defaults.finalTopK.toDouble(),
    );

    // retrievalMode 只允许 local / hybrid / vector
    final retrievalMode = base.retrievalMode == 'vector' ||
            base.retrievalMode == 'hybrid'
        ? base.retrievalMode
        : 'local';

    // 钳上界：即便绕过 UI 写入超大值，也不允许架空「token 预算是硬上限」的设计
    final memoryPackageTokenBudget = math.min(
      _finiteNumber(
        base.memoryPackageTokenBudget.toDouble(),
        MemoryEngineConfig.defaults.memoryPackageTokenBudget.toDouble(),
      ),
      memoryPackageTokenBudgetMax.toDouble(),
    ).toInt();

    // final_top_k：limitInject=true → memoryMaxInject；否则默认 finalTopK
    final finalTopK = _finiteNumber(
      base.finalTopK.toDouble(),
      settings.limitInject
          ? legacyLimit
          : MemoryEngineConfig.defaults.finalTopK.toDouble(),
    ).floor();

    return MemoryEngineConfig(
      enabled: base.enabled,
      allowMemoryContextInChat: base.allowMemoryContextInChat,
      allowExternalMemoryPayloads: base.allowExternalMemoryPayloads,
      retrievalMode: retrievalMode,
      embeddingEnabled: base.embeddingEnabled,
      embeddingApiBase: base.embeddingApiBase,
      embeddingApiKey: base.embeddingApiKey,
      embeddingModel: base.embeddingModel,
      embeddingDimension:
          _finiteNumber(base.embeddingDimension.toDouble(), 1024).toInt(),
      rerankerEnabled: base.rerankerEnabled,
      rerankerApiBase: base.rerankerApiBase,
      rerankerApiKey: base.rerankerApiKey,
      rerankerModel: base.rerankerModel,
      fallbackLocalEnabled: base.fallbackLocalEnabled,
      memoryPackageTokenBudget: memoryPackageTokenBudget,
      retrievalTokenBudget: _finiteNumber(
        base.retrievalTokenBudget.toDouble(),
        MemoryEngineConfig.defaults.retrievalTokenBudget.toDouble(),
      ).toInt(),
      vectorTopK: _finiteNumber(
        base.vectorTopK.toDouble(),
        MemoryEngineConfig.defaults.vectorTopK.toDouble(),
      ).floor(),
      keywordTopK: _finiteNumber(
        base.keywordTopK.toDouble(),
        MemoryEngineConfig.defaults.keywordTopK.toDouble(),
      ).floor(),
      rerankerTopK: _finiteNumber(
        base.rerankerTopK.toDouble(),
        MemoryEngineConfig.defaults.rerankerTopK.toDouble(),
      ).floor(),
      finalTopK: finalTopK,
      embeddingTimeoutMs: _finiteNumber(
        base.embeddingTimeoutMs.toDouble(),
        MemoryEngineConfig.defaults.embeddingTimeoutMs.toDouble(),
      ).toInt(),
      rerankerTimeoutMs: _finiteNumber(
        base.rerankerTimeoutMs.toDouble(),
        MemoryEngineConfig.defaults.rerankerTimeoutMs.toDouble(),
      ).toInt(),
      totalRetrievalTimeoutMs: _finiteNumber(
        base.totalRetrievalTimeoutMs.toDouble(),
        MemoryEngineConfig.defaults.totalRetrievalTimeoutMs.toDouble(),
      ).toInt(),
      profileTokenBudget: _finiteNumber(
        base.profileTokenBudget.toDouble(),
        MemoryEngineConfig.defaults.profileTokenBudget.toDouble(),
      ).toInt(),
    );
  }

  /// 有限数兜底：非有限或 ≤0 回退 fallback。对齐主项目 finiteNumber 行 131-134。
  double _finiteNumber(double value, double fallback) {
    return value.isFinite && value > 0 ? value : fallback;
  }

  // ═══════════════════════════════════════════════════════════════
  // 记忆加载 — 对齐主项目行 174-220
  // ═══════════════════════════════════════════════════════════════

  /// 选 pinned>0 OR importance>=0.85 OR memory_kind='character_promise'，
  /// 按 pinned/importance/updated_at DESC 排序，LIMIT 300。
  Future<List<Memory>> loadDefaultPriorityMemories(String characterId) async {
    final query = _db.select(_db.memories)
      ..where((m) => m.characterId.equals(characterId))
      ..where((m) => m.status.equals('active'))
      // pinned 是 BoolColumn，importance>=0.85，memory_kind='character_promise'
      ..where((m) =>
          m.pinned.equals(true) |
          m.importance.isBiggerOrEqualValue(0.85) |
          m.memoryKind.equals('character_promise'))
      ..orderBy([
        (m) => OrderingTerm(expression: m.pinned, mode: OrderingMode.desc),
        (m) => OrderingTerm(expression: m.importance, mode: OrderingMode.desc),
        (m) => OrderingTerm(expression: m.updatedAt, mode: OrderingMode.desc),
      ])
      ..limit(legacyMemoryCandidateLimit);
    return query.get();
  }

  /// 全量 active，按 pinned/importance/updated_at DESC，LIMIT 300。
  Future<List<Memory>> loadDefaultLegacyMemories(String characterId) async {
    final query = _db.select(_db.memories)
      ..where((m) => m.characterId.equals(characterId))
      ..where((m) => m.status.equals('active'))
      ..orderBy([
        (m) => OrderingTerm(expression: m.pinned, mode: OrderingMode.desc),
        (m) => OrderingTerm(expression: m.importance, mode: OrderingMode.desc),
        (m) => OrderingTerm(expression: m.updatedAt, mode: OrderingMode.desc),
      ])
      ..limit(legacyMemoryCandidateLimit);
    return query.get();
  }

  /// 按 id IN(...) 查 active，并按入参顺序排序。
  Future<List<Memory>> loadDefaultMemoriesByIds(List<String> ids) async {
    if (ids.isEmpty) return const <Memory>[];
    final rows = await (_db.select(_db.memories)
          ..where((m) => m.status.equals('active'))
          ..where((m) => m.id.isIn(ids)))
        .get();
    final order = <String, int>{
      for (var i = 0; i < ids.length; i++) ids[i]: i
    };
    rows.sort((a, b) =>
        (order[a.id] ?? 0).compareTo(order[b.id] ?? 0));
    return rows;
  }

  // ═══════════════════════════════════════════════════════════════
  // 标记 used — 对齐主项目行 222-246
  // ═══════════════════════════════════════════════════════════════

  /// UPDATE memories SET usage_count=usage_count+1, last_used_at=now WHERE id IN(ids)。
  /// 用 raw SQL 实现 usage_count 自增（Drift DSL 不直接支持列自引用表达式写入）。
  Future<void> markDefaultMemoriesUsed(List<String> ids) async {
    final uniqueIds = ids.where((id) => id.isNotEmpty).toSet().toList();
    if (uniqueIds.isEmpty) return;
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final placeholders = uniqueIds.map((_) => '?').join(',');
    await _db.customStatement(
      'UPDATE memories SET usage_count = usage_count + 1, last_used_at = ? '
      'WHERE id IN ($placeholders)',
      <dynamic>[nowMs, ...uniqueIds],
    );
  }

  /// 抽 ids 调 markDefaultMemoriesUsed；fire-and-forget（不阻塞主流程）。
  /// 调用方用 unawaited 包裹本方法返回的 Future。
  Future<void> markSelectedMemoriesUsed(List<Memory> memories) async {
    final ids = memories
        .map((m) => m.id)
        .where((id) => id.isNotEmpty)
        .toSet()
        .toList();
    if (ids.isEmpty) return;
    try {
      await markDefaultMemoriesUsed(ids);
    } catch (error) {
      // 对齐主项目 markSelectedMemoriesUsed 行 243-245：吞错不抛
      debugPrintRetrieval('[memory-retrieval] failed to update memory usage: $error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 候选写入与去重 — 对齐主项目行 248-264
  // ═══════════════════════════════════════════════════════════════

  /// 去重写入；source='priority' 强制覆盖（即使新 relevance 更低）。
  void addCandidate(
    Map<String, RetrievedMemory> map,
    Memory memory,
    double relevance,
    String source,
  ) {
    final existing = map[memory.id];
    if (existing == null ||
        relevance > existing.relevance ||
        source == 'priority') {
      map[memory.id] = RetrievedMemory(
        memory: memory,
        relevance: math.max(0.0, math.min(1.0, relevance)),
        finalScore: 0,
        source: source,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 评分函数 — 对齐主项目行 270-339
  // ═══════════════════════════════════════════════════════════════

  /// 钳 [0,1]，非 finite 回退 fallback。对齐主项目行 270-273。
  static double clamp01(double value, double fallback) {
    if (!value.isFinite) return fallback;
    return math.max(0.0, math.min(1.0, value));
  }

  /// 按 category 推断默认 memory_kind / importance / emotional_weight —
  /// 对齐主项目 src/lib/memory-category.ts inferMemoryDefaults。
  /// 复用 memory_candidates_service.dart 的同款映射。
  _MemoryDefaults _inferMemoryDefaults(String categoryValue) {
    final category = _normalizeMemoryCategory(categoryValue);
    switch (category) {
      case '基础信息':
        return const _MemoryDefaults('user_fact', 0.85, 0.0);
      case '人格特质':
        return const _MemoryDefaults('user_fact', 0.8, 0.0);
      case '重要事件':
        return const _MemoryDefaults('relationship_event', 0.75, 0.65);
      case '偏好习惯':
        return const _MemoryDefaults('user_preference', 0.65, 0.0);
      case '关系动态':
        return const _MemoryDefaults('relationship_event', 0.6, 0.6);
      case '四季日常':
        return const _MemoryDefaults('general', 0.4, 0.0);
      case '话题历史':
      default:
        return const _MemoryDefaults('general', 0.45, 0.0);
    }
  }

  /// 规范化记忆分类名 — 对齐主项目 normalizeMemoryCategory。
  String _normalizeMemoryCategory(String raw) {
    final trimmed = raw.trim();
    const known = {
      '关系动态', '话题历史', '基础信息', '偏好习惯', '人格特质', '重要事件', '四季日常',
    };
    return known.contains(trimmed) ? trimmed : '话题历史';
  }

  /// 优先 memory.memoryKind，回退按 category inferMemoryDefaults。
  String getMemoryKind(Memory memory) {
    final rawKind = memory.memoryKind;
    if (rawKind.isNotEmpty) return rawKind;
    return _inferMemoryDefaults(memory.category).memoryKind;
  }

  /// 1/(1+days/30)，days=(now-updatedAt).inDays，updatedAt 为空回退 0.4。
  double recencyScore(Memory memory, DateTime now) {
    final timestamp = memory.updatedAt;
    final days = now.difference(timestamp).inDays;
    if (days < 0) return 1.0;
    return math.max(0.0, math.min(1.0, 1 / (1 + days / 30)));
  }

  /// character_promise=1 / relationship_event|user_preference|user_fact|world_state=0.8
  /// / 中文分类=0.7 / 其余=0.2
  double categoryBonus(Memory memory) {
    final kind = getMemoryKind(memory);
    if (kind == 'character_promise') return 1.0;
    if (kind == 'relationship_event' ||
        kind == 'user_preference' ||
        kind == 'user_fact' ||
        kind == 'world_state') {
      return 0.8;
    }
    if (memory.category == '重要事件' ||
        memory.category == '关系动态' ||
        memory.category == '偏好习惯') {
      return 0.7;
    }
    return 0.2;
  }

  /// archived|superseded=0.7 / conflict=0.4 / 其余=0
  double statusPenalty(Memory memory) {
    final status = memory.status;
    if (status == 'archived' || status == 'superseded') return 0.7;
    if (status == 'conflict') return 0.4;
    return 0.0;
  }

  /// 加权：0.45·relevance + 0.20·importance + 0.15·emotionalWeight +
  /// 0.10·recency + 0.05·usageScore(log1p(usage_count)/log(11)) +
  /// 0.05·categoryBonus + pinned·0.4 - statusPenalty
  RetrievedMemory scoreCandidate(
    RetrievedMemory candidate, {
    required DateTime now,
  }) {
    final memory = candidate.memory;
    final defaults = _inferMemoryDefaults(memory.category);
    final importance = clamp01(memory.importance, defaults.importance);
    final emotionalWeight =
        clamp01(memory.emotionalWeight, defaults.emotionalWeight);
    final usageCount = memory.usageCount;
    final usageScore =
        math.max(0.0, math.min(1.0, math.log(1 + math.max(0, usageCount)) / math.log(11)));
    final pinned = memory.pinned ? 1.0 : 0.0;

    final finalScore =
        0.45 * candidate.relevance +
        0.20 * importance +
        0.15 * emotionalWeight +
        0.10 * recencyScore(memory, now) +
        0.05 * usageScore +
        0.05 * categoryBonus(memory) +
        pinned * 0.4 -
        statusPenalty(memory);

    return candidate.copyWith(finalScore: finalScore);
  }

  /// 按 relevance 降序 tie-break updated_at DESC
  List<RetrievedMemory> rankCandidatesByRelevance(
      Iterable<RetrievedMemory> candidates) {
    final list = candidates.toList();
    list.sort((a, b) {
      final cmp = b.relevance.compareTo(a.relevance);
      if (cmp != 0) return cmp;
      return b.memory.updatedAt.compareTo(a.memory.updatedAt);
    });
    return list;
  }

  /// scoreCandidate 后按 finalScore 降序 tie-break updated_at DESC
  List<RetrievedMemory> rankCandidates(
    Iterable<RetrievedMemory> candidates, {
    required DateTime now,
  }) {
    final scored = candidates.map((c) => scoreCandidate(c, now: now)).toList();
    scored.sort((a, b) {
      final cmp = b.finalScore.compareTo(a.finalScore);
      if (cmp != 0) return cmp;
      return b.memory.updatedAt.compareTo(a.memory.updatedAt);
    });
    return scored;
  }

  // ═══════════════════════════════════════════════════════════════
  // 分层 — 对齐主项目行 341-351
  // ═══════════════════════════════════════════════════════════════

  /// 返回 5 个分层标题之一。
  String layerForMemory(Memory memory) {
    final kind = getMemoryKind(memory);
    final pinned = memory.pinned;
    final importance =
        clamp01(memory.importance, _inferMemoryDefaults(memory.category).importance);

    if (pinned || importance >= 0.9) return '重要固定记忆';
    if (kind == 'character_promise') return '角色需要兑现的承诺';
    if (kind == 'user_preference' || kind == 'user_fact') {
      return '主人的偏好与长期信息';
    }
    if (kind == 'relationship_event' || kind == 'world_state') {
      return '关系与重要事件';
    }
    return '本轮相关回忆';
  }

  /// layer 为前两个之一（重要固定记忆 / 角色需要兑现的承诺）。
  bool isHighPriorityMemory(Memory memory) {
    final layer = layerForMemory(memory);
    return layer == '重要固定记忆' || layer == '角色需要兑现的承诺';
  }

  // ═══════════════════════════════════════════════════════════════
  // 画像处理 — 对齐主项目行 353-371 + 709-731
  // ═══════════════════════════════════════════════════════════════

  /// 行级累加，超 `min(profileTokenBudget, memoryPackageTokenBudget)` 就停。
  String trimProfileText(
    String profileText,
    MemoryEngineConfig config,
    int Function(String) tokenCounter,
  ) {
    final trimmed = profileText.trim();
    if (trimmed.isEmpty) return '';

    final profileBudget = math.min(
      config.profileTokenBudget,
      config.memoryPackageTokenBudget,
    );
    final selected = <String>[];
    for (final line in trimmed.split('\n')) {
      final candidate = [...selected, line].join('\n');
      if (tokenCounter(candidate) <= profileBudget) {
        selected.add(line);
      }
    }
    return selected.length > 1 ? selected.join('\n') : '';
  }

  /// readMemoryProfile → 为 null 用空 MemoryProfile 兜底 → renderMemoryProfile → trim
  Future<String> resolveProfileText(
    String characterId,
    MemoryEngineConfig config,
    int Function(String) tokenCounter,
  ) async {
    final profile = await _profileService.readMemoryProfile(characterId);
    final effective = profile ??
        MemoryProfile(
          characterId: characterId,
          updatedAt: DateTime.fromMillisecondsSinceEpoch(0),
        );
    final rendered = renderMemoryProfile(effective);
    return trimProfileText(rendered, config, tokenCounter);
  }

  // ═══════════════════════════════════════════════════════════════
  // 渲染 — 对齐主项目行 373-397
  // ═══════════════════════════════════════════════════════════════

  /// 5 分组渲染：
  /// - `## 记忆上下文\n\n### 记忆画像\n{profileText}\n`（profileText 非空时）
  /// - 按 layerForMemory 分组渲染
  /// - 末尾追加 `## 记忆使用原则\n{SystemPromptBuilder.memoryUsagePrinciples}`
  String renderPackage(List<Memory> memories, {String profileText = ''}) {
    if (memories.isEmpty && profileText.isEmpty) return '';

    final groups = <String, List<String>>{
      '重要固定记忆': <String>[],
      '角色需要兑现的承诺': <String>[],
      '主人的偏好与长期信息': <String>[],
      '关系与重要事件': <String>[],
      '本轮相关回忆': <String>[],
    };

    for (final memory in memories) {
      final content = memory.content.trim();
      if (content.isEmpty) continue;
      final layer = layerForMemory(memory);
      groups[layer]!.add('- $content');
    }

    final sections = <String>[SystemPromptBuilder.memoryContextTitle];
    if (profileText.isNotEmpty) {
      // 剥掉开头的「记忆画像：\n?」前缀（对齐主项目 replace(/^记忆画像：\n?/u, '')）
      final stripped =
          profileText.replaceFirst(RegExp(r'^记忆画像：\n?'), '').trim();
      sections.add('### 记忆画像\n$stripped');
    }
    for (final entry in groups.entries) {
      if (entry.value.isEmpty) continue;
      sections.add('### ${entry.key}\n${entry.value.join('\n')}');
    }
    sections.add(SystemPromptBuilder.memoryUsagePrinciples);
    return sections.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // token 预算裁剪 — 对齐主项目行 405-507
  // ═══════════════════════════════════════════════════════════════

  /// 二分搜索内容截断长度（保留 `…`），让单条高优先级记忆即使整条超预算仍能截断后注入。
  Memory? truncateMemoryForBudget(
    Memory memory,
    int budget,
    String profileText,
    int Function(String) tokenCounter,
    List<Memory> existingMemories,
  ) {
    final content = memory.content.trim();
    if (content.isEmpty) return null;

    var lo = 0;
    var hi = content.length;
    while (lo < hi) {
      final mid = ((lo + hi) / 2).ceil();
      final trial = '${content.substring(0, mid)}…';
      final tokens = tokenCounter(renderPackage(
        [...existingMemories, memory.copyWith(content: trial)],
        profileText: profileText,
      ));
      if (tokens <= budget) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    if (lo <= 0) return null;
    return memory.copyWith(content: '${content.substring(0, lo)}…');
  }

  /// 二分出预算内最大前缀；高优先级记忆截断保留；普通记忆 skipOversizedOrdinary 控制是否丢弃超预算条目。
  ({String text, List<Memory> selected, int tokenCount}) trimByTokenBudget({
    required List<RetrievedMemory> ranked,
    required MemoryEngineConfig config,
    required int Function(String) tokenCounter,
    required String profileText,
    required int maxMemoryCount,
    bool skipOversizedOrdinary = false,
  }) {
    final budget = config.memoryPackageTokenBudget;

    // 画像 + 固定结构若已超预算，丢弃画像让记忆仍能按预算注入
    var effectiveProfile = profileText;
    if (effectiveProfile.isNotEmpty &&
        tokenCounter(renderPackage(const <Memory>[], profileText: effectiveProfile)) >
            budget) {
      effectiveProfile = '';
    }

    final limit = math.min(ranked.length, math.max(0, maxMemoryCount));

    // 二分出预算内能容纳的最长高分前缀
    bool prefixFits(int k) {
      final text = renderPackage(
        ranked.sublist(0, k).map((c) => c.memory).toList(),
        profileText: effectiveProfile,
      );
      return (text.isEmpty ? 0 : tokenCounter(text)) <= budget;
    }

    var lo = 0;
    var hi = limit;
    while (lo < hi) {
      final mid = ((lo + hi) / 2).ceil();
      if (prefixFits(mid)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    final selected =
        ranked.sublist(0, lo).map((c) => c.memory).toList();

    bool canAppend(Memory memory) {
      final text = renderPackage([...selected, memory],
          profileText: effectiveProfile);
      return (text.isEmpty ? 0 : tokenCounter(text)) <= budget;
    }

    for (var index = lo;
        index < limit && selected.length < maxMemoryCount;
        index += 1) {
      final memory = ranked[index].memory;
      final highPriority = isHighPriorityMemory(memory);

      if (canAppend(memory)) {
        if (skipOversizedOrdinary || highPriority) {
          selected.add(memory);
        }
        continue;
      }

      if (highPriority) {
        final truncated = truncateMemoryForBudget(
          memory,
          budget,
          effectiveProfile,
          tokenCounter,
          selected,
        );
        if (truncated != null) {
          selected.add(truncated);
          continue;
        }
        break;
      }

      if (!skipOversizedOrdinary) {
        continue;
      }
    }

    final text = renderPackage(selected, profileText: effectiveProfile);
    final tokenCount = text.isEmpty ? 0 : tokenCounter(text);
    return (text: text, selected: selected, tokenCount: tokenCount);
  }

  // ═══════════════════════════════════════════════════════════════
  // 向量召回 — 对齐主项目行 567-616
  // ═══════════════════════════════════════════════════════════════

  /// 异步向量召回：embedText → loadReadyMemoryEmbeddings → rankEmbeddingRows →
  /// loadDefaultMemoriesByIds → addCandidate(source='vector')。
  /// 失败时抛出（由调用方 buildWorkingMemoryPackage 捕获并标记 embeddingFailed）。
  Future<void> addVectorCandidates({
    required String queryText,
    required String characterId,
    required MemoryEngineConfig config,
    required Map<String, RetrievedMemory> candidates,
  }) async {
    final queryEmbedding = await _embeddingsService.embedText(
      queryText,
      EmbeddingAdapterConfig(
        apiBase: config.embeddingApiBase,
        apiKey: config.embeddingApiKey,
        model: config.embeddingModel,
        dimension: config.embeddingDimension,
        timeoutMs: config.embeddingTimeoutMs,
        provider: 'openai-compatible',
      ),
    );

    final rows = await _embeddingTasks.loadReadyMemoryEmbeddings(
      characterId,
      provider: 'openai-compatible',
      model: config.embeddingModel,
      dimension: config.embeddingDimension,
    );

    // dimension mismatch 检测：dimension-filtered 查询返回 0 行时，
    // 不带 dimension 再查一次，若存在不同 dimension 的 ready 行则抛错
    if (rows.isEmpty && config.embeddingDimension > 0) {
      final mismatchedRows = await _embeddingTasks.loadReadyMemoryEmbeddings(
        characterId,
        provider: 'openai-compatible',
        model: config.embeddingModel,
      );
      final mismatchedDimensions = <int>{};
      for (final row in mismatchedRows) {
        if (row.dimension != config.embeddingDimension) {
          mismatchedDimensions.add(row.dimension);
        }
      }
      if (mismatchedDimensions.isNotEmpty) {
        throw StateError(
          'embedding dimension mismatch: expected ${config.embeddingDimension}, '
          'indexed ${mismatchedDimensions.join(', ')}',
        );
      }
    }

    final rankedRows = rankEmbeddingRows(
      queryEmbedding,
      rows,
      config.vectorTopK,
      (MemoryEmbedding row) => row.embeddingBlob,
    );

    if (rankedRows.isEmpty) return;

    final memories = await loadDefaultMemoriesByIds(
      rankedRows.map((item) => item.row.memoryId).toList(),
    );
    final memoryById = <String, Memory>{
      for (final m in memories) m.id: m,
    };

    for (final item in rankedRows) {
      final memory = memoryById[item.row.memoryId];
      if (memory == null) continue;
      // relevance = (similarity + 1) / 2，将 [-1,1] 余弦映射到 [0,1]
      addCandidate(candidates, memory, (item.similarity + 1) / 2, 'vector');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Reranker — 对齐主项目行 509-565
  // ═══════════════════════════════════════════════════════════════

  /// 异步重排：取 rerankerTopK 候选 → rerankDocuments → 归一化 score 到 [0,1]
  /// → 写回 candidate.relevance；未重排候选压到最低 reranker 分以下避免反超。
  /// 失败时返回失败原因（null=成功），不抛出（主流程降级跳过 reranker）。
  /// Dart 端无 AbortSignal，用 Future.timeout(rerankerTimeoutMs) 兜底。
  Future<String?> applyReranker({
    required String queryText,
    required Map<String, RetrievedMemory> candidates,
    required MemoryEngineConfig config,
  }) async {
    if (!config.rerankerEnabled || candidates.isEmpty) return null;

    final ranked = rankCandidatesByRelevance(candidates.values);
    final docs = ranked
        .sublist(0, math.min(config.rerankerTopK, ranked.length))
        .map((c) => RerankDocument(id: c.memory.id, text: c.memory.content))
        .toList();

    try {
      final results = await rerankDocuments(
        queryText,
        docs,
        RerankerAdapterConfig(
          apiBase: config.rerankerApiBase,
          apiKey: config.rerankerApiKey,
          model: config.rerankerModel,
          timeoutMs: config.rerankerTimeoutMs,
        ),
      ).timeout(Duration(milliseconds: config.rerankerTimeoutMs));

      final finiteScores = results
          .map((r) => r.score)
          .where((s) => s.isFinite)
          .toList();
      final minScore =
          finiteScores.isNotEmpty ? finiteScores.reduce(math.min) : 0.0;
      final maxScore =
          finiteScores.isNotEmpty ? finiteScores.reduce(math.max) : 0.0;
      final shouldNormalize =
          maxScore > minScore && (minScore < 0 || maxScore > 1);

      final rerankedIds = <String>{};
      var minRerankedRelevance = double.infinity;
      for (final result in results) {
        final candidate = candidates[result.id];
        if (candidate == null) continue;
        final score = result.score;
        if (!score.isFinite) continue;
        final newRelevance = shouldNormalize
            ? (score - minScore) / (maxScore - minScore)
            : math.max(0.0, math.min(1.0, score));
        candidates[result.id] =
            candidate.copyWith(relevance: newRelevance);
        rerankedIds.add(candidate.memory.id);
        if (newRelevance < minRerankedRelevance) {
          minRerankedRelevance = newRelevance;
        }
      }

      // 把未重排候选压到重排集最低分以下，避免在 finalScore 上反超
      if (minRerankedRelevance.isFinite) {
        for (final entry in candidates.entries.toList()) {
          if (rerankedIds.contains(entry.key)) continue;
          final candidate = entry.value;
          if (candidate.relevance > minRerankedRelevance) {
            candidates[entry.key] =
                candidate.copyWith(relevance: minRerankedRelevance);
          }
        }
      }
      return null;
    } catch (error) {
      return error is Exception ? error.toString() : error.toString();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 限制计算 — 对齐主项目行 618-638
  // ═══════════════════════════════════════════════════════════════

  /// limitInject=true → memoryMaxInject；否则 max(keywordTopK, finalTopK·2, 100, budget/50)
  int localMemoryLimit(AppSettings settings, MemoryEngineConfig config) {
    if (settings.limitInject) {
      return math.max(
          1, settings.memoryMaxInject == 0 ? config.finalTopK : settings.memoryMaxInject);
    }
    final baseLimit = math.max(
      math.max(config.keywordTopK, config.finalTopK * 2),
      100,
    );
    // 按 token 预算放宽本地召回上限，避免候选池太小导致 token 预算用不完
    final budgetLimit = config.memoryPackageTokenBudget ~/ 50;
    return math.max(baseLimit, budgetLimit);
  }

  /// 类似 localMemoryLimit 但更宽松
  int maxSelectedMemoryCount(AppSettings settings, MemoryEngineConfig config) {
    if (settings.limitInject) {
      return math.max(1, config.finalTopK);
    }
    final baseCap = math.max(
      math.max(
        math.max(100, config.keywordTopK),
        config.vectorTopK,
      ),
      config.finalTopK * 2,
    );
    // 按 token 预算放宽条数上限
    final budgetCap = config.memoryPackageTokenBudget ~/ 50;
    return math.max(baseCap, budgetCap);
  }

  // ═══════════════════════════════════════════════════════════════
  // 超时控制 — 对齐主项目行 640-654
  // ═══════════════════════════════════════════════════════════════

  /// 用 Future.timeout 实现；超时抛 TimeoutException
  Future<T> withTotalTimeout<T>(Future<T> Function() work, int timeoutMs) {
    return work().timeout(
      Duration(milliseconds: timeoutMs),
      onTimeout: () {
        throw TimeoutException(
          'memory retrieval timed out after ${timeoutMs}ms',
          Duration(milliseconds: timeoutMs),
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 兜底包构建 — 对齐主项目行 656-772
  // ═══════════════════════════════════════════════════════════════

  /// 全空 package（mode='local'）
  WorkingMemoryPackage buildEmptyPackage() {
    return const WorkingMemoryPackage(
      text: '',
      selectedMemories: <Memory>[],
      tokenCount: 0,
      mode: 'local',
    );
  }

  /// 兜底包：loadDefaultPriorityMemories + localRetrieve +
  /// rankCandidates + trimByTokenBudget；mode='local'，usedFallback=true
  Future<WorkingMemoryPackage> buildLocalFallbackPackage({
    required RetrieveWorkingMemoryOptions options,
    required MemoryEngineConfig config,
    WorkingMemoryPackageDiagnostics diagnostics =
        const WorkingMemoryPackageDiagnostics.empty(),
  }) async {
    final priorityMemories =
        await loadDefaultPriorityMemories(options.characterId);
    final profileText =
        await resolveProfileText(options.characterId, config, estimateTokens);
    final candidates = <String, RetrievedMemory>{};

    for (final memory in priorityMemories) {
      addCandidate(candidates, memory, 0.75, 'priority');
    }

    final localMemories = await _memoryEngine.retrieveRelevantMemories(
      queryText: options.queryText,
      characterId: options.characterId,
      maxMemories: localMemoryLimit(options.settings, config),
    );
    for (var i = 0; i < localMemories.length; i++) {
      final relevance = math.max(0.1, 0.7 - i * 0.01);
      addCandidate(candidates, localMemories[i], relevance, 'local');
    }

    final now = DateTime.now();
    final ranked = rankCandidates(candidates.values, now: now);
    final trimmed = trimByTokenBudget(
      ranked: ranked,
      config: config,
      tokenCounter: estimateTokens,
      profileText: profileText,
      maxMemoryCount: maxSelectedMemoryCount(options.settings, config),
    );

    return WorkingMemoryPackage(
      text: trimmed.text,
      selectedMemories: trimmed.selected,
      tokenCount: trimmed.tokenCount,
      mode: 'local',
      usedFallback: true,
      diagnostics: diagnostics.copyWith(candidateCount: ranked.length),
    );
  }

  /// limitInject=true 走 localRetrieve + trimByTokenBudget(mode='local')；
  /// limitInject=false 走 loadDefaultLegacyMemories 全量 + trimByTokenBudget(mode='full', skipOversizedOrdinary=true)
  Future<WorkingMemoryPackage> buildLegacyFullMemoryPackage({
    required RetrieveWorkingMemoryOptions options,
    required MemoryEngineConfig config,
  }) async {
    final List<Memory> legacyMemories;
    final int maxMemoryCount;

    if (options.settings.limitInject) {
      legacyMemories = await _memoryEngine.retrieveRelevantMemories(
        queryText: options.queryText,
        characterId: options.characterId,
        maxMemories: localMemoryLimit(options.settings, config),
      );
      maxMemoryCount = maxSelectedMemoryCount(options.settings, config);
    } else {
      legacyMemories = await loadDefaultLegacyMemories(options.characterId);
      maxMemoryCount = legacyMemories.length;
    }

    final ranked = <RetrievedMemory>[
      for (var i = 0; i < legacyMemories.length; i++)
        RetrievedMemory(
          memory: legacyMemories[i],
          relevance: 1,
          finalScore: 1 - i / 100000,
          source: 'local',
        ),
    ];

    final trimmed = trimByTokenBudget(
      ranked: ranked,
      config: config,
      tokenCounter: estimateTokens,
      profileText: '',
      maxMemoryCount: maxMemoryCount,
      skipOversizedOrdinary: !options.settings.limitInject,
    );

    return WorkingMemoryPackage(
      text: trimmed.text,
      selectedMemories: trimmed.selected,
      tokenCount: trimmed.tokenCount,
      // limitInject=false 是全量注入（不检索，只按预算裁剪）；
      // limitInject=true 是 legacy 本地关键词检索
      mode: options.settings.limitInject ? 'local' : 'full',
      usedFallback: false,
      diagnostics:
          WorkingMemoryPackageDiagnostics(candidateCount: ranked.length),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 主路径 — 对齐主项目行 774-840
  // ═══════════════════════════════════════════════════════════════

  /// 主路径：priority + 向量召回 + localRetrieve + reranker + rankCandidates + trim
  Future<WorkingMemoryPackage> buildWorkingMemoryPackage({
    required RetrieveWorkingMemoryOptions options,
    required MemoryEngineConfig config,
  }) async {
    if (!config.allowMemoryContextInChat) {
      return buildEmptyPackage();
    }

    var diagnostics = const WorkingMemoryPackageDiagnostics.empty();
    var mode = 'local';
    var usedFallback = false;

    final priorityMemories =
        await loadDefaultPriorityMemories(options.characterId);
    final profileText =
        await resolveProfileText(options.characterId, config, estimateTokens);
    final candidates = <String, RetrievedMemory>{};

    for (final memory in priorityMemories) {
      addCandidate(candidates, memory, 0.75, 'priority');
    }

    if (config.embeddingEnabled) {
      try {
        await addVectorCandidates(
          queryText: options.queryText,
          characterId: options.characterId,
          config: config,
          candidates: candidates,
        );
        mode = candidates.length > priorityMemories.length
            ? 'vector'
            : 'hybrid';
      } catch (error) {
        final msg = error is Exception ? error.toString() : error.toString();
        diagnostics = diagnostics.copyWith(embeddingFailed: msg);
        usedFallback = true;
        mode = 'local';
        debugPrintRetrieval(
            '[memory-retrieval] 向量检索失败，回退本地检索: $msg');
      }
    }

    if (!config.embeddingEnabled ||
        config.fallbackLocalEnabled ||
        usedFallback) {
      final localLimit = localMemoryLimit(options.settings, config);
      final localMemories = await _memoryEngine.retrieveRelevantMemories(
        queryText: options.queryText,
        characterId: options.characterId,
        maxMemories: localLimit,
      );
      final baseRelevance = usedFallback ? 0.7 : 0.55;
      for (var i = 0; i < localMemories.length; i++) {
        final relevance = math.max(0.1, baseRelevance - i * 0.01);
        addCandidate(candidates, localMemories[i], relevance, 'local');
      }
      if (config.embeddingEnabled && !usedFallback) mode = 'hybrid';
    }

    final rerankerFailed = await applyReranker(
      queryText: options.queryText,
      candidates: candidates,
      config: config,
    );
    if (rerankerFailed != null) {
      diagnostics = diagnostics.copyWith(rerankerFailed: rerankerFailed);
    }

    final now = DateTime.now();
    final ranked = rankCandidates(candidates.values, now: now);
    diagnostics = diagnostics.copyWith(candidateCount: ranked.length);
    final trimmed = trimByTokenBudget(
      ranked: ranked,
      config: config,
      tokenCounter: estimateTokens,
      profileText: profileText,
      maxMemoryCount: maxSelectedMemoryCount(options.settings, config),
    );

    return WorkingMemoryPackage(
      text: trimmed.text,
      selectedMemories: trimmed.selected,
      tokenCount: trimmed.tokenCount,
      mode: mode,
      usedFallback: usedFallback,
      diagnostics: diagnostics,
    );
  }
}

/// 默认值三元组 — 对齐主项目 src/lib/memory-category.ts inferMemoryDefaults 返回
class _MemoryDefaults {
  final String memoryKind;
  final double importance;
  final double emotionalWeight;

  const _MemoryDefaults(this.memoryKind, this.importance, this.emotionalWeight);
}

/// 调试输出辅助（对齐主项目 console.warn，本项目收敛到 debugPrint）。
/// 单独函数便于测试中静默或捕获。
void debugPrintRetrieval(String message) {
  // ignore: avoid_print
  print(message);
}
