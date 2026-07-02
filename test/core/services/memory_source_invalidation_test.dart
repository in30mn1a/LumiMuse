import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-source-invalidation';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(
  AppDatabase db, {
  String id = _charId,
  String name = '测试角色',
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: Value(name),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

/// 预置一条记忆，可指定 source_msg_ids / status / metadata
Future<void> _seedMemory(
  AppDatabase db, {
  required String id,
  required String content,
  String characterId = _charId,
  List<String> sourceMsgIds = const [],
  String status = 'active',
  String? metadata,
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: characterId,
          category: '基础信息',
          content: content,
          sourceMsgIds: Value(jsonEncode(sourceMsgIds)),
          status: Value(status),
          metadata: metadata != null ? Value(metadata) : const Value.absent(),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

void main() {
  // 这些测试对应 spec Task 10 的 invalidateMemoriesForSourceMessage 函数。
  //
  // 字段说明：
  // - source_msg_ids 是 Memories 表的独立列（Drift 字段 sourceMsgIds，JSON 数组字符串）
  //   —— 不是 metadata 字段，与主项目 src/lib/memory-source-tracking.ts 一致。
  // - metadata.sourceInvalidation 结构：{messageId, reason, at: <毫秒时间戳整数>}
  //   主项目原版字段名为 invalidatedAt（ISO 字符串），此处按 spec Task 10 用 at + ms 整数。

  test('重新生成消息后旧记忆失效（reason=regenerated）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // mem-1 的 source_msg_ids 含 'msg-A' → 应被失效
    // mem-2 的 source_msg_ids 含 'msg-B' → 不应被触碰
    await _seedMemory(
      db,
      id: 'mem-1',
      content: '用户喜欢猫',
      sourceMsgIds: const ['msg-A'],
    );
    await _seedMemory(
      db,
      id: 'mem-2',
      content: '用户喜欢狗',
      sourceMsgIds: const ['msg-B'],
    );

    final engine = MemoryEngine(db, LlmService());
    final beforeMs = DateTime.now().millisecondsSinceEpoch;
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-A',
      reason: 'regenerated',
    );
    final afterMs = DateTime.now().millisecondsSinceEpoch;

    expect(count, 1, reason: '只有 mem-1 的 source_msg_ids 含 msg-A');

    final memories = await db.select(db.memories).get();
    final mem1 = memories.firstWhere((m) => m.id == 'mem-1');
    final mem2 = memories.firstWhere((m) => m.id == 'mem-2');

    // mem-1: status='superseded'，metadata.sourceInvalidation 字段写入正确
    expect(mem1.status, 'superseded');
    final meta1 = jsonDecode(mem1.metadata!) as Map<String, dynamic>;
    expect(meta1['previousStatus'], 'active');
    final inv = meta1['sourceInvalidation'] as Map<String, dynamic>;
    expect(inv['messageId'], 'msg-A');
    expect(inv['reason'], 'regenerated');
    expect(inv['at'], isA<int>(), reason: 'at 应为毫秒时间戳整数');
    final atMs = inv['at'] as int;
    expect(atMs >= beforeMs, isTrue);
    expect(atMs <= afterMs, isTrue);

    // mem-2: 完全不变（status='active'，metadata=null）
    expect(mem2.status, 'active');
    expect(mem2.metadata, isNull,
        reason: '不含目标 messageId 的记忆不应被触碰');
  });

  test('删除消息后旧记忆失效（reason=deleted）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // source_msg_ids 含多个 messageId，只要包含目标即命中
    await _seedMemory(
      db,
      id: 'mem-x',
      content: '用户喜欢吃辣',
      sourceMsgIds: const ['msg-del', 'msg-other'],
    );

    final engine = MemoryEngine(db, LlmService());
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-del',
      reason: 'deleted',
    );

    expect(count, 1);
    final mem = await (db.select(db.memories)
          ..where((t) => t.id.equals('mem-x')))
        .getSingle();
    expect(mem.status, 'superseded');
    final meta = jsonDecode(mem.metadata!) as Map<String, dynamic>;
    final inv = meta['sourceInvalidation'] as Map<String, dynamic>;
    expect(inv['messageId'], 'msg-del');
    expect(inv['reason'], 'deleted');
  });

  test('不含该 messageId 的记忆不受影响', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // 空数组 / 含其他 messageId 都不应被失效
    await _seedMemory(
      db,
      id: 'mem-empty',
      content: '空数组',
      sourceMsgIds: const [],
    );
    await _seedMemory(
      db,
      id: 'mem-other',
      content: '其他 messageId',
      sourceMsgIds: const ['msg-X'],
    );

    final engine = MemoryEngine(db, LlmService());
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-NOT-EXIST',
      reason: 'regenerated',
    );

    expect(count, 0);
    final memories = await db.select(db.memories).get();
    for (final m in memories) {
      expect(m.status, 'active');
      expect(m.metadata, isNull, reason: '不应被触碰');
    }
  });

  test('已是 superseded 状态的记忆不再被处理', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // 已是 superseded 的记忆（即使 source_msg_ids 含目标 messageId）
    // SQL 过滤 status='active'，根本不会进命中列表
    await _seedMemory(
      db,
      id: 'mem-sup',
      content: '已失效',
      sourceMsgIds: const ['msg-A'],
      status: 'superseded',
      metadata: jsonEncode({'supersededBy': 'new-mem'}),
    );

    final engine = MemoryEngine(db, LlmService());
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-A',
      reason: 'regenerated',
    );

    expect(count, 0, reason: 'SQL 过滤 status=active，superseded 记忆不进命中列表');
    final mem = await (db.select(db.memories)
          ..where((t) => t.id.equals('mem-sup')))
        .getSingle();
    expect(mem.status, 'superseded');
    // metadata 不变（原有 supersededBy 保留，未被 sourceInvalidation 覆盖）
    final meta = jsonDecode(mem.metadata!) as Map<String, dynamic>;
    expect(meta['supersededBy'], 'new-mem');
    expect(meta.containsKey('sourceInvalidation'), isFalse,
        reason: '已是 superseded 的记忆不应被二次失效');
  });

  test('保留原有 metadata 字段，仅追加 sourceInvalidation', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // 记忆已有 metadata 字段（如 customField、tags_v2），失效后应保留
    await _seedMemory(
      db,
      id: 'mem-meta',
      content: '带元数据',
      sourceMsgIds: const ['msg-A'],
      metadata: jsonEncode({'customField': '保留我', 'tags_v2': [1, 2, 3]}),
    );

    final engine = MemoryEngine(db, LlmService());
    await engine.invalidateMemoriesForSourceMessage(
      'msg-A',
      reason: 'edited',
    );

    final mem = await (db.select(db.memories)
          ..where((t) => t.id.equals('mem-meta')))
        .getSingle();
    expect(mem.status, 'superseded');
    final meta = jsonDecode(mem.metadata!) as Map<String, dynamic>;
    expect(meta['customField'], '保留我');
    expect((meta['tags_v2'] as List).toList(), [1, 2, 3]);
    expect(meta['previousStatus'], 'active');
    expect((meta['sourceInvalidation'] as Map)['reason'], 'edited');
  });

  test('跨角色：不同角色的记忆若共享同一 messageId 都被失效', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db, id: 'char-A', name: '角色A');
    await _seedCharacter(db, id: 'char-B', name: '角色B');

    // 两个角色各有一条记忆，source_msg_ids 都含 'msg-shared'
    await _seedMemory(
      db,
      id: 'mem-A',
      content: '角色A的记忆',
      characterId: 'char-A',
      sourceMsgIds: const ['msg-shared'],
    );
    await _seedMemory(
      db,
      id: 'mem-B',
      content: '角色B的记忆',
      characterId: 'char-B',
      sourceMsgIds: const ['msg-shared'],
    );

    final engine = MemoryEngine(db, LlmService());
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-shared',
      reason: 'regenerated',
    );

    expect(count, 2, reason: '跨角色按 messageId 全表扫，两条都应失效');
    final memories = await db.select(db.memories).get();
    expect(memories.every((m) => m.status == 'superseded'), isTrue);
  });

  test('source_msg_ids JSON 异常时按空数组处理，不抛异常', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // 直接插入 source_msg_ids 为非法 JSON 的记忆
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-bad',
            characterId: _charId,
            category: '基础信息',
            content: '坏 JSON',
            sourceMsgIds: const Value('not-a-json'),
            createdAt: Value(DateTime(2026, 1, 1)),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );

    final engine = MemoryEngine(db, LlmService());
    // 即使 messageId 看起来在字符串里，也应按空数组处理（不命中）
    final count = await engine.invalidateMemoriesForSourceMessage(
      'not-a-json',
      reason: 'regenerated',
    );

    expect(count, 0, reason: 'JSON 解析失败按空数组，不应误命中');
    final mem = await (db.select(db.memories)
          ..where((t) => t.id.equals('mem-bad')))
        .getSingle();
    expect(mem.status, 'active');
    expect(mem.metadata, isNull, reason: '未命中不应写 metadata');
  });

  test('返回值反映实际失效条数（多条同时命中）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);

    // 三条记忆的 source_msg_ids 都含 'msg-A'
    await _seedMemory(
      db,
      id: 'm1',
      content: '记忆一',
      sourceMsgIds: const ['msg-A'],
    );
    await _seedMemory(
      db,
      id: 'm2',
      content: '记忆二',
      sourceMsgIds: const ['msg-A', 'msg-other'],
    );
    await _seedMemory(
      db,
      id: 'm3',
      content: '记忆三 不含',
      sourceMsgIds: const ['msg-B'],
    );

    final engine = MemoryEngine(db, LlmService());
    final count = await engine.invalidateMemoriesForSourceMessage(
      'msg-A',
      reason: 'regenerated',
    );

    expect(count, 2, reason: 'm1 和 m2 的 source_msg_ids 含 msg-A');
  });
}
