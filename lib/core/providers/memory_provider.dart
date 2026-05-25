import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/message_metadata.dart';
import '../services/memory_extraction_service.dart';
import 'database_provider.dart';

/// 记忆分类
const List<String> memoryCategories = [
  '关系动态',
  '话题历史',
  '基础信息',
  '偏好习惯',
  '人格特质',
  '重要事件',
];

/// 记忆列表 Provider（支持分页、筛选、搜索）
class MemoryListParams {
  final String characterId;
  final String? category;
  final String? keyword;
  final int page;
  final int pageSize;
  final bool oldestFirst;

  const MemoryListParams({
    required this.characterId,
    this.category,
    this.keyword,
    this.page = 0,
    this.pageSize = 20,
    this.oldestFirst = false,
  });

  @override
  bool operator ==(Object other) =>
      other is MemoryListParams &&
      characterId == other.characterId &&
      category == other.category &&
      keyword == other.keyword &&
      page == other.page &&
      pageSize == other.pageSize &&
      oldestFirst == other.oldestFirst;

  @override
  int get hashCode => Object.hash(characterId, category, keyword, page, pageSize, oldestFirst);
}

class MemoryListResult {
  final List<Memory> memories;
  final int total;
  final bool hasMore;

  const MemoryListResult({
    required this.memories,
    required this.total,
    required this.hasMore,
  });
}

/// LIKE 搜索关键词清洗：把 SQL LIKE 通配符 `%` `_` 移除，避免被识别为通配符。
///
/// 实现细节：
/// - drift 2.x 的 `column.like(pattern)` 直接生成 `column LIKE ?`，**不带**
///   `ESCAPE` 子句，因此用 `\%` `\_` 转义 + 反斜杠的方式在默认 LIKE 下无效。
/// - 也无法在 fluent API 里附加 `ESCAPE`（drift 没暴露 `customWhere` 给
///   `SimpleSelectStatement`）。
/// - 改用「直接移除 `%` 和 `_`」做关键词清洗：用户搜索 `100%电量` 时退化为
///   `100电量`（仍能命中含「100」+「电量」连续片段的记录），保证不会误命中
///   超出预期的"全部记录"或"任意单字符"。
/// - 反斜杠 `\` 不需要特殊处理（默认 LIKE 中 `\` 不是转义符）。
///
/// 这是在 drift 2.x API 限制下的最小副作用方案；如果未来升级到支持
/// `customWhere` / 原生 SQL ESCAPE 的版本，可以恢复转义语义。
String _sanitizeLikeKeyword(String s) {
  return s.replaceAll('%', '').replaceAll('_', '');
}

final memoryListProvider =
    FutureProvider.autoDispose.family<MemoryListResult, MemoryListParams>((ref, params) async {
  final db = ref.watch(databaseProvider);

  return await db.transaction(() async {
    // 构建查询
    var query = db.select(db.memories)
      ..where((t) => t.characterId.equals(params.characterId));

    if (params.category != null && params.category!.isNotEmpty) {
      query = query..where((t) => t.category.equals(params.category!));
    }

    if (params.keyword != null && params.keyword!.isNotEmpty) {
      final sanitized = _sanitizeLikeKeyword(params.keyword!);
      // sanitize 后若整个关键词都是通配符（如纯 "%%"），跳过 LIKE 过滤，
      // 避免 `LIKE '%%'` 退化为「匹配所有」。
      if (sanitized.isNotEmpty) {
        query = query
          ..where((t) =>
              t.content.like('%$sanitized%') |
              t.tags.like('%$sanitized%'));
      }
    }

    // 获取总数 — 使用 selectOnly + count() 避免全量加载所有行仅为了取数量
    final countQuery = db.selectOnly(db.memories)
      ..addColumns([db.memories.id.count()])
      ..where(db.memories.characterId.equals(params.characterId));
    if (params.category != null && params.category!.isNotEmpty) {
      countQuery.where(db.memories.category.equals(params.category!));
    }
    if (params.keyword != null && params.keyword!.isNotEmpty) {
      final sanitized = _sanitizeLikeKeyword(params.keyword!);
      if (sanitized.isNotEmpty) {
        countQuery.where(
          db.memories.content.like('%$sanitized%') |
          db.memories.tags.like('%$sanitized%'),
        );
      }
    }
    final countRow = await countQuery.getSingleOrNull();
    final total = countRow?.read(db.memories.id.count()) ?? 0;

    // 排序和分页
    var sortedQuery = db.select(db.memories)
      ..where((t) => t.characterId.equals(params.characterId));

    if (params.category != null && params.category!.isNotEmpty) {
      sortedQuery = sortedQuery..where((t) => t.category.equals(params.category!));
    }
    if (params.keyword != null && params.keyword!.isNotEmpty) {
      final sanitized = _sanitizeLikeKeyword(params.keyword!);
      if (sanitized.isNotEmpty) {
        sortedQuery = sortedQuery
          ..where((t) =>
              t.content.like('%$sanitized%') |
              t.tags.like('%$sanitized%'));
      }
    }

    sortedQuery = sortedQuery
      ..orderBy([
        (t) => params.oldestFirst
            ? OrderingTerm.asc(t.createdAt)
            : OrderingTerm.desc(t.createdAt),
        // 主项目对照：同一 created_at 内按 rowid 排序，保证后插入的记忆排在前面
        (t) => params.oldestFirst
            ? OrderingTerm(expression: const CustomExpression('rowid'), mode: OrderingMode.asc)
            : OrderingTerm(expression: const CustomExpression('rowid'), mode: OrderingMode.desc),
      ])
      ..limit(params.pageSize, offset: params.page * params.pageSize);

    final memories = await sortedQuery.get();

    return MemoryListResult(
      memories: memories,
      total: total,
      hasMore: (params.page + 1) * params.pageSize < total,
    );
  });
});

/// 记忆操作
final memoryActionsProvider = Provider<MemoryActions>((ref) {
  return MemoryActions(ref.read(databaseProvider));
});

class MemoryActions {
  final AppDatabase _db;
  static const _uuid = Uuid();

  MemoryActions(this._db);

  /// 添加记忆
  Future<String> create({
    required String characterId,
    required String category,
    required String content,
    double confidence = 0.9,
    List<String> tags = const [],
  }) async {
    // FIX(C1)：使用完整 UUID（之前 substring(0, 8) 短 UUID 在大数据量下存在
    // 碰撞风险，与 character / message 的修复保持一致）。
    final id = _uuid.v4();
    final now = DateTime.now();

    await _db.into(_db.memories).insert(MemoriesCompanion.insert(
      id: id,
      characterId: characterId,
      category: category,
      content: content,
      confidence: Value(confidence),
      tags: Value(jsonEncode(tags)),
      createdAt: Value(now),
      updatedAt: Value(now),
    ));

    return id;
  }

  /// 编辑记忆
  Future<void> update(String id, {
    String? category,
    String? content,
    double? confidence,
    List<String>? tags,
  }) async {
    await (_db.update(_db.memories)..where((t) => t.id.equals(id))).write(
      MemoriesCompanion(
        category: category != null ? Value(category) : const Value.absent(),
        content: content != null ? Value(content) : const Value.absent(),
        confidence: confidence != null ? Value(confidence) : const Value.absent(),
        tags: tags != null ? Value(jsonEncode(tags)) : const Value.absent(),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  /// 删除记忆
  Future<void> delete(String id) async {
    await (_db.delete(_db.memories)..where((t) => t.id.equals(id))).go();
  }

  /// 删除角色的所有记忆
  Future<void> deleteAllForCharacter(String characterId) async {
    await (_db.delete(_db.memories)
          ..where((t) => t.characterId.equals(characterId)))
        .go();
  }
}

/// 订阅指定对话「最近一条记忆任务」状态快照流。
///
/// - 直接从 Drift 读取 `memory_tasks` 最新一行，与
///   [MemoryExtractionService.watchLatestTaskStatus] 行为完全一致；
///   保留独立查询避免在 UI 层为了订阅状态而构造 LLM / MemoryEngine。
/// - 该对话尚无任务时发射 `null`。
/// - 同对话连续多任务时永远反映 `updated_at` 最新一行，订阅方可用
///   `taskId` 变化作为「新任务」的边沿信号。
///
/// 由 ChatView 消费，用于：
///   * `status == 'processing'` 时显示「记忆提取中」指示器
///   * `processing → done` 边沿且 `mergeCount > 0` 时弹出
///     「已合并/更新 N 条记忆」Toast
///   * `failed` 时隐藏指示器但不弹 Toast
final latestMemoryTaskProvider =
    StreamProvider.family<MemoryTaskStatus?, String>((ref, conversationId) {
  final db = ref.watch(databaseProvider);
  final query = db.select(db.memoryTasks)
    ..where((t) => t.conversationId.equals(conversationId))
    ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
    ..limit(1);
  return query.watch().map((rows) {
    if (rows.isEmpty) return null;
    final row = rows.first;
    return MemoryTaskStatus(
      taskId: row.id,
      status: row.status,
      mergeCount: row.mergeCount,
      updatedAt: row.updatedAt,
    );
  });
});

final conversationUnextractedCountProvider =
    StreamProvider.family<int, String>((ref, conversationId) {
  final db = ref.watch(databaseProvider);
  final query = db.select(db.messages)
    ..where((t) => t.conversationId.equals(conversationId) & t.role.equals('user'))
    ..orderBy([
      (t) => OrderingTerm.asc(t.createdAt),
      (t) => OrderingTerm.asc(t.seq),
    ]);

  return query.watch().map((allMessages) {
    return allMessages.where((message) {
      final raw = message.metadata.trim();
      if (raw.isEmpty || raw == '{}' || raw == 'null') return true;
      try {
        final meta = MessageMetadata.fromJsonString(raw);
        return !meta.memoryExtracted;
      } catch (_) {
        return true;
      }
    }).length;
  });
});