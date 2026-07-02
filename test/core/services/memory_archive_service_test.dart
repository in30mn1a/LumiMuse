// 记忆归档服务测试 — 覆盖 8 个公开 API 共 32 个用例。
// 对齐主项目 src/lib/memory-archive.ts + src/app/api/memory-archive/route.ts 行为。

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_archive_service.dart';
import 'package:lumimuse/core/services/memory_embedding_tasks_service.dart';
import 'package:lumimuse/core/services/memory_embeddings_service.dart';

const _charId = 'char-archive';

// ─────────────────────────────────────────────────────────────
// Fake / Recording 类
// ─────────────────────────────────────────────────────────────

/// 假 LLM：避免真实网络调用，返回固定响应。
class _FakeLlmService extends LlmService {
  final String response;
  int calls = 0;
  _FakeLlmService({required this.response});

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    calls++;
    return response;
  }
}

/// 记录 enqueueMemoryEmbeddingTask 调用的 fake。
class _RecordingEmbeddingTasks extends MemoryEmbeddingTasksService {
  // ignore: use_super_parameters
  _RecordingEmbeddingTasks(AppDatabase db) : super(db);
  final List<({String memoryId, String characterId, String reason})> calls = [];
  bool shouldQueue = true;

  @override
  Future<bool> enqueueMemoryEmbeddingTask(
    String memoryId,
    String characterId,
    String reason,
  ) async {
    calls.add((memoryId: memoryId, characterId: characterId, reason: reason));
    return shouldQueue;
  }
}

/// 记录 trigger 调用的 fake MemoryIndexTrigger。
class _RecordingIndexTrigger extends MemoryIndexTrigger {
  _RecordingIndexTrigger(AppDatabase db)
      : super(MemoryEmbeddingTasksService(db), MemoryEmbeddingsService());
  int triggerCalls = 0;

  @override
  bool trigger({
    required EmbeddingAdapterConfig? Function() configResolver,
    int delayMs = 0,
  }) {
    triggerCalls++;
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

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

Future<void> _seedMemory(
  AppDatabase db, {
  required String id,
  String characterId = _charId,
  String category = '基础信息',
  required String content,
  double confidence = 0.8,
  List<String> tags = const [],
  List<String> sourceMsgIds = const [],
  String memoryKind = 'general',
  double importance = 0.5,
  double emotionalWeight = 0.5,
  String status = 'active',
  bool pinned = false,
  Map<String, dynamic>? metadata,
  DateTime? createdAt,
  DateTime? updatedAt,
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: characterId,
          category: category,
          content: content,
          confidence: Value(confidence),
          tags: Value(jsonEncode(tags)),
          sourceMsgIds: Value(jsonEncode(sourceMsgIds)),
          memoryKind: Value(memoryKind),
          importance: Value(importance),
          emotionalWeight: Value(emotionalWeight),
          status: Value(status),
          pinned: Value(pinned),
          metadata:
              metadata != null ? Value(jsonEncode(metadata)) : const Value.absent(),
          createdAt: Value(createdAt ?? DateTime(2026, 1, 1)),
          updatedAt: Value(updatedAt ?? DateTime(2026, 1, 1)),
        ),
      );
}

Future<Memory> _getMemory(AppDatabase db, String id) async {
  return (db.select(db.memories)..where((m) => m.id.equals(id))).getSingle();
}

Map<String, dynamic> _readMeta(Memory row) {
  if (row.metadata == null || row.metadata!.isEmpty) return {};
  return Map<String, dynamic>.from(jsonDecode(row.metadata!) as Map);
}

const _defaultSettings = AppSettings(
  apiBase: 'https://api.example.com',
  apiKey: 'k',
  model: 'gpt-4',
  maxTokens: 4096,
);

// ═══════════════════════════════════════════════════════════════
// 测试主体
// ═══════════════════════════════════════════════════════════════

void main() {
  // ─────────────────────────────────────────────────────────────
  // 1. planMemorySummaryArchive（纯函数）
  // ─────────────────────────────────────────────────────────────
  group('planMemorySummaryArchive', () {
    final service = MemoryArchiveService(
        _createTestDb(), _FakeLlmService(response: ''));

    test('summary 字段对齐主项目常量', () {
      final now = DateTime(2026, 6, 1, 10);
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1',
            category: '话题历史',
            content: '旧记忆',
            confidence: 0.5,
            tags: ['tag'],
            sourceMsgIds: ['msg1'],
            memoryKind: 'general',
            importance: 0.3,
            emotionalWeight: 0.1,
            status: 'active',
            pinned: false,
            metadata: {},
          ),
        ],
        now: now,
      );

      final s = plan.summaryMemory;
      expect(s.id, 'sm1');
      expect(s.characterId, _charId);
      expect(s.category, '基础信息');
      expect(s.content, '摘要');
      expect(s.confidence, 0.9);
      expect(s.tags, ['archive-summary']);
      expect(s.sourceMsgIds, ['msg1']);
      expect(s.memoryKind, 'general');
      expect(s.importance, 0.7);
      expect(s.emotionalWeight, 0);
      expect(s.status, 'active');
      expect(s.pinned, false);
      expect(s.createdAt, now);
      expect(s.updatedAt, now);
    });

    test('summary metadata 含 archiveBatchId/archiveRole/coveredMemoryIds', () {
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1', category: 'c', content: 'x', confidence: 0.5,
            tags: [], sourceMsgIds: [], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {},
          ),
          const MemoryArchiveSourceMemory(
            id: 'm2', category: 'c', content: 'y', confidence: 0.5,
            tags: [], sourceMsgIds: [], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {},
          ),
        ],
        now: DateTime(2026, 6, 1),
      );

      final meta = plan.summaryMemory.metadata;
      expect(meta['archiveBatchId'], 'b1');
      expect(meta['archiveRole'], 'summary');
      expect(meta['coveredMemoryIds'], ['m1', 'm2']);
    });

    test('covered pinned=false → status=archived', () {
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1', category: 'c', content: 'x', confidence: 0.5,
            tags: [], sourceMsgIds: [], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {},
          ),
        ],
        now: DateTime(2026, 6, 1),
      );

      expect(plan.coveredMemoryUpdates.single.status, 'archived');
    });

    test('covered pinned=true → status=summarized', () {
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1', category: 'c', content: 'x', confidence: 0.5,
            tags: [], sourceMsgIds: [], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: true, metadata: {},
          ),
        ],
        now: DateTime(2026, 6, 1),
      );

      expect(plan.coveredMemoryUpdates.single.status, 'summarized');
    });

    test('covered metadata 合并 previousStatus + 保留原 metadata 字段', () {
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1', category: 'c', content: 'x', confidence: 0.5,
            tags: [], sourceMsgIds: [], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {'origin': 'manual', 'kind': 'foo'},
          ),
        ],
        now: DateTime(2026, 6, 1),
      );

      final meta = plan.coveredMemoryUpdates.single.metadata;
      expect(meta['origin'], 'manual');
      expect(meta['kind'], 'foo');
      expect(meta['archiveBatchId'], 'b1');
      expect(meta['summarizedBy'], 'sm1');
      expect(meta['previousStatus'], 'active');
    });

    test('source_msg_ids 去重 + 保留首次出现顺序', () {
      final plan = service.planMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        sourceMemories: [
          const MemoryArchiveSourceMemory(
            id: 'm1', category: 'c', content: 'x', confidence: 0.5,
            tags: [], sourceMsgIds: ['a', 'b'], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {},
          ),
          const MemoryArchiveSourceMemory(
            id: 'm2', category: 'c', content: 'y', confidence: 0.5,
            tags: [], sourceMsgIds: ['b', 'c'], memoryKind: 'general',
            importance: 0.5, emotionalWeight: 0.5, status: 'active',
            pinned: false, metadata: {},
          ),
        ],
        now: DateTime(2026, 6, 1),
      );

      expect(plan.summaryMemory.sourceMsgIds, ['a', 'b', 'c']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. executeMemorySummaryArchive
  // ─────────────────────────────────────────────────────────────
  group('executeMemorySummaryArchive', () {
    test('成功路径：summary INSERT + covered UPDATE', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1', sourceMsgIds: ['s1']);
      await _seedMemory(db, id: 'm2', content: '旧2', sourceMsgIds: ['s2']);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final now = DateTime(2026, 6, 1, 10);
      final plan = await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '归档摘要',
        coveredMemoryIds: ['m1', 'm2'],
        now: now,
      );

      // summary 已插入
      final summary = await _getMemory(db, 'sm1');
      expect(summary.content, '归档摘要');
      expect(summary.category, '基础信息');
      expect(summary.confidence, 0.9);
      expect(jsonDecode(summary.tags), ['archive-summary']);
      expect(jsonDecode(summary.sourceMsgIds), ['s1', 's2']);
      expect(summary.memoryKind, 'general');
      expect(summary.importance, 0.7);
      expect(summary.emotionalWeight, 0);
      expect(summary.status, 'active');
      expect(summary.pinned, false);
      final sMeta = _readMeta(summary);
      expect(sMeta['archiveBatchId'], 'b1');
      expect(sMeta['archiveRole'], 'summary');
      expect(sMeta['coveredMemoryIds'], ['m1', 'm2']);

      // covered 已 UPDATE
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'archived');
      final m1Meta = _readMeta(m1);
      expect(m1Meta['archiveBatchId'], 'b1');
      expect(m1Meta['summarizedBy'], 'sm1');
      expect(m1Meta['previousStatus'], 'active');

      // 返回 plan 字段对齐
      expect(plan.summaryMemory.id, 'sm1');
      expect(plan.coveredMemoryUpdates.length, 2);
    });

    test('coveredMemoryIds 为空抛 StateError', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: const [],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('empty'))),
      );
    });

    test('部分记忆不存在抛 StateError', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: ['m1', 'missing'],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('not found'))),
      );
    });

    test('非 active 记忆抛 Only active', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1', status: 'archived');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: ['m1'],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('Only active'))),
      );
    });

    test('已是 summary 的记忆抛 cannot be re-archived', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1', metadata: {'archiveRole': 'summary'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: ['m1'],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('re-archived'))),
      );
    });

    test('已带 archiveBatchId 的记忆抛 cannot be re-archived', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db,
          id: 'm1', content: '旧1', metadata: {'archiveBatchId': 'old-batch'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: ['m1'],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('re-archived'))),
      );
    });

    test('事务回滚：校验失败时 summary 未插入、covered 未 UPDATE', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1', status: 'active');
      await _seedMemory(db, id: 'm2', content: '旧2', status: 'archived');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      // m2 非 active，校验失败应触发事务回滚
      await expectLater(
        service.executeMemorySummaryArchive(
          batchId: 'b1',
          characterId: _charId,
          summaryMemoryId: 'sm1',
          summaryContent: 'x',
          coveredMemoryIds: ['m1', 'm2'],
          now: DateTime(2026, 6, 1),
        ),
        throwsA(isA<StateError>()),
      );

      // summary 未插入
      final summaryRows =
          await (db.select(db.memories)..where((m) => m.id.equals('sm1'))).get();
      expect(summaryRows, isEmpty);
      // m1 status 未变（仍是 active）
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'active');
      expect(_readMeta(m1), isEmpty);
    });

    test('embedding 入队触发（mock MemoryEmbeddingTasksService）', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final tasks = _RecordingEmbeddingTasks(db);
      final trigger = _RecordingIndexTrigger(db);
      final service = MemoryArchiveService(
        db,
        _FakeLlmService(response: ''),
        embeddingTasks: tasks,
        indexTrigger: trigger,
      );

      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1),
      );

      expect(tasks.calls.length, 1);
      expect(tasks.calls.single.memoryId, 'sm1');
      expect(tasks.calls.single.characterId, _charId);
      expect(tasks.calls.single.reason, 'created');
      expect(trigger.triggerCalls, 1);
    });

    test('未注入 embeddingTasks 时不入队也不报错', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      // 无 embeddingTasks 注入，应正常完成
      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1),
      );
      // 只要没抛错即可
      expect(await _getMemory(db, 'sm1'), isA<Memory>());
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. undoMemorySummaryArchiveBatch
  // ─────────────────────────────────────────────────────────────
  group('undoMemorySummaryArchiveBatch', () {
    test('成功路径：covered 恢复 previousStatus + metadata 清理 + summary 删除',
        () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      await _seedMemory(db, id: 'm2', content: '旧2', pinned: true);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      // 先归档
      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1', 'm2'],
        now: DateTime(2026, 6, 1, 10),
      );
      // 撤销
      final result = await service.undoMemorySummaryArchiveBatch(
        batchId: 'b1',
        characterId: _charId,
        now: DateTime(2026, 6, 2, 10),
      );

      expect(result.summaryMemoryId, 'sm1');
      expect(result.restoredMemoryIds, containsAll(['m1', 'm2']));

      // covered 恢复 active + metadata 清理
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'active');
      final m1Meta = _readMeta(m1);
      expect(m1Meta.containsKey('archiveBatchId'), isFalse);
      expect(m1Meta.containsKey('summarizedBy'), isFalse);
      expect(m1Meta.containsKey('previousStatus'), isFalse);

      // pinned 记忆恢复 active（previousStatus 也是 active）
      final m2 = await _getMemory(db, 'm2');
      expect(m2.status, 'active');

      // summary 已删除
      final summaryRows =
          await (db.select(db.memories)..where((m) => m.id.equals('sm1'))).get();
      expect(summaryRows, isEmpty);
    });

    test('不存在的 batchId：返回空 restoredMemoryIds', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.undoMemorySummaryArchiveBatch(
        batchId: 'nonexistent',
        characterId: _charId,
        now: DateTime(2026, 6, 2, 10),
      );

      expect(result.summaryMemoryId, isNull);
      expect(result.restoredMemoryIds, isEmpty);
    });

    test('previousStatus 非法抛 StateError', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      // 手动构造非法 previousStatus 的 covered 行
      await _seedMemory(db,
          id: 'm1',
          content: '旧1',
          status: 'archived',
          metadata: {
            'archiveBatchId': 'b1',
            'summarizedBy': 'sm1',
            'previousStatus': 'INVALID_STATUS',
          });
      await _seedMemory(db,
          id: 'sm1',
          content: '摘要',
          metadata: {'archiveBatchId': 'b1', 'archiveRole': 'summary'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await expectLater(
        service.undoMemorySummaryArchiveBatch(
          batchId: 'b1',
          characterId: _charId,
          now: DateTime(2026, 6, 2, 10),
        ),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'msg', contains('previousStatus'))),
      );
    });

    test('双重 undo 幂等性（第二次返回空）', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1, 10),
      );

      final first = await service.undoMemorySummaryArchiveBatch(
        batchId: 'b1',
        characterId: _charId,
        now: DateTime(2026, 6, 2, 10),
      );
      expect(first.restoredMemoryIds, ['m1']);

      final second = await service.undoMemorySummaryArchiveBatch(
        batchId: 'b1',
        characterId: _charId,
        now: DateTime(2026, 6, 3, 10),
      );
      expect(second.restoredMemoryIds, isEmpty);
      expect(second.summaryMemoryId, isNull);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. listUndoableMemoryArchiveBatches
  // ─────────────────────────────────────────────────────────────
  group('listUndoableMemoryArchiveBatches', () {
    test('多批次聚合 + 按 updated_at DESC 排序', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      await _seedMemory(db, id: 'm2', content: '旧2');
      await _seedMemory(db, id: 'm3', content: '旧3');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      // batch1: m1, updated_at=6/1
      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要1',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1, 10),
      );
      // batch2: m2, m3, updated_at=6/2（更晚）
      await service.executeMemorySummaryArchive(
        batchId: 'b2',
        characterId: _charId,
        summaryMemoryId: 'sm2',
        summaryContent: '摘要2',
        coveredMemoryIds: ['m2', 'm3'],
        now: DateTime(2026, 6, 2, 10),
      );

      final batches =
          await service.listUndoableMemoryArchiveBatches(_charId);
      expect(batches.length, 2);
      // DESC 排序：b2 在前
      expect(batches.first.batchId, 'b2');
      expect(batches.first.coveredCount, 2);
      expect(batches.first.summaryContent, '摘要2');
      expect(batches.first.summaryMemoryId, 'sm2');
      expect(batches.last.batchId, 'b1');
      expect(batches.last.coveredCount, 1);
    });

    test('summary_content COALESCE：summary 被删除时为空字符串', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要1',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1, 10),
      );

      // 手动删除 summary（模拟孤儿场景）
      await (db.delete(db.memories)..where((m) => m.id.equals('sm1'))).go();

      final batches =
          await service.listUndoableMemoryArchiveBatches(_charId);
      expect(batches.length, 1);
      expect(batches.first.summaryContent, '');
      // summary_memory_id 仍从 covered.metadata 读取
      expect(batches.first.summaryMemoryId, 'sm1');
    });

    test('无归档批次返回空列表', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final batches =
          await service.listUndoableMemoryArchiveBatches(_charId);
      expect(batches, isEmpty);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. loadCoveredMemories
  // ─────────────────────────────────────────────────────────────
  group('loadCoveredMemories', () {
    test('行数不匹配返回 null', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.loadCoveredMemories(_charId, ['m1', 'missing']);
      expect(result, isNull);
    });

    test('顺序保留 coveredMemoryIds 顺序', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      await _seedMemory(db, id: 'm2', content: '旧2');
      await _seedMemory(db,
          id: 'm3',
          content: '旧3',
          tags: ['t1'],
          sourceMsgIds: ['s1'],
          importance: 0.9);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result =
          await service.loadCoveredMemories(_charId, ['m3', 'm1', 'm2']);
      expect(result!.map((m) => m.id).toList(), ['m3', 'm1', 'm2']);
      // 字段转换正确
      final m3 = result.first;
      expect(m3.tags, ['t1']);
      expect(m3.sourceMsgIds, ['s1']);
      expect(m3.importance, 0.9);
    });

    test('空 coveredMemoryIds 返回空列表', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.loadCoveredMemories(_charId, const []);
      expect(result, isEmpty);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. aiArchiveMemories
  // ─────────────────────────────────────────────────────────────
  group('aiArchiveMemories', () {
    test('无 active 记忆返回 no_archivable_memories', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      // 只有 archived 记忆
      await _seedMemory(db, id: 'm1', content: 'x', status: 'archived');
      final service = MemoryArchiveService(
          db, _FakeLlmService(response: '{"archive_memory_ids":[],"summary":""}'));

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isFalse);
      expect(result.error, 'no_archivable_memories');
      expect(result.archiveCount, 0);
    });

    test('LLM provider 未配置返回错误', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: 'x');
      final service = MemoryArchiveService(
          db, _FakeLlmService(response: '{}'));

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: const AppSettings(apiBase: '', apiKey: '', model: ''),
      );

      expect(result.archived, isFalse);
      expect(result.error, 'LLM provider is not configured');
    });

    test('LLM 返回无效 JSON 返回失败 + rawResponse 截断 500 字符', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: 'x');
      // 构造长度 > 500 的无效响应
      final invalidResponse = 'x' * 600;
      final service = MemoryArchiveService(
          db, _FakeLlmService(response: invalidResponse));

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isFalse);
      expect(result.error, 'Failed to parse AI archive response');
      expect(result.rawResponse, isNotNull);
      expect(result.rawResponse!.length, 500);
    });

    test('LLM 返回 archive_memory_ids 为空 → archived=false, archiveCount=0',
        () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: 'x');
      final service = MemoryArchiveService(
          db, _FakeLlmService(response: '{"archive_memory_ids":[],"summary":"s"}'));

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isFalse);
      expect(result.archiveCount, 0);
      expect(result.error, isNull);
    });

    test('LLM 返回 summary 为空 → archived=false', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: 'x');
      final service = MemoryArchiveService(db,
          _FakeLlmService(response: '{"archive_memory_ids":["m1"],"summary":""}'));

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isFalse);
      expect(result.archiveCount, 0);
      expect(result.error, isNull);
    });

    test('LLM 返回的 ids 部分非法 → 过滤后仅归档合法的', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      await _seedMemory(db, id: 'm2', content: '旧2');
      final service = MemoryArchiveService(
        db,
        _FakeLlmService(response:
            '{"archive_memory_ids":["m1","nonexistent"],"summary":"摘要"}'),
      );

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isTrue);
      expect(result.archiveCount, 1);
      expect(result.summary, '摘要');
      expect(result.batchId, isNotNull);

      // m1 被 archived，m2 仍 active
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'archived');
      final m2 = await _getMemory(db, 'm2');
      expect(m2.status, 'active');
    });

    test('LLM 返回的 ids 全部非法 → archived=false', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(
        db,
        _FakeLlmService(response:
            '{"archive_memory_ids":["nonexistent1","nonexistent2"],"summary":"摘要"}'),
      );

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isFalse);
      expect(result.archiveCount, 0);
      // 记忆未被改动
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'active');
    });

    test('成功归档：summary INSERT + covered UPDATE + embedding 入队', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      await _seedMemory(db, id: 'm2', content: '旧2');
      final tasks = _RecordingEmbeddingTasks(db);
      final service = MemoryArchiveService(
        db,
        _FakeLlmService(response:
            '{"archive_memory_ids":["m1","m2"],"summary":"归档摘要"}'),
        embeddingTasks: tasks,
      );

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isTrue);
      expect(result.archiveCount, 2);
      expect(result.summary, '归档摘要');
      expect(result.batchId, isNotNull);
      expect(result.indexingQueued, isTrue);

      // covered 已 UPDATE
      final m1 = await _getMemory(db, 'm1');
      expect(m1.status, 'archived');
      final m2 = await _getMemory(db, 'm2');
      expect(m2.status, 'archived');

      // summary 已 INSERT（通过 metadata.archiveRole 查找）
      final summaryRows = await (db.select(db.memories)
            ..where((m) =>
                m.characterId.equals(_charId) &
                m.metadata.like('%archiveRole%summary%')))
          .get();
      expect(summaryRows.length, 1);
      expect(summaryRows.first.content, '归档摘要');

      // embedding 入队
      expect(tasks.calls.length, 1);
      expect(tasks.calls.single.reason, 'created');
    });

    test('LLM 返回带 ``` 代码块标记的 JSON 也能解析', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(
        db,
        _FakeLlmService(response:
            '```json\n{"archive_memory_ids":["m1"],"summary":"代码块摘要"}\n```'),
      );

      final result = await service.aiArchiveMemories(
        characterId: _charId,
        settings: _defaultSettings,
      );

      expect(result.archived, isTrue);
      expect(result.archiveCount, 1);
      expect(result.summary, '代码块摘要');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. getBatchDetails
  // ─────────────────────────────────────────────────────────────
  group('getBatchDetails', () {
    test('covered + summary 字段对齐', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1', category: '话题历史');
      await _seedMemory(db, id: 'm2', content: '旧2', category: '基础信息');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1', 'm2'],
        now: DateTime(2026, 6, 1, 10),
      );

      final details = await service.getBatchDetails(
        characterId: _charId,
        batchId: 'b1',
      );

      expect(details, isNotNull);
      expect(details!.batchId, 'b1');
      expect(details.covered.length, 2);
      // summary 字段
      expect(details.summary, isNotNull);
      expect(details.summary!.id, 'sm1');
      expect(details.summary!.content, '摘要');
      // covered id 集合
      final coveredIds = details.covered.map((c) => c.id).toSet();
      expect(coveredIds, {'m1', 'm2'});
      // covered status 都是 archived
      for (final c in details.covered) {
        expect(c.status, 'archived');
      }
    });

    test('不存在 batchId 返回 null', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final details = await service.getBatchDetails(
        characterId: _charId,
        batchId: 'nonexistent',
      );
      expect(details, isNull);
    });

    test('summary 被删除时 summary 字段为 null', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      await _seedMemory(db, id: 'm1', content: '旧1');
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      await service.executeMemorySummaryArchive(
        batchId: 'b1',
        characterId: _charId,
        summaryMemoryId: 'sm1',
        summaryContent: '摘要',
        coveredMemoryIds: ['m1'],
        now: DateTime(2026, 6, 1, 10),
      );

      // 手动删除 summary
      await (db.delete(db.memories)..where((m) => m.id.equals('sm1'))).go();

      final details = await service.getBatchDetails(
        characterId: _charId,
        batchId: 'b1',
      );
      expect(details, isNotNull);
      expect(details!.summary, isNull);
      expect(details.covered.length, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 8. cleanupOrphaned
  // ─────────────────────────────────────────────────────────────
  group('cleanupOrphaned', () {
    test('清理 archived summary + 返回 cleaned 数量', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      // 构造孤儿 summary：archiveRole=summary 且 status=archived
      await _seedMemory(db,
          id: 'sm1',
          content: '孤儿摘要',
          status: 'archived',
          metadata: {'archiveBatchId': 'b1', 'archiveRole': 'summary'});
      await _seedMemory(db,
          id: 'sm2',
          content: '另一个孤儿',
          status: 'archived',
          metadata: {'archiveBatchId': 'b2', 'archiveRole': 'summary'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.cleanupOrphaned(_charId);
      expect(result.cleaned, 2);
      expect(result.message, isNull);

      // 已删除
      final remaining = await (db.select(db.memories)
            ..where((m) =>
                m.characterId.equals(_charId) &
                m.id.isIn(['sm1', 'sm2'])))
          .get();
      expect(remaining, isEmpty);
    });

    test('空 case 返回 cleaned=0 + message', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.cleanupOrphaned(_charId);
      expect(result.cleaned, 0);
      expect(result.message, '没有残留的归档摘要');
    });

    test('不清理 active 的 summary（只清理 archived）', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      // active summary 不应被清理
      await _seedMemory(db,
          id: 'sm1',
          content: '活跃摘要',
          status: 'active',
          metadata: {'archiveBatchId': 'b1', 'archiveRole': 'summary'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.cleanupOrphaned(_charId);
      expect(result.cleaned, 0);
      // sm1 仍在
      expect(await _getMemory(db, 'sm1'), isA<Memory>());
    });

    test('不清理非 summary 的 archived 记忆', () async {
      final db = _createTestDb();
      await _seedCharacter(db);
      // 普通 archived 记忆（无 archiveRole=summary），不应被清理
      await _seedMemory(db,
          id: 'm1',
          content: '普通归档',
          status: 'archived',
          metadata: {'archiveBatchId': 'b1', 'summarizedBy': 'sm1'});
      final service = MemoryArchiveService(db, _FakeLlmService(response: ''));

      final result = await service.cleanupOrphaned(_charId);
      expect(result.cleaned, 0);
      expect(await _getMemory(db, 'm1'), isA<Memory>());
    });
  });
}
