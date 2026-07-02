// Feature: flutter-memory-lifecycle, Property 25: 消息删除后来源记忆失效不变量
// Validates: spec Task 10 / 19.2
//
// 设计说明
// ────────
// spec Task 10 的 invalidateMemoriesForSourceMessage：
//   对所有 source_msg_ids 数组含 [messageId] 的 active 记忆，
//   在单个 transaction 内 UPDATE status='superseded'，
//   并在 metadata 写入 {previousStatus, sourceInvalidation: {messageId, reason, at}}。
//
// 不变量（spec 19.2）：
//   - 调用 invalidateMemoriesForSourceMessage(messageId, reason='deleted') 后，
//     所有 source_msg_ids 含 messageId 的 active 记忆 status='superseded'
//   - metadata.sourceInvalidation 含 {messageId, reason, at: 毫秒时间戳整数}
//   - 不含该 messageId 的记忆不受影响（status='active'，metadata=null）
//
// 随机化输入：生成 N 条记忆，每条 source_msg_ids 从消息 id 池中随机抽取。
// 目标 messageId 也从同一池中选，保证「命中」与「不命中」两条分支都被高概率
// 覆盖（池大小 5，命中概率约 1 - (4/5)^srcLen）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-src-invalidation-prop';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机目标 messageId + 随机记忆集合
//
// - 消息 id 池 5 个（msg-0 ~ msg-4）；目标 messageId 从池中选
// - 记忆条数 ∈ [0, 5]：覆盖空集合、单条与中等规模
// - 每条记忆的 source_msg_ids 长度 ∈ [0, 3]，从池中随机抽（去重）
// - 用 seed 构造确定性 Random，保证 glados 失败重放可复现
// ──────────────────────────────────────────────────────────────────────────

class _MemorySeed {
  final String id;
  final List<String> sourceMsgIds;
  const _MemorySeed(this.id, this.sourceMsgIds);
  @override
  String toString() => '_MemorySeed($id, src=$sourceMsgIds)';
}

class _InvalidationCase {
  final String targetMessageId;
  final List<_MemorySeed> memories;
  const _InvalidationCase(this.targetMessageId, this.memories);

  bool isHit(_MemorySeed m) => m.sourceMsgIds.contains(targetMessageId);

  @override
  String toString() =>
      '_InvalidationCase(target=$targetMessageId, n=${memories.length})';
}

extension on Any {
  Generator<_InvalidationCase> get invalidationCases {
    return combine3<int, int, int, _InvalidationCase>(
      intInRange(0, 1 << 30), // 决定 targetMessageId
      intInRange(0, 6), // 记忆条数 [0, 5]
      intInRange(0, 1 << 30), // 决定每条记忆的 source_msg_ids
      (targetSeed, memCount, memSeed) {
        const msgPoolSize = 5;
        final targetRng = math.Random(targetSeed);
        final targetId = 'msg-${targetRng.nextInt(msgPoolSize)}';
        if (memCount == 0) {
          return _InvalidationCase(targetId, const []);
        }
        final rng = math.Random(memSeed);
        final mems = <_MemorySeed>[];
        for (var i = 0; i < memCount; i++) {
          final srcLen = rng.nextInt(4); // [0, 3]
          final srcs = <String>{};
          for (var j = 0; j < srcLen; j++) {
            srcs.add('msg-${rng.nextInt(msgPoolSize)}');
          }
          mems.add(_MemorySeed('mem-$i', srcs.toList()));
        }
        return _InvalidationCase(targetId, mems);
      },
    );
  }
}

Map<String, dynamic> _decodeMetadata(String? json) {
  if (json == null || json.isEmpty) return {};
  try {
    final decoded = jsonDecode(json);
    if (decoded is Map<String, dynamic>) return decoded;
  } catch (_) {}
  return {};
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 25: 消息删除后来源记忆失效不变量', () {
    Glados<_InvalidationCase>(
      any.invalidationCases,
      ExploreConfig(numRuns: 100),
    ).test(
      'invalidateMemoriesForSourceMessage 后含目标 messageId 的记忆全 superseded，不含的不变',
      (c) async {
        final db = _createTestDb();
        addTearDown(db.close);
        await _seedCharacter(db);

        // 落库所有记忆（status='active' 列默认值，metadata=null）
        for (final m in c.memories) {
          await db.into(db.memories).insert(
                MemoriesCompanion.insert(
                  id: m.id,
                  characterId: _charId,
                  category: '基础信息',
                  content: '内容-${m.id}',
                  sourceMsgIds: Value(jsonEncode(m.sourceMsgIds)),
                  createdAt: Value(DateTime(2026, 1, 1)),
                  updatedAt: Value(DateTime(2026, 1, 1)),
                ),
              );
        }

        final engine = MemoryEngine(db, LlmService());
        final beforeMs = DateTime.now().millisecondsSinceEpoch;
        final count = await engine.invalidateMemoriesForSourceMessage(
          c.targetMessageId,
          reason: 'deleted',
        );
        final afterMs = DateTime.now().millisecondsSinceEpoch;

        // 返回值 = 命中条数
        final expectedHits = c.memories.where(c.isHit).length;
        expect(count, expectedHits,
            reason: '返回值应等于 source_msg_ids 含目标 messageId 的记忆条数');

        // 逐条断言不变量
        final rows = await db.select(db.memories).get();
        for (final m in c.memories) {
          final row = rows.firstWhere((r) => r.id == m.id);
          if (c.isHit(m)) {
            // 命中：status='superseded' + metadata.sourceInvalidation 完整
            expect(row.status, 'superseded',
                reason: '${m.id} 的 source_msg_ids=${m.sourceMsgIds} '
                    '含 ${c.targetMessageId}，应被失效为 superseded');
            final meta = _decodeMetadata(row.metadata);
            expect(meta['previousStatus'], 'active',
                reason: 'previousStatus 应记录失效前状态');
            final inv = meta['sourceInvalidation'] as Map<String, dynamic>;
            expect(inv['messageId'], c.targetMessageId,
                reason: 'sourceInvalidation.messageId 应为目标 messageId');
            expect(inv['reason'], 'deleted',
                reason: 'sourceInvalidation.reason 应为 deleted');
            expect(inv['at'], isA<int>(),
                reason: 'sourceInvalidation.at 应为毫秒时间戳整数');
            final atMs = inv['at'] as int;
            expect(atMs >= beforeMs, isTrue,
                reason: 'at 不应早于调用前时间戳');
            expect(atMs <= afterMs, isTrue,
                reason: 'at 不应晚于调用后时间戳');
          } else {
            // 未命中：完全不变（status='active'，metadata=null）
            expect(row.status, 'active',
                reason: '${m.id} 的 source_msg_ids=${m.sourceMsgIds} '
                    '不含 ${c.targetMessageId}，status 应保持 active');
            expect(row.metadata, isNull,
                reason: '${m.id} 未命中，metadata 应保持 null');
          }
        }
      },
    );
  });
}
