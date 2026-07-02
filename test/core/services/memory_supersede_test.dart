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

const _charId = 'char-supersede-write';
const _convId = 'conv-supersede-write';

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
  // 一段长度 > 100 字符的对话，过 _processTask 的 `convText.length < 100` 早退
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: 'u1',
          conversationId: _convId,
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
          id: 'a1',
          conversationId: _convId,
          role: 'assistant',
          content: const Value('好的我记下了，你目前单身而且喜欢猫和狗，下次有相关话题我再主动跟你聊。'),
          seq: const Value(2),
          createdAt: Value(DateTime(2026, 1, 1, 12, 2)),
          metadata: const Value('{}'),
        ),
      );
}

/// 预置一条已有的活跃记忆，模拟 supersede 场景中的「旧记忆」
Future<void> _seedExistingMemory(
  AppDatabase db, {
  required String id,
  required String content,
  String status = 'active',
  String? metadata,
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: _charId,
          category: '基础信息',
          content: content,
          status: Value(status),
          metadata: metadata != null ? Value(metadata) : const Value.absent(),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

Future<MemoryTask?> _waitForFinishedTask(AppDatabase db) async {
  final service = MemoryExtractionService(
    db,
    _FakeLlmService(response: '{"memories":[]}'),
    MemoryEngine(db, _FakeLlmService(response: '{"memories":[]}')),
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
  // 这些测试对应 spec Task 9 的 supersede 写入分支。
  //
  // 说明：spec 的「矛盾信息覆盖」Scenario 用「用户单身」vs「用户结婚了」做语义示例，
  // 但实测下两者的 CJK bigram containment（去除停用词「用户」后）= 0，低于默认阈值
  // 0.6，findSimilarExistingMemories 实际不会命中。为同时守住 spec 场景的「矛盾信息
  // 覆盖」语义并保证相似度算法能命中目标，这里选取了语义矛盾且 bigram 高度重叠的
  // 文本对：「用户喜欢猫和狗，目前单身」vs「用户喜欢猫和狗，目前结婚」。
  // 计算见各 test 注释。

  test('矛盾信息覆盖：supersede 命中时把旧记忆翻 superseded 并写入新记忆', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    // 预置旧记忆：content="用户喜欢猫和狗，目前单身"，id='mem-old'，status='active'
    await _seedExistingMemory(
      db,
      id: 'mem-old',
      content: '用户喜欢猫和狗，目前单身',
    );

    // LLM 提取新记忆：content="用户喜欢猫和狗，目前结婚"，带 lifecycle_action='supersede'
    //
    // 相似度计算（CJK bigram containment，去除停用词「用户」）：
    //   existing CJK = "用户喜欢猫和狗目前单身"（11 字）
    //     bigrams = {户喜, 喜欢, 欢猫, 猫和, 和狗, 狗目, 目前, 前单, 单身}（9 个）
    //   candidate CJK = "用户喜欢猫和狗目前结婚"（11 字）
    //     bigrams = {户喜, 喜欢, 欢猫, 猫和, 和狗, 狗目, 目前, 前结, 结婚}（9 个）
    //   intersection = {户喜, 喜欢, 欢猫, 猫和, 和狗, 狗目, 目前}（7 个）
    //   containment = 7 / 9 ≈ 0.778 ≥ 0.6（默认阈值）→ 命中
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
    expect(task.mergeCount, 1, reason: 'supersede 命中应计入 changedCount');
    expect(llm.calls, 1);

    final memories = await db.select(db.memories).get();
    expect(memories, hasLength(2),
        reason: '应同时存在旧记忆（superseded）与新记忆（active）');

    // 旧记忆：status='superseded'，metadata.supersededBy 指向新记忆 id
    final oldMemory =
        memories.firstWhere((m) => m.id == 'mem-old');
    expect(oldMemory.status, 'superseded');
    final oldMeta =
        jsonDecode(oldMemory.metadata!) as Map<String, dynamic>;
    expect(oldMeta['supersededBy'], isA<String>(),
        reason: 'metadata.supersededBy 应写入新记忆 id');
    final newMemoryId = oldMeta['supersededBy'] as String;

    // 新记忆：status='active'，content 与 id 匹配
    final newMemory =
        memories.firstWhere((m) => m.id == newMemoryId);
    expect(newMemory.status, 'active');
    expect(newMemory.content, '用户喜欢猫和狗，目前结婚');

    // 后续 retrieveRelevantMemories 不返回旧记忆（SQL 过滤 status='active'）
    final engine = MemoryEngine(db, _FakeLlmService(response: '{"memories":[]}'));
    final retrieved = await engine.retrieveRelevantMemories(
      queryText: '感情状态',
      characterId: _charId,
    );
    expect(retrieved.any((m) => m.id == 'mem-old'), isFalse,
        reason: '旧记忆 status=superseded，retrieveRelevantMemories 不应返回');
    expect(retrieved.any((m) => m.id == newMemoryId), isTrue,
        reason: '新记忆 status=active 应能被检索到');
  });

  test("lifecycle_action='insert' 时走普通 insert 路径，旧记忆保持不变", () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    // 旧记忆：content="用户喜欢看电影"，与新记忆 bigram containment 不足 0.6
    await _seedExistingMemory(
      db,
      id: 'mem-old',
      content: '用户喜欢看电影',
    );

    // LLM 提取新记忆：content="用户喜欢吃辣"，lifecycle_action='insert'
    // （不触发 supersede 分支，且与新记忆 bigram Jaccard < 0.85 短记忆阈值，也不合并）
    final llm = _FakeLlmService(
      response: jsonEncode({
        'memories': [
          {
            'category': '基础信息',
            'content': '用户喜欢吃辣',
            'confidence': 0.9,
            'tags': ['饮食'],
            'lifecycle_action': 'insert',
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
    expect(task.mergeCount, 1, reason: '走普通 insert 路径应计入 changedCount');

    final memories = await db.select(db.memories).get();
    expect(memories, hasLength(2));

    // 旧记忆：status='active' 不变，metadata 仍为 null（_seedExistingMemory 未设值）
    final oldMemory =
        memories.firstWhere((m) => m.id == 'mem-old');
    expect(oldMemory.status, 'active');
    expect(oldMemory.metadata, isNull,
        reason: 'insert 路径不应触碰旧记忆的 metadata');

    // 新记忆：status='active'（列默认值），content 落库
    final newMemory =
        memories.firstWhere((m) => m.content == '用户喜欢吃辣');
    expect(newMemory.status, 'active');
  });

  test("lifecycle_action='supersede' 但未命中目标时退化为 insert", () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    // 旧记忆：content="用户喜欢看电影"，与新记忆 bigram containment 不足 0.6
    // → findSimilarExistingMemories 返回 null → 退化走下方普通 insert 分支
    await _seedExistingMemory(
      db,
      id: 'mem-old',
      content: '用户喜欢看电影',
    );

    // LLM 提取新记忆：content="用户喜欢吃辣"，lifecycle_action='supersede'
    // 相似度计算：
    //   existing CJK = "用户喜欢看电影"
    //     bigrams (去停用词「用户」) = {户喜, 喜欢, 欢看, 看电, 电影}（5）
    //   candidate CJK = "用户喜欢吃辣"
    //     bigrams (去停用词「用户」) = {户喜, 喜欢, 欢吃, 吃辣}（4）
    //   intersection = {户喜, 喜欢}（2）
    //   containment = 2 / 4 = 0.5 < 0.6 → null（未命中）
    final llm = _FakeLlmService(
      response: jsonEncode({
        'memories': [
          {
            'category': '基础信息',
            'content': '用户喜欢吃辣',
            'confidence': 0.9,
            'tags': ['饮食'],
            'lifecycle_action': 'supersede',
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
    expect(task.mergeCount, 1,
        reason: '未命中后退化走普通 insert 路径，应计入 changedCount');

    final memories = await db.select(db.memories).get();
    expect(memories, hasLength(2));

    // 旧记忆：完全不变（status='active'，metadata=null）
    final oldMemory =
        memories.firstWhere((m) => m.id == 'mem-old');
    expect(oldMemory.status, 'active');
    expect(oldMemory.metadata, isNull,
        reason: '未命中目标时不应触碰任何旧记忆');

    // 新记忆：作为独立行 INSERT，status='active'
    final newMemory =
        memories.firstWhere((m) => m.content == '用户喜欢吃辣');
    expect(newMemory.status, 'active');
    expect(newMemory.id, isNot('mem-old'));
  });
}
