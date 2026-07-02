// Spec Task 21 — MemoryExtractionService 测试缺口补齐
//
// 4 个子任务：
// - 21.1: 异常自动回滚验证（事务包裹写入循环，中途抛异常时前序变更回滚）
// - 21.2: 并发入队不重复插入（去重 guard 的 SELECT+INSERT 事务原子性）
// - 21.3: inFlight 排除（_processQueue 的 SQL 排除 inFlight 对话）
// - 21.4: MemoryTasks 状态流转字段写入（started_at / error_message 截断）

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_extraction_service.dart';

// ====== 共用测试基础设施 ======

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 默认返回 1 条「基础信息」记忆的 LLM。
class _FakeLlmService extends LlmService {
  final String response;
  int calls = 0;

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

/// 抛固定异常的 LLM：用于 SubTask 21.4 失败场景。
class _ThrowingLlmService extends LlmService {
  final Object error;
  _ThrowingLlmService(this.error);

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    throw error;
  }
}

/// 卡住 LLM 调用直到手动 complete：用于 SubTask 21.2 / 21.3 控制时序。
class _BlockingLlmService extends LlmService {
  final Completer<String> _completer = Completer<String>();
  int calls = 0;

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    calls++;
    return _completer.future;
  }

  void complete(String response) {
    if (!_completer.isCompleted) {
      _completer.complete(response);
    }
  }
}

/// 在第 [throwOnNthCall] 次 findSimilarExistingMemories 调用时抛 [error]。
/// 用于 SubTask 21.1：让 supersede 写入循环中途抛异常，验证事务回滚。
class _FaultyMemoryEngine extends MemoryEngine {
  int calls = 0;
  final int throwOnNthCall;
  final Object error;

  _FaultyMemoryEngine(
    super.db,
    super.llm, {
    required this.throwOnNthCall,
    required this.error,
  });

  @override
  Future<Memory?> findSimilarExistingMemories(
    String characterId,
    String candidateContent, {
    double threshold = 0.6,
  }) async {
    calls++;
    if (calls == throwOnNthCall) {
      throw error;
    }
    return super.findSimilarExistingMemories(
      characterId,
      candidateContent,
      threshold: threshold,
    );
  }
}

Future<void> _seedConversation(
  AppDatabase db, {
  String charId = 'char-test',
  String convId = 'conv-test',
  String charName = '测试角色',
  String msgIdPrefix = '',
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: charId,
          name: Value(charName),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: convId,
          characterId: charId,
          title: const Value('测试对话'),
          createdAt: Value(DateTime(2026, 1, 1, 12)),
          updatedAt: Value(DateTime(2026, 1, 1, 12)),
        ),
      );
  // 一段长度 > 100 字符的对话，过 _processTask 的 `convText.length < 100` 早退
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: '${msgIdPrefix}u1',
          conversationId: convId,
          role: 'user',
          content: const Value(
              '我之前和你说过的，我喜欢猫和狗，目前还是单身状态，不过最近感情上有些变化。'),
          seq: const Value(1),
          createdAt: Value(DateTime(2026, 1, 1, 12, 1)),
          metadata: const Value('{}'),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: '${msgIdPrefix}a1',
          conversationId: convId,
          role: 'assistant',
          content: const Value('好的我记下了，你目前单身而且喜欢猫和狗，下次有相关话题我再主动跟你聊。'),
          seq: const Value(2),
          createdAt: Value(DateTime(2026, 1, 1, 12, 2)),
          metadata: const Value('{}'),
        ),
      );
}

Future<void> _seedExistingMemory(
  AppDatabase db, {
  required String id,
  required String charId,
  required String content,
  String status = 'active',
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: charId,
          category: '基础信息',
          content: content,
          status: Value(status),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

/// 等待指定对话的最近任务到达终态（done / failed）。
Future<MemoryTask?> _waitForFinishedTask(
  AppDatabase db,
  String convId, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final service = MemoryExtractionService(
    db,
    _FakeLlmService(response: '{"memories":[]}'),
    MemoryEngine(db, _FakeLlmService(response: '{"memories":[]}')),
  );
  final snap = await service
      .watchLatestTaskStatus(convId)
      .firstWhere((s) => s?.status == 'done' || s?.status == 'failed')
      .timeout(timeout);
  if (snap == null) return null;
  return (db.select(db.memoryTasks)..where((t) => t.id.equals(snap.taskId)))
      .getSingle();
}

/// 等队列里的所有 pending/processing 行 settle（done / failed）。
/// 避免 unawaited(_processQueue) 在 db.close 之后还在写表。
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
  // ============================================================
  // SubTask 21.1: 异常自动回滚验证
  //
  // 场景：LLM 返回 2 条 supersede 记忆，第一条命中预置旧记忆 mem-old-1
  // （INSERT 新记忆 + UPDATE 旧记忆 status='superseded'），第二条
  // supersede 调用 findSimilarExistingMemories 时 _FaultyMemoryEngine
  // 抛异常。异常发生在 _processTask 的 db.transaction 内部，应触发
  // 整个事务回滚：第一条的 INSERT 和 UPDATE 都被撤销。
  //
  // 断言：
  // - 旧记忆 mem-old-1 / mem-old-2 仍是 'active'，metadata 仍无 supersededBy
  // - memories 表只有 2 条预置记忆（无新插入）
  // - task.status = 'failed'，error_message 包含注入的异常信息
  // ============================================================
  group('SubTask 21.1: 异常自动回滚验证', () {
    test('事务内中途抛异常时，前序 supersede 变更被回滚，task 翻 failed', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 预置两条旧记忆，分别对应两条新记忆的 supersede 目标
      //
      // mem-old-1: "用户喜欢猫和狗，目前单身"
      //   containment vs new-1 "用户喜欢猫和狗，目前结婚"
      //   = 7/9 ≈ 0.778 ≥ 0.6 → 命中
      //
      // mem-old-2: "用户喜欢吃辣，不爱吃甜食"
      //   containment vs new-2 "用户喜欢吃辣，最近爱吃甜食"
      //   = 7/10 = 0.7 ≥ 0.6 → 命中
      await _seedExistingMemory(
        db,
        id: 'mem-old-1',
        charId: 'char-test',
        content: '用户喜欢猫和狗，目前单身',
      );
      await _seedExistingMemory(
        db,
        id: 'mem-old-2',
        charId: 'char-test',
        content: '用户喜欢吃辣，不爱吃甜食',
      );

      // LLM 返回 2 条 supersede 记忆
      final llm = _FakeLlmService(
        response: jsonEncode({
          'memories': [
            {
              'category': '基础信息',
              'content': '用户喜欢猫和狗，目前结婚',
              'confidence': 0.9,
              'tags': ['感情状态'],
              'lifecycle_action': 'supersede',
            },
            {
              'category': '基础信息',
              'content': '用户喜欢吃辣，最近爱吃甜食',
              'confidence': 0.9,
              'tags': ['饮食'],
              'lifecycle_action': 'supersede',
            },
          ],
        }),
      );

      // Faulty engine：第 2 次 findSimilarExistingMemories 调用时抛异常
      const injectedError = '注入的测试异常 - 模拟事务中途失败';
      final faultyEngine = _FaultyMemoryEngine(
        db,
        llm,
        throwOnNthCall: 2,
        error: Exception(injectedError),
      );
      final service =
          MemoryExtractionService(db, llm, faultyEngine);

      // 记录写入前状态
      final memoriesBefore = await db.select(db.memories).get();
      expect(memoriesBefore, hasLength(2),
          reason: '写入前应只有 2 条预置记忆');

      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db, 'conv-test');
      expect(task, isNotNull);
      expect(task!.status, 'failed',
          reason: '事务内抛异常应让 task 翻成 failed');
      expect(task.errorMessage, contains(injectedError),
          reason: 'error_message 应包含注入的异常信息');
      expect(faultyEngine.calls, 2,
          reason: '应在第 2 次 findSimilarExistingMemories 调用时抛异常');

      // 验证事务回滚：memories 表仍只有 2 条预置记忆
      final memoriesAfter = await db.select(db.memories).get();
      expect(memoriesAfter, hasLength(2),
          reason: '事务回滚应撤销第一条 supersede 的 INSERT 新记忆');

      // mem-old-1 仍是 active，metadata 仍为 null（事务回滚撤销 UPDATE）
      final oldMemory1 =
          memoriesAfter.firstWhere((m) => m.id == 'mem-old-1');
      expect(oldMemory1.status, 'active',
          reason: '事务回滚应撤销 UPDATE status=superseded');
      expect(oldMemory1.metadata, isNull,
          reason: '事务回滚应撤销 metadata.supersededBy 写入');

      // mem-old-2 完全没被触碰
      final oldMemory2 =
          memoriesAfter.firstWhere((m) => m.id == 'mem-old-2');
      expect(oldMemory2.status, 'active');
      expect(oldMemory2.metadata, isNull);

      // mergeCount 不应被写入（与写入循环同事务，回滚时一并撤销）
      expect(task.mergeCount, 0,
          reason: 'mergeCount 与写入循环同事务，回滚时不应被写入');
    });
  });

  // ============================================================
  // SubTask 21.2: 并发入队不重复插入
  //
  // 场景：Future.wait 同时调用两次 enqueueExtraction(同一 conversationId)。
  // 去重 guard 的 SELECT+INSERT 必须在同一事务内原子执行，避免 TOCTOU
  // （两个并发 enqueue 同时观测到「无 pending/processing 行」后各自 INSERT）。
  //
  // SQLite 内存库是单连接，transaction 互斥串行化；本测试验证去重 guard
  // 在 transaction 串行执行下仍能正确去重。
  //
  // 断言：memory_tasks 表中该 conversation 只有 1 条 pending/processing 行。
  // ============================================================
  group('SubTask 21.2: 并发入队不重复插入', () {
    test('Future.wait 同时入队同一对话，去重 guard 防止重复 INSERT', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 用 BlockingLlm 卡住 _processTask，确保 task 停在 processing
      // 不会在 Future.wait 返回后立即 done。
      final llm = _BlockingLlmService();
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await Future.wait([
        service.enqueueExtraction(
          characterId: 'char-test',
          conversationId: 'conv-test',
          messageIds: const ['u1', 'a1'],
        ),
        service.enqueueExtraction(
          characterId: 'char-test',
          conversationId: 'conv-test',
          messageIds: const ['u1', 'a1'],
        ),
      ]);

      // 验证：该 conversation 只有 1 条 pending/processing 行
      final pendingOrProcessing = await (db.select(db.memoryTasks)
            ..where((t) =>
                t.conversationId.equals('conv-test') &
                (t.status.equals('pending') |
                    t.status.equals('processing'))))
          .get();
      expect(pendingOrProcessing, hasLength(1),
          reason: '去重 guard 应防止并发入队重复 INSERT task 行');

      // 同时验证 memory_tasks 表总数也是 1（不会有额外的 done/failed 行）
      final allTasks = await db.select(db.memoryTasks).get();
      expect(allTasks, hasLength(1),
          reason: '该 conversation 不应有任何额外的 task 行');

      // 释放 BlockingLlm，让 task 完成，避免 db.close 后台写入
      llm.complete('{"memories":[]}');
      await _waitForQueueDrained(db);
    });

    test('快速连续两次入队，第二次命中第一次的 pending 行被跳过', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _BlockingLlmService();
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      // 第一次入队
      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );
      // 第二次入队（第一次的 task 还在 pending/processing）
      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      final allTasks = await db.select(db.memoryTasks).get();
      expect(allTasks, hasLength(1),
          reason: '第二次入队应命中第一次的 pending 行被跳过');

      llm.complete('{"memories":[]}');
      await _waitForQueueDrained(db);
    });
  });

  // ============================================================
  // SubTask 21.3: inFlight 排除
  //
  // _processQueue 的 SQL 查询用 `conversation_id NOT IN (_inFlightConversations)`
  // 排除正在处理中的对话。由于 _processQueue 是 while 串行，inFlight 排除
  // 实际上是「防御性编程」（防止去重 guard 失效时同一 conversation 的多个
  // pending 任务被串行处理）。本测试通过手动 mark + processQueueForTesting
  // 直接验证 SQL 排除逻辑。
  //
  // 测试 1（间接验证 inFlight 管理）：
  //   _processTask 执行期间 inFlight 集合包含当前 conversation，结束后移除。
  //   用 BlockingLlm 卡住 _processTask，断言 inFlight 集合状态。
  //
  // 测试 2（直接验证 SQL 排除）：
  //   手动 mark A 为 inFlight，调用 processQueueForTesting，断言 B 被处理、
  //   A 被跳过。清理 inFlight 后 unawaited 的 _processQueue 会处理 A。
  // ============================================================
  group('SubTask 21.3: inFlight 排除', () {
    test('_processTask 执行期间 inFlight 集合包含当前对话，结束后移除', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final llm = _BlockingLlmService();
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      // 初始 inFlight 集合为空
      expect(service.inFlightConversationsForTesting, isEmpty);

      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      // 等待 task 进入 processing（_processTask 卡在 LLM 调用上）
      MemoryTask? task;
      for (var i = 0; i < 80; i++) {
        task = await (db.select(db.memoryTasks)
              ..where((t) => t.status.equals('processing'))
              ..limit(1))
            .getSingleOrNull();
        if (task != null) break;
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
      expect(task, isNotNull, reason: 'task 应进入 processing');
      expect(llm.calls, 1, reason: 'LLM 应被调用一次（卡在 await 上）');

      // _processTask 执行期间，inFlight 集合应包含 conv-test
      expect(service.inFlightConversationsForTesting, contains('conv-test'),
          reason: '_processTask 执行期间 inFlight 集合应包含当前对话');

      // 释放 LLM，让 _processTask 完成
      llm.complete('{"memories":[]}');
      await _waitForQueueDrained(db);

      // _processTask 结束后，inFlight 集合应移除 conv-test
      expect(service.inFlightConversationsForTesting, isNot(contains('conv-test')),
          reason: '_processTask 结束后 inFlight 集合应移除当前对话');
    });

    test('A 在 inFlight 时，_processQueue 跳过 A 的 pending 任务，处理 B 的',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      // 构造 A、B 两个独立对话（绕过 enqueueExtraction 的去重 guard，
      // 手动 INSERT 两条 pending task）
      await _seedConversation(db, charId: 'charA', convId: 'convA', msgIdPrefix: 'A');
      await _seedConversation(db, charId: 'charB', convId: 'convB', msgIdPrefix: 'B');

      final now = DateTime.now();
      // A 的 pending task（id 较小，正常情况下会被先 SELECT 出来）
      await db.into(db.memoryTasks).insert(
            MemoryTasksCompanion.insert(
              characterId: 'charA',
              conversationId: 'convA',
              messageIds: const Value('["Au1","Aa1"]'),
              status: const Value('pending'),
              createdAt: Value(now),
              updatedAt: Value(now),
            ),
          );
      // B 的 pending task
      await db.into(db.memoryTasks).insert(
            MemoryTasksCompanion.insert(
              characterId: 'charB',
              conversationId: 'convB',
              messageIds: const Value('["Bu1","Ba1"]'),
              status: const Value('pending'),
              createdAt: Value(now),
              updatedAt: Value(now),
            ),
          );

      final llm = _FakeLlmService(response: '{"memories":[]}');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      // 手动把 A 标记为 inFlight，模拟「A 正在被处理」
      service.markConversationInFlightForTesting('convA');

      // 调用 processQueueForTesting 驱动一次队列处理
      await service.processQueueForTesting();

      // 断言：B 被处理（done），A 仍 pending（被 SQL 排除）
      final bTask = await (db.select(db.memoryTasks)
            ..where((t) => t.conversationId.equals('convB')))
          .getSingle();
      expect(bTask.status, 'done',
          reason: 'inFlight 排除应让 B 的 pending 任务被处理');

      final aTask = await (db.select(db.memoryTasks)
            ..where((t) => t.conversationId.equals('convA')))
          .getSingle();
      expect(aTask.status, 'pending',
          reason: 'A 在 inFlight 中，其 pending 任务应被 SQL 排除跳过');

      // 清理 inFlight：让 unawaited(_processQueue) 能处理 A
      // （finally 中的 pending 探测会发现 A 仍 pending，触发新一轮 _processQueue，
      //  但 inFlight 未清理时新一轮也会排除 A，形成空转；清理后 A 被处理）
      service.unmarkConversationInFlightForTesting('convA');
      await _waitForQueueDrained(db);

      // A 最终被 unawaited 的 _processQueue 处理
      final aTaskFinal = await (db.select(db.memoryTasks)
            ..where((t) => t.conversationId.equals('convA')))
          .getSingle();
      expect(aTaskFinal.status, 'done',
          reason: 'inFlight 清理后 A 应被 unawaited 的 _processQueue 处理');
    });
  });

  // ============================================================
  // SubTask 21.4: MemoryTasks 状态流转字段写入
  //
  // - pending → processing：验证 started_at 被写入当前毫秒时间戳
  // - processing → done：验证 error_message 不被写入（无失败原因）
  // - processing → failed：验证 error_message 被写入并截断到 1000 字符
  // ============================================================
  group('SubTask 21.4: MemoryTasks 状态流转字段写入', () {
    test('成功场景：pending → processing → done，started_at 写入，error_message 为 null',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final beforeEnqueue = DateTime.now();

      final llm = _FakeLlmService(response: '{"memories":[]}');
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db, 'conv-test');
      expect(task, isNotNull);
      expect(task!.status, 'done');

      // started_at 应被写入毫秒级时间戳，且 >= 入队前时刻
      expect(task.startedAt, isNotNull,
          reason: 'pending → processing 时应写入 started_at');
      expect(task.startedAt! >= beforeEnqueue.millisecondsSinceEpoch, isTrue,
          reason: 'started_at 应 >= 入队前时刻（毫秒级时间戳）');

      // error_message 不应被写入（成功场景无失败原因）
      expect(task.errorMessage, isNull,
          reason: 'processing → done 时不应写入 error_message');

      // mergeCount 应为 0（LLM 返回空 memories）
      expect(task.mergeCount, 0);
    });

    test('失败场景：processing → failed，error_message 被写入并截断到 1000 字符',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 构造一个超长错误信息（>1000 字符），验证截断逻辑
      final longErrorContent = 'X' * 1500;
      final llm = _ThrowingLlmService(Exception(longErrorContent));
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db, 'conv-test');
      expect(task, isNotNull);
      expect(task!.status, 'failed',
          reason: 'LLM 抛异常应让 task 翻成 failed');

      // started_at 应被写入（pending → processing 仍然发生）
      expect(task.startedAt, isNotNull,
          reason: '即使后续失败，pending → processing 时仍应写入 started_at');

      // error_message 应被写入，且截断到 1000 字符
      expect(task.errorMessage, isNotNull,
          reason: 'processing → failed 时应写入 error_message');
      expect(task.errorMessage!.length, 1000,
          reason: 'error_message 应被截断到 1000 字符（原长 1500）');
      expect(task.errorMessage, contains('X'),
          reason: 'error_message 应包含异常信息内容');
    });

    test('短错误信息不截断，原样写入', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      const shortError = 'LLM 网络请求失败';
      final llm = _ThrowingLlmService(Exception(shortError));
      final service = MemoryExtractionService(db, llm, MemoryEngine(db, llm));

      await service.enqueueExtraction(
        characterId: 'char-test',
        conversationId: 'conv-test',
        messageIds: const ['u1', 'a1'],
      );

      final task = await _waitForFinishedTask(db, 'conv-test');
      expect(task, isNotNull);
      expect(task!.status, 'failed');
      // 业务代码存的是 e.toString()，对 Exception(msg) 即 'Exception: msg'，
      // 故用 contains 验证「短错误信息（<1000 字符）不被截断」这一核心不变量。
      expect(task.errorMessage, contains(shortError),
          reason: '短错误信息（<1000 字符）应原样写入，不截断');
      expect(task.errorMessage!.length, lessThanOrEqualTo(1000));
    });
  });
}
