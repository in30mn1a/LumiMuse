// 记忆候选修复服务测试 — 覆盖 insertCandidate / listCandidates /
// acceptCandidate（含 CAS 守护 + embedding 入队 + 校准）/ discard / ignore /
// delete + _parseExtractionResponse 改造（经 _processTask 间接验证）。
// 对齐主项目 src/app/api/memory-candidates 路由行为。

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_candidates_service.dart';
import 'package:lumimuse/core/services/memory_embedding_tasks_service.dart';
import 'package:lumimuse/core/services/memory_embeddings_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_extraction_service.dart';

const _charId = 'char-cand';
const _charId2 = 'char-cand-2';
const _convId = 'conv-cand';

// ─────────────────────────────────────────────────────────────
// Fake / helpers
// ─────────────────────────────────────────────────────────────

/// 假 embedding tasks service — 记录 enqueueMemoryEmbeddingTask 调用
class _FakeEmbeddingTasksService extends MemoryEmbeddingTasksService {
  int enqueueCalls = 0;
  final List<String> enqueuedMemoryIds = [];
  final List<String> enqueuedCharacterIds = [];
  final List<String> enqueuedReasons = [];
  bool enqueueResult = true;

  _FakeEmbeddingTasksService(super.db);

  @override
  Future<bool> enqueueMemoryEmbeddingTask(
    String memoryId,
    String characterId,
    String reason,
  ) async {
    enqueueCalls++;
    enqueuedMemoryIds.add(memoryId);
    enqueuedCharacterIds.add(characterId);
    enqueuedReasons.add(reason);
    return enqueueResult;
  }
}

/// 假 index trigger — 记录 trigger 调用（不实际排空）
class _FakeIndexTrigger extends MemoryIndexTrigger {
  int triggerCalls = 0;
  final List<EmbeddingAdapterConfig?> resolvedConfigs = [];

  _FakeIndexTrigger(
    super.tasks,
    super.embeddings,
  );

  @override
  bool trigger({
    required EmbeddingAdapterConfig? Function() configResolver,
    int delayMs = 0,
  }) {
    triggerCalls++;
    resolvedConfigs.add(configResolver());
    return true;
  }
}

/// 假 LLM — 返回预设响应
class _FakeLlmService extends LlmService {
  final String response;
  _FakeLlmService(this.response);

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    return response;
  }
}

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(AppDatabase db, {String id = _charId}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

/// 直接向 memory_extraction_candidates 写一行（绕过 service）。
Future<int> _insertCandidateRow(
  AppDatabase db, {
  String characterId = _charId,
  String? conversationId,
  Map<String, dynamic>? rawCandidate,
  String? rawResponse,
  required String status,
  String? errorReason,
  DateTime? createdAt,
}) async {
  final now = DateTime.now();
  return db.into(db.memoryExtractionCandidates).insert(
        MemoryExtractionCandidatesCompanion.insert(
          characterId: characterId,
          status: status,
          conversationId: conversationId != null
              ? Value(conversationId)
              : const Value.absent(),
          rawCandidateJson: rawCandidate != null
              ? Value(jsonEncode(rawCandidate))
              : const Value.absent(),
          rawResponse:
              rawResponse != null ? Value(rawResponse) : const Value.absent(),
          errorReason:
              errorReason != null ? Value(errorReason) : const Value.absent(),
          createdAt: Value(createdAt ?? now),
          updatedAt: Value(createdAt ?? now),
        ),
      );
}

/// seed 完整对话 + 2 条消息（content 足够长，>100 字符触发提取）
Future<void> _seedConversation(AppDatabase db) async {
  await _seedCharacter(db);
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('测试对话'),
          createdAt: Value(DateTime(2026, 1, 1, 12)),
          updatedAt: Value(DateTime(2026, 1, 1, 12)),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: 'u1',
          conversationId: _convId,
          role: 'user',
          content: const Value(
              '我叫小明，最近一直在准备 2026 年 6 月的软件工程考试，想每天晚上复习两个小时。'),
          seq: const Value(1),
          createdAt: Value(DateTime(2026, 1, 1, 12, 1)),
          metadata: const Value('{}'),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: 'a1',
          conversationId: _convId,
          role: 'assistant',
          content: const Value(
              '我会记住这件事，之后提醒你按计划复习，也会帮你把复习节奏安排得温柔一点。'),
          seq: const Value(2),
          createdAt: Value(DateTime(2026, 1, 1, 12, 2)),
          metadata: const Value('{}'),
        ),
      );
}

Future<MemoryTask?> _waitForFinishedTask(AppDatabase db) async {
  final service = MemoryExtractionService(
    db,
    _FakeLlmService(''),
    MemoryEngine(db, _FakeLlmService('')),
  );
  final snap = await service
      .watchLatestTaskStatus(_convId)
      .firstWhere((s) => s?.status == 'done' || s?.status == 'failed')
      .timeout(const Duration(seconds: 2));
  if (snap == null) return null;
  return (db.select(db.memoryTasks)..where((t) => t.id.equals(snap.taskId)))
      .getSingle();
}

MemoryCandidatesService _newService(AppDatabase db) =>
    MemoryCandidatesService(db, MemoryEngine(db, _FakeLlmService('')));

void main() {
  // ═══════════════════════════════════════════════════════════════
  // insertCandidate
  // ═══════════════════════════════════════════════════════════════
  group('insertCandidate', () {
    test('写入 repairable 状态候选行，可读回 status=repairable', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _newService(db).insertCandidate(
        characterId: _charId,
        rawResponse: 'raw resp',
        status: 'repairable',
        errorReason: 'parse failed',
      );

      final rows = await db.select(db.memoryExtractionCandidates).get();
      expect(rows, hasLength(1));
      expect(rows.single.status, 'repairable');
      expect(rows.single.rawResponse, 'raw resp');
      expect(rows.single.errorReason, 'parse failed');
    });

    test('写入 ignored 状态候选行', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _newService(db).insertCandidate(
        characterId: _charId,
        rawResponse: 'empty memories',
        status: 'ignored',
        errorReason: '无有效记忆',
      );

      final rows = await db.select(db.memoryExtractionCandidates).get();
      expect(rows.single.status, 'ignored');
    });

    test('rawCandidateJson 序列化为 JSON 字符串存库', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final raw = {'content': '用户叫小明', 'category': '基础信息'};
      await _newService(db).insertCandidate(
        characterId: _charId,
        rawCandidateJson: raw,
        rawResponse: 'resp',
        status: 'repairable',
        errorReason: 'err',
      );

      final rows = await db.select(db.memoryExtractionCandidates).get();
      expect(rows.single.rawCandidateJson, jsonEncode(raw));
    });

    test('rawCandidateJson 为 null 时库列存 null', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _newService(db).insertCandidate(
        characterId: _charId,
        rawResponse: 'resp',
        status: 'repairable',
        errorReason: 'err',
      );

      final rows = await db.select(db.memoryExtractionCandidates).get();
      expect(rows.single.rawCandidateJson, isNull);
    });

    test('taskId / conversationId 正确写入', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _newService(db).insertCandidate(
        characterId: _charId,
        options: const ExtractMemoryOptions(taskId: 42, conversationId: 'conv-1'),
        rawResponse: 'resp',
        status: 'repairable',
        errorReason: 'err',
      );

      final rows = await db.select(db.memoryExtractionCandidates).get();
      expect(rows.single.taskId, 42);
      expect(rows.single.conversationId, 'conv-1');
    });

    test('status 非法抛 ArgumentError', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      expect(
        () => _newService(db).insertCandidate(
          characterId: _charId,
          rawResponse: 'resp',
          status: 'repaired',
          errorReason: 'err',
        ),
        throwsArgumentError,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listCandidates
  // ═══════════════════════════════════════════════════════════════
  group('listCandidates', () {
    test('只返回 repairable 状态（ignored/discarded/repaired 被排除）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _insertCandidateRow(db, status: 'repairable', rawResponse: 'r1');
      await _insertCandidateRow(db, status: 'ignored');
      await _insertCandidateRow(db, status: 'discarded');
      await _insertCandidateRow(db, status: 'repaired');

      final result = await _newService(db).listCandidates();

      expect(result.total, 1);
      expect(result.candidates, hasLength(1));
      expect(result.candidates.single.rawResponse, 'r1');
    });

    test('按 created_at DESC 排序（晚的在前）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final early = await _insertCandidateRow(
          db, status: 'repairable', createdAt: DateTime(2026, 1, 1));
      final late = await _insertCandidateRow(
          db, status: 'repairable', createdAt: DateTime(2026, 1, 2));

      final result = await _newService(db).listCandidates();

      expect(result.candidates.map((c) => c.id).toList(), [late, early]);
    });

    test('created_at 相同时按 id DESC 排序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final sameTime = DateTime(2026, 1, 1);
      final first = await _insertCandidateRow(
          db, status: 'repairable', createdAt: sameTime);
      final second = await _insertCandidateRow(
          db, status: 'repairable', createdAt: sameTime);

      final result = await _newService(db).listCandidates();

      expect(result.candidates.map((c) => c.id).toList(), [second, first]);
    });

    test('characterId 过滤', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db, id: _charId);
      await _seedCharacter(db, id: _charId2);

      await _insertCandidateRow(db, characterId: _charId, status: 'repairable');
      await _insertCandidateRow(
          db, characterId: _charId2, status: 'repairable');

      final result = await _newService(db).listCandidates(characterId: _charId);

      expect(result.total, 1);
      expect(result.candidates.single.characterId, _charId);
    });

    test('limit clamp 到 100（传入 200，实际取 100，但只有 3 行）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      for (var i = 0; i < 3; i++) {
        await _insertCandidateRow(db, status: 'repairable');
      }

      final result = await _newService(db).listCandidates(limit: 200);

      expect(result.candidates, hasLength(3));
      expect(result.total, 3);
    });

    test('limit clamp 到 1（传入 0 按 1 处理）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _insertCandidateRow(db, status: 'repairable');
      await _insertCandidateRow(db, status: 'repairable');

      final result = await _newService(db).listCandidates(limit: 0);

      expect(result.candidates, hasLength(1));
      expect(result.total, 2);
      expect(result.hasMore, isTrue);
    });

    test('分页 hasMore 正确（offset + rows.length < total）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      for (var i = 0; i < 5; i++) {
        await _insertCandidateRow(db, status: 'repairable');
      }
      final service = _newService(db);

      final r1 = await service.listCandidates(limit: 2, offset: 0);
      expect(r1.candidates, hasLength(2));
      expect(r1.total, 5);
      expect(r1.hasMore, isTrue); // 0 + 2 < 5

      final r2 = await service.listCandidates(limit: 2, offset: 4);
      expect(r2.candidates, hasLength(1));
      expect(r2.hasMore, isFalse); // 4 + 1 < 5 == false

      final r3 = await service.listCandidates(limit: 2, offset: 5);
      expect(r3.candidates, isEmpty);
      expect(r3.hasMore, isFalse); // 5 + 0 < 5 == false
    });

    test('rawCandidate 解析为 Map<String,dynamic>', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'content': '内容',
        'category': '基础信息',
      });

      final result = await _newService(db).listCandidates();

      expect(result.candidates.single.rawCandidate, isNotNull);
      expect(result.candidates.single.rawCandidate!['content'], '内容');
      expect(result.candidates.single.rawCandidate!['category'], '基础信息');
    });

    test('rawCandidateJson 非 object 时 rawCandidate 返回空 Map', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      // 直接写一个 JSON 数组字符串（非 object）
      await db.into(db.memoryExtractionCandidates).insert(
            MemoryExtractionCandidatesCompanion.insert(
              characterId: _charId,
              status: 'repairable',
              rawCandidateJson: const Value('[1,2,3]'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );

      final result = await _newService(db).listCandidates();

      expect(result.candidates.single.rawCandidate, isEmpty);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // acceptCandidate
  // ═══════════════════════════════════════════════════════════════
  group('acceptCandidate', () {
    test('事务成功：status 翻 repaired + memory INSERT，返回 memory 字段对齐 rawCandidate', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '基础信息',
        'content': '用户叫小明',
        'memory_kind': 'user_fact',
        'importance': 0.9,
        'emotional_weight': 0.1,
        'tags': ['姓名'],
        'confidence': 0.95,
      });

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isTrue);
      expect(result.memory, isNotNull);
      expect(result.memory!.content, '用户叫小明');
      expect(result.memory!.category, '基础信息');
      expect(result.memory!.memoryKind, 'user_fact');
      expect(result.memory!.importance, 0.9);
      expect(result.memory!.emotionalWeight, 0.1);
      expect(result.memory!.confidence, 0.95);
      expect(result.memory!.tags, jsonEncode(['姓名']));
      expect(result.memory!.status, 'active');
      expect(result.memory!.pinned, isFalse);
      expect(result.memory!.characterId, _charId);
      expect(result.memory!.id.length, 12);

      final candRow = await (db.select(db.memoryExtractionCandidates)
            ..where((t) => t.id.equals(id)))
          .getSingle();
      expect(candRow.status, 'repaired');
    });

    test('override 字段覆盖 rawCandidate（content 重写）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        'content': '原始内容',
      });

      final result = await _newService(db).acceptCandidate(
        candidateId: id,
        override: {'content': '覆盖内容'},
      );

      expect(result.accepted, isTrue);
      expect(result.memory!.content, '覆盖内容');
    });

    test('不存在 candidateId 返回 accepted:false + error', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final result = await _newService(db).acceptCandidate(candidateId: 9999);

      expect(result.accepted, isFalse);
      expect(result.error, 'Candidate not found or not repairable');
      expect(result.memory, isNull);
      expect(await db.select(db.memories).get(), isEmpty);
    });

    test('非 repairable 状态返回 accepted:false，无副作用', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'discarded', rawCandidate: {
        'category': '话题历史',
        'content': '内容',
      });

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isFalse);
      expect(result.error, 'Candidate not found or not repairable');
      expect(await db.select(db.memories).get(), isEmpty);
    });

    test('CAS 并发守护：先手动翻 repaired 再 accept，返回失败', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        'content': '内容',
      });

      // 模拟并发：先把候选行手动翻 repaired
      await (db.update(db.memoryExtractionCandidates)
            ..where((t) => t.id.equals(id)))
          .write(const MemoryExtractionCandidatesCompanion(
        status: Value('repaired'),
      ));

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isFalse);
      expect(result.error, 'Candidate is not repairable');
      expect(await db.select(db.memories).get(), isEmpty);
    });

    test('embedding 入队触发（fake embeddingTasks 记录调用）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        'content': '内容',
      });

      final fakeTasks = _FakeEmbeddingTasksService(db);
      final fakeTrigger =
          _FakeIndexTrigger(fakeTasks, MemoryEmbeddingsService());
      final service = MemoryCandidatesService(
        db,
        MemoryEngine(db, _FakeLlmService('')),
        embeddingTasks: fakeTasks,
        indexTrigger: fakeTrigger,
      );

      final result = await service.acceptCandidate(candidateId: id);

      expect(result.accepted, isTrue);
      expect(fakeTasks.enqueueCalls, 1);
      expect(fakeTasks.enqueuedMemoryIds.single, result.memory!.id);
      expect(fakeTasks.enqueuedCharacterIds.single, _charId);
      expect(fakeTasks.enqueuedReasons.single, 'created');
      expect(fakeTrigger.triggerCalls, 1);
      expect(fakeTrigger.resolvedConfigs.single, isNull);
    });

    test('enqueue 返回 false 时 trigger 不被调用', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        'content': '内容',
      });

      final fakeTasks = _FakeEmbeddingTasksService(db);
      fakeTasks.enqueueResult = false;
      final fakeTrigger =
          _FakeIndexTrigger(fakeTasks, MemoryEmbeddingsService());
      final service = MemoryCandidatesService(
        db,
        MemoryEngine(db, _FakeLlmService('')),
        embeddingTasks: fakeTasks,
        indexTrigger: fakeTrigger,
      );

      final result = await service.acceptCandidate(candidateId: id);

      expect(result.accepted, isTrue);
      expect(fakeTasks.enqueueCalls, 1);
      expect(fakeTrigger.triggerCalls, 0);
    });

    test('默认构造（无 embeddingTasks）：accept 成功不抛异常', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        'content': '内容',
      });

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isTrue);
      expect(result.memory, isNotNull);
    });

    test('content 缺失返回 accepted:false + error', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '话题历史',
        // 无 content
      });

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isFalse);
      expect(result.error, 'content is required');
      expect(await db.select(db.memories).get(), isEmpty);
      // 候选行仍为 repairable（未进事务）
      final candRow = await (db.select(db.memoryExtractionCandidates)
            ..where((t) => t.id.equals(id)))
          .getSingle();
      expect(candRow.status, 'repairable');
    });

    test('rawCandidateJson 为 null 时用 override 提供 content 仍能 accept', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable'); // 无 rawCandidate

      final result = await _newService(db).acceptCandidate(
        candidateId: id,
        override: {'content': 'override 内容', 'category': '基础信息'},
      );

      expect(result.accepted, isTrue);
      expect(result.memory!.content, 'override 内容');
      expect(result.memory!.category, '基础信息');
    });

    test('calibrateRawMemoryItem 校准：承诺信号词升级为 character_promise', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable', rawCandidate: {
        'category': '基础信息',
        'content': '我会记得用户的偏好',
        'memory_kind': 'user_fact',
        'importance': 0.5,
        'emotional_weight': 0.1,
      });

      final result = await _newService(db).acceptCandidate(candidateId: id);

      expect(result.accepted, isTrue);
      expect(result.memory!.memoryKind, 'character_promise');
      expect(result.memory!.category, '关系动态');
      expect(result.memory!.importance, greaterThanOrEqualTo(0.8));
      expect(result.memory!.emotionalWeight, greaterThanOrEqualTo(0.7));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // discardCandidate / ignoreCandidate
  // ═══════════════════════════════════════════════════════════════
  group('discardCandidate / ignoreCandidate', () {
    test('discardCandidate 翻 discarded 返回 true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable');

      final ok = await _newService(db).discardCandidate(id);

      expect(ok, isTrue);
      final row = await (db.select(db.memoryExtractionCandidates)
            ..where((t) => t.id.equals(id)))
          .getSingle();
      expect(row.status, 'discarded');
    });

    test('discardCandidate 对非 repairable 返回 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'ignored');

      expect(await _newService(db).discardCandidate(id), isFalse);
    });

    test('ignoreCandidate 翻 ignored 返回 true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable');

      final ok = await _newService(db).ignoreCandidate(id);

      expect(ok, isTrue);
      final row = await (db.select(db.memoryExtractionCandidates)
            ..where((t) => t.id.equals(id)))
          .getSingle();
      expect(row.status, 'ignored');
    });

    test('ignoreCandidate 对非 repairable 返回 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'discarded');

      expect(await _newService(db).ignoreCandidate(id), isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // deleteCandidate
  // ═══════════════════════════════════════════════════════════════
  group('deleteCandidate', () {
    test('deleteCandidate 删除返回 true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      final id = await _insertCandidateRow(db, status: 'repairable');

      expect(await _newService(db).deleteCandidate(id), isTrue);
      expect(await db.select(db.memoryExtractionCandidates).get(), isEmpty);
    });

    test('deleteCandidate 不存在返回 false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharacter(db);

      expect(await _newService(db).deleteCandidate(9999), isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // _parseExtractionResponse 改造（经 _processTask 间接验证）
  // ═══════════════════════════════════════════════════════════════
  group('_parseExtractionResponse 改造（经 _processTask 间接验证）', () {
    test('LLM 返回无法解析的响应 → 候选 status=repairable + errorReason', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _FakeLlmService('这不是 JSON，没有花括号');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db);
      expect(task, isNotNull);
      expect(task!.status, 'done');

      final candidates = await db.select(db.memoryExtractionCandidates).get();
      expect(candidates, hasLength(1));
      expect(candidates.single.status, 'repairable');
      expect(candidates.single.errorReason, '无法找到 JSON 代码块');
      expect(candidates.single.rawResponse, '这不是 JSON，没有花括号');
      expect(candidates.single.characterId, _charId);
    });

    test('LLM 返回空 memories 数组 → 候选 status=ignored', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _FakeLlmService('{"memories":[]}');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db);
      expect(task, isNotNull);
      expect(task!.status, 'done');

      final candidates = await db.select(db.memoryExtractionCandidates).get();
      expect(candidates, hasLength(1));
      expect(candidates.single.status, 'ignored');
      expect(candidates.single.errorReason, '无有效记忆可提取');
    });

    test('LLM 返回有效 memories → 不写候选', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _FakeLlmService(jsonEncode({
        'memories': [
          {
            'category': '基础信息',
            'content': '用户叫小明，正在准备考试。',
            'confidence': 0.9,
            'tags': ['姓名'],
          },
        ],
      }));
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db);
      expect(task, isNotNull);
      expect(task!.status, 'done');

      expect(await db.select(db.memoryExtractionCandidates).get(), isEmpty);
      expect(await db.select(db.memories).get(), hasLength(1));
    });

    test('LLM 返回 JSON 解析异常 → 候选 status=repairable + errorReason 含解析失败', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 有花括号但 JSON 非法，jsonDecode 会抛异常
      final llm = _FakeLlmService('{bad json}');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db);
      expect(task, isNotNull);
      expect(task!.status, 'done');

      final candidates = await db.select(db.memoryExtractionCandidates).get();
      expect(candidates, hasLength(1));
      expect(candidates.single.status, 'repairable');
      expect(candidates.single.errorReason, contains('JSON 解析失败'));
    });

    test('LLM 返回顶层非 memories 对象 → 候选 status=repairable', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _FakeLlmService('{"other":123}');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db);
      expect(task, isNotNull);
      expect(task!.status, 'done');

      final candidates = await db.select(db.memoryExtractionCandidates).get();
      expect(candidates, hasLength(1));
      expect(candidates.single.status, 'repairable');
      expect(candidates.single.errorReason, 'JSON 顶层非 memories 对象或数组');
    });

    test('候选行 task_id / conversation_id 正确写入（来自 task）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _FakeLlmService('no json here');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: _charId,
        conversationId: _convId,
        messageIds: const ['u1', 'a1'],
      );

      await _waitForFinishedTask(db);

      final candidates = await db.select(db.memoryExtractionCandidates).get();
      expect(candidates, hasLength(1));
      expect(candidates.single.conversationId, _convId);
      // task_id 应等于 memory_tasks 行 id
      final tasks = await db.select(db.memoryTasks).get();
      expect(tasks, hasLength(1));
      expect(candidates.single.taskId, tasks.single.id);
    });
  });
}
