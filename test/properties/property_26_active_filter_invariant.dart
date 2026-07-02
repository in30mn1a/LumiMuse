// Feature: flutter-memory-lifecycle, Property 26: retrieveRelevantMemories 仅返回 active 记忆
// Validates: spec 19.3
//
// 设计说明
// ────────
// MemoryEngine.retrieveRelevantMemories 的 SQL 过滤 `status.equals('active')`
// 是记忆检索的核心不变量：无论记忆总数、status 分布、查询文本如何，返回结果
// 永远只含 status='active' 的记忆，archived / conflict / superseded / summarized
// 等其他状态的记忆一律不返回。
//
// 不变量（spec 19.3）：
//   对任意记忆集合（status 混合分布），retrieveRelevantMemories 返回的记忆
//   status 全为 'active'；且当总数 ≤ maxMemories(30) 时，所有 active 记忆
//   都被返回（无随机裁剪）。
//
// 随机化输入：每条记忆随机 status（active/archived/conflict/superseded/summarized
// 五类等概率）+ 随机 content（中文池，保证 CJK bigram token）。记忆条数 ≤ 10，
// 远小于 maxMemories=30，确保「全量返回 active」分支被覆盖。

import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-active-filter-prop';

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

// 五类 status：active + 四种非 active（覆盖 spec 19.3 列举的全部状态）
const _statusPool = [
  'active',
  'archived',
  'conflict',
  'superseded',
  'summarized',
];

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机记忆集合 + 随机查询文本
//
// - 记忆条数 ∈ [0, 10]：覆盖空集合与中等规模
// - 每条记忆随机 status（五类等概率）+ 随机 content（中文池）
// - 查询文本也从中文池中选，保证有命中（不影响不变量本身，仅保证 retrieve 走打分路径）
// - 用 seed 构造确定性 Random，保证 glados 失败重放可复现
// ──────────────────────────────────────────────────────────────────────────

class _MemoryRow {
  final String id;
  final String status;
  final String content;
  const _MemoryRow(this.id, this.status, this.content);
  @override
  String toString() => '_MemoryRow($id, $status)';
}

class _ActiveFilterCase {
  final List<_MemoryRow> rows;
  final String queryText;
  const _ActiveFilterCase(this.rows, this.queryText);
  @override
  String toString() =>
      '_ActiveFilterCase(n=${rows.length}, q=$queryText)';
}

extension on Any {
  Generator<_ActiveFilterCase> get activeFilterCases {
    return combine2<int, int, _ActiveFilterCase>(
      intInRange(0, 1 << 30), // Random 种子
      intInRange(0, 11), // 记忆条数 [0, 10]
      (seed, rowCount) {
        final rng = math.Random(seed);
        // 中文内容池，保证 CJK bigram token（_tokenize 走 CJK bigram）
        const pool = ['用户喜欢猫', '用户喜欢狗', '用户单身', '用户结婚', '看电影', '吃辣'];
        if (rowCount == 0) {
          return const _ActiveFilterCase([], '用户喜欢猫');
        }
        final rows = <_MemoryRow>[];
        for (var i = 0; i < rowCount; i++) {
          final status = _statusPool[rng.nextInt(_statusPool.length)];
          final content = pool[rng.nextInt(pool.length)];
          rows.add(_MemoryRow('mem-$i', status, content));
        }
        final query = pool[rng.nextInt(pool.length)];
        return _ActiveFilterCase(rows, query);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 26: retrieveRelevantMemories 仅返回 active 记忆', () {
    Glados<_ActiveFilterCase>(
      any.activeFilterCases,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 status 分布的记忆集合下，retrieveRelevantMemories 仅返回 status=active 的记忆',
      (c) async {
        final db = _createTestDb();
        addTearDown(db.close);
        await _seedCharacter(db);

        for (final r in c.rows) {
          await db.into(db.memories).insert(
                MemoriesCompanion.insert(
                  id: r.id,
                  characterId: _charId,
                  category: '基础信息',
                  content: r.content,
                  status: Value(r.status),
                  createdAt: Value(DateTime(2026, 1, 1)),
                  updatedAt: Value(DateTime(2026, 1, 1)),
                ),
              );
        }

        final engine = MemoryEngine(db, LlmService());
        final retrieved = await engine.retrieveRelevantMemories(
          queryText: c.queryText,
          characterId: _charId,
        );

        // 核心不变量：返回的记忆 status 全为 'active'
        for (final m in retrieved) {
          expect(m.status, 'active',
              reason: 'retrieveRelevantMemories 返回了 status=${m.status} 的记忆'
                  '（id=${m.id}），应仅返回 active');
        }

        // 辅助不变量：总数 ≤ maxMemories(30) 时，所有 active 记忆都应被返回
        // （rowCount ≤ 10 << 30，走「全量返回」分支，无 TF-IDF 裁剪）
        final activeRows =
            c.rows.where((r) => r.status == 'active').toList();
        final retrievedIds = retrieved.map((m) => m.id).toSet();
        for (final r in activeRows) {
          expect(retrievedIds.contains(r.id), isTrue,
              reason: '${r.id} status=active 应被 retrieveRelevantMemories 返回');
        }
      },
    );
  });
}
