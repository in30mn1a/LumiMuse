import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/models/message_metadata.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_extraction_service.dart';

const _charId = 'char-memory';
const _convId = 'conv-memory';

class _FakeLlmService extends LlmService {
  int calls = 0;
  final String response;

  _FakeLlmService({
    String? response,
  }) : response = response ??
            jsonEncode({
              'memories': [
                {
                  'category': '基础信息',
                  'content': '用户叫小明，正在准备 2026 年 6 月的软件工程考试。',
                  'confidence': 0.9,
                  'tags': ['姓名', '考试'],
                },
              ],
            });

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

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedConversation(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
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
          content: const Value('我叫小明，最近一直在准备 2026 年 6 月的软件工程考试，想每天晚上复习两个小时。'),
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
          content: const Value('我会记住这件事，之后提醒你按计划复习，也会帮你把复习节奏安排得温柔一点。'),
          seq: const Value(2),
          createdAt: Value(DateTime(2026, 1, 1, 12, 2)),
          metadata: const Value('{}'),
        ),
      );
}

Future<MemoryTask?> _waitForFinishedTask(AppDatabase db) async {
  final service = MemoryExtractionService(
    db,
    _FakeLlmService(),
    MemoryEngine(db, _FakeLlmService()),
  );
  final snap = await service
      .watchLatestTaskStatus(_convId)
      .firstWhere((s) => s?.status == 'done' || s?.status == 'failed')
      .timeout(const Duration(seconds: 2));
  if (snap == null) return null;
  return (db.select(db.memoryTasks)..where((t) => t.id.equals(snap.taskId)))
      .getSingle();
}

void main() {
  test('按未提取用户消息选择提取片段，并带上紧随其后的助手回复', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 'u2',
            conversationId: _convId,
            role: 'user',
            content: const Value('这条已经提取过，不应该再次进入提取片段。'),
            seq: const Value(3),
            createdAt: Value(DateTime(2026, 1, 1, 12, 3)),
            metadata: Value(jsonEncode({'memory_extracted': true})),
          ),
        );
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 'a2',
            conversationId: _convId,
            role: 'assistant',
            content: const Value('这条回复也不应该因为前一条用户消息已提取而被带上。'),
            seq: const Value(4),
            createdAt: Value(DateTime(2026, 1, 1, 12, 4)),
            metadata: const Value('{}'),
          ),
        );
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 's1',
            conversationId: _convId,
            role: 'system',
            content: const Value('对话总结不进入记忆提取片段。'),
            seq: const Value(5),
            createdAt: Value(DateTime(2026, 1, 1, 12, 5)),
            metadata: Value(jsonEncode({'isSummary': true})),
          ),
        );

    final messages = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(_convId))
          ..orderBy([
            (t) => OrderingTerm.asc(t.createdAt),
            (t) => OrderingTerm.asc(t.seq),
          ]))
        .get();

    expect(
      MemoryExtractionService.selectExtractionMessageIds(messages),
      ['u1', 'a1'],
    );
  });

  test('模型返回空结果时不标记消息已提取，也不计入完成数量', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    final llm = _FakeLlmService(response: '{"memories":[]}');
    final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

    await service.enqueueExtraction(
      characterId: _charId,
      conversationId: _convId,
      messageIds: const ['u1', 'a1'],
    );

    final task = await _waitForFinishedTask(db);
    expect(task, isNotNull);
    expect(task!.status, 'done');
    expect(task.mergeCount, 0);

    final memories = await db.select(db.memories).get();
    expect(memories, isEmpty);

    final user = await (db.select(db.messages)..where((t) => t.id.equals('u1')))
        .getSingle();
    expect(
      MessageMetadata.fromJsonString(user.metadata).memoryExtracted,
      isFalse,
    );
  });

  test('新增记忆也会计入任务结果并标记用户消息已提取', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    final llm = _FakeLlmService();
    final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

    await service.enqueueExtraction(
      characterId: _charId,
      conversationId: _convId,
      messageIds: const ['u1', 'a1'],
    );

    final task = await _waitForFinishedTask(db);
    expect(task, isNotNull);
    expect(task!.status, 'done');
    expect(task.mergeCount, 1);
    expect(llm.calls, 1);

    final memories = await db.select(db.memories).get();
    expect(memories, hasLength(1));
    expect(memories.single.content, contains('小明'));

    final user = await (db.select(db.messages)..where((t) => t.id.equals('u1')))
        .getSingle();
    expect(
      MessageMetadata.fromJsonString(user.metadata).memoryExtracted,
      isTrue,
    );
  });

  // ============ 合并阈值动态函数（Task 7）============
  // 对照主项目 src/lib/memory-engine.ts:274-277：短文本（shorterLen < 20）
  // 采用更严格的 0.85 阈值，长文本（shorterLen >= 20）维持默认 0.72 阈值。
  group('合并阈值动态函数', () {
    test('较短记忆长度 < 20 时阈值取 0.85（短文本更严格）', () {
      expect(MemoryExtractionService.mergeThresholdForTesting(0), 0.85);
      expect(MemoryExtractionService.mergeThresholdForTesting(1), 0.85);
      expect(MemoryExtractionService.mergeThresholdForTesting(19), 0.85);
    });

    test('较短记忆长度 >= 20 时阈值取 0.72（长文本维持默认）', () {
      expect(MemoryExtractionService.mergeThresholdForTesting(20), 0.72);
      expect(MemoryExtractionService.mergeThresholdForTesting(21), 0.72);
      expect(MemoryExtractionService.mergeThresholdForTesting(1000), 0.72);
    });

    test('spec 示例：短记忆 shorterLen=10、相似度 0.80 低于 0.85，不合并', () {
      const shorterLen = 10;
      const similarity = 0.80;
      final threshold =
          MemoryExtractionService.mergeThresholdForTesting(shorterLen);
      expect(threshold, 0.85);
      expect(similarity >= threshold, isFalse,
          reason: '相似度 0.80 低于短记忆阈值 0.85，应判定为不合并');
    });

    test('spec 示例：长记忆 shorterLen=30、相似度 0.75 达到 0.72，合并', () {
      const shorterLen = 30;
      const similarity = 0.75;
      final threshold =
          MemoryExtractionService.mergeThresholdForTesting(shorterLen);
      expect(threshold, 0.72);
      expect(similarity >= threshold, isTrue,
          reason: '相似度 0.75 达到长记忆阈值 0.72，应判定为合并');
    });
  });

  // 端到端：验证动态阈值真实参与合并判定。
  // 构造 bigram Jaccard 恰为 0.80 的短记忆对：
  //   existing="用户喜欢猫粮"（长度 6）
  //   newContent="用户喜欢猫"（长度 5）
  //   bigrams A={用户,户喜,喜欢,欢猫,猫粮}（5 个）
  //   bigrams B={用户,户喜,喜欢,欢猫}（4 个）
  //   交集 4 / 并集 5 = 0.80
  // shorterLen=min(6,5)=5 < 20 → 阈值 0.85 → 0.80 < 0.85 → 不合并。
  // 若错误回退到 0.72 阈值，0.80 >= 0.72 会合并（错误行为），本测试守护此不变量。
  test('短记忆相似度 0.80 低于动态阈值 0.85，作为独立记忆新增而非合并', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    // 预置一条短记忆（content.length = 6 < 20）
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'm1',
            characterId: _charId,
            category: '偏好习惯',
            content: '用户喜欢猫粮',
            confidence: const Value(0.9),
            tags: const Value('[]'),
            createdAt: Value(DateTime(2026, 1, 1)),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );

    // LLM 返回相似度 0.80 的短记忆，shorterLen=5 < 20
    final llm = _FakeLlmService(
      response: jsonEncode({
        'memories': [
          {
            'category': '偏好习惯',
            'content': '用户喜欢猫',
            'confidence': 0.9,
            'tags': [],
          },
        ],
      }),
    );
    final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

    await service.enqueueExtraction(
      characterId: _charId,
      conversationId: _convId,
      messageIds: const ['u1', 'a1'],
    );

    final task = await _waitForFinishedTask(db);
    expect(task, isNotNull);
    expect(task!.status, 'done');
    // 不合并 → 走"新增"分支 → changedCount = 1
    expect(task.mergeCount, 1);

    final memories = await db.select(db.memories).get();
    expect(memories, hasLength(2));
    // 原有记忆 content 未被合并改写
    expect(
      memories.where((m) => m.id == 'm1').single.content,
      '用户喜欢猫粮',
    );
  });
}
