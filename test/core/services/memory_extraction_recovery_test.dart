// 记忆提取卡死恢复回归测试
//
// 用户反馈："记忆提取卡住了…大概七八十条消息一直变成了'提取中'，重开软件
// 也不行。" 复现路径：单次手动触发 N 条消息提取期间 App 被杀，memory_tasks
// 行卡在 `processing`，重启后 [enqueueExtraction] 的去重 guard 把所有后续
// 触发静默吞掉，UI 永久显示「提取中」。
//
// 这里覆盖两层修复：
// 1. [recoverStaleTasksOnStartup]：App 启动时把所有未完成行翻成 failed。
// 2. enqueueExtraction 内部按 updated_at 阈值清理孤儿，覆盖运行时残留。

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_extraction_service.dart';

/// 假 LLM：避免本测试触发真实 dio 网络调用，并允许 _processQueue 自然走完。
class _FakeLlmService extends LlmService {
  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    CancelToken? cancelToken,
  }) async {
    return jsonEncode({'memories': []});
  }
}

Future<void> _seedCharAndConv(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: 'c1',
          name: const Value('A'),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: 'conv1',
          characterId: 'c1',
        ),
      );
}

Future<int> _insertStaleTask(
  AppDatabase db, {
  required Duration age,
  String status = 'processing',
}) async {
  final stale = DateTime.now().subtract(age);
  return db.into(db.memoryTasks).insert(
        MemoryTasksCompanion.insert(
          characterId: 'c1',
          conversationId: 'conv1',
          messageIds: const Value('["m1"]'),
          status: Value(status),
          createdAt: Value(stale),
          updatedAt: Value(stale),
        ),
      );
}

/// 等队列里的所有 pending/processing 行 settle（done / failed）。
/// 避免后台 _processQueue 在 db.close 之后还在写表导致测试报错。
Future<void> _waitForQueueDrained(AppDatabase db) async {
  for (var i = 0; i < 80; i++) {
    final pending = await (db.select(db.memoryTasks)
          ..where((t) =>
              t.status.equals('pending') | t.status.equals('processing'))
          ..limit(1))
        .get();
    if (pending.isEmpty) return;
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  group('recoverStaleTasksOnStartup', () {
    test('把残留的 processing/pending 行翻成 failed', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(() => db.close());
      await _seedCharAndConv(db);

      final processingId = await _insertStaleTask(db,
          age: const Duration(hours: 1), status: 'processing');
      final pendingId = await _insertStaleTask(db,
          age: const Duration(hours: 1), status: 'pending');

      final affected =
          await MemoryExtractionService.recoverStaleTasksOnStartup(db);
      expect(affected, 2);

      final pRow = await (db.select(db.memoryTasks)
            ..where((t) => t.id.equals(processingId)))
          .getSingle();
      final qRow = await (db.select(db.memoryTasks)
            ..where((t) => t.id.equals(pendingId)))
          .getSingle();
      expect(pRow.status, 'failed');
      expect(qRow.status, 'failed');
    });

    test('已完成的 done/failed 行不受影响', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(() => db.close());
      await _seedCharAndConv(db);

      final doneId = await _insertStaleTask(db,
          age: const Duration(hours: 1), status: 'done');
      final failedId = await _insertStaleTask(db,
          age: const Duration(hours: 1), status: 'failed');

      await MemoryExtractionService.recoverStaleTasksOnStartup(db);

      final dRow = await (db.select(db.memoryTasks)
            ..where((t) => t.id.equals(doneId)))
          .getSingle();
      final fRow = await (db.select(db.memoryTasks)
            ..where((t) => t.id.equals(failedId)))
          .getSingle();
      expect(dRow.status, 'done');
      expect(fRow.status, 'failed');
    });
  });

  group('enqueueExtraction 防御性恢复', () {
    test('启动恢复后再 enqueue 能成功入队（即孤儿不再阻塞后续触发）', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      await _seedCharAndConv(db);
      // 模拟上一次运行残留
      await _insertStaleTask(db, age: const Duration(hours: 1));
      // 模拟"App 启动"
      await MemoryExtractionService.recoverStaleTasksOnStartup(db);

      final llm = _FakeLlmService();
      final svc = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      final before = (await db.select(db.memoryTasks).get()).length;
      await svc.enqueueExtraction(
        characterId: 'c1',
        conversationId: 'conv1',
        messageIds: ['m1'],
      );
      // 等队列推进至终态，避免后台任务在 db 关闭后仍写表。
      await _waitForQueueDrained(db);

      final rows = await db.select(db.memoryTasks).get();
      // 应该新增一行（终态 done / failed）
      expect(rows.length, before + 1);
      // 旧的孤儿行已被恢复为 failed
      expect(
        rows.where((r) => r.status == 'failed').length,
        greaterThanOrEqualTo(1),
      );

      llm.dispose();
      await db.close();
    });

    test(
        '运行时残留：未走启动恢复时，enqueue 内部按 updated_at 阈值清理孤儿',
        () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      await _seedCharAndConv(db);
      // 跳过启动恢复，直接塞一条 11 分钟前的 processing 孤儿
      await _insertStaleTask(db, age: const Duration(minutes: 11));

      final llm = _FakeLlmService();
      final svc = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      final before = (await db.select(db.memoryTasks).get()).length;
      await svc.enqueueExtraction(
        characterId: 'c1',
        conversationId: 'conv1',
        messageIds: ['m1'],
      );
      await _waitForQueueDrained(db);
      final after = (await db.select(db.memoryTasks).get()).length;

      // 新行应当成功入队
      expect(after, before + 1);

      llm.dispose();
      await db.close();
    });

    test('未超时的 processing 行仍然作为去重保护起作用，不会被误清', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      await _seedCharAndConv(db);
      // 1 分钟前刚刚开始的 processing：合理范围内的真实任务
      await _insertStaleTask(db, age: const Duration(minutes: 1));

      final llm = _FakeLlmService();
      final svc = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      final before = (await db.select(db.memoryTasks).get()).length;
      await svc.enqueueExtraction(
        characterId: 'c1',
        conversationId: 'conv1',
        messageIds: ['m1'],
      );
      final after = (await db.select(db.memoryTasks).get()).length;

      // 不应该重复入队，原 processing 行不应被翻
      expect(after, before);
      final stillProcessing = await (db.select(db.memoryTasks)
            ..where((t) => t.status.equals('processing')))
          .get();
      expect(stillProcessing.length, 1);

      llm.dispose();
      await db.close();
    });
  });
}
