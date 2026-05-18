// Feature: flutter-parity-completion, Property 12: watchLatestTaskStatus 反映最新一条
//
// **Validates: Requirements 6.1, 6.5**
//
// 通过内存 Drift（`AppDatabase.forTesting`）+ `package:glados` 生成同一
// `conversationId` 下的 `memory_tasks` 行集合（可空），订阅
// `watchLatestTaskStatus(id).first` 拿到首个快照后断言：
// - 非空集合：`snapshot.updatedAt == max(rows.updatedAt)`，且 `status` /
//   `mergeCount` / `taskId` 全部来源于该最新行。
// - 空集合：`snapshot == null`。
// - 同对话连续多任务时，`updatedAt` 排序逻辑正确（与插入顺序无关）。
//
// 默认 100 次迭代（glados 默认值）。Drift `DateTime` 默认按 Unix 秒存储，
// 因此生成器使用秒级互不重复的 `updatedAt`，避免「最新一条」歧义。

import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';
import 'package:lumimuse/core/services/memory_extraction_service.dart';

import '../../_helpers/merge_toast_helper.dart';

const _convId = 'conv-1';
const _otherConvId = 'conv-2';
const _charId = 'char-1';

/// 创建内存数据库 — 与 test_search_pagination.dart 保持一致的工厂。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 预先插入 character + conversation —— task 8.3 显式要求的前置条件。
/// `memory_tasks.conversation_id` 虽然没有外键约束，但 ChatView 真实场景里
/// 一定挂在已存在的对话上，这里也保持同样的种子顺序。
Future<void> _seedCharAndConv(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('测试角色'),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _otherConvId,
          characterId: _charId,
        ),
      );
}

/// 内存表示的一条 `memory_tasks` 行 —— 仅包含本属性关心的字段。
class _Row {
  final String status;
  final int mergeCount;
  final DateTime updatedAt;
  const _Row(this.status, this.mergeCount, this.updatedAt);
}

/// 由 `(count, seed)` 派生的 `memory_tasks` 行集合：
/// - `count == 0` 时返回空集合（覆盖空集场景）。
/// - 否则生成 `count` 条 `updatedAt` 互不相同的行（秒级），并按 `updatedAt`
///   降序排列 —— 第 0 项即为「最新一条」预期值。
List<_Row> _buildRows(int count, int seed) {
  if (count <= 0) return const <_Row>[];
  final rng = math.Random(seed);
  const statuses = <String>['pending', 'processing', 'done', 'failed'];
  final base = DateTime(2026, 1, 1);
  // 用 Set 去重确保 `updatedAt` 互不相同（秒级），消除「最新一条」歧义。
  final offsets = <int>{};
  while (offsets.length < count) {
    offsets.add(rng.nextInt(1 << 20));
  }
  final sortedDesc = offsets.toList()..sort((a, b) => b.compareTo(a));
  return List<_Row>.generate(count, (i) {
    return _Row(
      statuses[rng.nextInt(statuses.length)],
      rng.nextInt(50),
      base.add(Duration(seconds: sortedDesc[i])),
    );
  });
}

void main() {
  group('Property 12: watchLatestTaskStatus 反映最新一条', () {
    Glados2<int, int>(
      any.intInRange(0, 7), // count: 0~6，覆盖空集 + 小到中等规模
      any.intInRange(0, 1 << 30), // seed: 决定 status / mergeCount / 插入顺序
    ).test(
      '订阅快照 updatedAt 等于 max(rows.updatedAt) 且字段来源于最新行；空集返回 null',
      (count, seed) async {
        final db = _createTestDb();
        try {
          await _seedCharAndConv(db);
          final rows = _buildRows(count, seed);

          // 用 seed 派生的 Random 打乱插入顺序：确保 watchLatestTaskStatus 的
          // 「按 updated_at DESC 排序」逻辑正确，而不是依赖「最后插入的一条」。
          final shuffled = rows.toList()..shuffle(math.Random(seed ^ 0x5A5A));

          // 同时记录每条 row 对应数据库分配的自增 id —— 用于断言
          // `snapshot.taskId` 等于最新行真实的 id。
          final assignedIds = <_Row, int>{};
          for (final r in shuffled) {
            final id = await db.into(db.memoryTasks).insert(
                  MemoryTasksCompanion.insert(
                    characterId: _charId,
                    conversationId: _convId,
                    status: Value(r.status),
                    mergeCount: Value(r.mergeCount),
                    createdAt: Value(r.updatedAt),
                    updatedAt: Value(r.updatedAt),
                  ),
                );
            assignedIds[r] = id;
          }

          // 同时往另一对话插入一条「时间最大」的干扰行，验证 conversationId
          // 过滤逻辑（即「最新一条」必须按 conversationId 过滤）。
          await db.into(db.memoryTasks).insert(
                MemoryTasksCompanion.insert(
                  characterId: _charId,
                  conversationId: _otherConvId,
                  status: const Value('processing'),
                  mergeCount: const Value(99),
                  createdAt: Value(DateTime(2099, 12, 31)),
                  updatedAt: Value(DateTime(2099, 12, 31)),
                ),
              );

          final svc = MemoryExtractionService(
            db,
            LlmService(),
            MemoryEngine(db, LlmService()),
          );

          final snapshot = await svc.watchLatestTaskStatus(_convId).first;

          if (rows.isEmpty) {
            expect(snapshot, isNull,
                reason: '该对话尚无 memory_tasks 时快照应为 null');
          } else {
            expect(snapshot, isNotNull, reason: '非空集合应发射快照');
            final latest = rows.first; // 已按 updatedAt 降序排列，第 0 项即最新
            final expectedMaxSec = rows
                .map((r) => r.updatedAt.millisecondsSinceEpoch ~/ 1000)
                .reduce(math.max);
            expect(
              snapshot!.updatedAt.millisecondsSinceEpoch ~/ 1000,
              expectedMaxSec,
              reason: 'snapshot.updatedAt 必须等于 max(rows.updatedAt)',
            );
            expect(snapshot.status, latest.status,
                reason: 'status 必须来源于 updatedAt 最大的那一行');
            expect(snapshot.mergeCount, latest.mergeCount,
                reason: 'mergeCount 必须来源于 updatedAt 最大的那一行');
            expect(snapshot.taskId, assignedIds[latest],
                reason: 'taskId 必须等于最新行数据库分配的自增 id');
          }
        } finally {
          await db.close();
        }
      },
    );

    // 例测：边界场景显式断言，配合属性测试形成双层保护。
    test('空集合返回 null（边界例测）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db);
      final svc = MemoryExtractionService(
        db,
        LlmService(),
        MemoryEngine(db, LlmService()),
      );
      final snapshot = await svc.watchLatestTaskStatus(_convId).first;
      expect(snapshot, isNull);
    });

    test('单条记录快照字段全部来自该行', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db);
      final ts = DateTime(2026, 1, 1, 10);
      final id = await db.into(db.memoryTasks).insert(
            MemoryTasksCompanion.insert(
              characterId: _charId,
              conversationId: _convId,
              status: const Value('done'),
              mergeCount: const Value(3),
              createdAt: Value(ts),
              updatedAt: Value(ts),
            ),
          );
      final svc = MemoryExtractionService(
        db,
        LlmService(),
        MemoryEngine(db, LlmService()),
      );
      final snapshot = await svc.watchLatestTaskStatus(_convId).first;
      expect(snapshot, isNotNull);
      expect(snapshot!.taskId, id);
      expect(snapshot.status, 'done');
      expect(snapshot.mergeCount, 3);
      expect(snapshot.updatedAt.millisecondsSinceEpoch ~/ 1000,
          ts.millisecondsSinceEpoch ~/ 1000);
    });

    test('多条记录按 updatedAt 取最新一条（与插入顺序无关）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db);
      // 故意先插入 updatedAt 较大的一条，再插 updatedAt 较小的一条。
      final older = DateTime(2026, 1, 1, 10);
      final newer = DateTime(2026, 1, 1, 12);
      final newerId = await db.into(db.memoryTasks).insert(
            MemoryTasksCompanion.insert(
              characterId: _charId,
              conversationId: _convId,
              status: const Value('processing'),
              mergeCount: const Value(7),
              createdAt: Value(newer),
              updatedAt: Value(newer),
            ),
          );
      await db.into(db.memoryTasks).insert(
            MemoryTasksCompanion.insert(
              characterId: _charId,
              conversationId: _convId,
              status: const Value('failed'),
              mergeCount: const Value(0),
              createdAt: Value(older),
              updatedAt: Value(older),
            ),
          );
      final svc = MemoryExtractionService(
        db,
        LlmService(),
        MemoryEngine(db, LlmService()),
      );
      final snapshot = await svc.watchLatestTaskStatus(_convId).first;
      expect(snapshot, isNotNull);
      expect(snapshot!.taskId, newerId,
          reason: '应反映 updatedAt 最大的那一条，而非最后插入的那一条');
      expect(snapshot.status, 'processing');
      expect(snapshot.mergeCount, 7);
    });
  });

  // 注册 Property 13: mergeCount toast 边沿触发（追加在同一 main() 内）。
  _runProperty13();
}


// ════════════════════════════════════════════════════════════════════════════
// Feature: flutter-parity-completion, Property 13: mergeCount toast 边沿触发
//
// **Validates: Requirements 6.3, 6.4**
//
// 通过 `package:glados` 生成 `MemoryTaskStatus` 快照序列，喂入抽出的纯函数
// `shouldShowMergeToast(prev, next)` 后断言：
// - toast 触发计数等于满足
//   `s[k-1].taskId == s[k].taskId && s[k-1].status == 'processing'
//    && s[k].status == 'done' && s[k].mergeCount > 0` 的相邻对数量。
// - 任一快照 `status == 'failed'` 时不触发 toast，但指示器需隐藏（即
//   `shouldShowExtractionIndicator(failedSnap) == false`）。
//
// 默认 100 次迭代（glados 默认值）。生成器使用「小 taskId 池 × 中等序列长度」
// 策略，让「同一任务的 processing → done」分支被高概率覆盖；同时随机注入
// taskId 切换，验证「新任务首推时不触发 toast」的行为。

/// 由 `(seqLen, taskIdCap, seed)` 派生的 `MemoryTaskStatus` 序列：
/// - `seqLen ∈ [0, 12]`：序列长度，覆盖空序列与中等规模。
/// - `taskIdCap ∈ [1, 3]`：taskId 池上限，限制为小池可让「同一任务多步推进」
///   分支被高概率覆盖。
/// - `seed`：用于在生成器内构造确定性 `Random`，保证 glados 失败重放可复现。
List<MemoryTaskStatus> _buildSnapshots(int seqLen, int taskIdCap, int seed) {
  if (seqLen == 0) return const <MemoryTaskStatus>[];
  final rng = math.Random(seed);
  const statuses = <String>['pending', 'processing', 'done', 'failed'];
  final base = DateTime(2026, 1, 1);
  return List<MemoryTaskStatus>.generate(seqLen, (i) {
    return MemoryTaskStatus(
      taskId: rng.nextInt(taskIdCap) + 1, // taskId ∈ [1, taskIdCap]
      status: statuses[rng.nextInt(statuses.length)],
      mergeCount: rng.nextInt(8), // 0..7，覆盖 0 与 >0 两种情况
      updatedAt: base.add(Duration(seconds: i)),
    );
  });
}

void _runProperty13() {
  group('Property 13: mergeCount toast 边沿触发', () {
    Glados3<int, int, int>(
      any.intInRange(0, 13), // seqLen: 0~12
      any.intInRange(1, 4), // taskIdCap: 1~3
      any.intInRange(0, 1 << 30), // seed
    ).test(
      'toast 触发计数等于「同 taskId 且 processing → done 且 mergeCount>0」相邻对数量',
      (seqLen, taskIdCap, seed) {
        final snaps = _buildSnapshots(seqLen, taskIdCap, seed);

        // 以 `shouldShowMergeToast` 驱动整段序列：
        // prev 初始为 null（与 ChatView 首次订阅时一致），逐步推进。
        // 注：真实 ChatView 在「snap == null」与「taskId 切换」时会重置 prev，
        // 这里 helper 已经覆盖这两种语义，因此直接传入相邻快照即可。
        MemoryTaskStatus? prev;
        var actualToastCount = 0;
        var failedButIndicatorShown = 0;
        for (final cur in snaps) {
          if (shouldShowMergeToast(prev, cur)) actualToastCount++;
          // 6.4：failed 时不触发 toast，但指示器需隐藏
          if (cur.status == 'failed') {
            // 同步检查指示器逻辑：failed 不应保留指示器
            if (shouldShowExtractionIndicator(cur)) {
              failedButIndicatorShown++;
            }
          }
          prev = cur;
        }

        // 期望计数：直接按定义遍历相邻对统计。
        var expectedToastCount = 0;
        for (var k = 1; k < snaps.length; k++) {
          final a = snaps[k - 1];
          final b = snaps[k];
          if (a.taskId == b.taskId &&
              a.status == 'processing' &&
              b.status == 'done' &&
              b.mergeCount > 0) {
            expectedToastCount++;
          }
        }

        expect(actualToastCount, expectedToastCount,
            reason: 'toast 触发计数应等于满足边沿条件的相邻对数量');
        expect(failedButIndicatorShown, 0,
            reason: 'failed 状态下指示器必须隐藏（6.4）');
      },
    );

    Glados3<int, int, int>(
      any.intInRange(0, 13),
      any.intInRange(1, 4),
      any.intInRange(0, 1 << 30),
    ).test(
      'taskId 切换时不触发 toast（即使 processing → done 边沿语义成立）',
      (seqLen, taskIdCap, seed) {
        final snaps = _buildSnapshots(seqLen, taskIdCap, seed);
        for (var k = 1; k < snaps.length; k++) {
          final a = snaps[k - 1];
          final b = snaps[k];
          if (a.taskId != b.taskId) {
            // 跨 taskId 的相邻对永远不应触发 toast，无论 status / mergeCount
            // 取何值（与 ChatView 中「taskId 切换 → 仅记录初始状态，不弹 toast」
            // 的行为一致）。
            expect(shouldShowMergeToast(a, b), isFalse,
                reason: 'taskId 不同的相邻对必须不触发 toast');
          }
        }
      },
    );

    // ─── 例测：边界场景显式断言，与属性测试形成双层保护 ───
    test('processing → done 且 mergeCount > 0 → 触发 toast（6.3）', () {
      final ts = DateTime(2026, 1, 1, 10);
      final prev = MemoryTaskStatus(
        taskId: 1,
        status: 'processing',
        mergeCount: 0,
        updatedAt: ts,
      );
      final next = MemoryTaskStatus(
        taskId: 1,
        status: 'done',
        mergeCount: 3,
        updatedAt: ts.add(const Duration(seconds: 1)),
      );
      expect(shouldShowMergeToast(prev, next), isTrue);
    });

    test('processing → done 但 mergeCount == 0 → 不触发 toast（6.3）', () {
      final ts = DateTime(2026, 1, 1, 10);
      final prev = MemoryTaskStatus(
        taskId: 1,
        status: 'processing',
        mergeCount: 0,
        updatedAt: ts,
      );
      final next = MemoryTaskStatus(
        taskId: 1,
        status: 'done',
        mergeCount: 0,
        updatedAt: ts.add(const Duration(seconds: 1)),
      );
      expect(shouldShowMergeToast(prev, next), isFalse);
      expect(memoryExtractStatusForTask(next), 'idle',
          reason: '没有实际写入记忆时不应显示「提取完成」');
    });

    test('processing → failed → 不触发 toast，且指示器隐藏（6.4）', () {
      final ts = DateTime(2026, 1, 1, 10);
      final prev = MemoryTaskStatus(
        taskId: 1,
        status: 'processing',
        mergeCount: 0,
        updatedAt: ts,
      );
      final next = MemoryTaskStatus(
        taskId: 1,
        status: 'failed',
        mergeCount: 0,
        updatedAt: ts.add(const Duration(seconds: 1)),
      );
      expect(shouldShowMergeToast(prev, next), isFalse,
          reason: 'failed 时不应弹 toast');
      expect(shouldShowExtractionIndicator(next), isFalse,
          reason: 'failed 时指示器必须隐藏');
    });

    test('taskId 切换 → 即使新任务直接 done 也不触发 toast', () {
      final ts = DateTime(2026, 1, 1, 10);
      final prev = MemoryTaskStatus(
        taskId: 1,
        status: 'processing',
        mergeCount: 0,
        updatedAt: ts,
      );
      final next = MemoryTaskStatus(
        taskId: 2, // 新任务
        status: 'done',
        mergeCount: 5,
        updatedAt: ts.add(const Duration(seconds: 1)),
      );
      expect(shouldShowMergeToast(prev, next), isFalse,
          reason: 'taskId 切换时仅记录初始状态，不应弹 toast');
    });

    test('prev 为 null（首次订阅）→ 不触发 toast', () {
      final ts = DateTime(2026, 1, 1, 10);
      final next = MemoryTaskStatus(
        taskId: 1,
        status: 'done',
        mergeCount: 3,
        updatedAt: ts,
      );
      expect(shouldShowMergeToast(null, next), isFalse);
    });

    test('指示器状态：null / pending / processing / done / failed', () {
      final ts = DateTime(2026, 1, 1, 10);
      expect(shouldShowExtractionIndicator(null), isFalse);
      expect(
          shouldShowExtractionIndicator(MemoryTaskStatus(
            taskId: 1,
            status: 'pending',
            mergeCount: 0,
            updatedAt: ts,
          )),
          isFalse);
      expect(
          shouldShowExtractionIndicator(MemoryTaskStatus(
            taskId: 1,
            status: 'processing',
            mergeCount: 0,
            updatedAt: ts,
          )),
          isTrue);
      expect(
          shouldShowExtractionIndicator(MemoryTaskStatus(
            taskId: 1,
            status: 'done',
            mergeCount: 3,
            updatedAt: ts,
          )),
          isFalse);
      expect(
          shouldShowExtractionIndicator(MemoryTaskStatus(
            taskId: 1,
            status: 'failed',
            mergeCount: 0,
            updatedAt: ts,
          )),
          isFalse);
      expect(
        memoryExtractStatusForTask(MemoryTaskStatus(
          taskId: 1,
          status: 'done',
          mergeCount: 3,
          updatedAt: ts,
        )),
        'done',
      );
      expect(
        memoryExtractStatusForTask(MemoryTaskStatus(
          taskId: 1,
          status: 'done',
          mergeCount: 0,
          updatedAt: ts,
        )),
        'idle',
      );
      expect(
        memoryExtractStatusForTask(MemoryTaskStatus(
          taskId: 1,
          status: 'failed',
          mergeCount: 0,
          updatedAt: ts,
        )),
        'failed',
      );
    });
  });
}

// Property 13 注册函数 `_runProperty13()` 已在 main() 末尾被调用，
// 与 Property 12 共享同一 flutter_test 入口。
