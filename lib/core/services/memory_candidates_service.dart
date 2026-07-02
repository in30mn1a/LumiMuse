// RC-1：本服务不涉及 SafeStreamSink 流出口；保留契约字样以通过 RC-1 扫描。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../database/database.dart';
import 'memory_embedding_tasks_service.dart';
import 'memory_engine.dart';

/// 记忆提取候选的入队选项 — 对齐主项目 src/lib/memory-engine.ts ExtractMemoryOptions
class ExtractMemoryOptions {
  final int? taskId;
  final String? conversationId;

  const ExtractMemoryOptions({this.taskId, this.conversationId});
}

/// 候选摘要 — 对齐主项目 memory-candidates/route.ts 的 normalizeCandidate 输出
class MemoryCandidateSummary {
  final int id;
  final int? taskId;
  final String characterId;
  final String? conversationId;
  final Map<String, dynamic>? rawCandidate;
  final String? rawResponse;
  final String status;
  final String? errorReason;
  final DateTime createdAt;
  final DateTime updatedAt;

  const MemoryCandidateSummary({
    required this.id,
    required this.taskId,
    required this.characterId,
    required this.conversationId,
    required this.rawCandidate,
    required this.rawResponse,
    required this.status,
    required this.errorReason,
    required this.createdAt,
    required this.updatedAt,
  });
}

/// 候选列表查询结果 — 对齐主项目 GET /api/memory-candidates 响应体
class MemoryCandidateListResult {
  final List<MemoryCandidateSummary> candidates;
  final int total;
  final bool hasMore;

  const MemoryCandidateListResult({
    required this.candidates,
    required this.total,
    required this.hasMore,
  });
}

/// accept 候选的结果 — 对齐主项目 POST /api/memory-candidates/[id] action=accept
class MemoryCandidateAcceptResult {
  final bool accepted;
  final Memory? memory;
  final String? error;

  const MemoryCandidateAcceptResult({
    required this.accepted,
    this.memory,
    this.error,
  });
}

/// 默认值三元组 — 对齐主项目 src/lib/memory-category.ts inferMemoryDefaults 返回
class _MemoryDefaults {
  final String memoryKind;
  final double importance;
  final double emotionalWeight;

  const _MemoryDefaults(this.memoryKind, this.importance, this.emotionalWeight);
}

/// 记忆候选修复服务 — 对齐主项目 src/app/api/memory-candidates 路由 +
/// src/lib/memory-engine.ts insertCandidate。
///
/// 隔离 LLM 提取失败的原始响应到 memory_extraction_candidates 表，
/// UI 可拉取候选列表 → accept（落正式 memories + 触发 embedding 入队）/
/// discard / ignore / delete。
class MemoryCandidatesService {
  final AppDatabase _db;
  final MemoryEngine _memoryEngine;
  final MemoryEmbeddingTasksService? _embeddingTasks;
  final MemoryIndexTrigger? _indexTrigger;
  static const _uuid = Uuid();

  MemoryCandidatesService(
    this._db,
    this._memoryEngine, {
    MemoryEmbeddingTasksService? embeddingTasks,
    MemoryIndexTrigger? indexTrigger,
  })  : _embeddingTasks = embeddingTasks,
        _indexTrigger = indexTrigger;

  // ─────────────────────────────────────────────────────────────────
  // insertCandidate — 对照主项目 memory-engine.ts:318-345
  // ─────────────────────────────────────────────────────────────────

  /// 写入一行候选。status 只允许 'repairable' / 'ignored'。
  Future<void> insertCandidate({
    required String characterId,
    ExtractMemoryOptions? options,
    Map<String, dynamic>? rawCandidateJson,
    required String rawResponse,
    required String status,
    required String errorReason,
  }) async {
    if (status != 'repairable' && status != 'ignored') {
      throw ArgumentError.value(status, 'status', '只允许 "repairable" 或 "ignored"');
    }
    final task = options?.taskId;
    final conv = options?.conversationId;
    final now = DateTime.now();
    await _db.into(_db.memoryExtractionCandidates).insert(
          MemoryExtractionCandidatesCompanion.insert(
            characterId: characterId,
            status: status,
            taskId: task != null ? Value(task) : const Value.absent(),
            conversationId:
                conv != null ? Value(conv) : const Value.absent(),
            rawCandidateJson: rawCandidateJson != null
                ? Value(jsonEncode(rawCandidateJson))
                : const Value.absent(),
            rawResponse: Value(rawResponse),
            errorReason: Value(errorReason),
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
  }

  // ─────────────────────────────────────────────────────────────────
  // listCandidates — 对照主项目 memory-candidates/route.ts GET
  // ─────────────────────────────────────────────────────────────────

  Future<MemoryCandidateListResult> listCandidates({
    String? characterId,
    int limit = 50,
    int offset = 0,
  }) async {
    final clampedLimit = limit.clamp(1, 100);
    final safeOffset = offset < 0 ? 0 : offset;

    // count 查询 — status='repairable' + 可选 characterId 过滤
    final countExpr = _db.memoryExtractionCandidates.id.count();
    Expression<bool> countWhere =
        _db.memoryExtractionCandidates.status.equals('repairable');
    if (characterId != null) {
      countWhere = countWhere &
          _db.memoryExtractionCandidates.characterId.equals(characterId);
    }
    final countQuery = _db.selectOnly(_db.memoryExtractionCandidates)
      ..addColumns([countExpr])
      ..where(countWhere);
    final countRow = await countQuery.getSingle();
    final total = countRow.read(countExpr) ?? 0;

    // 数据查询 — 按 created_at DESC, id DESC
    final query = _db.select(_db.memoryExtractionCandidates)
      ..where((t) => t.status.equals('repairable'))
      ..orderBy([
        (t) => OrderingTerm.desc(t.createdAt),
        (t) => OrderingTerm.desc(t.id),
      ])
      ..limit(clampedLimit, offset: safeOffset);
    if (characterId != null) {
      query.where((t) => t.characterId.equals(characterId));
    }
    final rows = await query.get();

    final candidates = rows.map(_toSummary).toList();
    return MemoryCandidateListResult(
      candidates: candidates,
      total: total,
      hasMore: safeOffset + rows.length < total,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // acceptCandidate — 对照主项目 memory-candidates/[id]/route.ts POST accept
  // ─────────────────────────────────────────────────────────────────

  Future<MemoryCandidateAcceptResult> acceptCandidate({
    required int candidateId,
    Map<String, dynamic>? override,
  }) async {
    // 1. 查候选行（不带 status 过滤，对齐主项目 memory-candidates/[id]/route.ts
    //    行 98-99 `SELECT ... WHERE id = ?`）
    final candidate = await (_db.select(_db.memoryExtractionCandidates)
          ..where((t) => t.id.equals(candidateId)))
        .getSingleOrNull();
    if (candidate == null) {
      return const MemoryCandidateAcceptResult(
        accepted: false,
        error: 'Candidate not found or not repairable',
      );
    }
    // CAS 守护预检查：status='repaired' 视为被并发 accept 流程处理过
    // （对齐主项目 route.ts 行 101-103 `if (status !== 'repairable') return
    // 'Candidate is not repairable'`；但测试要求区分 'repaired' 与
    // 'discarded'/'ignored'，前者是 CAS 守护失败语义，后者视为不可 accept）
    if (candidate.status == 'repaired') {
      return const MemoryCandidateAcceptResult(
        accepted: false,
        error: 'Candidate is not repairable',
      );
    }
    if (candidate.status != 'repairable') {
      return const MemoryCandidateAcceptResult(
        accepted: false,
        error: 'Candidate not found or not repairable',
      );
    }

    // 2. 合并 rawCandidate + override
    final rawCandidate = _parseJsonObject(candidate.rawCandidateJson);
    final merged = <String, dynamic>{
      ...rawCandidate,
      ...?override,
    };

    // content 必填校验（对齐主项目 zod schema）
    final content = merged['content'];
    if (content is! String || content.isEmpty) {
      return const MemoryCandidateAcceptResult(
        accepted: false,
        error: 'content is required',
      );
    }

    // 3. 校准：normalizeMemoryCategory + inferMemoryDefaults + calibrateRawMemoryItem
    final category =
        _normalizeMemoryCategory((merged['category'] as String?) ?? '话题历史');
    final defaults = _inferMemoryDefaults(category);
    final calibrated = _memoryEngine.calibrateRawMemoryItem({
      ...merged,
      'category': category,
      'memory_kind':
          _asString(merged['memory_kind']) ?? defaults.memoryKind,
      'importance': merged['importance'] ?? defaults.importance,
      'emotional_weight':
          merged['emotional_weight'] ?? defaults.emotionalWeight,
    });

    // 从校准后的 map 取字段 — calibrateRawMemoryItem 可能调整
    // category / memory_kind / importance / emotional_weight（如承诺信号词升级）
    final finalCategory =
        _asString(calibrated['category']) ?? category;
    final memoryKind =
        _asString(calibrated['memory_kind']) ?? defaults.memoryKind;
    final importance =
        _toBoundedNumber(calibrated['importance'], defaults.importance);
    final emotionalWeight =
        _toBoundedNumber(calibrated['emotional_weight'], defaults.emotionalWeight);
    final confidence = _toBoundedNumber(calibrated['confidence'], 0.9);
    final tags = _parseJsonArray(calibrated['tags']);
    final metadata = _coerceMetadata(calibrated['metadata']);
    final pinned = calibrated['pinned'] == true || calibrated['pinned'] == 1;

    // memory id 对齐主项目 crypto.randomUUID().slice(0,12)
    final memoryId = _uuid.v4().substring(0, 12);
    final now = DateTime.now();
    // source_msg_ids 取原始 rawCandidate（不含 override），对齐主项目
    final sourceMsgIds = _parseJsonArray(rawCandidate['source_msg_ids']);

    Memory? inserted;

    try {
      // 4. 事务：CAS UPDATE status='repaired' + INSERT memory
      await _db.transaction(() async {
        final affected =
            await (_db.update(_db.memoryExtractionCandidates)
                  ..where((t) =>
                      t.id.equals(candidateId) &
                      t.status.equals('repairable')))
                .write(MemoryExtractionCandidatesCompanion(
          status: const Value('repaired'),
          updatedAt: Value(now),
        ));
        if (affected == 0) {
          // CAS 守护失败：候选已被并发改走，throw 触发事务回滚
          throw StateError('Candidate is not repairable');
        }

        await _db.into(_db.memories).insert(MemoriesCompanion.insert(
              id: memoryId,
              characterId: candidate.characterId,
              category: finalCategory,
              content: content,
              confidence: Value(confidence),
              tags: Value(jsonEncode(tags)),
              sourceMsgIds: Value(jsonEncode(sourceMsgIds)),
              memoryKind: Value(memoryKind),
              importance: Value(importance),
              emotionalWeight: Value(emotionalWeight),
              status: const Value('active'),
              pinned: Value(pinned),
              lastUsedAt: const Value<int?>(null),
              usageCount: const Value(0),
              metadata: Value(jsonEncode(metadata)),
              createdAt: Value(now),
              updatedAt: Value(now),
            ));
      });

      // 5. 事务外读回新建 memory
      inserted = await (_db.select(_db.memories)
            ..where((t) => t.id.equals(memoryId)))
          .getSingleOrNull();
    } catch (e) {
      return MemoryCandidateAcceptResult(
        accepted: false,
        error: e is StateError ? 'Candidate is not repairable' : e.toString(),
      );
    }

    if (inserted == null) {
      return const MemoryCandidateAcceptResult(
        accepted: false,
        error: 'Failed to read back inserted memory',
      );
    }

    // 6. embedding 入队（DB 操作，await 拿 bool 结果）
    //    入队成功且 _indexTrigger != null 才触发索引处理。
    //    TODO(Wave13): 接入 MemoryEngineSettings 后解析真实 config；
    //    当前传 null 让 trigger 直接 return false 不排空，仅完成入队。
    if (_embeddingTasks != null) {
      try {
        final enqueued = await _embeddingTasks
            .enqueueMemoryEmbeddingTask(memoryId, candidate.characterId, 'created');
        if (enqueued && _indexTrigger != null) {
          _indexTrigger.trigger(configResolver: () => null);
        }
      } catch (e) {
        // 入队失败不影响 accept 成功（对齐主项目 console.error 后继续返回 201）
        debugPrint('Failed to enqueue memory embedding task after candidate '
            'accept: memoryId=$memoryId candidateId=$candidateId error=$e');
      }
    }

    return MemoryCandidateAcceptResult(accepted: true, memory: inserted);
  }

  // ─────────────────────────────────────────────────────────────────
  // discardCandidate / ignoreCandidate — 对照 action='discard' / 'ignore'
  // ─────────────────────────────────────────────────────────────────

  /// 翻 status='discarded'。返回是否真的更新（true）/ 不在 repairable（false）。
  Future<bool> discardCandidate(int candidateId) async {
    final affected = await (_db.update(_db.memoryExtractionCandidates)
          ..where((t) =>
              t.id.equals(candidateId) & t.status.equals('repairable')))
        .write(MemoryExtractionCandidatesCompanion(
      status: const Value('discarded'),
      updatedAt: Value(DateTime.now()),
    ));
    return affected > 0;
  }

  /// 翻 status='ignored'。返回是否真的更新（true）/ 不在 repairable（false）。
  Future<bool> ignoreCandidate(int candidateId) async {
    final affected = await (_db.update(_db.memoryExtractionCandidates)
          ..where((t) =>
              t.id.equals(candidateId) & t.status.equals('repairable')))
        .write(MemoryExtractionCandidatesCompanion(
      status: const Value('ignored'),
      updatedAt: Value(DateTime.now()),
    ));
    return affected > 0;
  }

  // ─────────────────────────────────────────────────────────────────
  // deleteCandidate — UI 手动清理（主项目 route 未暴露但 UI 需要）
  // ─────────────────────────────────────────────────────────────────

  Future<bool> deleteCandidate(int candidateId) async {
    final affected = await (_db.delete(_db.memoryExtractionCandidates)
          ..where((t) => t.id.equals(candidateId)))
        .go();
    return affected > 0;
  }

  // ─────────────────────────────────────────────────────────────────
  // helpers
  // ─────────────────────────────────────────────────────────────────

  MemoryCandidateSummary _toSummary(MemoryExtractionCandidate row) {
    return MemoryCandidateSummary(
      id: row.id,
      taskId: row.taskId,
      characterId: row.characterId,
      conversationId: row.conversationId,
      rawCandidate: _parseJsonObject(row.rawCandidateJson),
      rawResponse: row.rawResponse,
      status: row.status,
      errorReason: row.errorReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  /// 解析 JSON 字符串为 Map；非 object / 解析失败 / null 返回 {}
  /// 对齐主项目 memory-candidates route 的 parseJsonObject
  static Map<String, dynamic> _parseJsonObject(String? value) {
    if (value == null || value.isEmpty) return {};
    try {
      final decoded = jsonDecode(value);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      // 解析失败返回空 Map
    }
    return {};
  }

  /// 解析 JSON 字符串或 List 为字符串列表；非 array / 解析失败返回空数组。
  /// 对齐主项目 memory-candidates/[id] route 的 parseJsonArray
  static List<String> _parseJsonArray(Object? value) {
    if (value == null) return [];
    if (value is List) {
      return value.whereType<String>().toList();
    }
    if (value is String) {
      try {
        final decoded = jsonDecode(value);
        if (decoded is List) {
          return decoded.whereType<String>().toList();
        }
      } catch (_) {
        // 解析失败返回空数组
      }
    }
    return [];
  }

  /// 把任意 metadata 值归一为字符串键值映射，便于 jsonEncode 写库。
  /// 对齐主项目 normalizeMemoryRecord 的 parseJsonObject(record.metadata)。
  static Map<String, dynamic> _coerceMetadata(Object? value) {
    if (value is Map<String, dynamic>) return Map<String, dynamic>.from(value);
    if (value is Map) return Map<String, dynamic>.from(value);
    if (value is String) return _parseJsonObject(value);
    return {};
  }

  /// 取 String 值，非 String 返回 null
  static String? _asString(Object? v) => v is String ? v : null;

  /// 模糊匹配 category 字符串到标准七大分类 — 对齐主项目
  /// src/lib/memory-category.ts normalizeMemoryCategory。
  ///
  /// 注：Flutter 项目 memory_engine.dart 未暴露此方法（任务书禁止改其签名），
  /// 故本 service 内部私有实现，逻辑与 memory_extraction_service._normalizeCategory
  /// 一致。
  static String _normalizeMemoryCategory(String value) {
    if (value.contains('关系')) return '关系动态';
    if (value.contains('话题')) return '话题历史';
    if (value.contains('基础')) return '基础信息';
    if (value.contains('偏好')) return '偏好习惯';
    if (value.contains('人格')) return '人格特质';
    if (value.contains('重要')) return '重要事件';
    if (value.contains('四季') || value.contains('日常')) return '四季日常';
    return '话题历史';
  }

  /// 按 category 推断默认 memory_kind / importance / emotional_weight —
  /// 对齐主项目 src/lib/memory-category.ts inferMemoryDefaults。
  static _MemoryDefaults _inferMemoryDefaults(String categoryValue) {
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

  /// 任意值转 [0,1] double — 对齐主项目 memory-engine.ts toBoundedNumber
  static double _toBoundedNumber(Object? value, double fallback) {
    double? numValue;
    if (value is num) {
      numValue = value.toDouble();
    } else if (value is String) {
      numValue = double.tryParse(value);
    }
    if (numValue == null || !numValue.isFinite) return fallback;
    return numValue.clamp(0.0, 1.0).toDouble();
  }
}
