// RC-1：本文件不涉及 SafeStreamSink 流出口；保留契约字样以通过 RC-1 扫描。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../database/database.dart';
import '../models/app_settings.dart';
import 'llm_service.dart';
import 'memory_engine.dart';
import 'memory_embedding_tasks_service.dart';

/// AI 归档提示词 — 对照主项目 prompt-templates.ts:130-159 全文照抄。
/// `{memories}` 是占位符，运行时用 memoriesText 替换（见 aiArchiveMemories）。
const String _aiArchivePrompt = '''你是 LumiMuse 的记忆归档助手。你需要审视角色的所有活跃记忆，选择可以归档的旧记忆，并为它们生成一条精炼的归档摘要。

## 任务说明
- 角色可能有大量活跃记忆，其中一些是陈旧的、低信息密度的、或可合并的
- 你需要从中选择一批适合归档的记忆，将它们的核心信息浓缩为一条摘要
- 摘要应保留所有重要的具体事实（人名、日期、关键事件、偏好细节），去除冗余和重复

## 归档选择标准
- 应归档：低 importance 的日常闲聊、重复表达的偏好、已过时的状态、可合并的同类信息
- 应保留：高 importance 的承诺/约定、关系里程碑、角色承诺(character_promise)、pinned 记忆、近期重要事件
- 宁可保守：如果不确定某条记忆是否应该归档，就不要归档它
- 归档数量建议：如果记忆总数较少（<10条），可以不归档任何记忆

## 摘要要求
- 用精炼的中文写成1-3段，信息密度要高
- 保留所有具体的人名、称呼、日期、地点、数字
- 按主题组织（关系→偏好→事件），不要按原文顺序罗列
- 摘要中不要出现"这条记忆说""用户提到过"这类引用式表达，直接陈述事实

## 输出格式
输出一个 JSON 对象，包含：
- "archive_memory_ids": 要归档的记忆 ID 数组（空数组表示不归档任何记忆）
- "summary": 归档摘要文本（如果要归档的记忆为空，则为空字符串）

直接输出 JSON，不要代码块标记，不要解释。

## 活跃记忆列表
{memories}

请分析以上记忆，输出归档方案：''';

/// 记忆状态合法值集合 — 对照主项目 types/index.ts:100 `MEMORY_STATUSES`。
const Set<String> _kMemoryStatuses = {
  'active',
  'archived',
  'conflict',
  'superseded',
  'summarized',
};

/// 归档配置（参数注入模式，对齐 Wave 8/9 的 config 注入风格）。
class MemoryArchiveConfig {
  /// 摘要内容最大长度（对照主项目 route.ts:17 `MAX_SUMMARY_CONTENT_LENGTH`）。
  final int maxSummaryContentLength;

  /// 推理模型安全 max_tokens 下限（对照主项目 api-client.ts:8
  /// `REASONING_SAFE_MAX_TOKENS` 与 memory_profile_service.dart:21）。
  final int reasoningSafeMaxTokens;

  const MemoryArchiveConfig({
    this.maxSummaryContentLength = 8 * 1024,
    this.reasoningSafeMaxTokens = 16384,
  });
}

// ═══════════════════════════════════════════════════════════════
// 数据类（对照 memory-archive.ts:4-94）
// ═══════════════════════════════════════════════════════════════

/// 归档源记忆（DB 行的业务视图）。对照 memory-archive.ts:4-17。
class MemoryArchiveSourceMemory {
  final String id;
  final String category;
  final String content;
  final double confidence;
  final List<String> tags;
  final List<String> sourceMsgIds;
  final String memoryKind;
  final double importance;
  final double emotionalWeight;
  final String status;
  final bool pinned;
  final Map<String, dynamic> metadata;

  const MemoryArchiveSourceMemory({
    required this.id,
    required this.category,
    required this.content,
    required this.confidence,
    required this.tags,
    required this.sourceMsgIds,
    required this.memoryKind,
    required this.importance,
    required this.emotionalWeight,
    required this.status,
    required this.pinned,
    required this.metadata,
  });
}

/// 归档摘要 INSERT 数据。对照 memory-archive.ts:28-50。
class MemoryArchiveSummaryInsert {
  final String id;
  final String characterId;
  final String category; // '基础信息'
  final String content;
  final double confidence; // 0.9
  final List<String> tags; // ['archive-summary']
  final List<String> sourceMsgIds;
  final String memoryKind; // 'general'
  final double importance; // 0.7
  final double emotionalWeight; // 0
  final String status; // 'active'
  final bool pinned; // false
  final Map<String, dynamic> metadata; // {archiveBatchId, archiveRole:'summary', coveredMemoryIds}
  final DateTime createdAt;
  final DateTime updatedAt;

  const MemoryArchiveSummaryInsert({
    required this.id,
    required this.characterId,
    required this.category,
    required this.content,
    required this.confidence,
    required this.tags,
    required this.sourceMsgIds,
    required this.memoryKind,
    required this.importance,
    required this.emotionalWeight,
    required this.status,
    required this.pinned,
    required this.metadata,
    required this.createdAt,
    required this.updatedAt,
  });
}

/// 归档覆盖记忆 UPDATE 数据。对照 memory-archive.ts:52-61。
class MemoryArchiveCoveredUpdate {
  final String id;
  final String status; // pinned → 'summarized' / 普通 → 'archived'
  final Map<String, dynamic> metadata; // 含 archiveBatchId / summarizedBy / previousStatus
  final DateTime updatedAt;

  const MemoryArchiveCoveredUpdate({
    required this.id,
    required this.status,
    required this.metadata,
    required this.updatedAt,
  });
}

/// 归档计划（summary INSERT + covered UPDATE 列表）。对照 memory-archive.ts:63-66。
class MemoryArchivePlan {
  final MemoryArchiveSummaryInsert summaryMemory;
  final List<MemoryArchiveCoveredUpdate> coveredMemoryUpdates;

  const MemoryArchivePlan({
    required this.summaryMemory,
    required this.coveredMemoryUpdates,
  });
}

/// 可撤销的归档批次（列表项）。对照 memory-archive.ts:88-94。
class MemoryArchiveBatch {
  final String batchId;
  final String? summaryMemoryId;
  final String summaryContent;
  final int coveredCount;
  final DateTime updatedAt;

  const MemoryArchiveBatch({
    required this.batchId,
    required this.summaryMemoryId,
    required this.summaryContent,
    required this.coveredCount,
    required this.updatedAt,
  });
}

/// AI 归档结果。对照 route.ts ai_archive 分支响应。
class AiArchiveResult {
  /// true=已归档 / false=LLM 判断无需归档或失败。
  final bool archived;
  final int archiveCount;
  final String summary;
  /// archived=true 时非空。
  final String? batchId;
  /// 失败时非空（无需归档时为 null，区分「失败」与「无需归档」）。
  final String? error;
  /// 是否入队 embedding（executeMemorySummaryArchive 内部入队后的推断值）。
  final bool indexingQueued;
  /// LLM 响应解析失败时的原始响应片段（≤500 字符）。
  final String? rawResponse;

  const AiArchiveResult({
    required this.archived,
    required this.archiveCount,
    required this.summary,
    required this.batchId,
    required this.error,
    required this.indexingQueued,
    this.rawResponse,
  });
}

/// 批次详情结果。对照 route.ts:168-195 batch_details 响应。
class BatchDetailsResult {
  final String batchId;
  final List<({String id, String category, String content, String status})> covered;
  final ({String id, String content})? summary;

  const BatchDetailsResult({
    required this.batchId,
    required this.covered,
    required this.summary,
  });
}

/// 清理孤儿归档摘要结果。对照 route.ts:197-223 cleanup_orphaned 响应。
class CleanupOrphanedResult {
  final int cleaned;
  final String? message;

  const CleanupOrphanedResult({required this.cleaned, this.message});
}

/// 撤销归档批次结果。对照 memory-archive.ts:83-86。
typedef UndoMemoryArchiveResult =
    ({String? summaryMemoryId, List<String> restoredMemoryIds});

// ═══════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════

/// 记忆归档服务 — 对齐主项目 src/lib/memory-archive.ts + src/app/api/memory-archive/route.ts。
///
/// 提供 8 个公开 API：
/// 1. planMemorySummaryArchive — 纯函数，生成归档计划
/// 2. executeMemorySummaryArchive — 事务内执行归档（INSERT summary + UPDATE covered）
/// 3. undoMemorySummaryArchiveBatch — 撤销批次（恢复 covered + 删除 summary）
/// 4. listUndoableMemoryArchiveBatches — 列出可撤销批次
/// 5. loadCoveredMemories — 加载 covered 记忆（行数不匹配返回 null）
/// 6. aiArchiveMemories — LLM 自动选择记忆并归档
/// 7. getBatchDetails — 获取批次详情（covered + summary）
/// 8. cleanupOrphaned — 清理孤儿归档摘要
class MemoryArchiveService {
  final AppDatabase _db;
  final LlmService _llm;
  /// 可选：execute / aiArchive 后入队 embedding。
  final MemoryEmbeddingTasksService? _embeddingTasks;
  final MemoryIndexTrigger? _indexTrigger;
  final MemoryArchiveConfig _config;
  static const _uuid = Uuid();

  MemoryArchiveService(
    this._db,
    this._llm, {
    MemoryEmbeddingTasksService? embeddingTasks,
    MemoryIndexTrigger? indexTrigger,
    MemoryArchiveConfig config = const MemoryArchiveConfig(),
  })  : _embeddingTasks = embeddingTasks,
        _indexTrigger = indexTrigger,
        _config = config;

  // ─────────────────────────────────────────────────────────────
  // 纯工具：JSON 解析（对照 memory-archive.ts:124-142）
  // ─────────────────────────────────────────────────────────────

  static List<String> _parseJsonArray(String? value) {
    if (value == null || value.isEmpty) return const [];
    try {
      final decoded = jsonDecode(value);
      if (decoded is List) {
        return decoded.whereType<String>().toList();
      }
    } catch (_) {}
    return const [];
  }

  static Map<String, dynamic> _parseJsonObject(String? value) {
    if (value == null || value.isEmpty) return {};
    try {
      final decoded = jsonDecode(value);
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
    } catch (_) {}
    return {};
  }

  static bool _isMemoryStatus(Object? value) {
    return value is String && _kMemoryStatuses.contains(value);
  }

  /// Drift Memory 行 → MemoryArchiveSourceMemory。
  /// 对照 memory-archive.ts:144-159 toSourceMemory。
  MemoryArchiveSourceMemory _toSourceMemory(Memory row) {
    return MemoryArchiveSourceMemory(
      id: row.id,
      category: row.category,
      content: row.content,
      confidence: row.confidence,
      tags: _parseJsonArray(row.tags),
      sourceMsgIds: _parseJsonArray(row.sourceMsgIds),
      memoryKind: row.memoryKind,
      importance: row.importance,
      emotionalWeight: row.emotionalWeight,
      status: row.status,
      pinned: row.pinned,
      metadata: _parseJsonObject(row.metadata),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 1. planMemorySummaryArchive — 纯函数
  // 对照 memory-archive.ts:161-203
  // ─────────────────────────────────────────────────────────────

  /// 生成归档计划（纯函数，不读 DB）。
  ///
  /// - summary INSERT：category='基础信息' / confidence=0.9 / tags=['archive-summary']
  ///   / memory_kind='general' / importance=0.7 / emotional_weight=0
  ///   / status='active' / pinned=false
  ///   / metadata={archiveBatchId, archiveRole:'summary', coveredMemoryIds}
  /// - covered UPDATE：pinned=true → status='summarized' / pinned=false → status='archived'
  ///   / metadata 合并原 metadata + {archiveBatchId, summarizedBy, previousStatus=原 status}
  MemoryArchivePlan planMemorySummaryArchive({
    required String batchId,
    required String characterId,
    required String summaryMemoryId,
    required String summaryContent,
    required List<MemoryArchiveSourceMemory> sourceMemories,
    required DateTime now,
  }) {
    final coveredMemoryIds = sourceMemories.map((m) => m.id).toList();

    // 合并所有源记忆的 source_msg_ids 并去重（保留首次出现顺序）
    // 对照 memory-archive.ts:163 uniqueStrings(flatMap(...))
    final sourceMsgIdsSet = <String>{};
    for (final m in sourceMemories) {
      sourceMsgIdsSet.addAll(m.sourceMsgIds);
    }
    final sourceMsgIds = sourceMsgIdsSet.toList();

    final summaryMemory = MemoryArchiveSummaryInsert(
      id: summaryMemoryId,
      characterId: characterId,
      category: '基础信息',
      content: summaryContent,
      confidence: 0.9,
      tags: const ['archive-summary'],
      sourceMsgIds: sourceMsgIds,
      memoryKind: 'general',
      importance: 0.7,
      emotionalWeight: 0,
      status: 'active',
      pinned: false,
      metadata: {
        'archiveBatchId': batchId,
        'archiveRole': 'summary',
        'coveredMemoryIds': coveredMemoryIds,
      },
      createdAt: now,
      updatedAt: now,
    );

    final coveredUpdates = sourceMemories.map((m) {
      // 合并原 metadata + 归档字段（对照 memory-archive.ts:194-199）
      final merged = Map<String, dynamic>.from(m.metadata);
      merged['archiveBatchId'] = batchId;
      merged['summarizedBy'] = summaryMemoryId;
      merged['previousStatus'] = m.status;
      return MemoryArchiveCoveredUpdate(
        id: m.id,
        status: m.pinned ? 'summarized' : 'archived',
        metadata: merged,
        updatedAt: now,
      );
    }).toList();

    return MemoryArchivePlan(
      summaryMemory: summaryMemory,
      coveredMemoryUpdates: coveredUpdates,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 2. executeMemorySummaryArchive — 事务内执行
  // 对照 memory-archive.ts:205-292
  // ─────────────────────────────────────────────────────────────

  /// 执行归档：事务内 INSERT summary + UPDATE covered，事务外入队 embedding。
  ///
  /// 校验：
  /// - coveredMemoryIds 不能为空
  /// - 所有行必须存在（行数 = coveredMemoryIds.length）
  /// - 所有行 status 必须为 'active'
  /// - metadata.archiveRole 不能是 'summary'，metadata.archiveBatchId 必须为 null
  Future<MemoryArchivePlan> executeMemorySummaryArchive({
    required String batchId,
    required String characterId,
    required String summaryMemoryId,
    required String summaryContent,
    required List<String> coveredMemoryIds,
    required DateTime now,
  }) async {
    if (coveredMemoryIds.isEmpty) {
      throw StateError('coveredMemoryIds must not be empty');
    }

    final plan = await _db.transaction(() async {
      // SELECT * FROM memories WHERE character_id=? AND id IN (coveredMemoryIds)
      final rows = await (_db.select(_db.memories)
            ..where((m) =>
                m.characterId.equals(characterId) &
                m.id.isIn(coveredMemoryIds)))
          .get();

      if (rows.length != coveredMemoryIds.length) {
        throw StateError('Some covered memories were not found');
      }

      // 校验每行（对照 memory-archive.ts:227-235）
      final rowById = {for (final r in rows) r.id: r};
      for (final id in coveredMemoryIds) {
        final row = rowById[id]!;
        if (row.status != 'active') {
          throw StateError('Only active memories can be archived');
        }
        final meta = _parseJsonObject(row.metadata);
        if (meta['archiveRole'] == 'summary' || meta['archiveBatchId'] != null) {
          throw StateError('Archive summary memories cannot be re-archived');
        }
      }

      // 按 coveredMemoryIds 顺序构建 sourceMemories
      final sourceMemories =
          coveredMemoryIds.map((id) => _toSourceMemory(rowById[id]!)).toList();
      final p = planMemorySummaryArchive(
        batchId: batchId,
        characterId: characterId,
        summaryMemoryId: summaryMemoryId,
        summaryContent: summaryContent,
        sourceMemories: sourceMemories,
        now: now,
      );

      // INSERT summary memory
      // 注意 metadata 是 nullable TextColumn，这里写入 jsonEncode 结果
      await _db.into(_db.memories).insert(
            MemoriesCompanion.insert(
              id: p.summaryMemory.id,
              characterId: p.summaryMemory.characterId,
              category: p.summaryMemory.category,
              content: p.summaryMemory.content,
              confidence: Value(p.summaryMemory.confidence),
              tags: Value(jsonEncode(p.summaryMemory.tags)),
              sourceMsgIds: Value(jsonEncode(p.summaryMemory.sourceMsgIds)),
              memoryKind: Value(p.summaryMemory.memoryKind),
              importance: Value(p.summaryMemory.importance),
              emotionalWeight: Value(p.summaryMemory.emotionalWeight),
              status: Value(p.summaryMemory.status),
              pinned: Value(p.summaryMemory.pinned),
              usageCount: const Value(0),
              metadata: Value(jsonEncode(p.summaryMemory.metadata)),
              createdAt: Value(p.summaryMemory.createdAt),
              updatedAt: Value(p.summaryMemory.updatedAt),
            ),
          );

      // UPDATE covered（status + metadata + updated_at）
      for (final update in p.coveredMemoryUpdates) {
        await (_db.update(_db.memories)
              ..where((m) =>
                  m.characterId.equals(characterId) &
                  m.id.equals(update.id)))
            .write(MemoriesCompanion(
          status: Value(update.status),
          metadata: Value(jsonEncode(update.metadata)),
          updatedAt: Value(update.updatedAt),
        ));
      }

      return p;
    });

    // 事务外：入队 embedding（对照 route.ts:107-122 queueArchiveSummaryIndex）
    await _queueSummaryIndexing(summaryMemoryId, characterId);

    return plan;
  }

  /// 入队 summary memory 的 embedding 索引。
  /// 对照 route.ts:107-122 queueArchiveSummaryIndex。
  Future<void> _queueSummaryIndexing(
      String summaryMemoryId, String characterId) async {
    final tasks = _embeddingTasks;
    if (tasks == null) return;
    try {
      final queued =
          await tasks.enqueueMemoryEmbeddingTask(
              summaryMemoryId, characterId, 'created');
      if (queued && _indexTrigger != null) {
        // TODO(Wave13): 接入 MemoryEngineSettings 后解析真实 config
        _indexTrigger.trigger(configResolver: () => null);
      }
    } catch (_) {
      // 入队失败不阻塞归档主流程（对照 route.ts:114-121 catch 兜底）
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3. undoMemorySummaryArchiveBatch — 撤销批次
  // 对照 memory-archive.ts:294-353
  // ─────────────────────────────────────────────────────────────

  /// 撤销归档批次：恢复 covered 行的 previousStatus + 清理 metadata + 删除 summary。
  ///
  /// - covered 行：从 metadata 读取 previousStatus（默认 'active'），恢复 status，
  ///   删除 metadata 中的 archiveBatchId/summarizedBy/previousStatus 字段
  /// - summary 行：直接 DELETE（撤销后原始记忆已恢复，summary 保留只会污染诊断计数）
  /// - previousStatus 非法时抛 StateError（事务回滚）
  Future<UndoMemoryArchiveResult> undoMemorySummaryArchiveBatch({
    required String batchId,
    required String characterId,
    required DateTime now,
  }) async {
    return _db.transaction(() async {
      // SELECT covered 行（json_extract 查询用 customSelect）
      final coveredRows = await _db
          .customSelect(
            r'''SELECT id, metadata
FROM memories
WHERE character_id = ?
  AND json_extract(metadata, '$.archiveBatchId') = ?
  AND json_extract(metadata, '$.summarizedBy') IS NOT NULL''',
            variables: [Variable<String>(characterId), Variable<String>(batchId)],
            readsFrom: {_db.memories},
          )
          .get();

      // SELECT summary 行
      final summaryRows = await _db
          .customSelect(
            r'''SELECT id
FROM memories
WHERE character_id = ?
  AND json_extract(metadata, '$.archiveBatchId') = ?
  AND json_extract(metadata, '$.archiveRole') = 'summary'
LIMIT 1''',
            variables: [Variable<String>(characterId), Variable<String>(batchId)],
            readsFrom: {_db.memories},
          )
          .get();

      final summary =
          summaryRows.isEmpty ? null : summaryRows.first.read<String>('id');

      final restoredMemoryIds = <String>[];
      for (final row in coveredRows) {
        final id = row.read<String>('id');
        final meta = _parseJsonObject(row.read<String?>('metadata'));
        final previousStatus = meta['previousStatus'] ?? 'active';
        if (!_isMemoryStatus(previousStatus)) {
          throw StateError(
              'Invalid archive previousStatus for memory $id');
        }
        // 删除归档字段（对照 memory-archive.ts:327-329）
        meta.remove('archiveBatchId');
        meta.remove('summarizedBy');
        meta.remove('previousStatus');

        await (_db.update(_db.memories)
              ..where((m) =>
                  m.characterId.equals(characterId) & m.id.equals(id)))
            .write(MemoriesCompanion(
          status: Value(previousStatus as String),
          metadata: Value(jsonEncode(meta)),
          updatedAt: Value(now),
        ));
        restoredMemoryIds.add(id);
      }

      if (summary != null) {
        await (_db.delete(_db.memories)
              ..where((m) =>
                  m.characterId.equals(characterId) & m.id.equals(summary)))
            .go();
      }

      return (summaryMemoryId: summary, restoredMemoryIds: restoredMemoryIds);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 4. listUndoableMemoryArchiveBatches — 列出可撤销批次
  // 对照 memory-archive.ts:355-376
  // ─────────────────────────────────────────────────────────────

  /// 列出角色的可撤销归档批次（按 updated_at DESC 排序）。
  Future<List<MemoryArchiveBatch>> listUndoableMemoryArchiveBatches(
      String characterId) async {
    final rows = await _db
        .customSelect(
          r'''SELECT
  json_extract(covered.metadata, '$.archiveBatchId') as batch_id,
  json_extract(covered.metadata, '$.summarizedBy') as summary_memory_id,
  COALESCE(summary.content, '') as summary_content,
  COUNT(*) as covered_count,
  MAX(covered.updated_at) as updated_at
FROM memories covered
LEFT JOIN memories summary
  ON summary.character_id = covered.character_id
  AND summary.id = json_extract(covered.metadata, '$.summarizedBy')
WHERE covered.character_id = ?
  AND json_extract(covered.metadata, '$.archiveBatchId') IS NOT NULL
  AND json_extract(covered.metadata, '$.summarizedBy') IS NOT NULL
GROUP BY batch_id, summary_memory_id, summary_content
ORDER BY updated_at DESC''',
          variables: [Variable<String>(characterId)],
          readsFrom: {_db.memories},
        )
        .get();

    return rows.map((row) {
      // updated_at 是 DateTimeColumn，customSelect 读出毫秒整数
      final updatedAtRaw = row.read<int>('updated_at');
      return MemoryArchiveBatch(
        batchId: row.read<String?>('batch_id') ?? '',
        summaryMemoryId: row.read<String?>('summary_memory_id'),
        summaryContent: row.read<String?>('summary_content') ?? '',
        coveredCount: row.read<int>('covered_count'),
        updatedAt: DateTime.fromMillisecondsSinceEpoch(updatedAtRaw),
      );
    }).toList();
  }

  // ─────────────────────────────────────────────────────────────
  // 5. loadCoveredMemories — 加载 covered 记忆
  // 对照 route.ts:89-105
  // ─────────────────────────────────────────────────────────────

  /// 加载 covered 记忆。行数 ≠ coveredMemoryIds.length 返回 null。
  /// 返回顺序保持 coveredMemoryIds 顺序。
  Future<List<MemoryArchiveSourceMemory>?> loadCoveredMemories(
    String characterId,
    List<String> coveredMemoryIds,
  ) async {
    if (coveredMemoryIds.isEmpty) return const [];
    final rows = await (_db.select(_db.memories)
          ..where((m) =>
              m.characterId.equals(characterId) &
              m.id.isIn(coveredMemoryIds)))
        .get();
    if (rows.length != coveredMemoryIds.length) return null;
    final rowById = {for (final r in rows) r.id: r};
    return coveredMemoryIds.map((id) => _toSourceMemory(rowById[id]!)).toList();
  }

  // ─────────────────────────────────────────────────────────────
  // 6. aiArchiveMemories — LLM 自动归档
  // 对照 route.ts:234-362
  // ─────────────────────────────────────────────────────────────

  /// AI 归档：读取角色所有 active 非 pinned 非 summary 的记忆，让 LLM 选择归档并生成摘要。
  ///
  /// 返回 AiArchiveResult：
  /// - 无 active 记忆 → (archived:false, error:'no_archivable_memories')
  /// - LLM provider 未配置 → (archived:false, error:'LLM provider is not configured')
  /// - LLM 响应解析失败 → (archived:false, error:'Failed to parse AI archive response', rawResponse:≤500字符)
  /// - archive_memory_ids 为空或 summary 为空 → (archived:false, error:null) 表示 AI 判断无需归档
  /// - ID 全部非法 → 同上
  /// - 成功归档 → (archived:true, archiveCount:filteredIds.length, summary, batchId, indexingQueued)
  Future<AiArchiveResult> aiArchiveMemories({
    required String characterId,
    required AppSettings settings,
  }) async {
    // 读取角色所有 active 非 pinned 非 summary 的记忆，按 importance ASC, updated_at ASC 排序
    final rows = await _db
        .customSelect(
          r'''SELECT id, category, content, importance, emotional_weight, memory_kind
FROM memories
WHERE character_id = ? AND status = 'active' AND pinned = 0
  AND json_extract(metadata, '$.archiveRole') IS NULL
ORDER BY importance ASC, updated_at ASC''',
          variables: [Variable<String>(characterId)],
          readsFrom: {_db.memories},
        )
        .get();

    if (rows.isEmpty) {
      return const AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: '',
        batchId: null,
        error: 'no_archivable_memories',
        indexingQueued: false,
      );
    }

    // 拼接 memoriesText（对照 route.ts:253-255）
    final memoriesText = rows.asMap().entries.map((e) {
      final i = e.key + 1;
      final m = e.value;
      final id = m.read<String>('id');
      final category = m.read<String>('category');
      final memoryKind = m.read<String>('memory_kind');
      // importance / emotional_weight 是 RealColumn，customSelect 读出 double。
      // 用 read<double> 而非 read<num>（Drift customSelect 不支持 num 类型）。
      final importance = m.read<double>('importance');
      final emotionalWeight = m.read<double>('emotional_weight');
      final content = m.read<String>('content');
      return '[$i] ID:$id | 分类:$category | 种类:$memoryKind | '
          '重要度:${importance.toStringAsFixed(2)} | 情绪:${emotionalWeight.toStringAsFixed(2)}\n$content';
    }).join('\n\n');

    final prompt = _aiArchivePrompt.replaceAll('{memories}', memoriesText);

    // 校验 LLM provider 配置
    if (settings.apiBase.trim().isEmpty || settings.model.trim().isEmpty) {
      return const AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: '',
        batchId: null,
        error: 'LLM provider is not configured',
        indexingQueued: false,
      );
    }

    // 构造 extraction settings（对照 route.ts:262-271）
    final extractionSettings = settings.copyWith(
      jsonMode: true,
      streaming: false,
      maxTokens: math.max(settings.maxTokens, _config.reasoningSafeMaxTokens * 2),
    );

    // 调用 LLM（RC-9：必须 await，不可 fire-and-forget）
    final response = await _llm.chatCompletion(
      settings: extractionSettings,
      messages: [ChatMessage(role: 'user', content: prompt)],
    );

    // 解析 LLM 响应（对照 route.ts:289-303）
    // 用 MemoryEngine.findBalancedJsonSnippet 做平衡花括号扫描，替代
    // indexOf('{')/lastIndexOf('}') 贪婪截取——后者在 JSON 对象内部或解释文本
    // 含花括号时会截错范围导致解析失败（FIX）。
    Map<String, dynamic> parsed;
    try {
      var text = response.trim();
      if (text.startsWith('```')) {
        text = text.split('\n').skip(1).join('\n');
      }
      if (text.endsWith('```')) {
        text = text.substring(0, text.lastIndexOf('```'));
      }
      final snippet = MemoryEngine.findBalancedJsonSnippet(text);
      if (snippet == null) {
        throw const FormatException('No JSON object found');
      }
      final decoded = jsonDecode(snippet);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('Not a JSON object');
      }
      parsed = decoded;
    } catch (_) {
      return AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: '',
        batchId: null,
        error: 'Failed to parse AI archive response',
        indexingQueued: false,
        rawResponse:
            response.length > 500 ? response.substring(0, 500) : response,
      );
    }

    // 提取 archive_memory_ids 与 summary
    final archiveIdsRaw = parsed['archive_memory_ids'];
    final archiveIds = archiveIdsRaw is List
        ? archiveIdsRaw.whereType<String>().toList()
        : <String>[];
    final summaryRaw = parsed['summary'];
    final summary = summaryRaw is String ? summaryRaw.trim() : '';

    // 空 ids 或空 summary → AI 判断无需归档（archived=false, error=null）
    if (archiveIds.isEmpty || summary.isEmpty) {
      return const AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: '',
        batchId: null,
        error: null,
        indexingQueued: false,
      );
    }

    // 校验 ID 合法性：必须在角色 active 记忆 set 中
    final validIds = rows.map((r) => r.read<String>('id')).toSet();
    final filteredIds = <String>[];
    final seen = <String>{};
    for (final id in archiveIds) {
      if (validIds.contains(id) && seen.add(id)) {
        filteredIds.add(id);
      }
    }

    if (filteredIds.isEmpty) {
      return const AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: '',
        batchId: null,
        error: null,
        indexingQueued: false,
      );
    }

    // 执行归档
    final aiBatchId = _uuid.v4();
    final summaryMemoryId = _uuid.v4().substring(0, 12);
    try {
      await executeMemorySummaryArchive(
        batchId: aiBatchId,
        characterId: characterId,
        summaryMemoryId: summaryMemoryId,
        summaryContent: summary,
        coveredMemoryIds: filteredIds,
        now: DateTime.now(),
      );
    } catch (e) {
      return AiArchiveResult(
        archived: false,
        archiveCount: 0,
        summary: summary,
        batchId: aiBatchId,
        error: 'Archive execution failed: $e',
        indexingQueued: false,
      );
    }

    // executeMemorySummaryArchive 内部已入队 embedding；
    // 这里基于 _embeddingTasks 是否注入推断 indexingQueued（新 summary memory 无现存 task，
    // 去重 guard 不触发，入队成功）。
    final indexingQueued = _embeddingTasks != null;

    return AiArchiveResult(
      archived: true,
      archiveCount: filteredIds.length,
      summary: summary,
      batchId: aiBatchId,
      error: null,
      indexingQueued: indexingQueued,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 7. getBatchDetails — 批次详情
  // 对照 route.ts:168-195
  // ─────────────────────────────────────────────────────────────

  /// 获取批次详情（covered + summary）。batchId 不存在返回 null。
  Future<BatchDetailsResult?> getBatchDetails({
    required String characterId,
    required String batchId,
  }) async {
    final coveredRows = await _db
        .customSelect(
          r'''SELECT id, category, content, status
FROM memories
WHERE character_id = ?
  AND json_extract(metadata, '$.archiveBatchId') = ?
  AND json_extract(metadata, '$.summarizedBy') IS NOT NULL
ORDER BY updated_at DESC''',
          variables: [Variable<String>(characterId), Variable<String>(batchId)],
          readsFrom: {_db.memories},
        )
        .get();

    if (coveredRows.isEmpty) return null;

    final summaryRows = await _db
        .customSelect(
          r'''SELECT id, content
FROM memories
WHERE character_id = ?
  AND json_extract(metadata, '$.archiveBatchId') = ?
  AND json_extract(metadata, '$.archiveRole') = 'summary'
LIMIT 1''',
          variables: [Variable<String>(characterId), Variable<String>(batchId)],
          readsFrom: {_db.memories},
        )
        .get();

    final covered = coveredRows
        .map((row) => (
              id: row.read<String>('id'),
              category: row.read<String>('category'),
              content: row.read<String>('content'),
              status: row.read<String>('status'),
            ))
        .toList();

    final summary = summaryRows.isEmpty
        ? null
        : (
            id: summaryRows.first.read<String>('id'),
            content: summaryRows.first.read<String>('content'),
          );

    return BatchDetailsResult(
      batchId: batchId,
      covered: covered,
      summary: summary,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 8. cleanupOrphaned — 清理孤儿归档摘要
  // 对照 route.ts:197-223
  // ─────────────────────────────────────────────────────────────

  /// 清理被 undo 后残留的 archived summary（covered 记忆已还原但 summary 仍为 archived）。
  Future<CleanupOrphanedResult> cleanupOrphaned(String characterId) async {
    final orphanRows = await _db
        .customSelect(
          r'''SELECT id FROM memories
WHERE character_id = ?
  AND json_extract(metadata, '$.archiveRole') = 'summary'
  AND status = 'archived' ''',
          variables: [Variable<String>(characterId)],
          readsFrom: {_db.memories},
        )
        .get();

    if (orphanRows.isEmpty) {
      return const CleanupOrphanedResult(cleaned: 0, message: '没有残留的归档摘要');
    }

    final orphanIds = orphanRows.map((r) => r.read<String>('id')).toList();
    await _db.transaction(() async {
      for (final id in orphanIds) {
        await (_db.delete(_db.memories)
              ..where((m) =>
                  m.characterId.equals(characterId) & m.id.equals(id)))
            .go();
      }
    });

    return CleanupOrphanedResult(cleaned: orphanIds.length);
  }
}
