// 记忆 AI 整理批量校准服务测试 — 对照 Wave 14.2 任务书。
//
// 覆盖：
// - reviewMemories 批量校准（单批修正 / 空 memories / importance 越界 / 非法 id / 非法 category）
// - buildMemoryReviewBatches 分批（超限切批 / 空 entries）
// - parseMemoryReviewCorrections（去 ``` 包裹 / 无 corrections / 非 JSON）
// - mapWithConcurrencySettled 失败隔离
// - 翻页（has_more / next_offset）

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_embedding_tasks_service.dart';
import 'package:lumimuse/core/services/memory_review_service.dart';

const _charId = 'char-review';

/// 拦截 LLM 调用：按队列返回预设响应，捕获入参供断言。
class _CapturingLlm extends LlmService {
  _CapturingLlm(List<String> responses) : _responses = responses;

  final List<String> _responses;
  final List<AppSettings> capturedSettings = [];
  final List<List<ChatMessage>> capturedMessages = [];
  int _callIndex = 0;

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    capturedSettings.add(settings);
    capturedMessages.add(messages);
    final response = _responses[_callIndex % _responses.length];
    _callIndex += 1;
    return response;
  }
}

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

Future<void> _seedMemory(
  AppDatabase db, {
  required String id,
  required String characterId,
  String category = '关系动态',
  String content = '测试内容',
  String tags = '[]',
  double importance = 0.5,
  String memoryKind = 'general',
  String status = 'active',
  DateTime? updatedAt,
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: characterId,
          category: category,
          content: content,
          tags: Value(tags),
          importance: Value(importance),
          memoryKind: Value(memoryKind),
          status: Value(status),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(updatedAt ?? DateTime(2026, 1, 1)),
        ),
      );
}

AppSettings _baseSettings({int maxTokens = 1024}) {
  return AppSettings(
    apiBase: 'http://localhost',
    apiKey: 'k',
    model: 'm',
    maxTokens: maxTokens,
  );
}

void main() {
  // ─────────────────────────────────────────────────────────────
  // 组 1：reviewMemories 批量校准
  // ─────────────────────────────────────────────────────────────
  group('reviewMemories 批量校准', () {
    test('单批记忆修正 category/tags/importance', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      // seed 5 条 active memories，内容短 → 1 个 batch
      for (var i = 1; i <= 5; i++) {
        await _seedMemory(db,
            id: 'mem-$i',
            characterId: _charId,
            category: '关系动态',
            content: '记忆内容$i',
            tags: '[]',
            importance: 0.3 + i * 0.1);
      }

      final llm = _CapturingLlm([
        '{"corrections":[{"id":"mem-1","category":"基础信息","tags":["早餐","对话"],"importance":0.8}]}',
      ]);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(db, llm, embeddingTasks);

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.changes.length, 1);
      expect(result.corrected, 1);
      expect(result.indexingQueued, 1);
      expect(result.indexingStarted, isFalse); // 未注入 indexTrigger

      // 验证 DB 中 mem-1 已更新
      final updated = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-1')))
          .getSingle();
      expect(updated.category, '基础信息');
      expect(updated.tags, '["早餐","对话"]');
      expect(updated.importance, 0.8);

      // 验证其他 memory 未被修改
      final untouched = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-2')))
          .getSingle();
      expect(untouched.category, '关系动态');
      expect(untouched.importance, 0.5);
    });

    test('空 active memories 返回 ok=true reviewed=0', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      // 不 seed 任何 memory

      final llm = _CapturingLlm(['{"corrections":[]}']);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(db, llm, embeddingTasks);

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.reviewed, 0);
      expect(result.totalActive, 0);
      expect(result.nextOffset, isNull);
      expect(result.hasMore, isFalse);
      expect(result.changes, isEmpty);
      // LLM 未被调用
      expect(llm.capturedMessages, isEmpty);
    });

    test('importance 越界（>1 或 <0）被忽略', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedMemory(db,
          id: 'mem-1', characterId: _charId, importance: 0.5);
      await _seedMemory(db,
          id: 'mem-2', characterId: _charId, importance: 0.5);

      final llm = _CapturingLlm([
        '{"corrections":[{"id":"mem-1","importance":1.5},{"id":"mem-2","importance":-0.5}]}',
      ]);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(db, llm, embeddingTasks);

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.changes, isEmpty);
      expect(result.corrected, 0);

      // 验证 DB 中 importance 未变
      final m1 = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-1')))
          .getSingle();
      expect(m1.importance, 0.5);
      final m2 = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-2')))
          .getSingle();
      expect(m2.importance, 0.5);
    });

    test('非法 id 的 correction 被忽略', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedMemory(db, id: 'mem-1', characterId: _charId);

      final llm = _CapturingLlm([
        '{"corrections":[{"id":"nonexistent-id","category":"基础信息"}]}',
      ]);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(db, llm, embeddingTasks);

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.changes, isEmpty);
      expect(result.corrected, 0);

      // mem-1 未被修改
      final m1 = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-1')))
          .getSingle();
      expect(m1.category, '关系动态');
    });

    test('category 不在 memoryCategories 内被忽略', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      await _seedMemory(db,
          id: 'mem-1', characterId: _charId, category: '关系动态');

      final llm = _CapturingLlm([
        '{"corrections":[{"id":"mem-1","category":"不存在的分类"}]}',
      ]);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(db, llm, embeddingTasks);

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.changes, isEmpty);
      expect(result.corrected, 0);

      final m1 = await (db.select(db.memories)
            ..where((t) => t.id.equals('mem-1')))
          .getSingle();
      expect(m1.category, '关系动态');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 2：buildMemoryReviewBatches 分批
  // ─────────────────────────────────────────────────────────────
  group('buildMemoryReviewBatches 分批', () {
    test('超过 batchTextCharLimit 自动切批', () {
      // 3 条 5000 字符的 entry，limit=8000
      // 第 1 条入批 (currentLength=5000)
      // 第 2 条: 5000+2+5000=10002 > 8000 → 切批
      // 第 3 条: 5000+2+5000=10002 > 8000 → 切批
      // 结果: 3 个 batch，每个 1 条
      final entries = ['x' * 5000, 'y' * 5000, 'z' * 5000];
      final batches = MemoryReviewService.buildMemoryReviewBatches(
        entries,
        batchTextCharLimit: 8000,
      );
      expect(batches.length, 3);
      for (final batch in batches) {
        expect(batch.length, 1);
        // 每批 join 后长度 ≤ limit
        expect(batch.join('\n\n').length, lessThanOrEqualTo(8000));
      }
    });

    test('separator 边界：恰好不超限时合并到同批', () {
      // entry1=4000, entry2=3998: 4000+2+3998=8000 = 8000 → 不切批
      final entries = ['x' * 4000, 'y' * 3998];
      final batches = MemoryReviewService.buildMemoryReviewBatches(
        entries,
        batchTextCharLimit: 8000,
      );
      expect(batches.length, 1);
      expect(batches[0].length, 2);
      final joined = batches[0].join('\n\n');
      expect(joined.length, 4000 + 2 + 3998); // = 8000
    });

    test('空 entries 返回空 batches', () {
      final batches = MemoryReviewService.buildMemoryReviewBatches(
        [],
        batchTextCharLimit: 8000,
      );
      expect(batches, isEmpty);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 3：parseMemoryReviewCorrections
  // ─────────────────────────────────────────────────────────────
  group('parseMemoryReviewCorrections', () {
    test('去 ``` 包裹 + 找 JSON 对象', () {
      const raw = '```json\n{"corrections":[{"id":"m1","category":"基础信息","tags":["早餐","对话"],"importance":0.8}]}\n```';
      final result = MemoryReviewService.parseMemoryReviewCorrections(raw);
      expect(result.length, 1);
      expect(result[0].id, 'm1');
      expect(result[0].category, '基础信息');
      expect(result[0].tags, ['早餐', '对话']);
      expect(result[0].importance, 0.8);
    });

    test('无 corrections 字段返回空', () {
      const raw = '{"other":"data"}';
      final result = MemoryReviewService.parseMemoryReviewCorrections(raw);
      expect(result, isEmpty);
    });

    test('非 JSON 抛 FormatException', () {
      expect(
        () => MemoryReviewService.parseMemoryReviewCorrections('not json at all'),
        throwsA(isA<FormatException>()),
      );
    });

    test('corrections 非数组返回空', () {
      const raw = '{"corrections":"not-an-array"}';
      final result = MemoryReviewService.parseMemoryReviewCorrections(raw);
      expect(result, isEmpty);
    });

    test('id 非字符串的条目被过滤', () {
      const raw = '{"corrections":[{"id":123,"category":"基础信息"},{"id":"m1","category":"偏好习惯"}]}';
      final result = MemoryReviewService.parseMemoryReviewCorrections(raw);
      expect(result.length, 1);
      expect(result[0].id, 'm1');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 4：mapWithConcurrencySettled 失败隔离
  // ─────────────────────────────────────────────────────────────
  group('mapWithConcurrencySettled 失败隔离', () {
    test('单批失败不阻断整批，仍返回成功批次结果', () async {
      final items = [1, 2, 3];
      final outcomes =
          await MemoryReviewService.mapWithConcurrencySettled<int, int>(
        items,
        3,
        (item, index) async {
          if (index == 1) throw Exception('batch 2 failed');
          return item * 10;
        },
      );
      expect(outcomes.length, 3);
      expect(outcomes[0].ok, isTrue);
      expect(outcomes[0].value, 10);
      expect(outcomes[1].ok, isFalse);
      expect(outcomes[2].ok, isTrue);
      expect(outcomes[2].value, 30);
    });

    test('空列表返回空结果', () async {
      final outcomes = await MemoryReviewService.mapWithConcurrencySettled<
          int, int>(
        [],
        3,
        (item, index) async => item,
      );
      expect(outcomes, isEmpty);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 组 5：翻页
  // ─────────────────────────────────────────────────────────────
  group('翻页', () {
    test('has_more + next_offset 推进', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      // seed 10 条 active memories
      for (var i = 1; i <= 10; i++) {
        await _seedMemory(db,
            id: 'mem-$i',
            characterId: _charId,
            content: '记忆$i',
            importance: 0.5,
            updatedAt: DateTime(2026, 1, i));
      }

      final llm = _CapturingLlm(['{"corrections":[]}']);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(
        db,
        llm,
        embeddingTasks,
        config: const MemoryReviewConfig(activeMemoryLimit: 5),
      );

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 0,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.reviewed, 5);
      expect(result.totalActive, 10);
      expect(result.hasMore, isTrue);
      expect(result.nextOffset, 5);
      // skippedDueToLimit = max(0, totalActive - (offset + reviewed)) = max(0, 10 - 5) = 5
      // 对照 route.ts 行 209：表示本批整理后仍未被 review 的尾部条数。
      expect(result.skippedDueToLimit, 5);
    });

    test('最后一页 has_more=false next_offset=null', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);
      for (var i = 1; i <= 10; i++) {
        await _seedMemory(db,
            id: 'mem-$i',
            characterId: _charId,
            content: '记忆$i',
            importance: 0.5,
            updatedAt: DateTime(2026, 1, i));
      }

      final llm = _CapturingLlm(['{"corrections":[]}']);
      final embeddingTasks = MemoryEmbeddingTasksService(db);
      final svc = MemoryReviewService(
        db,
        llm,
        embeddingTasks,
        config: const MemoryReviewConfig(activeMemoryLimit: 5),
      );

      final result = await svc.reviewMemories(
        characterId: _charId,
        offset: 5,
        settings: _baseSettings(),
      );

      expect(result.ok, isTrue);
      expect(result.reviewed, 5);
      expect(result.totalActive, 10);
      expect(result.hasMore, isFalse);
      expect(result.nextOffset, isNull);
    });
  });
}
