// Feature: flutter-parity-completion, Property 14: resetExtraction round-trip
// **Validates: Requirements 7.2, 7.3**
//
// 通过 `package:glados` 生成对话内 assistant 消息集合（混合 `memory_extracted`
// 标记），覆盖以下三条性质：
// - R7.2 reset：执行后所有目标 metadata 不再包含 `memory_extracted` 字段，
//   且 `affectedCount == |M_e ∩ targets|`（被实际清理的标记数）。
// - R7.3 mark：执行后所有目标 metadata `memory_extracted == true`，
//   且 `affectedCount == |targets \ M_e|`（被实际写入的新增数）。
// - 幂等：连续两次同 action 的第二次 `affectedCount == 0`。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/conversation_provider.dart';

import '../../_helpers/generators.dart';

/// 创建内存数据库
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 预先创建 character + conversation + 多条 assistant 消息
///
/// `preMarked[i]` 为 true 时第 i 条消息的 metadata 写入 `memory_extracted=true`。
Future<void> _seedConversation(
  AppDatabase db, {
  required String characterId,
  required String conversationId,
  required List<bool> preMarked,
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: characterId,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );

  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: conversationId,
          characterId: characterId,
          title: const Value('测试对话'),
          ignoreMemory: const Value(0),
          createdAt: Value(DateTime(2026, 1, 2)),
          updatedAt: Value(DateTime(2026, 1, 2)),
        ),
      );

  for (var i = 0; i < preMarked.length; i++) {
    final meta =
        preMarked[i] ? jsonEncode({'memory_extracted': true}) : '{}';
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 'msg-$i',
            conversationId: conversationId,
            role: 'assistant',
            content: Value('回复 $i'),
            tokenCount: const Value(10),
            seq: Value(i),
            createdAt: Value(DateTime(2026, 1, 2, 0, 0, i)),
            metadata: Value(meta),
          ),
        );
  }
}

/// 读取该对话所有 assistant 消息当前的 `memory_extracted` 标记
Future<List<bool>> _readMarks(AppDatabase db, String conversationId) async {
  final rows = await (db.select(db.messages)
        ..where((t) =>
            t.conversationId.equals(conversationId) &
            t.role.equals('assistant'))
        ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
      .get();
  return rows.map((m) {
    try {
      final parsed = jsonDecode(m.metadata);
      if (parsed is Map<String, dynamic>) {
        return parsed['memory_extracted'] == true;
      }
    } catch (_) {}
    return false;
  }).toList();
}

/// 读取目标消息的 metadata Map（用于断言「不再包含 memory_extracted 字段」）
Future<Map<String, dynamic>> _readMeta(
  AppDatabase db,
  String messageId,
) async {
  final row = await (db.select(db.messages)
        ..where((t) => t.id.equals(messageId)))
      .getSingle();
  final parsed = jsonDecode(row.metadata);
  return parsed is Map<String, dynamic> ? parsed : <String, dynamic>{};
}

void main() {
  group('Property 14: resetExtraction round-trip', () {
    Glados<List<bool>>(any.assistantPreMarkedFlags).test(
      'reset 后所有目标 metadata 不含 memory_extracted 且 affectedCount == |M_e ∩ targets|',
      (preMarked) async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        await _seedConversation(
          db,
          characterId: 'char-1',
          conversationId: 'conv-1',
          preMarked: preMarked,
        );

        final actions = ConversationActions(db);
        final result =
            await actions.resetExtraction('conv-1', action: ExtractionAction.reset);

        // affectedCount == 预先标记为 true 的条数
        final expectedAffected = preMarked.where((b) => b).length;
        expect(result.affectedCount, expectedAffected);
        expect(result.action, ExtractionAction.reset);

        // 所有目标消息当前都不应再带 memory_extracted = true
        final marks = await _readMarks(db, 'conv-1');
        expect(marks.every((b) => b == false), isTrue);

        // 进一步断言「不再包含该键」（reset 是 remove，不是置 false）
        for (var i = 0; i < preMarked.length; i++) {
          final meta = await _readMeta(db, 'msg-$i');
          expect(meta.containsKey('memory_extracted'), isFalse,
              reason: 'reset 后 memory_extracted 应被移除而非置 false');
        }
      },
    );

    Glados<List<bool>>(any.assistantPreMarkedFlags).test(
      'mark 后所有目标 memory_extracted == true 且 affectedCount == |targets \\ M_e|',
      (preMarked) async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        await _seedConversation(
          db,
          characterId: 'char-1',
          conversationId: 'conv-1',
          preMarked: preMarked,
        );

        final actions = ConversationActions(db);
        final result = await actions.resetExtraction('conv-1', action: ExtractionAction.mark);

        // affectedCount == 预先未标记的条数
        final expectedAffected = preMarked.where((b) => !b).length;
        expect(result.affectedCount, expectedAffected);
        expect(result.action, ExtractionAction.mark);

        // 所有目标消息当前都应为 true
        final marks = await _readMarks(db, 'conv-1');
        expect(marks.length, preMarked.length);
        expect(marks.every((b) => b == true), isTrue);
      },
    );

    Glados<List<bool>>(any.assistantPreMarkedFlags).test(
      '连续两次同 action（reset）的第二次 affectedCount == 0（幂等）',
      (preMarked) async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        await _seedConversation(
          db,
          characterId: 'char-1',
          conversationId: 'conv-1',
          preMarked: preMarked,
        );

        final actions = ConversationActions(db);
        await actions.resetExtraction('conv-1', action: ExtractionAction.reset);
        final second =
            await actions.resetExtraction('conv-1', action: ExtractionAction.reset);
        expect(second.affectedCount, 0);
      },
    );

    Glados<List<bool>>(any.assistantPreMarkedFlags).test(
      '连续两次同 action（mark）的第二次 affectedCount == 0（幂等）',
      (preMarked) async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        await _seedConversation(
          db,
          characterId: 'char-1',
          conversationId: 'conv-1',
          preMarked: preMarked,
        );

        final actions = ConversationActions(db);
        await actions.resetExtraction('conv-1', action: ExtractionAction.mark);
        final second =
            await actions.resetExtraction('conv-1', action: ExtractionAction.mark);
        expect(second.affectedCount, 0);
      },
    );

    // 例测：边界场景显式断言，配合属性测试形成双层保护。
    test('空对话（无 assistant 消息）reset 与 mark 均返回 0', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(
        db,
        characterId: 'char-empty',
        conversationId: 'conv-empty',
        preMarked: const <bool>[],
      );

      final actions = ConversationActions(db);
      final r1 = await actions.resetExtraction('conv-empty', action: ExtractionAction.reset);
      expect(r1.affectedCount, 0);
      final r2 = await actions.resetExtraction('conv-empty', action: ExtractionAction.mark);
      expect(r2.affectedCount, 0);
    });

    // P1-2：action 参数已从 String 改为 ExtractionAction 枚举，
    // Dart 编译期类型检查即保证合法性，之前的运行时 ArgumentError 测试已不再需要。
  });
}
