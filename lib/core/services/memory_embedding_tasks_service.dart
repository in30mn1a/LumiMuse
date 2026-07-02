// RC-1：本文件涉及 SSE 转发/多订阅分支时必须能 grep 到 SafeStreamSink（预留）。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../database/database.dart';
import 'memory_embeddings_service.dart';

/// 记忆索引处理被阻塞的原因枚举。
/// 对齐主项目 memory-index-trigger.ts:21-26 `MemoryIndexProcessingBlockedReason`。
enum MemoryIndexProcessingBlockedReason {
  memoryEngineDisabled,
  externalMemoryPayloadsDisabled,
  embeddingDisabled,
  embeddingApiBaseMissing,
  embeddingModelMissing,
}

/// 向量检索目标（按 provider/model/dimension 过滤 ready embedding）。
/// 对齐主项目 memory-embeddings.ts:59-63 `MemoryEmbeddingTarget`。
class MemoryEmbeddingTarget {
  final String? provider;
  final String? model;
  final int? dimension;

  const MemoryEmbeddingTarget({this.provider, this.model, this.dimension});

  /// 是否显式声明了 model 字段（null 表示未声明，与「声明为空字符串」不同）。
  /// 用于对齐主项目 `Object.prototype.hasOwnProperty.call(target, 'model')` 语义：
  /// 声明了但为空 → 强制 `1=0`（永不命中）；未声明 → 不加过滤条件。
  bool get hasModel => model != null;
}

/// 索引状态快照 — 对齐主项目 memory-embeddings.ts:50-57 `MemoryIndexStatus`。
class MemoryIndexStatus {
  final int total;
  final int ready;
  final int pending;
  final int processing;
  final int failed;
  final String? latestError;

  const MemoryIndexStatus({
    required this.total,
    required this.ready,
    required this.pending,
    required this.processing,
    required this.failed,
    this.latestError,
  });
}

/// 处理一批 embedding 任务的结果。
class ProcessedEmbeddingTasksResult {
  final int processed;
  final int failed;
  const ProcessedEmbeddingTasksResult(this.processed, this.failed);
}

/// 向量索引触发器常量 — 对齐主项目 memory-index-trigger.ts:10-15。
const int memoryIndexProcessBatchLimit = 8;
const int memoryIndexDrainMaxBatches = 32;
const int memoryIndexDrainMaxDurationMs = 25000;
const int memoryIndexMinEmbeddingTimeoutMs = 10000;
const int memoryIndexDrainRetryDelayMs = 30000;

/// 记忆嵌入任务队列服务 — 对齐主项目 memory-embeddings.ts 的 upsert/load/enqueue/
/// process/recover/retry/status 与 memory-index-trigger.ts 的触发/排空。
///
/// 纯 Drift 操作；HTTP 嵌入经 [MemoryEmbeddingsService] 注入或函数引用。
class MemoryEmbeddingTasksService {
  final AppDatabase _db;
  static const _uuid = Uuid();

  MemoryEmbeddingTasksService(this._db);

  // ─────────────────────────────────────────────────────────────────
  // upsert / load
  // ─────────────────────────────────────────────────────────────────

  /// 写入或更新一条 embedding（按 memory_id+provider+model+dimension 唯一）。
  /// 对齐主项目 memory-embeddings.ts:357-400 `upsertMemoryEmbedding`：
  /// - 先归一化向量，存 `normalized=1`；
  /// - dimension 取归一化后长度；
  /// - status 默认 'ready'；
  /// - 用 [insertOnConflictUpdate] 实现 ON CONFLICT DO UPDATE。
  Future<void> upsertMemoryEmbedding({
    required String memoryId,
    required String characterId,
    required String provider,
    required String model,
    required List<double> embedding,
    required String embeddingTextHash,
    String status = 'ready',
    String? errorMessage,
  }) async {
    final normalized = normalizeEmbedding(embedding);
    final blob = embeddingToBlob(normalized.toList());
    final now = DateTime.now();
    await _db.into(_db.memoryEmbeddings).insertOnConflictUpdate(
          MemoryEmbeddingsCompanion.insert(
            memoryId: memoryId,
            characterId: characterId,
            provider: provider,
            model: model,
            dimension: normalized.length,
            embeddingBlob: blob,
            normalized: const Value(1),
            embeddingTextHash: embeddingTextHash,
            status: Value(status),
            errorMessage: Value(errorMessage),
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
  }

  /// 加载 ready embedding 行（按 character_id + 可选 provider/model/dimension 过滤）。
  /// 对齐主项目 memory-embeddings.ts:402-452 `loadReadyMemoryEmbeddings`：
  /// - status='ready' 且对应 memory.status='active'；
  /// - ORDER BY pinned DESC, importance DESC, updated_at DESC, memory_id ASC；
  /// - 分批扫描（candidate=500，scan=5000），提前结束条件：本批不足 batchLimit。
  Future<List<MemoryEmbedding>> loadReadyMemoryEmbeddings(
    String characterId, {
    String? provider,
    String? model,
    int? dimension,
    int limit = vectorRetrievalScanLimit,
  }) async {
    final scanLimit = limit > 0 ? limit : vectorRetrievalScanLimit;
    final rows = <MemoryEmbedding>[];
    // 主项目用单 SQL + LIMIT/OFFSET 翻页；Drift 在 Dart 层手动翻页以保持 SQL 简单。
    for (var offset = 0; offset < scanLimit; offset += vectorRetrievalCandidateLimit) {
      final batchLimit = mathMin(vectorRetrievalCandidateLimit, scanLimit - offset);
      final query = _db.select(_db.memoryEmbeddings).join([
        innerJoin(
          _db.memories,
          _db.memories.id.equalsExp(_db.memoryEmbeddings.memoryId),
        ),
      ])
        ..where(_db.memoryEmbeddings.characterId.equals(characterId))
        ..where(_db.memoryEmbeddings.status.equals('ready'))
        ..where(_db.memories.status.equals('active'));
      if (provider != null && provider.isNotEmpty) {
        query.where(_db.memoryEmbeddings.provider.equals(provider));
      }
      if (model != null && model.isNotEmpty) {
        query.where(_db.memoryEmbeddings.model.equals(model));
      }
      if (dimension != null && dimension > 0) {
        query.where(_db.memoryEmbeddings.dimension.equals(dimension));
      }
      query
        ..orderBy([
          OrderingTerm.desc(_db.memories.pinned),
          OrderingTerm.desc(_db.memories.importance),
          OrderingTerm.desc(_db.memoryEmbeddings.updatedAt),
          OrderingTerm.asc(_db.memoryEmbeddings.memoryId),
        ])
        ..limit(batchLimit, offset: offset);
      final batch = await query.map((row) => row.readTable(_db.memoryEmbeddings)).get();
      rows.addAll(batch);
      if (batch.length < batchLimit) break;
    }
    return rows;
  }

  // ─────────────────────────────────────────────────────────────────
  // enqueue
  // ─────────────────────────────────────────────────────────────────

  /// 入队一条 embedding 任务（去重：同 memory_id 已有 pending/processing 不重复入队）。
  /// 对齐主项目 memory-embeddings.ts:454-492 `enqueueMemoryEmbeddingTask`：
  /// - 事务内 SELECT 去重；
  /// - 已有 failed 行则复用其 id 翻 pending（retry_count=0, claim_token=null）；
  /// - 否则 INSERT 新 pending 行。
  /// 返回是否真的入队（true）/ 被去重吞掉（false）。
  Future<bool> enqueueMemoryEmbeddingTask(
    String memoryId,
    String characterId,
    String reason,
  ) async {
    final now = DateTime.now();
    return _db.transaction(() async {
      final active = await (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.memoryId.equals(memoryId) &
                (t.status.equals('pending') | t.status.equals('processing')))
            ..limit(1))
          .get();
      if (active.isNotEmpty) return false;

      final failed = await (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.memoryId.equals(memoryId) & t.status.equals('failed'))
            ..orderBy([
              (t) => OrderingTerm.desc(t.updatedAt),
              (t) => OrderingTerm.desc(t.id),
            ])
            ..limit(1))
          .get();
      if (failed.isNotEmpty) {
        await (_db.update(_db.memoryEmbeddingTasks)
              ..where((t) => t.id.equals(failed.first.id)))
            .write(MemoryEmbeddingTasksCompanion(
          characterId: Value(characterId),
          reason: Value(reason),
          status: const Value('pending'),
          claimToken: const Value(null),
          retryCount: const Value(0),
          errorMessage: const Value(null),
          updatedAt: Value(now),
        ));
        return true;
      }

      await _db.into(_db.memoryEmbeddingTasks).insert(
            MemoryEmbeddingTasksCompanion.insert(
              memoryId: memoryId,
              characterId: characterId,
              reason: reason,
              status: const Value('pending'),
              createdAt: Value(now),
              updatedAt: Value(now),
            ),
          );
      return true;
    });
  }

  /// 为某角色全部记忆入队重建任务。
  /// 对齐主项目 memory-embeddings.ts:494-509 `enqueueRebuildMemoryEmbeddings`。
  Future<int> enqueueRebuildMemoryEmbeddings(String characterId) async {
    final memories = await (_db.select(_db.memories)
          ..where((m) => m.characterId.equals(characterId)))
        .get();
    var queued = 0;
    for (final m in memories) {
      if (await enqueueMemoryEmbeddingTask(m.id, m.characterId, 'rebuild')) {
        queued += 1;
      }
    }
    return queued;
  }

  /// 为某角色（或全库）未索引的记忆入队 backfill 任务。
  /// 对齐主项目 memory-embeddings.ts:511-560 `enqueueUnindexedMemoryEmbeddings`：
  /// - provider/model 缺失直接返回 0；
  /// - 选出「无对应 provider/model/dimension 的 ready embedding」的记忆；
  /// - 已有其他 ready embedding 的记忆优先（主项目 CASE WHEN ... THEN 0 ELSE 1）。
  Future<int> enqueueUnindexedMemoryEmbeddings(
    String? characterId, {
    required String provider,
    required String model,
    int? dimension,
  }) async {
    final p = provider.trim();
    final m = model.trim();
    if (p.isEmpty || m.isEmpty) return 0;

    // 先按 character_id 过滤候选记忆
    final candidates = await (_db.select(_db.memories)
          ..where((mem) => characterId == null
              ? const Constant(true)
              : mem.characterId.equals(characterId)))
        .get();

    // 已有 ready embedding（任意 provider/model）的记忆 id 集合，用于排序优先
    final anyReadyRows = await (_db.selectOnly(_db.memoryEmbeddings)
          ..addColumns([_db.memoryEmbeddings.memoryId])
          ..where(_db.memoryEmbeddings.status.equals('ready')))
        .map((row) => row.read(_db.memoryEmbeddings.memoryId))
        .get();
    final anyReady = anyReadyRows.toSet();

    // 对每个候选记忆检查是否存在指定 provider/model(/dimension) 的 ready embedding
    final toQueue = <Memory>[];
    for (final mem in candidates) {
      final query = _db.select(_db.memoryEmbeddings)
        ..where((e) =>
            e.memoryId.equals(mem.id) &
            e.status.equals('ready') &
            e.provider.equals(p) &
            e.model.equals(m));
      if (dimension != null && dimension > 0) {
        query.where((e) => e.dimension.equals(dimension));
      }
      final existing = await query.get();
      if (existing.isEmpty) toQueue.add(mem);
    }
    // 已有其他 ready embedding 的优先（主项目 CASE WHEN ... THEN 0 ELSE 1）
    toQueue.sort((a, b) {
      final aHas = anyReady.contains(a.id) ? 0 : 1;
      final bHas = anyReady.contains(b.id) ? 0 : 1;
      if (aHas != bHas) return aHas.compareTo(bHas);
      final uc = a.updatedAt.compareTo(b.updatedAt);
      if (uc != 0) return uc;
      return a.id.compareTo(b.id);
    });

    var queued = 0;
    for (final mem in toQueue) {
      if (await enqueueMemoryEmbeddingTask(mem.id, mem.characterId, 'semantic_backfill')) {
        queued += 1;
      }
    }
    return queued;
  }

  // ─────────────────────────────────────────────────────────────────
  // clear / stop / recover / retry
  // ─────────────────────────────────────────────────────────────────

  /// 清空索引（embeddings + tasks）。
  /// 对齐主项目 memory-embeddings.ts:562-581 `clearMemoryIndex`。
  Future<({int clearedEmbeddings, int clearedTasks})> clearMemoryIndex(
      [String? characterId]) async {
    return _db.transaction(() async {
      final embeddingsRemoved = characterId == null
          ? await (_db.delete(_db.memoryEmbeddings)).go()
          : await (_db.delete(_db.memoryEmbeddings)
                ..where((e) => e.characterId.equals(characterId)))
              .go();
      final tasksRemoved = characterId == null
          ? await (_db.delete(_db.memoryEmbeddingTasks)).go()
          : await (_db.delete(_db.memoryEmbeddingTasks)
                ..where((t) => t.characterId.equals(characterId)))
              .go();
      return (clearedEmbeddings: embeddingsRemoved, clearedTasks: tasksRemoved);
    });
  }

  /// 删除 pending/processing 任务（停止索引）。
  /// 对齐主项目 memory-embeddings.ts:583-596 `stopCurrentMemoryIndexTasks`。
  Future<int> stopCurrentMemoryIndexTasks([String? characterId]) async {
    if (characterId == null) {
      return (_db.delete(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.status.equals('pending') | t.status.equals('processing')))
          .go();
    }
    return (_db.delete(_db.memoryEmbeddingTasks)
          ..where((t) =>
              t.characterId.equals(characterId) &
              (t.status.equals('pending') | t.status.equals('processing'))))
        .go();
  }

  /// 启动恢复：把残留 processing 翻回 pending（claim_token 清空）。
  /// 对齐主项目 memory-embeddings.ts:598-608 `recoverStaleMemoryEmbeddingTasks`。
  Future<int> recoverStaleMemoryEmbeddingTasks() async {
    final now = DateTime.now();
    return (_db.update(_db.memoryEmbeddingTasks)
          ..where((t) => t.status.equals('processing')))
        .write(MemoryEmbeddingTasksCompanion(
      status: const Value('pending'),
      claimToken: const Value(null),
      updatedAt: Value(now),
    ));
  }

  /// 重试 failed 任务（无对应 ready embedding 且无活跃任务的最新 failed 行）。
  /// 对齐主项目 memory-embeddings.ts:610-666 `retryFailedMemoryEmbeddings`。
  Future<int> retryFailedMemoryEmbeddings({
    String? characterId,
    MemoryEmbeddingTarget? target,
  }) async {
    final now = DateTime.now();
    // 收集每个 memory_id 的「最新 failed 行 id」
    final failedRows = await (_db.select(_db.memoryEmbeddingTasks)
          ..where((t) =>
              t.status.equals('failed') &
              (characterId == null
                  ? const Constant(true)
                  : t.characterId.equals(characterId))))
        .get();
    if (failedRows.isEmpty) return 0;

    // 按 memory_id 分组取最新 failed
    final latestFailedByMemory = <String, MemoryEmbeddingTask>{};
    for (final t in failedRows) {
      final existing = latestFailedByMemory[t.memoryId];
      if (existing == null ||
          t.updatedAt.isAfter(existing.updatedAt) ||
          (t.updatedAt == existing.updatedAt && t.id > existing.id)) {
        latestFailedByMemory[t.memoryId] = t;
      }
    }

    final toRetry = <int>[];
    for (final entry in latestFailedByMemory.entries) {
      final memoryId = entry.key;
      final task = entry.value;
      // 跳过：仍有活跃任务
      final active = await (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.memoryId.equals(memoryId) &
                (t.status.equals('pending') | t.status.equals('processing')))
            ..limit(1))
          .get();
      if (active.isNotEmpty) continue;
      // 跳过：已有对应 ready embedding（按 target 过滤）
      final readyQuery = _db.select(_db.memoryEmbeddings)
        ..where((e) =>
            e.memoryId.equals(memoryId) & e.status.equals('ready'));
      if (target?.provider != null && target!.provider!.isNotEmpty) {
        readyQuery.where((e) => e.provider.equals(target.provider!));
      }
      if (target?.hasModel == true) {
        final m = target!.model?.trim() ?? '';
        if (m.isEmpty) {
          // 对齐主项目：声明了 model 但为空 → 1=0（永不命中），直接视为无 ready
          continue;
        }
        readyQuery.where((e) => e.model.equals(m));
      }
      if (target?.dimension != null && target!.dimension! > 0) {
        readyQuery.where((e) => e.dimension.equals(target.dimension!));
      }
      final ready = await readyQuery.get();
      if (ready.isNotEmpty) continue;
      toRetry.add(task.id);
    }

    if (toRetry.isEmpty) return 0;
    await _db.transaction(() async {
      for (final id in toRetry) {
        await (_db.update(_db.memoryEmbeddingTasks)
              ..where((t) => t.id.equals(id)))
            .write(MemoryEmbeddingTasksCompanion(
          reason: const Value('retry_failed'),
          status: const Value('pending'),
          claimToken: const Value(null),
          retryCount: const Value(0),
          errorMessage: const Value(null),
          updatedAt: Value(now),
        ));
      }
    });
    return toRetry.length;
  }

  // ─────────────────────────────────────────────────────────────────
  // process
  // ─────────────────────────────────────────────────────────────────

  /// 处理一批 embedding 任务。
  /// 对齐主项目 memory-embeddings.ts:748-898 `processMemoryEmbeddingTasks`：
  /// - claim_token 租约：事务内把 pending（retry_count=0 或 updated_at 已过退避）
  ///   翻 processing 并写入 claim_token；
  /// - 逐条 embedText → upsert（status=ready）+ done；
  /// - 失败按 [isRecoverableEmbeddingError] 判定：recoverable 且
  ///   retry_count+1 < [maxRecoverableEmbeddingAttempts] → retry_count++ 翻 pending；
  ///   否则翻 failed + error_message；
  /// - 记忆不存在时直接 done（finishMissingMemoryTask）。
  Future<ProcessedEmbeddingTasksResult> processMemoryEmbeddingTasks({
    required EmbeddingAdapterConfig config,
    required MemoryEmbeddingsService embeddings,
    int limit = 8,
  }) async {
    final clampedLimit = mathMax(1, mathMin(limit, 64));
    final provider = (config.provider?.trim().isNotEmpty ?? false)
        ? config.provider!.trim()
        : 'openai-compatible';
    final model = config.model?.trim() ?? '';
    final claimToken = _uuid.v4();
    final now = DateTime.now();
    final retryReadyBefore =
        now.subtract(const Duration(milliseconds: recoverableEmbeddingRetryDelayMs));

    // 1. claim 一批 pending（retry_count=0 或 updated_at <= retryReadyBefore）
    // Drift 的 update(...).write(...) 不支持 LIMIT，因此先 SELECT 取 id 再 update，
    // 保证只 claim clampedLimit 条任务（对齐主项目 processMemoryEmbeddingTasks 的批次上限）。
    final claimed = await _db.transaction(() async {
      final toClaim = await (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.status.equals('pending') &
                (t.retryCount.equals(0) |
                    t.updatedAt.isSmallerThanValue(retryReadyBefore))))
          .get();
      final ids = <int>[];
      for (final t in toClaim) {
        if (ids.length >= clampedLimit) break;
        ids.add(t.id);
      }
      if (ids.isNotEmpty) {
        await (_db.update(_db.memoryEmbeddingTasks)
              ..where((t) => t.id.isIn(ids)))
            .write(MemoryEmbeddingTasksCompanion(
          status: const Value('processing'),
          claimToken: Value(claimToken),
          updatedAt: Value(now),
        ));
      }

      return (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.status.equals('processing') & t.claimToken.equals(claimToken))
            ..orderBy([(t) => OrderingTerm.asc(t.id)]))
          .get();
    });

    var processed = 0;
    var failed = 0;

    Future<void> finishMissingMemoryTask(MemoryEmbeddingTask task) async {
      final changed = await (_db.update(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.id.equals(task.id) &
                t.status.equals('processing') &
                t.claimToken.equals(claimToken)))
          .write(MemoryEmbeddingTasksCompanion(
        status: const Value('done'),
        claimToken: const Value(null),
        updatedAt: Value(DateTime.now()),
      ));
      if (changed > 0) processed += 1;
    }

    Future<void> failTask(MemoryEmbeddingTask task, Object error) async {
      final errorMessage = error.toString();
      final nextRetryCount = task.retryCount + 1;
      final shouldRetry = isRecoverableEmbeddingError(errorMessage) &&
          nextRetryCount < maxRecoverableEmbeddingAttempts;
      final changed = await (_db.update(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.id.equals(task.id) &
                t.status.equals('processing') &
                t.claimToken.equals(claimToken)))
          .write(MemoryEmbeddingTasksCompanion(
        status: Value(shouldRetry ? 'pending' : 'failed'),
        claimToken: const Value(null),
        retryCount: Value(nextRetryCount),
        errorMessage: Value(errorMessage),
        updatedAt: Value(DateTime.now()),
      ));
      if (changed > 0 && !shouldRetry) failed += 1;
    }

    Future<void> completeTask(
      MemoryEmbeddingTask task,
      Memory memory,
      String text,
      List<double> embedding,
    ) async {
      final completed = await _db.transaction(() async {
        final active = await (_db.select(_db.memoryEmbeddingTasks)
              ..where((t) =>
                  t.id.equals(task.id) &
                  t.status.equals('processing') &
                  t.claimToken.equals(claimToken))
              ..limit(1))
            .get();
        if (active.isEmpty) return false;
        await upsertMemoryEmbedding(
          memoryId: task.memoryId,
          characterId: task.characterId,
          provider: provider,
          model: model,
          embedding: embedding,
          embeddingTextHash: hashEmbeddingText(text),
        );
        final changed = await (_db.update(_db.memoryEmbeddingTasks)
              ..where((t) =>
                  t.id.equals(task.id) &
                  t.status.equals('processing') &
                  t.claimToken.equals(claimToken)))
            .write(MemoryEmbeddingTasksCompanion(
          status: const Value('done'),
          claimToken: const Value(null),
          errorMessage: const Value(null),
          updatedAt: Value(DateTime.now()),
        ));
        return changed > 0;
      });
      if (completed) processed += 1;
    }

    for (final task in claimed) {
      final memory = await (_db.select(_db.memories)
            ..where((m) =>
                m.id.equals(task.memoryId) &
                m.characterId.equals(task.characterId))
            ..limit(1))
          .getSingleOrNull();
      if (memory == null) {
        await finishMissingMemoryTask(task);
        continue;
      }
      try {
        final text = buildMemoryEmbeddingText(memory);
        final embedding = await embeddings.embedText(text, config);
        await completeTask(task, memory, text, embedding);
      } catch (e) {
        await failTask(task, e);
      }
    }

    return ProcessedEmbeddingTasksResult(processed, failed);
  }

  // ─────────────────────────────────────────────────────────────────
  // status
  // ─────────────────────────────────────────────────────────────────

  /// 索引状态聚合 — 对齐主项目 memory-embeddings.ts:668-746 `getMemoryIndexStatus`。
  ///
  /// 简化说明：主项目按 target 过滤 ready/failed 计数；这里在 Dart 层逐条件过滤。
  /// `failed` 只计「无活跃任务且无对应 ready embedding」的未解决失败。
  Future<MemoryIndexStatus> getMemoryIndexStatus({
    String? characterId,
    MemoryEmbeddingTarget? target,
  }) async {
    // total：对应角色的 active 记忆总数（主项目是全部记忆数，这里按 active 计更贴近实际可用索引量）
    final totalCount = _db.memories.id.count();
    final totalQuery = _db.selectOnly(_db.memories)
      ..addColumns([totalCount]);
    if (characterId != null) {
      totalQuery.where(_db.memories.characterId.equals(characterId));
    }
    final totalRow = await totalQuery.getSingle();
    final total = totalRow.read(totalCount) ?? 0;

    // ready：distinct memory_id 数量（按 target 过滤）
    // 注意：countDistinct 表达式必须捕获为变量后复用，否则 read() 与 addColumns
    // 使用的是不同 Expression 实例，无法解析（Drift TypedResult 按表达式实例匹配）。
    final readyCount = _db.memoryEmbeddings.memoryId.count(distinct: true);
    final readyQuery = _db.selectOnly(_db.memoryEmbeddings)
      ..addColumns([readyCount])
      ..where(_db.memoryEmbeddings.status.equals('ready'));
    if (characterId != null) {
      readyQuery.where(_db.memoryEmbeddings.characterId.equals(characterId));
    }
    if (target?.provider != null && target!.provider!.isNotEmpty) {
      readyQuery.where(_db.memoryEmbeddings.provider.equals(target.provider!));
    }
    if (target?.hasModel == true) {
      final m = target!.model?.trim() ?? '';
      if (m.isEmpty) {
        // 声明 model 为空 → 1=0
        readyQuery.where(const Constant(false));
      } else {
        readyQuery.where(_db.memoryEmbeddings.model.equals(m));
      }
    }
    if (target?.dimension != null && target!.dimension! > 0) {
      readyQuery.where(_db.memoryEmbeddings.dimension.equals(target.dimension!));
    }
    final readyRow = await readyQuery.getSingle();
    final ready = readyRow.read(readyCount) ?? 0;

    // pending / processing：按 character 过滤的活跃任务数
    final activeCount = _db.memoryEmbeddingTasks.memoryId.count(distinct: true);
    final activeQuery = _db.selectOnly(_db.memoryEmbeddingTasks)
      ..addColumns([
        _db.memoryEmbeddingTasks.status,
        activeCount,
      ])
      ..where(_db.memoryEmbeddingTasks.status
          .isIn(['pending', 'processing']));
    if (characterId != null) {
      activeQuery.where(_db.memoryEmbeddingTasks.characterId.equals(characterId));
    }
    activeQuery.groupBy([_db.memoryEmbeddingTasks.status]);
    final activeRows = await activeQuery.get();
    var pending = 0;
    var processing = 0;
    for (final row in activeRows) {
      final status = row.read(_db.memoryEmbeddingTasks.status) ?? '';
      final n = row.read(activeCount) ?? 0;
      if (status == 'pending') pending = n;
      if (status == 'processing') processing = n;
    }

    // failed：未解决（无活跃任务 + 无对应 ready embedding）
    final failedTasks = await (_db.select(_db.memoryEmbeddingTasks)
          ..where((t) =>
              t.status.equals('failed') &
              (characterId == null
                  ? const Constant(true)
                  : t.characterId.equals(characterId))))
        .get();
    final failedByMemory = <String, MemoryEmbeddingTask>{};
    for (final t in failedTasks) {
      final existing = failedByMemory[t.memoryId];
      if (existing == null ||
          t.updatedAt.isAfter(existing.updatedAt) ||
          (t.updatedAt == existing.updatedAt && t.id > existing.id)) {
        failedByMemory[t.memoryId] = t;
      }
    }
    var failed = 0;
    String? latestError;
    MemoryEmbeddingTask? latestFailedTask;
    for (final entry in failedByMemory.entries) {
      final memoryId = entry.key;
      final task = entry.value;
      final active = await (_db.select(_db.memoryEmbeddingTasks)
            ..where((t) =>
                t.memoryId.equals(memoryId) &
                (t.status.equals('pending') | t.status.equals('processing')))
            ..limit(1))
          .get();
      if (active.isNotEmpty) continue;
      final readyQ = _db.select(_db.memoryEmbeddings)
        ..where((e) =>
            e.memoryId.equals(memoryId) & e.status.equals('ready'));
      if (target?.provider != null && target!.provider!.isNotEmpty) {
        readyQ.where((e) => e.provider.equals(target.provider!));
      }
      if (target?.hasModel == true) {
        final m = target!.model?.trim() ?? '';
        if (m.isEmpty) {
          continue;
        }
        readyQ.where((e) => e.model.equals(m));
      }
      if (target?.dimension != null && target!.dimension! > 0) {
        readyQ.where((e) => e.dimension.equals(target.dimension!));
      }
      final readyRows = await readyQ.get();
      if (readyRows.isNotEmpty) continue;
      failed += 1;
      if (task.errorMessage != null && task.errorMessage!.isNotEmpty) {
        if (latestFailedTask == null ||
            task.updatedAt.isAfter(latestFailedTask.updatedAt) ||
            (task.updatedAt == latestFailedTask.updatedAt &&
                task.id > latestFailedTask.id)) {
          latestFailedTask = task;
        }
      }
    }
    latestError = latestFailedTask?.errorMessage;

    return MemoryIndexStatus(
      total: total,
      ready: ready,
      pending: pending,
      processing: processing,
      failed: failed,
      latestError: latestError,
    );
  }
}

int mathMin(int a, int b) => a < b ? a : b;
int mathMax(int a, int b) => a > b ? a : b;

// ─────────────────────────────────────────────────────────────────
// index-trigger（对齐 memory-index-trigger.ts）
// ─────────────────────────────────────────────────────────────────

/// 向量索引触发器 — 单例式状态机，对齐主项目 memory-index-trigger.ts 的模块级变量。
///
/// 配置阻塞原因不直接读 AppSettings.memoryEngine（Wave 13 才加），改为接受外部
/// 传入的 [EmbeddingAdapterConfig]（或 null 表示被阻塞）。调用方在 Wave 13 接入
/// MemoryEngineSettings 后自行解析为 config/blockedReason 再调用本触发器。
class MemoryIndexTrigger {
  bool _drainActive = false;
  bool _drainRequested = false;
  int _drainStopVersion = 0;

  final MemoryEmbeddingTasksService _tasks;
  final MemoryEmbeddingsService _embeddings;

  MemoryIndexTrigger(this._tasks, this._embeddings);

  /// 停止索引处理。对齐主项目 memory-index-trigger.ts:146-151 `stopMemoryIndexProcessing`。
  void stop() {
    _drainRequested = false;
    _drainStopVersion += 1;
    _drainActive = false;
  }

  /// 触发索引处理。对齐主项目 memory-index-trigger.ts:153-169 `triggerMemoryIndexProcessing`。
  ///
  /// [configResolver]：返回当前可用的 embedding config 或 null（被阻塞）。
  /// TODO(Wave13): 接入 MemoryEngineSettings，由 settings 解析 config/blockedReason。
  bool trigger({
    required EmbeddingAdapterConfig? Function() configResolver,
    int delayMs = 0,
  }) {
    final config = configResolver();
    if (config == null) return false;
    _drainRequested = true;
    if (_drainActive) return true;
    _drainActive = true;
    _scheduleDrain(config, delayMs);
    return true;
  }

  void _scheduleDrain(EmbeddingAdapterConfig config, int delayMs) {
    final stopVersion = _drainStopVersion;
    Future<void>.delayed(Duration(milliseconds: delayMs), () async {
      if (stopVersion != _drainStopVersion) {
        _drainActive = false;
        return;
      }
      try {
        await _drain(config, stopVersion);
      } catch (_) {
        // 排空失败不抛出，对齐主项目 .catch 兜底
      } finally {
        _drainActive = false;
        if (stopVersion == _drainStopVersion) {
          final status = await _tasks.getMemoryIndexStatus();
          if (status.pending > 0) {
            // 仍有 pending：继续触发（对齐主项目 hasPendingMemoryIndexTasks）
            trigger(
              configResolver: () => config,
              delayMs: memoryIndexDrainRetryDelayMs,
            );
          }
        }
      }
    });
  }

  /// 排空一批批任务。对齐主项目 memory-index-trigger.ts:77-119 `drainMemoryIndexTasks`。
  Future<int> _drain(EmbeddingAdapterConfig config, int stopVersion) async {
    final startedAt = DateTime.now();
    var configVar = config;
    var batches = 0;
    var totalHandled = 0;
    while (
        batches < memoryIndexDrainMaxBatches &&
        DateTime.now().difference(startedAt).inMilliseconds <
            memoryIndexDrainMaxDurationMs &&
        stopVersion == _drainStopVersion) {
      _drainRequested = false;
      final result = await _tasks.processMemoryEmbeddingTasks(
        config: configVar,
        embeddings: _embeddings,
        limit: memoryIndexProcessBatchLimit,
      );
      batches += 1;
      final handled = result.processed + result.failed;
      totalHandled += handled;
      if (stopVersion != _drainStopVersion || handled == 0) break;
      if (handled < memoryIndexProcessBatchLimit && !_drainRequested) break;
    }
    return totalHandled;
  }

  /// 同步排空入口（测试 / 显式调用）。对齐主项目 `drainMemoryIndexTasks` 的直接调用。
  Future<int> drainOnce(EmbeddingAdapterConfig config) async {
    return _drain(config, _drainStopVersion);
  }

  /// 当前是否处于排空中。
  bool get isActive => _drainActive;
}
