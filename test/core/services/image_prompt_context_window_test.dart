// Feature: flutter-parity-completion, Property 20: messageId 锚点上下文窗口
//
// **Validates: Requirements 12.2, 12.3**
//
// 通过内存 Drift（`AppDatabase.forTesting`）+ `package:glados` 生成 `(对话消息列表, messageId)`，
// 调用 `ImagePromptService.loadContextWindowForTesting`（`@visibleForTesting`
// 暴露的 `_loadContextWindow` 别名）后断言：
// - `messageId` 命中：取 `seq <= target.seq` 的最近 4 条消息，再按 `seq` 升序返回
//   （`seq < 4` 时不足 4 条则返回全部）。
// - `messageId == null` 或未命中：取该对话最近 4 条消息按 `seq` 升序返回
//   （消息 < 4 条时返回全部）。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/image_prompt_service.dart';

const _charId = 'char-ctx';
const _convId = 'conv-ctx';

/// 创建内存数据库 — 与同目录其它属性测试保持一致的工厂。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 预先创建 character + conversation + 指定数量的消息。
///
/// `seq` 直接使用 `i`（连续从 0 开始），`id` 使用 `msg-$i`，便于断言时按
/// 索引推导 expected。`role` 在 user / assistant 之间交替仅为模拟真实数据，
/// `_loadContextWindow` 不依赖 role。
Future<void> _seed(AppDatabase db, {required int messageCount}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('上下文窗口测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('上下文窗口测试对话'),
          createdAt: Value(DateTime(2026, 1, 2)),
          updatedAt: Value(DateTime(2026, 1, 2)),
        ),
      );
  for (var i = 0; i < messageCount; i++) {
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 'msg-$i',
            conversationId: _convId,
            role: i.isEven ? 'user' : 'assistant',
            content: Value('测试内容 $i'),
            seq: Value(i),
            createdAt: Value(DateTime(2026, 1, 2).add(Duration(seconds: i))),
          ),
        );
  }
}

/// 命中 / 未命中 / 空 messageId 三种场景的预期结果（仅返回 seq 列表）。
///
/// - 命中（`targetSeq != null`）：取 `seq ∈ [targetSeq - limit + 1, targetSeq]`，
///   其中 `limit = min(targetSeq + 1, 4)`，按升序输出。
/// - 未命中或为空：取 `seq ∈ [messageCount - limit, messageCount - 1]`，
///   其中 `limit = min(messageCount, 4)`，按升序输出。
List<int> _expectedSeqs({
  required int messageCount,
  required int? targetSeq,
}) {
  if (messageCount == 0) return const <int>[];
  if (targetSeq != null) {
    final limit = math.min(targetSeq + 1, 4);
    return List<int>.generate(limit, (j) => targetSeq - (limit - 1) + j);
  }
  final limit = math.min(messageCount, 4);
  return List<int>.generate(limit, (j) => messageCount - limit + j);
}

void main() {
  group('Property 20: messageId 锚点上下文窗口', () {
    Glados3<int, int, int>(
      any.intInRange(0, 11), // messageCount: 0..10，覆盖空对话与中等规模
      any.intInRange(0, 1 << 20), // 用于派生确定性 Random（target / mode 选择）
      any.intInRange(0, 4), // mode: 0=null, 1=miss, 2..3=hit（hit 占 50%）
    ).test(
      'hit: 取 seq<=target.seq 的最近 4 条升序; null/miss: 取最近 4 条升序',
      (messageCount, seed, modeChoice) async {
        final db = _createTestDb();
        try {
          await _seed(db, messageCount: messageCount);
          final svc = ImagePromptService();

          // 决定 messageId 与对应的 targetSeq（命中时）。
          // 当 messageCount==0 时只能走 null / miss。
          String? messageId;
          int? targetSeq;
          if (messageCount == 0) {
            messageId = modeChoice == 0 ? null : 'msg-nonexistent-$seed';
          } else {
            switch (modeChoice) {
              case 0:
                messageId = null;
                break;
              case 1:
                messageId = 'msg-nonexistent-$seed';
                break;
              default:
                final rng = math.Random(seed);
                final idx = rng.nextInt(messageCount);
                messageId = 'msg-$idx';
                targetSeq = idx;
                break;
            }
          }

          final actual = await svc.loadContextWindowForTesting(
            db: db,
            conversationId: _convId,
            messageId: messageId,
          );

          // 断言：seq 列表与预期一致（数量 + 顺序 + 边界）。
          final expected =
              _expectedSeqs(messageCount: messageCount, targetSeq: targetSeq);
          expect(
            actual.map((m) => m.seq).toList(),
            expected,
            reason: 'mode=$modeChoice, messageCount=$messageCount, '
                'targetSeq=$targetSeq, messageId=$messageId',
          );

          // 进一步不变量：返回的消息 seq 必须严格升序（覆盖 R12.2 / 12.3 的「按 seq 升序」）。
          for (var i = 1; i < actual.length; i++) {
            expect(
              actual[i].seq > actual[i - 1].seq,
              isTrue,
              reason: '相邻消息 seq 必须严格升序：'
                  '[${actual[i - 1].seq}, ${actual[i].seq}]',
            );
          }

          // 至多 4 条（无论命中与否）。
          expect(actual.length <= 4, isTrue,
              reason: '上下文窗口最多 4 条，实际 ${actual.length}');

          // 命中时所有返回 seq 不超过 target.seq。
          if (targetSeq != null) {
            for (final m in actual) {
              expect(m.seq <= targetSeq, isTrue,
                  reason: '命中分支返回的 seq 不能大于 target.seq=$targetSeq');
            }
          }
        } finally {
          await db.close();
        }
      },
    );

    // ───────── 边界例测：与属性测试形成双层保护 ─────────

    test('空对话：null / 任意 messageId 均返回空列表', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 0);
      final svc = ImagePromptService();
      final r1 = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: null,
      );
      expect(r1, isEmpty);
      final r2 = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: 'msg-anything',
      );
      expect(r2, isEmpty);
    });

    test('hit：target.seq==0 时返回 1 条（不足 4 条不报错）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 5);
      final svc = ImagePromptService();
      final result = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: 'msg-0',
      );
      expect(result.map((m) => m.seq).toList(), [0]);
    });

    test('hit：target.seq==2 时返回升序 [0, 1, 2]', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 5);
      final svc = ImagePromptService();
      final result = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: 'msg-2',
      );
      expect(result.map((m) => m.seq).toList(), [0, 1, 2]);
    });

    test('hit：target.seq==5 且总条数 6 时返回 [2, 3, 4, 5]', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 6);
      final svc = ImagePromptService();
      final result = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: 'msg-5',
      );
      expect(result.map((m) => m.seq).toList(), [2, 3, 4, 5]);
    });

    test('null：取最近 4 条升序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 7);
      final svc = ImagePromptService();
      final result = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: null,
      );
      expect(result.map((m) => m.seq).toList(), [3, 4, 5, 6]);
    });

    test('miss（messageId 不存在）：与 null 等价，取最近 4 条升序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seed(db, messageCount: 7);
      final svc = ImagePromptService();
      final result = await svc.loadContextWindowForTesting(
        db: db,
        conversationId: _convId,
        messageId: 'msg-not-in-conversation',
      );
      expect(result.map((m) => m.seq).toList(), [3, 4, 5, 6]);
    });
  });
}
