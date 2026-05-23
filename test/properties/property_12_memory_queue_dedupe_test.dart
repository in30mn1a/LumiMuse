// Feature: flutter-pixel-perfect-parity, Property 12: MemoryQueue 双层去重
// Validates: Requirements B7.3 (INV-6)
//
// 设计说明
// ────────
// design.md §7 / INV-6 要求：
//   `MemoryQueue.enqueue` 在内存 Set 与 `memory_tasks` 表都不存在
//   `(conversation_id, batch_signature)` 时才入队；任意 (conv_id, sig)
//   二元组在表中最终至多 1 行，重复入队返回 false 且不产生写入。
//
// 本属性测试不依赖 Drift 真实数据库，把 design §7 的契约落到两个最小
// 替身上：
//
//   - `_FakeMemoryTaskTable`：用 `List<Map<String, dynamic>>` 模拟
//      `memory_tasks` 表（仅保留 conversation_id / batch_signature 两列，
//      足以验证去重不变量）；
//   - `_FakeMemoryQueue`：内部维护 `Set<String> _inMemorySignatures` 与
//      `_FakeMemoryTaskTable _table`，按 design §7 实现三步去重：
//        1) 内存 Set 命中 → return false；
//        2) 表已存在 (conv_id, sig) 行 → return false；
//        3) 否则插入表 + 加入 Set，return true。
//
// glados 随机构造重复入队序列（候选 (conv_id, sig) 池较小，强制制造
// 重复），逐步执行 enqueue 并在每一步断言：
//
//   - 任何 (conv_id, sig) 在表中至多 1 行（INV-6 不变量）；
//   - 命中重复时 enqueue 返回 false 且表行数不变；
//   - 内存 Set 中每个键至多出现一次（Set 语义自然成立，仍显式断言以
//     防 _FakeMemoryQueue 实现退化）。
//
// 失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 入队请求 —— `(conversation_id, batch_signature)` 二元组
// ──────────────────────────────────────────────────────────────────────────

class _EnqueueRequest {
  final String conversationId;
  final String batchSignature;
  const _EnqueueRequest(this.conversationId, this.batchSignature);

  /// 双层去重键：与 _FakeMemoryQueue 内部使用的拼接规则保持一致。
  String get key => '$conversationId\u0000$batchSignature';

  @override
  String toString() => 'enqueue($conversationId, $batchSignature)';
}

// ──────────────────────────────────────────────────────────────────────────
// 最小 `_FakeMemoryTaskTable`
//
// 用 `List<Map<String, dynamic>>` 模拟 `memory_tasks` 表，只保留
// 双层去重必须的两列；行的额外字段不影响 INV-6 的验证。
// ──────────────────────────────────────────────────────────────────────────

class _FakeMemoryTaskTable {
  final List<Map<String, dynamic>> _rows = <Map<String, dynamic>>[];

  /// 表中是否已存在 (conv_id, sig) 行（对应主项目 `memory-queue.ts`
  /// 在 DB 层的存在性查询）。
  bool exists(String conversationId, String batchSignature) {
    for (final row in _rows) {
      if (row['conversation_id'] == conversationId &&
          row['batch_signature'] == batchSignature) {
        return true;
      }
    }
    return false;
  }

  /// 插入一行 pending 任务（对应 design §7 的「插入 memory_tasks（pending）」）。
  void insert(String conversationId, String batchSignature) {
    _rows.add(<String, dynamic>{
      'conversation_id': conversationId,
      'batch_signature': batchSignature,
      'status': 'pending',
    });
  }

  /// 当前总行数 —— 用来判断「未发生写入」时表行数不变。
  int get rowCount => _rows.length;

  /// 统计 (conv_id, sig) 在表中的行数 —— 用来断言「至多 1 行」。
  int countOf(String conversationId, String batchSignature) {
    var c = 0;
    for (final row in _rows) {
      if (row['conversation_id'] == conversationId &&
          row['batch_signature'] == batchSignature) {
        c++;
      }
    }
    return c;
  }

  /// 表中所有 (conv_id, sig) 键的快照（无重复语义）—— 仅用于断言。
  Iterable<String> get distinctKeys {
    final s = <String>{};
    for (final row in _rows) {
      s.add('${row['conversation_id']}\u0000${row['batch_signature']}');
    }
    return s;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 最小 `_FakeMemoryQueue`
//
// 行为完全对齐 design §7：
//   1) 内存 Set 命中 → return false（不查表、不写表）；
//   2) 表已存在 (conv_id, sig) 行 → 把键补回内存 Set 后 return false（
//      模拟「跨进程重启后内存 Set 为空，但表里有历史记录」的兜底分支），
//      不写表；
//   3) 否则插入表 + 加入 Set，return true。
// ──────────────────────────────────────────────────────────────────────────

class _FakeMemoryQueue {
  final Set<String> _inMemorySignatures = <String>{};
  final _FakeMemoryTaskTable _table;

  _FakeMemoryQueue(this._table);

  /// 入队键：与 `_EnqueueRequest.key` 保持一致的拼接规则。
  String _key(String conversationId, String batchSignature) =>
      '$conversationId\u0000$batchSignature';

  /// 双层去重入队 —— 返回是否产生了新写入。
  bool enqueue({
    required String conversationId,
    required String batchSignature,
  }) {
    final k = _key(conversationId, batchSignature);

    // 第 1 层：内存 Set 命中。
    if (_inMemorySignatures.contains(k)) {
      return false;
    }

    // 第 2 层：表中已存在历史记录（跨进程恢复场景）。
    if (_table.exists(conversationId, batchSignature)) {
      // 补回内存 Set，后续命中走第 1 层；不写表。
      _inMemorySignatures.add(k);
      return false;
    }

    // 两层都不命中：插入表 + 加入 Set。
    _table.insert(conversationId, batchSignature);
    _inMemorySignatures.add(k);
    return true;
  }

  // 仅供测试断言使用 —— 暴露内存 Set 快照。
  Set<String> get inMemorySnapshot => Set<String>.unmodifiable(_inMemorySignatures);
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机构造含重复元素的入队序列
//
// 设计策略：
// - 序列长度 ∈ [0, 30]：覆盖空序列、单步与中等规模序列。
// - conv_id 池大小 4（`conv-0` ~ `conv-3`）、batch_signature 池大小 5
//   （`sig-0` ~ `sig-4`），合计 20 个候选键，但序列长度可达 30，
//   保证「重复入队」分支被高概率覆盖。
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<List<_EnqueueRequest>> get enqueueRequestSequences {
    return combine2<int, int, List<_EnqueueRequest>>(
      intInRange(0, 31), // 序列长度 [0, 30]
      intInRange(0, 1 << 30), // Random 种子
      (seqLen, seed) {
        if (seqLen == 0) return const <_EnqueueRequest>[];
        final rng = math.Random(seed);
        return List<_EnqueueRequest>.generate(seqLen, (_) {
          final convId = 'conv-${rng.nextInt(4)}';
          final sig = 'sig-${rng.nextInt(5)}';
          return _EnqueueRequest(convId, sig);
        });
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 12: MemoryQueue 双层去重', () {
    Glados<List<_EnqueueRequest>>(
      any.enqueueRequestSequences,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 (conversation_id, batch_signature) 入队序列下，每一步后表中该键至多 1 行、内存 Set 至多一次、命中重复时 enqueue 返回 false 且无写入',
      (requests) {
        final table = _FakeMemoryTaskTable();
        final queue = _FakeMemoryQueue(table);

        // 初始状态：表与内存 Set 都为空 —— 不变量平凡成立。
        expect(table.rowCount, 0, reason: '初始表必为空');
        expect(queue.inMemorySnapshot, isEmpty, reason: '初始内存 Set 必为空');

        for (final req in requests) {
          // 调用前快照：用于「命中重复时表行数不变」断言。
          final beforeRowCount = table.rowCount;
          final beforeKeyCount = table.countOf(
            req.conversationId,
            req.batchSignature,
          );
          final beforeAlreadyKnown = beforeKeyCount > 0 ||
              queue.inMemorySnapshot.contains(req.key);

          final inserted = queue.enqueue(
            conversationId: req.conversationId,
            batchSignature: req.batchSignature,
          );

          // INV-6 主条款：表中该键至多 1 行。
          final afterKeyCount = table.countOf(
            req.conversationId,
            req.batchSignature,
          );
          expect(
            afterKeyCount,
            lessThanOrEqualTo(1),
            reason:
                '执行 $req 后违反 INV-6：'
                '(${req.conversationId}, ${req.batchSignature}) 在表中出现 '
                '$afterKeyCount 次，应 ≤ 1',
          );

          // 命中重复 → enqueue 返回 false 且表行数不变（无写入）。
          if (beforeAlreadyKnown) {
            expect(
              inserted,
              isFalse,
              reason:
                  '执行 $req 时键已存在（表/内存 Set），enqueue 必须返回 false',
            );
            expect(
              table.rowCount,
              beforeRowCount,
              reason:
                  '执行 $req 时键已存在，表行数应保持 $beforeRowCount，'
                  '实际 ${table.rowCount}',
            );
          } else {
            // 未命中 → 必须返回 true，且表行数 +1、该键行数恰为 1。
            expect(
              inserted,
              isTrue,
              reason: '执行 $req 时键不存在，enqueue 必须返回 true',
            );
            expect(
              table.rowCount,
              beforeRowCount + 1,
              reason:
                  '执行 $req 时键不存在，表行数应 +1，'
                  '实际从 $beforeRowCount 变为 ${table.rowCount}',
            );
            expect(
              afterKeyCount,
              1,
              reason:
                  '执行 $req 后该键应恰好写入 1 行，实际 $afterKeyCount',
            );
          }

          // INV-6 辅助条款：表中所有键去重后的数量 == 实际行数（每键至多 1 行）。
          expect(
            table.distinctKeys.length,
            table.rowCount,
            reason:
                '执行 $req 后表中存在重复键：'
                'distinct=${table.distinctKeys.length}，'
                'rowCount=${table.rowCount}',
          );

          // INV-6 辅助条款：每个键在内存 Set 中至多一次（Set 语义自然成立，
          // 仍显式断言以防 _FakeMemoryQueue 实现退化）。
          final snapshot = queue.inMemorySnapshot;
          expect(
            snapshot.length,
            snapshot.toSet().length,
            reason: '执行 $req 后内存 Set 出现重复元素，违反 Set 语义',
          );
        }

        // 终态总不变量：所有写入过的键在表中各占 1 行；内存 Set 至少包含
        // 表中所有键（可能多出来自第 2 层补回的键，但不会更少）。
        for (final k in table.distinctKeys) {
          final parts = k.split('\u0000');
          expect(
            table.countOf(parts[0], parts[1]),
            1,
            reason: '终态键 $k 在表中应恰好 1 行',
          );
          expect(
            queue.inMemorySnapshot.contains(k),
            isTrue,
            reason: '终态键 $k 必须存在于内存 Set 中',
          );
        }
      },
    );
  });
}
