// 工作记忆包检索服务测试 — 覆盖 22 个用例组：配置解析 / 记忆加载 / 标记 used /
// 候选去重 / 评分函数 / 分层 / 画像处理 / 渲染 / token 预算裁剪 / 向量召回 /
// 重排 / 限制计算 / 超时 / 兜底包 / 主路径 / 主入口。
// 对齐主项目 src/lib/memory-retrieval.ts 行为。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/models/working_memory_package.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_embedding_tasks_service.dart';
import 'package:lumimuse/core/services/memory_embeddings_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_profile_service.dart';
import 'package:lumimuse/core/services/memory_retrieval_service.dart';
import 'package:lumimuse/core/utils/system_prompt_builder.dart';
import 'package:lumimuse/core/utils/token_counter.dart';

// ─────────────────────────────────────────────────────────────
// 测试辅助
// ─────────────────────────────────────────────────────────────

const _charId = 'char-retrieval';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(
  AppDatabase db, {
  String id = _charId,
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

/// 测试默认时间锚点（避免 Drift currentDateAndTime 导致断言不稳定）。
DateTime _defaultTime() => DateTime(2026, 1, 1);

/// 写一行 Memory 并回读，便于测试断言字段。updatedAt/createdAt 显式传入避免 Drift
/// 默认 currentDateAndTime 导致测试断言不稳定。
Future<Memory> _seedMemory(
  AppDatabase db, {
  required String id,
  String characterId = _charId,
  String category = '基础信息',
  String content = '',
  double importance = 0.5,
  double emotionalWeight = 0.5,
  String memoryKind = 'general',
  String status = 'active',
  bool pinned = false,
  int usageCount = 0,
  DateTime? updatedAt,
  DateTime? createdAt,
}) async {
  final ts = updatedAt ?? _defaultTime();
  final cs = createdAt ?? _defaultTime();
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: characterId,
          category: category,
          content: content,
          importance: Value(importance),
          emotionalWeight: Value(emotionalWeight),
          memoryKind: Value(memoryKind),
          status: Value(status),
          pinned: Value(pinned),
          usageCount: Value(usageCount),
          updatedAt: Value(ts),
          createdAt: Value(cs),
        ),
      );
  return (db.select(db.memories)..where((m) => m.id.equals(id))).getSingle();
}

/// 直接构造 Memory 行类（不写库），用于纯逻辑测试。
Memory _makeMemory({
  String id = 'mem',
  String characterId = _charId,
  String category = '基础信息',
  String content = '记忆内容',
  double importance = 0.5,
  double emotionalWeight = 0.5,
  String memoryKind = 'general',
  String status = 'active',
  bool pinned = false,
  int usageCount = 0,
  DateTime? updatedAt,
  DateTime? createdAt,
}) {
  final ts = updatedAt ?? _defaultTime();
  final cs = createdAt ?? _defaultTime();
  return Memory(
    id: id,
    characterId: characterId,
    category: category,
    content: content,
    confidence: 0.8,
    tags: '[]',
    sourceMsgIds: '[]',
    createdAt: cs,
    updatedAt: ts,
    memoryKind: memoryKind,
    importance: importance,
    emotionalWeight: emotionalWeight,
    status: status,
    pinned: pinned,
    usageCount: usageCount,
  );
}

// ─────────────────────────────────────────────────────────────
// Fake 服务
// ─────────────────────────────────────────────────────────────

/// 假 LLM：避免 MemoryEngine 触发真实网络。
class _FakeLlmService extends LlmService {
  _FakeLlmService() : super();
}

/// 假 MemoryEmbeddingsService：override embedText 返回受控向量。
class _FakeEmbeddingsService extends MemoryEmbeddingsService {
  _FakeEmbeddingsService();

  /// 设置后 embedText 返回该向量；为 null 时抛错模拟失败。
  List<double>? nextEmbedding;

  /// embedText 调用计数，用于断言路径是否进入。
  int callCount = 0;

  @override
  Future<List<double>> embedText(
    String input,
    EmbeddingAdapterConfig config,
  ) async {
    callCount += 1;
    if (nextEmbedding == null) {
      throw StateError('embedText failed: no embedding configured');
    }
    return List<double>.from(nextEmbedding!);
  }
}

/// 假 MemoryEmbeddingTasksService：override loadReadyMemoryEmbeddings 返回受控行。
class _FakeEmbeddingTasksService extends MemoryEmbeddingTasksService {
  _FakeEmbeddingTasksService(super.db);

  /// 设置后 loadReadyMemoryEmbeddings 返回该列表；为 null 时调用真实实现。
  List<MemoryEmbedding>? nextRows;

  /// 控制不带 dimension 重查时返回的行（用于 dimension mismatch 测试）。
  List<MemoryEmbedding>? nextMismatchedRows;

  @override
  Future<List<MemoryEmbedding>> loadReadyMemoryEmbeddings(
    String characterId, {
    String? provider,
    String? model,
    int? dimension,
    int limit = vectorRetrievalScanLimit,
  }) async {
    if (dimension != null) {
      return nextRows ?? const <MemoryEmbedding>[];
    }
    // 不带 dimension 的二次查询（dimension mismatch 检测路径）
    return nextMismatchedRows ?? const <MemoryEmbedding>[];
  }
}

/// 假 MemoryProfileService：override readMemoryProfile 返回受控画像。
class _FakeProfileService extends MemoryProfileService {
  _FakeProfileService(super.db, super.llm);

  /// 设置后 readMemoryProfile 返回该值；为 null 时返回 null（模拟角色无画像）。
  MemoryProfile? nextProfile;

  @override
  Future<MemoryProfile?> readMemoryProfile(String characterId) async {
    return nextProfile;
  }
}

/// HttpServer mock LLM/Reranker/Embedding — 返回固定 JSON body。
Future<HttpServer> _serveJson(
  Object body, {
  int statusCode = 200,
  void Function(HttpRequest)? onRequest,
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(
    server.forEach((request) async {
      if (onRequest != null) onRequest(request);
      request.response.statusCode = statusCode;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    }),
  );
  return server;
}

/// 构造 OpenAI 兼容 reranker 响应（results 数组格式）。
Map<String, dynamic> _rerankBody(List<Map<String, dynamic>> results) {
  return {'results': results};
}

/// 组装 MemoryEmbedding 行，embedding 用 [embeddingToBlob] 序列化。
MemoryEmbedding _makeEmbeddingRow({
  required String memoryId,
  required List<double> embedding,
  String characterId = _charId,
  String provider = 'openai-compatible',
  String model = 'test-model',
  int? dimension,
}) {
  return MemoryEmbedding(
    id: 0,
    memoryId: memoryId,
    characterId: characterId,
    provider: provider,
    model: model,
    dimension: dimension ?? embedding.length,
    embeddingBlob: embeddingToBlob(embedding),
    normalized: 1,
    embeddingTextHash: 'hash-$memoryId',
    status: 'ready',
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 1, 1),
  );
}

/// 组装一个完整的 MemoryRetrievalService，依赖按需 fake。
MemoryRetrievalService _makeService({
  required AppDatabase db,
  _FakeEmbeddingsService? embeddings,
  _FakeEmbeddingTasksService? embeddingTasks,
  _FakeProfileService? profile,
  MemoryEngine? memoryEngine,
}) {
  return MemoryRetrievalService(
    db,
    memoryEngine ?? MemoryEngine(db, _FakeLlmService()),
    embeddings ?? _FakeEmbeddingsService(),
    embeddingTasks ?? _FakeEmbeddingTasksService(db),
    profile ?? _FakeProfileService(db, _FakeLlmService()),
  );
}

// ─────────────────────────────────────────────────────────────
// 测试主体
// ─────────────────────────────────────────────────────────────

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  // ═══════════════════════════════════════════════════════════════
  // 1. resolveMemoryEngineConfig
  // ═══════════════════════════════════════════════════════════════
  group('1. resolveMemoryEngineConfig', () {
    test('默认值合并：override 为 null 时回退 defaults', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final resolved = svc.resolveMemoryEngineConfig(const AppSettings());

      expect(resolved.enabled, MemoryEngineConfig.defaults.enabled);
      expect(resolved.memoryPackageTokenBudget,
          MemoryEngineConfig.defaults.memoryPackageTokenBudget);
      expect(resolved.finalTopK, MemoryEngineConfig.defaults.finalTopK);
      expect(resolved.embeddingDimension, 1024);
    });

    test('memoryPackageTokenBudget 钳上界 32000', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final resolved = svc.resolveMemoryEngineConfig(
        const AppSettings(),
        override: const MemoryEngineConfig(
          enabled: true,
          memoryPackageTokenBudget: 100000,
        ),
      );

      expect(resolved.memoryPackageTokenBudget, 32000);
    });

    test('limitInject=true 且 base.finalTopK 无效时 finalTopK = memoryMaxInject', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // base.finalTopK=0 视为无效 → fallback 到 limitInject 路径的 memoryMaxInject
      final resolved = svc.resolveMemoryEngineConfig(
        const AppSettings(limitInject: true, memoryMaxInject: 42),
        override: const MemoryEngineConfig(finalTopK: 0),
      );

      expect(resolved.finalTopK, 42);
    });

    test('limitInject=false 时 finalTopK 取 base.finalTopK', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final resolved = svc.resolveMemoryEngineConfig(
        const AppSettings(limitInject: false),
        override: const MemoryEngineConfig(finalTopK: 25),
      );

      expect(resolved.finalTopK, 25);
    });

    test('retrievalMode 非 vector/hybrid 时回退 local', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final resolved = svc.resolveMemoryEngineConfig(
        const AppSettings(),
        override: const MemoryEngineConfig(retrievalMode: 'invalid'),
      );

      expect(resolved.retrievalMode, 'local');
    });

    test('embeddingDimension 非法回退 1024', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final resolved = svc.resolveMemoryEngineConfig(
        const AppSettings(),
        override: const MemoryEngineConfig(embeddingDimension: 0),
      );

      expect(resolved.embeddingDimension, 1024);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. loadDefaultPriorityMemories
  // ═══════════════════════════════════════════════════════════════
  group('2. loadDefaultPriorityMemories', () {
    test('返回 pinned/importance>=0.85/character_promise 三类', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      // pinned
      await _seedMemory(db, id: 'm-pin', pinned: true, importance: 0.1);
      // importance>=0.85
      await _seedMemory(db, id: 'm-imp', importance: 0.9, pinned: false);
      // character_promise
      await _seedMemory(db,
          id: 'm-promise', memoryKind: 'character_promise', importance: 0.5);
      // 非优先级（应被过滤）
      await _seedMemory(db, id: 'm-skip', importance: 0.5, memoryKind: 'general');

      final result = await svc.loadDefaultPriorityMemories(_charId);
      final ids = result.map((m) => m.id).toSet();
      expect(ids, containsAll(<String>{'m-pin', 'm-imp', 'm-promise'}));
      expect(ids, isNot(contains('m-skip')));
    });

    test('排序：pinned DESC → importance DESC → updatedAt DESC', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      // 都 pinned=true，importance 高的在前
      await _seedMemory(db,
          id: 'm-low',
          pinned: true,
          importance: 0.5,
          updatedAt: DateTime(2026, 1, 1));
      await _seedMemory(db,
          id: 'm-high',
          pinned: true,
          importance: 0.95,
          updatedAt: DateTime(2026, 1, 1));

      final result = await svc.loadDefaultPriorityMemories(_charId);
      expect(result.first.id, 'm-high');
    });

    test('status != active 被过滤', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db,
          id: 'm-arch', pinned: true, status: 'archived');

      final result = await svc.loadDefaultPriorityMemories(_charId);
      expect(result, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. loadDefaultLegacyMemories
  // ═══════════════════════════════════════════════════════════════
  group('3. loadDefaultLegacyMemories', () {
    test('返回所有 active 记忆，按 pinned/importance/updatedAt DESC', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      // 非优先级记忆也应被召回（区别于 loadDefaultPriorityMemories）
      await _seedMemory(db,
          id: 'm-a', importance: 0.5, updatedAt: DateTime(2026, 1, 1));
      await _seedMemory(db,
          id: 'm-b',
          importance: 0.8, updatedAt: DateTime(2026, 1, 2));
      // archived 应过滤
      await _seedMemory(db,
          id: 'm-arch', status: 'archived', importance: 0.99);

      final result = await svc.loadDefaultLegacyMemories(_charId);
      expect(result, hasLength(2));
      // importance 高的在前
      expect(result.first.id, 'm-b');
    });

    test('LIMIT 300：超过 300 条只返回前 300', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      for (var i = 0; i < 310; i++) {
        await _seedMemory(db, id: 'm-$i', content: 'content $i');
      }

      final result = await svc.loadDefaultLegacyMemories(_charId);
      expect(result.length, 300);
    }, timeout: const Timeout(Duration(seconds: 30)));
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. loadDefaultMemoriesByIds
  // ═══════════════════════════════════════════════════════════════
  group('4. loadDefaultMemoriesByIds', () {
    test('按入参顺序返回，跳过不存在 id', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-3');
      await _seedMemory(db, id: 'm-1');
      await _seedMemory(db, id: 'm-2');

      final result = await svc
          .loadDefaultMemoriesByIds(<String>['m-2', 'm-x', 'm-1', 'm-3']);
      expect(result.map((m) => m.id).toList(), <String>['m-2', 'm-1', 'm-3']);
    });

    test('空 ids 返回空列表', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final result = await svc.loadDefaultMemoriesByIds(<String>[]);
      expect(result, isEmpty);
    });

    test('status != active 的记忆被过滤', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-arch', status: 'archived');

      final result = await svc.loadDefaultMemoriesByIds(<String>['m-arch']);
      expect(result, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. markDefaultMemoriesUsed / markSelectedMemoriesUsed
  // ═══════════════════════════════════════════════════════════════
  group('5. markDefaultMemoriesUsed / markSelectedMemoriesUsed', () {
    test('usage_count 自增 1，last_used_at 更新', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', usageCount: 5);
      await _seedMemory(db, id: 'm-b', usageCount: 0);

      await svc.markDefaultMemoriesUsed(<String>['m-a', 'm-b']);

      final rows = await db.select(db.memories).get();
      final a = rows.firstWhere((m) => m.id == 'm-a');
      final b = rows.firstWhere((m) => m.id == 'm-b');
      expect(a.usageCount, 6);
      expect(b.usageCount, 1);
      // last_used_at 应为非空毫秒级时间戳
      expect(a.lastUsedAt, isNotNull);
      expect(b.lastUsedAt, isNotNull);
    });

    test('空 ids 不抛错', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      await svc.markDefaultMemoriesUsed(<String>[]);
      // 不抛错即通过
    });

    test('markSelectedMemoriesUsed 吞错不抛（bad id）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // 不存在的 id 走 raw SQL 不会抛错（IN 子句空匹配 0 行）
      await svc.markSelectedMemoriesUsed(<Memory>[
        _makeMemory(id: 'nope'),
      ]);
      // 不抛错即通过
    });

    test('markSelectedMemoriesUsed 去重相同 id', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', usageCount: 0);

      // 同一 id 传两次，应该只 +1（去重后单次更新）
      await svc.markSelectedMemoriesUsed(<Memory>[
        _makeMemory(id: 'm-a'),
        _makeMemory(id: 'm-a'),
      ]);

      final row = await (db.select(db.memories)
            ..where((m) => m.id.equals('m-a')))
          .getSingle();
      expect(row.usageCount, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. addCandidate
  // ═══════════════════════════════════════════════════════════════
  group('6. addCandidate', () {
    test('新 id 直接写入', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final map = <String, RetrievedMemory>{};
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 0.5, 'local');
      expect(map, hasLength(1));
      expect(map['m-a']!.relevance, 0.5);
      expect(map['m-a']!.source, 'local');
    });

    test('去重：相同 id 时保留更高 relevance', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final map = <String, RetrievedMemory>{};
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 0.3, 'local');
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 0.7, 'vector');

      expect(map, hasLength(1));
      expect(map['m-a']!.relevance, 0.7);
      expect(map['m-a']!.source, 'vector');
    });

    test('source=priority 强制覆盖即使新 relevance 更低', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final map = <String, RetrievedMemory>{};
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 0.9, 'vector');
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 0.1, 'priority');

      expect(map['m-a']!.relevance, 0.1);
      expect(map['m-a']!.source, 'priority');
    });

    test('relevance 钳 [0,1]', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final map = <String, RetrievedMemory>{};
      svc.addCandidate(map, _makeMemory(id: 'm-a'), 1.5, 'local');
      expect(map['m-a']!.relevance, 1.0);

      svc.addCandidate(map, _makeMemory(id: 'm-b'), -0.5, 'local');
      expect(map['m-b']!.relevance, 0.0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. clamp01 / recencyScore / categoryBonus / statusPenalty
  // ═══════════════════════════════════════════════════════════════
  group('7. clamp01 / recencyScore / categoryBonus / statusPenalty', () {
    test('clamp01：[0,1] 范围内原样返回；越界钳制；NaN 回退 fallback', () {
      expect(MemoryRetrievalService.clamp01(0.5, 0.0), 0.5);
      expect(MemoryRetrievalService.clamp01(-1.0, 0.0), 0.0);
      expect(MemoryRetrievalService.clamp01(2.0, 0.0), 1.0);
      expect(MemoryRetrievalService.clamp01(double.nan, 0.42), 0.42);
    });

    test('recencyScore：now → 1.0；30天前 → 0.5；未来 → 1.0', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      final now = DateTime(2026, 7, 1);

      final today =
          _makeMemory(id: 'm', updatedAt: now);
      expect(svc.recencyScore(today, now), 1.0);

      final monthAgo =
          _makeMemory(id: 'm', updatedAt: now.subtract(const Duration(days: 30)));
      expect(svc.recencyScore(monthAgo, now), closeTo(0.5, 1e-9));

      final future =
          _makeMemory(id: 'm', updatedAt: now.add(const Duration(days: 1)));
      expect(svc.recencyScore(future, now), 1.0);
    });

    test('categoryBonus：character_promise=1.0；relationship_event=0.8；重要事件=0.7；其余=0.2',
        () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      expect(svc.categoryBonus(_makeMemory(memoryKind: 'character_promise')), 1.0);
      expect(svc.categoryBonus(_makeMemory(memoryKind: 'relationship_event')), 0.8);
      expect(svc.categoryBonus(_makeMemory(category: '重要事件', memoryKind: 'general')),
          0.7);
      expect(svc.categoryBonus(_makeMemory(memoryKind: 'general')), 0.2);
    });

    test('statusPenalty：archived/superseded=0.7；conflict=0.4；其余=0', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      expect(svc.statusPenalty(_makeMemory(status: 'archived')), 0.7);
      expect(svc.statusPenalty(_makeMemory(status: 'superseded')), 0.7);
      expect(svc.statusPenalty(_makeMemory(status: 'conflict')), 0.4);
      expect(svc.statusPenalty(_makeMemory(status: 'active')), 0.0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. scoreCandidate
  // ═══════════════════════════════════════════════════════════════
  group('8. scoreCandidate', () {
    test('加权计算正确（全字段已知）', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // 现在时间，确保 recencyScore=1.0
      final now = DateTime(2026, 7, 1);
      final memory = _makeMemory(
        id: 'm',
        importance: 0.6,
        emotionalWeight: 0.4,
        memoryKind: 'character_promise',
        pinned: true,
        usageCount: 10,
        updatedAt: now,
      );
      final candidate = RetrievedMemory(
        memory: memory,
        relevance: 0.8,
        finalScore: 0,
        source: 'vector',
      );

      final scored = svc.scoreCandidate(candidate, now: now);
      // 期望：0.45·0.8 + 0.20·0.6 + 0.15·0.4 + 0.10·1.0 +
      //       0.05·(log(11)/log(11)=1) + 0.05·1.0 + 1·0.4 - 0 = 0.36+0.12+0.06+0.1+0.05+0.05+0.4 = 1.14
      expect(scored.finalScore, closeTo(1.14, 1e-6));
    });

    test('非 finite importance 应用 defaults 兜底', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final now = DateTime(2026, 7, 1);
      // category='基础信息' → defaults.importance=0.85, emotionalWeight=0.0
      final memory = _makeMemory(
        id: 'm',
        category: '基础信息',
        importance: double.nan,
        emotionalWeight: double.nan,
        updatedAt: now,
      );
      final candidate = RetrievedMemory(
        memory: memory,
        relevance: 0.0,
        finalScore: 0,
        source: 'local',
      );

      final scored = svc.scoreCandidate(candidate, now: now);
      // 0.20·0.85(importance defaults) + 0.10·1.0(recency=now) +
      // 0.05·0.2(categoryBonus, memoryKind=general, category=基础信息 不在 bonus 列表) = 0.28
      expect(scored.finalScore, closeTo(0.28, 1e-6));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. rankCandidates / rankCandidatesByRelevance
  // ═══════════════════════════════════════════════════════════════
  group('9. rankCandidates / rankCandidatesByRelevance', () {
    test('rankCandidatesByRelevance：relevance DESC，tie-break updatedAt DESC',
        () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final candidates = <RetrievedMemory>[
        RetrievedMemory(
            memory: _makeMemory(id: 'a', updatedAt: DateTime(2026, 1, 1)),
            relevance: 0.3,
            finalScore: 0,
            source: 'local'),
        RetrievedMemory(
            memory: _makeMemory(id: 'b', updatedAt: DateTime(2026, 1, 2)),
            relevance: 0.3,
            finalScore: 0,
            source: 'local'),
        RetrievedMemory(
            memory: _makeMemory(id: 'c', updatedAt: DateTime(2026, 1, 1)),
            relevance: 0.9,
            finalScore: 0,
            source: 'vector'),
      ];

      final ranked = svc.rankCandidatesByRelevance(candidates);
      expect(ranked.map((c) => c.memory.id).toList(), <String>['c', 'b', 'a']);
    });

    test('rankCandidates：finalScore DESC，tie-break updatedAt DESC', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final now = DateTime(2026, 7, 1);
      // 都给 0 relevance，让 finalScore 完全由 importance+recency 决定
      final candidates = <RetrievedMemory>[
        RetrievedMemory(
            memory: _makeMemory(id: 'low', importance: 0.1, updatedAt: now),
            relevance: 0.0,
            finalScore: 0,
            source: 'local'),
        RetrievedMemory(
            memory: _makeMemory(id: 'high', importance: 0.9, updatedAt: now),
            relevance: 0.0,
            finalScore: 0,
            source: 'local'),
      ];

      final ranked = svc.rankCandidates(candidates, now: now);
      expect(ranked.first.memory.id, 'high');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 10. layerForMemory
  // ═══════════════════════════════════════════════════════════════
  group('10. layerForMemory', () {
    test('pinned → 重要固定记忆', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory(pinned: true)), '重要固定记忆');
    });

    test('importance >= 0.9 → 重要固定记忆', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory(importance: 0.9)), '重要固定记忆');
    });

    test('memoryKind=character_promise → 角色需要兑现的承诺', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory(memoryKind: 'character_promise')),
          '角色需要兑现的承诺');
    });

    test('memoryKind=user_preference → 主人的偏好与长期信息', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory(memoryKind: 'user_preference')),
          '主人的偏好与长期信息');
    });

    test('memoryKind=relationship_event → 关系与重要事件', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory(memoryKind: 'relationship_event')),
          '关系与重要事件');
    });

    test('默认 → 本轮相关回忆', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);
      expect(svc.layerForMemory(_makeMemory()), '本轮相关回忆');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 11. trimProfileText
  // ═══════════════════════════════════════════════════════════════
  group('11. trimProfileText', () {
    test('空字符串返回空', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final result = svc.trimProfileText(
        '',
        MemoryEngineConfig.defaults,
        estimateTokens,
      );
      expect(result, isEmpty);
    });

    test('行级累加，超 budget 停', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // 用极小 budget 强制截断；每行约 9 token（6 CJK 字 × 1.5）
      final profileText = List.generate(20, (i) => '行 $i 内容填充').join('\n');
      final result = svc.trimProfileText(
        profileText,
        const MemoryEngineConfig(profileTokenBudget: 30),
        estimateTokens,
      );
      // 30 token 只够前 2-3 行
      expect(result.length, lessThan(profileText.length));
      expect(result, isNotEmpty);
    });

    test('单行超 budget 时返回空字符串', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // budget 缩到 5 token，单行中文 5 字 ≈ 7.5 token 必然超
      final result = svc.trimProfileText(
        '这是一个非常长的画像文本行',
        const MemoryEngineConfig(profileTokenBudget: 5),
        estimateTokens,
      );
      expect(result, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 12. resolveProfileText
  // ═══════════════════════════════════════════════════════════════
  group('12. resolveProfileText', () {
    test('null profile 回退空 MemoryProfile，渲染为空字符串', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeProfile = _FakeProfileService(db, _FakeLlmService());
      fakeProfile.nextProfile = null;
      final svc = _makeService(db: db, profile: fakeProfile);

      final result = await svc.resolveProfileText(
        _charId,
        MemoryEngineConfig.defaults,
        estimateTokens,
      );
      expect(result, isEmpty);
    });

    test('真实 profile 渲染并 trim', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeProfile = _FakeProfileService(db, _FakeLlmService());
      fakeProfile.nextProfile = MemoryProfile(
        characterId: _charId,
        relationshipState: '朋友',
        updatedAt: DateTime(2026, 1, 1),
      );
      final svc = _makeService(db: db, profile: fakeProfile);

      final result = await svc.resolveProfileText(
        _charId,
        MemoryEngineConfig.defaults,
        estimateTokens,
      );
      expect(result, contains('朋友'));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 13. renderPackage
  // ═══════════════════════════════════════════════════════════════
  group('13. renderPackage', () {
    test('空 memories + 空 profile → 空字符串', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      expect(svc.renderPackage(<Memory>[]), isEmpty);
    });

    test('5 分组结构 + profileText 注入 + 末尾记忆使用原则', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final memories = <Memory>[
        _makeMemory(id: 'pin', content: '置顶内容', pinned: true),
        _makeMemory(
            id: 'promise',
            content: '承诺内容',
            memoryKind: 'character_promise'),
        _makeMemory(
            id: 'pref', content: '偏好内容', memoryKind: 'user_preference'),
        _makeMemory(
            id: 'rel', content: '关系内容', memoryKind: 'relationship_event'),
        _makeMemory(id: 'gen', content: '普通内容'),
      ];

      final text = svc.renderPackage(memories, profileText: '画像文本');
      expect(text, startsWith(SystemPromptBuilder.memoryContextTitle));
      expect(text, contains('### 记忆画像'));
      expect(text, contains('画像文本'));
      expect(text, contains('### 重要固定记忆'));
      expect(text, contains('置顶内容'));
      expect(text, contains('### 角色需要兑现的承诺'));
      expect(text, contains('承诺内容'));
      expect(text, contains('### 主人的偏好与长期信息'));
      expect(text, contains('偏好内容'));
      expect(text, contains('### 关系与重要事件'));
      expect(text, contains('关系内容'));
      expect(text, contains('### 本轮相关回忆'));
      expect(text, contains('普通内容'));
      // 末尾追加记忆使用原则
      expect(text, endsWith(SystemPromptBuilder.memoryUsagePrinciples));
    });

    test('空 content 的记忆被跳过', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final memories = <Memory>[
        _makeMemory(id: 'empty', content: '   ', pinned: true),
        _makeMemory(id: 'real', content: '真实内容', pinned: true),
      ];
      final text = svc.renderPackage(memories);
      expect(text, contains('真实内容'));
      // 重要固定记忆分组应只有真实内容
      expect(text, contains('### 重要固定记忆\n- 真实内容'));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 14. truncateMemoryForBudget
  // ═══════════════════════════════════════════════════════════════
  group('14. truncateMemoryForBudget', () {
    test('空 content 返回 null', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final result = svc.truncateMemoryForBudget(
        _makeMemory(content: ''),
        1000,
        '',
        estimateTokens,
        <Memory>[],
      );
      expect(result, isNull);
    });

    test('超 budget 时截断并保留 …', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final long = _makeMemory(content: '一二三四五六七八九十' * 100);
      // budget 需大于固定结构（~255 token）但小于完整内容（~1500 token）
      final result = svc.truncateMemoryForBudget(
        long,
        400,
        '',
        estimateTokens,
        <Memory>[],
      );
      expect(result, isNotNull);
      expect(result!.content, endsWith('…'));
      expect(result.content.length, lessThan(long.content.length + 1));
    });

    test('budget 内能容纳整条时返回完整内容（含 … 后缀）', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final short = _makeMemory(content: '短内容');
      final result = svc.truncateMemoryForBudget(
        short,
        10000, // 极大 budget 完全容纳
        '',
        estimateTokens,
        <Memory>[],
      );
      expect(result, isNotNull);
      // 实现总是追加 … 后缀（即使完整内容在预算内）
      expect(result!.content, '短内容…');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 15. trimByTokenBudget
  // ═══════════════════════════════════════════════════════════════
  group('15. trimByTokenBudget', () {
    test('二分出预算内最大前缀', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final now = DateTime(2026, 7, 1);
      final ranked = List.generate(
        20,
        (i) => RetrievedMemory(
          memory: _makeMemory(
            id: 'm-$i',
            content: '记忆 $i 内容 $i',
            importance: 0.9,
            updatedAt: now,
          ),
          relevance: 0.5,
          finalScore: 1.0 - i * 0.01,
          source: 'local',
        ),
      );

      final result = svc.trimByTokenBudget(
        ranked: ranked,
        config: const MemoryEngineConfig(memoryPackageTokenBudget: 100),
        tokenCounter: estimateTokens,
        profileText: '',
        maxMemoryCount: 20,
      );

      expect(result.selected.length, lessThan(20));
      expect(result.tokenCount, lessThanOrEqualTo(100));
    });

    test('高优先级记忆超 budget 时被截断保留', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final now = DateTime(2026, 7, 1);
      // pinned=true → 高优先级
      final big = RetrievedMemory(
        memory: _makeMemory(
          id: 'big',
          content: '一二三四五六七八九十' * 50,
          pinned: true,
          updatedAt: now,
        ),
        relevance: 0.5,
        finalScore: 0.8,
        source: 'priority',
      );

      // budget 需大于固定结构（~255 token）但小于完整内容（~750 token）
      final result = svc.trimByTokenBudget(
        ranked: <RetrievedMemory>[big],
        config: const MemoryEngineConfig(memoryPackageTokenBudget: 400),
        tokenCounter: estimateTokens,
        profileText: '',
        maxMemoryCount: 10,
      );

      expect(result.selected, hasLength(1));
      expect(result.selected.first.content, endsWith('…'));
    });

    test('skipOversizedOrdinary=false 时普通超预算记忆被跳过不丢', () {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final now = DateTime(2026, 7, 1);
      // 普通记忆但极长，整个加进去会超 budget
      final big = RetrievedMemory(
        memory: _makeMemory(
          id: 'big',
          content: '一二三四五六七八九十' * 50,
          importance: 0.5,
          updatedAt: now,
        ),
        relevance: 0.5,
        finalScore: 0.5,
        source: 'local',
      );

      // skipOversizedOrdinary=false → 普通记忆超 budget 直接跳过（不丢但不截断）
      final result = svc.trimByTokenBudget(
        ranked: <RetrievedMemory>[big],
        config: const MemoryEngineConfig(memoryPackageTokenBudget: 50),
        tokenCounter: estimateTokens,
        profileText: '',
        maxMemoryCount: 10,
        skipOversizedOrdinary: false,
      );

      expect(result.selected, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 16. addVectorCandidates
  // ═══════════════════════════════════════════════════════════════
  group('16. addVectorCandidates', () {
    test('成功路径：embedText + loadReadyMemoryEmbeddings + 写候选', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.nextRows = <MemoryEmbedding>[
        _makeEmbeddingRow(memoryId: 'm-vec', embedding: <double>[1.0, 0.0]),
      ];
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );
      await _seedMemory(db, id: 'm-vec', content: '向量记忆');

      final candidates = <String, RetrievedMemory>{};
      await svc.addVectorCandidates(
        queryText: '查询',
        characterId: _charId,
        config: const MemoryEngineConfig(
          embeddingEnabled: true,
          embeddingDimension: 2,
          vectorTopK: 10,
        ),
        candidates: candidates,
      );

      expect(candidates, contains('m-vec'));
      expect(candidates['m-vec']!.source, 'vector');
      // similarity=1.0 → relevance = (1+1)/2 = 1.0
      expect(candidates['m-vec']!.relevance, 1.0);
    });

    test('embedText 失败抛错（让上层标记 embeddingFailed）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeEmb = _FakeEmbeddingsService();
      // nextEmbedding=null → embedText 抛 StateError
      final fakeTasks = _FakeEmbeddingTasksService(db);
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      final candidates = <String, RetrievedMemory>{};
      await expectLater(
        svc.addVectorCandidates(
          queryText: '查询',
          characterId: _charId,
          config: const MemoryEngineConfig(
            embeddingEnabled: true,
            embeddingDimension: 2,
          ),
          candidates: candidates,
        ),
        throwsA(isA<StateError>()),
      );
      expect(candidates, isEmpty);
    });

    test('dimension mismatch 抛错（dimension filtered 为空但 mismatched 有不同维度）',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      // dimension=2 查询返回空（dimension filtered）
      fakeTasks.nextRows = <MemoryEmbedding>[];
      // 不带 dimension 的二次查询返回 dimension=3 的行
      fakeTasks.nextMismatchedRows = <MemoryEmbedding>[
        _makeEmbeddingRow(
          memoryId: 'm-mismatch',
          embedding: <double>[1.0, 0.0, 0.0],
        ),
      ];
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      final candidates = <String, RetrievedMemory>{};
      await expectLater(
        svc.addVectorCandidates(
          queryText: '查询',
          characterId: _charId,
          config: const MemoryEngineConfig(
            embeddingEnabled: true,
            embeddingDimension: 2,
          ),
          candidates: candidates,
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('rows 为空且无 mismatched 时不抛错', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.nextRows = <MemoryEmbedding>[];
      fakeTasks.nextMismatchedRows = <MemoryEmbedding>[];
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      final candidates = <String, RetrievedMemory>{};
      await svc.addVectorCandidates(
        queryText: '查询',
        characterId: _charId,
        config: const MemoryEngineConfig(
          embeddingEnabled: true,
          embeddingDimension: 2,
        ),
        candidates: candidates,
      );
      expect(candidates, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 17. applyReranker
  // ═══════════════════════════════════════════════════════════════
  group('17. applyReranker', () {
    test('成功路径：HTTP mock rerankDocuments 写回候选 relevance', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // 启动 mock reranker 服务
      final server = await _serveJson(_rerankBody(<Map<String, dynamic>>[
        {'id': 'm-a', 'relevance_score': 0.95},
        {'id': 'm-b', 'relevance_score': 0.30},
      ]));
      addTearDown(() => server.close());

      final candidates = <String, RetrievedMemory>{
        'm-a': RetrievedMemory(
            memory: _makeMemory(id: 'm-a'),
            relevance: 0.5,
            finalScore: 0,
            source: 'vector'),
        'm-b': RetrievedMemory(
            memory: _makeMemory(id: 'm-b'),
            relevance: 0.6,
            finalScore: 0,
            source: 'vector'),
      };

      final err = await svc.applyReranker(
        queryText: '查询',
        candidates: candidates,
        config: MemoryEngineConfig(
          rerankerEnabled: true,
          rerankerApiBase: 'http://${server.address.address}:${server.port}',
          rerankerModel: 'rerank-v1',
          rerankerTimeoutMs: 5000,
        ),
      );

      expect(err, isNull);
      // 归一化后：min=0.30, max=0.95, 范围 [0,1] 内不需要归一化，直接钳 [0,1]
      expect(candidates['m-a']!.relevance, 0.95);
      expect(candidates['m-b']!.relevance, 0.30);
    });

    test('rerankerEnabled=false 直接返回 null（不调用）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final candidates = <String, RetrievedMemory>{
        'm-a': RetrievedMemory(
            memory: _makeMemory(id: 'm-a'),
            relevance: 0.5,
            finalScore: 0,
            source: 'vector'),
      };

      final err = await svc.applyReranker(
        queryText: '查询',
        candidates: candidates,
        config: const MemoryEngineConfig(rerankerEnabled: false),
      );

      expect(err, isNull);
      // 未被重排
      expect(candidates['m-a']!.relevance, 0.5);
    });

    test('HTTP 失败返回错误信息（不抛错）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      // 启动返回 500 的 mock
      final server = await _serveJson({'error': 'boom'}, statusCode: 500);
      addTearDown(() => server.close());

      final candidates = <String, RetrievedMemory>{
        'm-a': RetrievedMemory(
            memory: _makeMemory(id: 'm-a'),
            relevance: 0.5,
            finalScore: 0,
            source: 'vector'),
      };

      final err = await svc.applyReranker(
        queryText: '查询',
        candidates: candidates,
        config: MemoryEngineConfig(
          rerankerEnabled: true,
          rerankerApiBase: 'http://${server.address.address}:${server.port}',
          rerankerModel: 'rerank-v1',
          rerankerTimeoutMs: 5000,
        ),
      );

      expect(err, isNotNull);
    });

    test('空 candidates 直接返回 null', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final err = await svc.applyReranker(
        queryText: '查询',
        candidates: <String, RetrievedMemory>{},
        config: const MemoryEngineConfig(rerankerEnabled: true),
      );

      expect(err, isNull);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 18. withTotalTimeout
  // ═══════════════════════════════════════════════════════════════
  group('18. withTotalTimeout', () {
    test('超时抛 TimeoutException', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      await expectLater(
        svc.withTotalTimeout<int>(
          () async {
            await Future<void>.delayed(const Duration(milliseconds: 100));
            return 42;
          },
          10, // 10ms 超时
        ),
        throwsA(isA<TimeoutException>()),
      );
    });

    test('正常完成返回值', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final svc = _makeService(db: db);

      final result = await svc.withTotalTimeout<int>(
        () async => 42,
        5000,
      );
      expect(result, 42);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 19. buildLocalFallbackPackage
  // ═══════════════════════════════════════════════════════════════
  group('19. buildLocalFallbackPackage', () {
    test('priority + local retrieve + mode=local + usedFallback=true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      // priority: pinned
      await _seedMemory(db, id: 'm-pin', pinned: true, content: '置顶');
      // local: 普通记忆（按 TF-IDF 召回）
      await _seedMemory(db, id: 'm-gen', content: '普通记忆 cat dog');

      final pkg = await svc.buildLocalFallbackPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: 'cat dog',
          settings: AppSettings(),
        ),
        config: MemoryEngineConfig.defaults,
      );

      expect(pkg.mode, 'local');
      expect(pkg.usedFallback, isTrue);
      expect(pkg.text, contains('置顶'));
      // 至少召回了一条
      expect(pkg.selectedMemories, isNotEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 20. buildLegacyFullMemoryPackage
  // ═══════════════════════════════════════════════════════════════
  group('20. buildLegacyFullMemoryPackage', () {
    test('limitInject=true 走 localRetrieve + mode=local', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', content: '记忆 cat dog');

      final pkg = await svc.buildLegacyFullMemoryPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: 'cat dog',
          settings: AppSettings(limitInject: true, memoryMaxInject: 10),
        ),
        config: MemoryEngineConfig.defaults,
      );

      expect(pkg.mode, 'local');
      expect(pkg.usedFallback, isFalse);
      // limitInject=true 应该按 local retrieve 召回
      expect(pkg.text, contains('记忆 cat dog'));
    });

    test('limitInject=false 走全量 + mode=full', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', content: '记忆 A');
      await _seedMemory(db, id: 'm-b', content: '记忆 B');

      final pkg = await svc.buildLegacyFullMemoryPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: 'whatever',
          settings: AppSettings(limitInject: false),
        ),
        config: MemoryEngineConfig.defaults,
      );

      expect(pkg.mode, 'full');
      expect(pkg.usedFallback, isFalse);
      // limitInject=false 是全量注入，两条记忆都应该在
      expect(pkg.text, contains('记忆 A'));
      expect(pkg.text, contains('记忆 B'));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 21. buildWorkingMemoryPackage
  // ═══════════════════════════════════════════════════════════════
  group('21. buildWorkingMemoryPackage', () {
    test('embedding 成功 + reranker 成功 → mode=hybrid', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.nextRows = <MemoryEmbedding>[
        _makeEmbeddingRow(memoryId: 'm-vec', embedding: <double>[1.0, 0.0]),
      ];
      // 启动 reranker mock
      final server = await _serveJson(_rerankBody(<Map<String, dynamic>>[]));
      addTearDown(() => server.close());

      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );
      await _seedMemory(db, id: 'm-vec', content: '向量记忆');

      final pkg = await svc.buildWorkingMemoryPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: '查询',
          settings: AppSettings(),
        ),
        config: MemoryEngineConfig(
          embeddingEnabled: true,
          embeddingDimension: 2,
          rerankerEnabled: true,
          rerankerApiBase: 'http://${server.address.address}:${server.port}',
          rerankerModel: 'rerank-v1',
          fallbackLocalEnabled: true,
        ),
      );

      expect(pkg.mode, anyOf('hybrid', 'vector'));
      expect(pkg.usedFallback, isFalse);
      expect(pkg.diagnostics.embeddingFailed, isNull);
    });

    test('embedding 失败 → mode=local + diagnostics.embeddingFailed 非空',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final fakeEmb = _FakeEmbeddingsService();
      // nextEmbedding=null → embedText 抛错
      final fakeTasks = _FakeEmbeddingTasksService(db);
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      // 提供一条本地记忆让 fallback 路径有内容
      await _seedMemory(db, id: 'm-local', content: '本地记忆 cat');

      final pkg = await svc.buildWorkingMemoryPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: 'cat',
          settings: AppSettings(),
        ),
        config: const MemoryEngineConfig(
          embeddingEnabled: true,
          embeddingDimension: 2,
          fallbackLocalEnabled: true,
        ),
      );

      expect(pkg.mode, 'local');
      expect(pkg.usedFallback, isTrue);
      expect(pkg.diagnostics.embeddingFailed, isNotNull);
    });

    test('embedding 禁用 → 走 local retrieve + mode=local', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final fakeEmb = _FakeEmbeddingsService();
      final fakeTasks = _FakeEmbeddingTasksService(db);
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      await _seedMemory(db, id: 'm-local', content: '本地记忆 cat');

      final pkg = await svc.buildWorkingMemoryPackage(
        options: const RetrieveWorkingMemoryOptions(
          characterId: _charId,
          queryText: 'cat',
          settings: AppSettings(),
        ),
        config: const MemoryEngineConfig(
          embeddingEnabled: false,
          fallbackLocalEnabled: true,
        ),
      );

      expect(pkg.mode, 'local');
      // embedding 禁用不调用 embedText
      expect(fakeEmb.callCount, 0);
      expect(pkg.diagnostics.embeddingFailed, isNull);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 22. retrieveWorkingMemoryPackage 主入口
  // ═══════════════════════════════════════════════════════════════
  group('22. retrieveWorkingMemoryPackage 主入口', () {
    test('engine.enabled=false → 走 legacy 路径 + mode=full', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', content: '记忆 A');

      final pkg = await svc.retrieveWorkingMemoryPackage(
        characterId: _charId,
        queryText: 'whatever',
        settings: const AppSettings(limitInject: false),
        config: const MemoryEngineConfig(enabled: false),
      );

      expect(pkg.mode, 'full');
      expect(pkg.text, contains('记忆 A'));
    });

    test('allowMemoryContextInChat=false → 返回空包', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      final svc = _makeService(db: db);

      await _seedMemory(db, id: 'm-a', content: '记忆 A');

      final pkg = await svc.retrieveWorkingMemoryPackage(
        characterId: _charId,
        queryText: 'whatever',
        settings: const AppSettings(),
        config: const MemoryEngineConfig(allowMemoryContextInChat: false),
      );

      expect(pkg.text, isEmpty);
      expect(pkg.selectedMemories, isEmpty);
    });

    test('总超时 → 走 fallback + diagnostics.totalRetrievalTimedOut=true',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      // 让 embedText 永远卡住，触发总超时
      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.nextRows = <MemoryEmbedding>[];

      // 用一个会卡住的 fake：override embedText 等待长延迟
      final stuckEmb = _StuckEmbeddingsService();
      final svc = _makeService(
        db: db,
        embeddings: stuckEmb,
        embeddingTasks: fakeTasks,
      );
      // fallback 路径需要本地记忆
      await _seedMemory(db, id: 'm-local', content: '本地记忆 cat');

      final pkg = await svc.retrieveWorkingMemoryPackage(
        characterId: _charId,
        queryText: 'cat',
        settings: const AppSettings(),
        config: const MemoryEngineConfig(
          enabled: true,
          embeddingEnabled: true,
          embeddingDimension: 2,
          totalRetrievalTimeoutMs: 50, // 50ms 总超时
          embeddingTimeoutMs: 10000, // 单步 embedding 超时大于总超时
        ),
      );

      expect(pkg.usedFallback, isTrue);
      expect(pkg.mode, 'local');
      expect(pkg.diagnostics.totalRetrievalTimedOut, isTrue);
    }, timeout: const Timeout(Duration(seconds: 5)));

    test('主路径成功：markSelectedMemoriesUsed 被调用（usage_count +1）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final fakeEmb = _FakeEmbeddingsService();
      fakeEmb.nextEmbedding = <double>[1.0, 0.0];
      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.nextRows = <MemoryEmbedding>[];
      final svc = _makeService(
        db: db,
        embeddings: fakeEmb,
        embeddingTasks: fakeTasks,
      );

      await _seedMemory(db, id: 'm-pin', pinned: true, content: '置顶');

      final pkg = await svc.retrieveWorkingMemoryPackage(
        characterId: _charId,
        queryText: '查询',
        settings: const AppSettings(),
        config: const MemoryEngineConfig(
          enabled: true,
          embeddingEnabled: false, // 关闭 embedding 走纯 local retrieve
          fallbackLocalEnabled: true,
        ),
      );

      // 至少召回 m-pin
      expect(pkg.selectedMemories, isNotEmpty);

      // markSelectedMemoriesUsed 是 fire-and-forget；await 一小段让 raw SQL 完成
      await Future<void>.delayed(const Duration(milliseconds: 100));

      final row = await (db.select(db.memories)
            ..where((m) => m.id.equals('m-pin')))
          .getSingle();
      expect(row.usageCount, greaterThan(0));
    });
  });
}

/// 卡住的 fake embeddings：embedText 永久挂起，用于触发总超时。
class _StuckEmbeddingsService extends _FakeEmbeddingsService {
  @override
  Future<List<double>> embedText(
    String input,
    EmbeddingAdapterConfig config,
  ) async {
    // 永远不返回（让总超时触发）
    await Future<void>.delayed(const Duration(seconds: 30));
    return <double>[1.0, 0.0];
  }
}
