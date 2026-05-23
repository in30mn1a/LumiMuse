// Feature: flutter-parity-completion, Property 10 + Property 11
//
// Property 10: ignore_memory 切换持久化（**Validates: Requirements 5.2**）
//   通过内存 Drift（`AppDatabase.forTesting`）+ `package:glados` 生成对话 ID 与
//   布尔序列 `flags`，依次调用 `ConversationActions.toggleIgnoreMemory`，断言
//   每一步后查询数据库取到的 `ignoreMemory` 字段值等于 `flags[i] ? 1 : 0`。
//   该属性测试覆盖 R5.2：用户切换「忽略记忆提取」开关时 `ignore_memory`
//   字段必须立即持久化为 0 或 1（每次 toggle 都被持久化，不被中间状态污染）。
//
// Property 11: ignore_memory==1 跳过自动触发（**Validates: Requirements 5.3**）
//   按 tasks.md 7.4 推荐策略：把 `_postReplyProcessing` 的 ignore_memory 判定
//   抽出为纯函数 `ChatController.shouldSkipAutoMemoryTrigger(int)`，对该判定
//   做属性测试，断言「`ignore_memory == 1` 时返回 true（自动记忆 / 自动生图
//   全跳过）；其它值（含 0）返回 false，由原触发条件决定是否触发」。
//   这样无需 mock Riverpod / Dio / LLM 即可在 100 次迭代下覆盖 R5.3。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/chat_provider.dart';
import 'package:lumimuse/core/providers/conversation_provider.dart';

import '../../_helpers/generators.dart';

const _charId = 'char-ignore-memory';

/// 创建内存数据库 — 与同目录其它属性测试保持一致的工厂。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 预先创建 character 与 conversation 行 — 任务 7.3 显式要求的前置条件。
///
/// `conversations.character_id` 是外键，因此必须先插入 character；
/// 这里复用同一个 `_charId`，让用例内的所有对话挂在同一角色下。
Future<void> _seedCharAndConv(AppDatabase db, String conversationId) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('忽略记忆测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: conversationId,
          characterId: _charId,
          title: const Value('忽略记忆测试对话'),
          // ignoreMemory 缺省值已是 0，这里显式写出与生产逻辑保持一致
          ignoreMemory: const Value(0),
          createdAt: Value(DateTime(2026, 1, 2)),
          updatedAt: Value(DateTime(2026, 1, 2)),
        ),
      );
}

/// 读取该对话当前的 `ignore_memory` 字段值（0 或 1）。
Future<int> _readIgnoreMemory(AppDatabase db, String conversationId) async {
  final row = await (db.select(db.conversations)
        ..where((t) => t.id.equals(conversationId)))
      .getSingle();
  return row.ignoreMemory;
}

void main() {
  group('Property 10: ignore_memory 切换持久化', () {
    Glados2<String, List<bool>>(
      any.conversationId,
      any.toggleFlagsSequence,
    ).test(
      '依次 toggleIgnoreMemory 后查询返回值等于 flags[i] ? 1 : 0（每步均持久化）',
      (conversationId, flags) async {
        final db = _createTestDb();
        try {
          await _seedCharAndConv(db, conversationId);

          final actions = ConversationActions(db);

          // 初始值：未 toggle 前必须为 0（与 R5.5 默认行为一致）
          expect(
            await _readIgnoreMemory(db, conversationId),
            0,
            reason: '尚未 toggle 时 ignore_memory 应为默认值 0',
          );

          for (var i = 0; i < flags.length; i++) {
            await actions.toggleIgnoreMemory(conversationId, flags[i]);
            final actual = await _readIgnoreMemory(db, conversationId);
            final expected = flags[i] ? 1 : 0;
            expect(
              actual,
              expected,
              reason: '第 $i 步 toggle($conversationId, ${flags[i]}) 后 '
                  'ignore_memory 应为 $expected，实际为 $actual',
            );
          }
        } finally {
          await db.close();
        }
      },
    );

    // 例测：边界场景显式断言，配合属性测试形成双层保护。
    test('未 toggle 时 ignore_memory 默认为 0（边界例测）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db, 'conv-default');
      expect(await _readIgnoreMemory(db, 'conv-default'), 0);
    });

    test('单次 toggle(true) 后持久化为 1', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db, 'conv-single-true');
      final actions = ConversationActions(db);
      await actions.toggleIgnoreMemory('conv-single-true', true);
      expect(await _readIgnoreMemory(db, 'conv-single-true'), 1);
    });

    test('toggle(true) → toggle(false) 后回到 0（往返）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db, 'conv-roundtrip');
      final actions = ConversationActions(db);
      await actions.toggleIgnoreMemory('conv-roundtrip', true);
      expect(await _readIgnoreMemory(db, 'conv-roundtrip'), 1);
      await actions.toggleIgnoreMemory('conv-roundtrip', false);
      expect(await _readIgnoreMemory(db, 'conv-roundtrip'), 0);
    });

    test('连续 toggle(true) 两次保持为 1（幂等）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db, 'conv-idempotent');
      final actions = ConversationActions(db);
      await actions.toggleIgnoreMemory('conv-idempotent', true);
      await actions.toggleIgnoreMemory('conv-idempotent', true);
      expect(await _readIgnoreMemory(db, 'conv-idempotent'), 1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Property 11: ignore_memory==1 跳过自动触发
  // **Validates: Requirements 5.3**
  // ─────────────────────────────────────────────────────────────
  //
  // 测试策略（参考 tasks.md 7.4 推荐策略）：
  // - 把 `_postReplyProcessing` 中「`ignore_memory == 1` → 跳过所有自动
  //   触发」的判定抽出为纯函数 `ChatController.shouldSkipAutoMemoryTrigger(int)`，
  //   对该判定做属性测试。
  // - 这样不需要 mock Riverpod / Dio / LLM / MemoryExtractionService 等依赖。
  //   断言：仅当 `ignoreMemory == 1` 时返回 true（即跳过自动触发，等价于
  //   「`MemoryExtractionService.enqueueExtraction` 调用次数为 0」）；其它值
  //   返回 false（由原有触发条件决定）。
  // - 配合内存 Drift 例测，验证当 `conversations.ignore_memory` 字段被
  //   `toggleIgnoreMemory(true)` 持久化为 1 后，读出的字段值经
  //   `shouldSkipAutoMemoryTrigger` 判定为 true，与生产路径一致。
  group('Property 11: ignore_memory==1 跳过自动触发', () {
    Glados<int>(any.intInRange(-1000, 1001)).test(
      'shouldSkipAutoMemoryTrigger(n) 当且仅当 n == 1 时返回 true',
      (ignoreMemory) {
        final actual =
            ChatController.shouldSkipAutoMemoryTrigger(ignoreMemory);
        final expected = ignoreMemory == 1;
        expect(
          actual,
          expected,
          reason: 'shouldSkipAutoMemoryTrigger($ignoreMemory) 应为 $expected，'
              '实际为 $actual（ignore_memory == 1 时跳过自动触发，其它值由触发条件决定）',
        );
      },
    );

    // 例测 1：边界值显式断言，与属性测试形成双层保护。
    test('ignore_memory == 0 → 不跳过（由触发条件决定）', () {
      expect(ChatController.shouldSkipAutoMemoryTrigger(0), isFalse);
    });

    test('ignore_memory == 1 → 跳过自动触发', () {
      expect(ChatController.shouldSkipAutoMemoryTrigger(1), isTrue);
    });

    // 例测 2：异常值（非 0/1）一律视为「不跳过」，避免数据库脏数据导致
    // 静默失活；与设计文档一致：仅 `== 1` 跳过。
    test('ignore_memory == 2 等异常值 → 不跳过', () {
      expect(ChatController.shouldSkipAutoMemoryTrigger(2), isFalse);
      expect(ChatController.shouldSkipAutoMemoryTrigger(-1), isFalse);
      expect(ChatController.shouldSkipAutoMemoryTrigger(99), isFalse);
    });

    // 例测 3：与 toggle 持久化路径串通 —— 切换到 true 后，从数据库读出的
    // ignoreMemory 字段经判定函数应为 true，证明判定逻辑与持久化字段对齐。
    test('toggleIgnoreMemory(true) 后读库判定为「跳过」（端到端串通）',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedCharAndConv(db, 'conv-end-to-end');
      final actions = ConversationActions(db);
      await actions.toggleIgnoreMemory('conv-end-to-end', true);
      final value = await _readIgnoreMemory(db, 'conv-end-to-end');
      expect(ChatController.shouldSkipAutoMemoryTrigger(value), isTrue);

      await actions.toggleIgnoreMemory('conv-end-to-end', false);
      final value2 = await _readIgnoreMemory(db, 'conv-end-to-end');
      expect(ChatController.shouldSkipAutoMemoryTrigger(value2), isFalse);
    });
  });
}
