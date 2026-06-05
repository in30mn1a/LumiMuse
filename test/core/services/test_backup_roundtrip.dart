// 导出导入 round-trip 集成测试
// Feature: flutter-data-management, Property 10: 导出文件格式 round-trip
// Feature: flutter-data-management, Property 1: 角色字段 migration 向后兼容

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:drift/drift.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/backup_service.dart';

// ═══════════════════════════════════════════════════════════════
// 辅助数据生成（复用 test_backup_service.dart 中的模式）
// ═══════════════════════════════════════════════════════════════

/// 创建内存数据库用于测试
AppDatabase createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 生成测试角色数据并插入数据库，返回角色 ID
Future<String> insertTestCharacter(
  AppDatabase db, {
  required String id,
  required String name,
  String basicInfo = '基本信息',
  String otherInfo = '其他信息',
  String personality = '测试性格',
}) async {
  await db.into(db.characters).insert(
    CharactersCompanion.insert(
      id: id,
      name: Value(name),
      personality: Value(personality),
      scenario: const Value('测试场景'),
      greeting: const Value('你好'),
      exampleDialogue: const Value('示例对话'),
      systemPrompt: const Value('系统提示'),
      imageTags: const Value('标签'),
      basicInfo: Value(basicInfo),
      otherInfo: Value(otherInfo),
      sortOrder: const Value(0),
      createdAt: Value(DateTime(2026, 1, 1)),
      updatedAt: Value(DateTime(2026, 1, 1)),
    ),
  );
  return id;
}

/// 插入测试记忆
Future<void> insertTestMemory(
  AppDatabase db, {
  required String id,
  required String characterId,
  required String content,
}) async {
  await db.into(db.memories).insert(
    MemoriesCompanion.insert(
      id: id,
      characterId: characterId,
      category: 'fact',
      content: content,
      confidence: const Value(0.9),
      tags: const Value('["测试"]'),
      sourceMsgIds: const Value('[]'),
      createdAt: Value(DateTime(2026, 1, 1)),
      updatedAt: Value(DateTime(2026, 1, 1)),
    ),
  );
}

/// 插入测试对话
Future<void> insertTestConversation(
  AppDatabase db, {
  required String id,
  required String characterId,
  required String title,
}) async {
  await db.into(db.conversations).insert(
    ConversationsCompanion.insert(
      id: id,
      characterId: characterId,
      title: Value(title),
      ignoreMemory: const Value(0),
      createdAt: Value(DateTime(2026, 1, 2)),
      updatedAt: Value(DateTime(2026, 1, 2)),
    ),
  );
}

/// 插入测试消息
Future<void> insertTestMessage(
  AppDatabase db, {
  required String id,
  required String conversationId,
  required String role,
  required String content,
  required int seq,
}) async {
  await db.into(db.messages).insert(
    MessagesCompanion.insert(
      id: id,
      conversationId: conversationId,
      role: role,
      content: Value(content),
      tokenCount: const Value(10),
      seq: Value(seq),
      createdAt: Value(DateTime(2026, 1, 2, 0, 0, seq)),
      metadata: const Value('{}'),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════
// Glados 自定义生成器
// ═══════════════════════════════════════════════════════════════

extension RoundtripTestGenerators on Any {
  /// 生成角色名称（确保非空且唯一性好）
  Generator<String> get characterName {
    return intInRange(1, 10000).map((i) => '角色$i');
  }

  /// 生成 1~3 个记忆数量
  Generator<int> get memoryCount => intInRange(1, 4);

  /// 生成 1~3 个对话数量
  Generator<int> get conversationCount => intInRange(1, 4);

  /// 生成 1~4 个消息数量
  Generator<int> get messageCount => intInRange(1, 5);
}

// ═══════════════════════════════════════════════════════════════
// 测试主体
// ═══════════════════════════════════════════════════════════════

void main() {
  // **Validates: Requirements 2.6, 3.2**
  group('Property 10: 导出 version 2 格式后导入到空数据库，验证数据等价', () {
    Glados3(any.characterName, any.memoryCount, any.conversationCount,
            ExploreConfig(numRuns: 50))
        .test(
      '导出角色（含记忆和对话）后导入到空数据库，数据等价',
      (name, memCount, convCount) async {
        // ─── 源数据库：创建角色、记忆、对话和消息 ───
        final sourceDb = createTestDb();
        try {
          final charId = await insertTestCharacter(sourceDb,
              id: 'source-char-1',
              name: name,
              basicInfo: '基本信息-$name',
              otherInfo: '其他信息-$name',
              personality: '性格-$name');

          // 插入记忆
          for (int i = 0; i < memCount; i++) {
            await insertTestMemory(sourceDb,
                id: 'mem-$i', characterId: charId, content: '记忆内容$i-$name');
          }

          // 插入对话和消息
          for (int c = 0; c < convCount; c++) {
            await insertTestConversation(sourceDb,
                id: 'conv-$c', characterId: charId, title: '对话$c-$name');
            // 每个对话 2 条消息
            await insertTestMessage(sourceDb,
                id: 'msg-$c-0',
                conversationId: 'conv-$c',
                role: 'user',
                content: '用户消息$c-$name',
                seq: 0);
            await insertTestMessage(sourceDb,
                id: 'msg-$c-1',
                conversationId: 'conv-$c',
                role: 'assistant',
                content: '助手回复$c-$name',
                seq: 1);
          }

          // ─── 导出 ───
          final sourceService = BackupService(sourceDb);
          final exported = await sourceService.exportCharacterToJson(charId,
              options: const ExportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: true,
              ));

          // 验证导出格式
          expect(exported['version'], equals(2));

          // ─── 目标数据库：空数据库，导入 ───
          final targetDb = createTestDb();
          try {
            final targetService = BackupService(targetDb);
            final jsonStr = jsonEncode(exported);
            final result = await targetService.importWithOptions(jsonStr,
                options: const ImportOptions(
                  includeCharacter: true,
                  includeMemories: true,
                  includeConversations: true,
                ));

            // 验证导入统计
            expect(result.addedCount, greaterThan(0));
            expect(result.memoriesImported, equals(memCount));
            expect(result.conversationsImported, equals(convCount));
            expect(result.messagesImported, equals(convCount * 2));

            // ─── 验证数据等价 ───

            // 验证角色
            final targetChars = await targetDb.select(targetDb.characters).get();
            expect(targetChars.length, equals(1));
            final targetChar = targetChars.first;
            expect(targetChar.name, equals(name));
            expect(targetChar.basicInfo, equals('基本信息-$name'));
            expect(targetChar.otherInfo, equals('其他信息-$name'));
            expect(targetChar.personality, equals('性格-$name'));
            expect(targetChar.scenario, equals('测试场景'));
            expect(targetChar.greeting, equals('你好'));
            expect(targetChar.exampleDialogue, equals('示例对话'));
            expect(targetChar.systemPrompt, equals('系统提示'));

            // 验证记忆
            final targetMemories =
                await targetDb.select(targetDb.memories).get();
            expect(targetMemories.length, equals(memCount));
            // 验证记忆内容（按内容排序比较）
            final sourceMemContents = List.generate(
                memCount, (i) => '记忆内容$i-$name')
              ..sort();
            final targetMemContents =
                targetMemories.map((m) => m.content).toList()..sort();
            expect(targetMemContents, equals(sourceMemContents));
            // 验证记忆关联到正确的角色
            for (final mem in targetMemories) {
              expect(mem.characterId, equals(targetChar.id));
            }

            // 验证对话
            final targetConvs =
                await targetDb.select(targetDb.conversations).get();
            expect(targetConvs.length, equals(convCount));
            // 验证对话标题（按标题排序比较）
            final sourceConvTitles = List.generate(
                convCount, (c) => '对话$c-$name')
              ..sort();
            final targetConvTitles =
                targetConvs.map((c) => c.title).toList()..sort();
            expect(targetConvTitles, equals(sourceConvTitles));
            // 验证对话关联到正确的角色
            for (final conv in targetConvs) {
              expect(conv.characterId, equals(targetChar.id));
            }

            // 验证消息
            final targetMsgs = await targetDb.select(targetDb.messages).get();
            expect(targetMsgs.length, equals(convCount * 2));
            // 验证消息内容
            final sourceUserMsgs = List.generate(
                convCount, (c) => '用户消息$c-$name')
              ..sort();
            final targetUserMsgs = targetMsgs
                .where((m) => m.role == 'user')
                .map((m) => m.content)
                .toList()
              ..sort();
            expect(targetUserMsgs, equals(sourceUserMsgs));

            final sourceAssistantMsgs = List.generate(
                convCount, (c) => '助手回复$c-$name')
              ..sort();
            final targetAssistantMsgs = targetMsgs
                .where((m) => m.role == 'assistant')
                .map((m) => m.content)
                .toList()
              ..sort();
            expect(targetAssistantMsgs, equals(sourceAssistantMsgs));
          } finally {
            await targetDb.close();
          }
        } finally {
          await sourceDb.close();
        }
      },
    );
  });

  // **Validates: Requirements 1.1**
  group('Property 1: Migration 向后兼容 — basic_info/other_info 默认值', () {
    Glados(any.characterName, ExploreConfig(numRuns: 50)).test(
      '新建角色不指定 basic_info/other_info 时默认为空字符串',
      (name) async {
        final db = createTestDb();
        try {
          // 插入角色时不指定 basic_info 和 other_info（模拟 v1 升级到 v2 的场景）
          await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: 'char-migration-test',
              name: Value(name),
              personality: const Value('性格'),
              scenario: const Value('场景'),
              greeting: const Value('开场白'),
              exampleDialogue: const Value(''),
              systemPrompt: const Value(''),
              imageTags: const Value(''),
              sortOrder: const Value(0),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );

          // 查询角色，验证 basic_info 和 other_info 为空字符串
          final char = await (db.select(db.characters)
                ..where((t) => t.id.equals('char-migration-test')))
              .getSingle();

          expect(char.name, equals(name));
          expect(char.basicInfo, equals(''));
          expect(char.otherInfo, equals(''));
          // 验证其他字段不受影响
          expect(char.personality, equals('性格'));
          expect(char.scenario, equals('场景'));
          expect(char.greeting, equals('开场白'));
        } finally {
          await db.close();
        }
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════
  // 10.3 边界情况：空角色（无记忆无对话）导出导入
  // ═══════════════════════════════════════════════════════════════
  group('边界情况：空角色导出导入', () {
    test('空角色（无记忆无对话）导出后导入，角色数据正确，记忆和对话为空', () async {
      // ─── 源数据库：创建角色，不添加记忆和对话 ───
      final sourceDb = createTestDb();
      try {
        final charId = await insertTestCharacter(sourceDb,
            id: 'empty-char',
            name: '空角色',
            basicInfo: '空角色基本信息',
            otherInfo: '空角色其他信息');

        // 导出
        final sourceService = BackupService(sourceDb);
        final exported = await sourceService.exportCharacterToJson(charId,
            options: const ExportOptions(
              includeCharacter: true,
              includeMemories: true,
              includeConversations: true,
            ));

        // 验证导出数据中记忆和对话为空数组
        expect(exported['version'], equals(2));
        expect(exported.containsKey('character'), isTrue);
        expect((exported['memories'] as List).length, equals(0));
        expect((exported['conversations'] as List).length, equals(0));

        // ─── 目标数据库：导入 ───
        final targetDb = createTestDb();
        try {
          final targetService = BackupService(targetDb);
          final jsonStr = jsonEncode(exported);
          final result = await targetService.importWithOptions(jsonStr,
              options: const ImportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: true,
              ));

          // 验证导入统计
          expect(result.addedCount, equals(1)); // 只有角色
          expect(result.memoriesImported, equals(0));
          expect(result.conversationsImported, equals(0));
          expect(result.messagesImported, equals(0));

          // 验证角色数据正确
          final targetChars =
              await targetDb.select(targetDb.characters).get();
          expect(targetChars.length, equals(1));
          final targetChar = targetChars.first;
          expect(targetChar.name, equals('空角色'));
          expect(targetChar.basicInfo, equals('空角色基本信息'));
          expect(targetChar.otherInfo, equals('空角色其他信息'));
          expect(targetChar.personality, equals('测试性格'));

          // 验证记忆和对话为空
          final targetMemories =
              await targetDb.select(targetDb.memories).get();
          expect(targetMemories.length, equals(0));
          final targetConvs =
              await targetDb.select(targetDb.conversations).get();
          expect(targetConvs.length, equals(0));
          final targetMsgs =
              await targetDb.select(targetDb.messages).get();
          expect(targetMsgs.length, equals(0));
        } finally {
          await targetDb.close();
        }
      } finally {
        await sourceDb.close();
      }
    });
  });

  group('importFromJson 兼容 v2 单角色格式', () {
    test('importFromJson imports nested v2 character messages', () async {
      final sourceDb = createTestDb();
      try {
        final charId = await insertTestCharacter(
          sourceDb,
          id: 'v2-char',
          name: 'v2 单角色',
        );
        await insertTestConversation(
          sourceDb,
          id: 'v2-conv',
          characterId: charId,
          title: 'v2 对话',
        );
        await insertTestMessage(
          sourceDb,
          id: 'v2-msg-user',
          conversationId: 'v2-conv',
          role: 'user',
          content: '嵌套用户消息',
          seq: 0,
        );
        await insertTestMessage(
          sourceDb,
          id: 'v2-msg-assistant',
          conversationId: 'v2-conv',
          role: 'assistant',
          content: '嵌套助手回复',
          seq: 1,
        );

        final exported = await BackupService(sourceDb).exportCharacterToJson(
          charId,
          options: const ExportOptions(
            includeCharacter: true,
            includeMemories: true,
            includeConversations: true,
          ),
        );

        final targetDb = createTestDb();
        try {
          await BackupService(targetDb).importFromJson(jsonEncode(exported));

          final messages = await targetDb.select(targetDb.messages).get();
          expect(messages.length, equals(2));
          final contents = messages.map((m) => m.content).toSet();
          expect(contents, contains('嵌套用户消息'));
          expect(contents, contains('嵌套助手回复'));
        } finally {
          await targetDb.close();
        }
      } finally {
        await sourceDb.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 10.4 边界情况：导入同名角色跳过后记忆/对话正确关联到已有角色
  // ═══════════════════════════════════════════════════════════════
  group('边界情况：导入同名角色跳过后记忆/对话正确关联', () {
    test('导入同名角色时跳过，记忆和对话关联到已有角色 ID', () async {
      final targetDb = createTestDb();
      try {
        // ─── 目标数据库中已有角色 "Alice" ───
        await insertTestCharacter(targetDb,
            id: 'existing-alice', name: 'Alice');

        // ─── 构建导入数据：包含同名角色 "Alice" 及其记忆和对话 ───
        final importData = {
          'version': 2,
          'exported_at': DateTime.now().toIso8601String(),
          'character': {
            'id': 'original-alice',
            'name': 'Alice',
            'personality': '导入的性格',
            'scenario': '导入的场景',
            'greeting': '导入的开场白',
            'example_dialogue': '',
            'system_prompt': '',
            'image_tags': '',
            'basic_info': '导入的基本信息',
            'other_info': '导入的其他信息',
            'sort_order': 0,
            'created_at': '2026-02-01T00:00:00.000Z',
            'updated_at': '2026-02-01T00:00:00.000Z',
          },
          'memories': [
            {
              'id': 'mem-alice-1',
              'character_id': 'original-alice',
              'category': 'fact',
              'content': 'Alice 喜欢猫',
              'confidence': 0.9,
              'tags': '["宠物"]',
              'source_msg_ids': '[]',
              'created_at': '2026-02-01T00:00:00.000Z',
              'updated_at': '2026-02-01T00:00:00.000Z',
            },
            {
              'id': 'mem-alice-2',
              'character_id': 'original-alice',
              'category': 'preference',
              'content': 'Alice 喜欢蓝色',
              'confidence': 0.85,
              'tags': '["颜色"]',
              'source_msg_ids': '[]',
              'created_at': '2026-02-01T00:00:00.000Z',
              'updated_at': '2026-02-01T00:00:00.000Z',
            },
          ],
          'conversations': [
            {
              'id': 'conv-alice-1',
              'character_id': 'original-alice',
              'title': '和 Alice 的第一次对话',
              'ignore_memory': 0,
              'created_at': '2026-02-01T00:00:00.000Z',
              'updated_at': '2026-02-01T00:00:00.000Z',
              'messages': [
                {
                  'id': 'msg-alice-1',
                  'conversation_id': 'conv-alice-1',
                  'role': 'user',
                  'content': '你好 Alice',
                  'token_count': 5,
                  'seq': 0,
                  'created_at': '2026-02-01T00:00:00.000Z',
                  'metadata': '{}',
                },
                {
                  'id': 'msg-alice-2',
                  'conversation_id': 'conv-alice-1',
                  'role': 'assistant',
                  'content': '你好！很高兴认识你',
                  'token_count': 8,
                  'seq': 1,
                  'created_at': '2026-02-01T00:00:01.000Z',
                  'metadata': '{}',
                },
              ],
            },
          ],
        };

        // ─── 执行导入 ───
        final targetService = BackupService(targetDb);
        final result = await targetService.importWithOptions(
          jsonEncode(importData),
          options: const ImportOptions(
            includeCharacter: true,
            includeMemories: true,
            includeConversations: true,
          ),
        );

        // ─── 验证：角色被跳过 ───
        expect(result.skippedCount, equals(1));

        // 数据库中仍然只有一个 "Alice"
        final chars = await (targetDb.select(targetDb.characters)
              ..where((t) => t.name.equals('Alice')))
            .get();
        expect(chars.length, equals(1));
        expect(chars.first.id, equals('existing-alice'));

        // ─── 验证：记忆关联到已有角色 ID ───
        final memories = await targetDb.select(targetDb.memories).get();
        expect(memories.length, equals(2));
        for (final mem in memories) {
          expect(mem.characterId, equals('existing-alice'),
              reason: '记忆应通过 idMap 映射到已有角色 ID');
        }
        // 验证记忆内容
        final memContents = memories.map((m) => m.content).toSet();
        expect(memContents, contains('Alice 喜欢猫'));
        expect(memContents, contains('Alice 喜欢蓝色'));

        // ─── 验证：对话关联到已有角色 ID ───
        final convs = await targetDb.select(targetDb.conversations).get();
        expect(convs.length, equals(1));
        expect(convs.first.characterId, equals('existing-alice'),
            reason: '对话应通过 idMap 映射到已有角色 ID');
        expect(convs.first.title, equals('和 Alice 的第一次对话'));

        // ─── 验证：消息正确关联到新对话 ID ───
        final msgs = await targetDb.select(targetDb.messages).get();
        expect(msgs.length, equals(2));
        // 消息的 conversation_id 应该是新生成的对话 ID（不是原始的 conv-alice-1）
        for (final msg in msgs) {
          expect(msg.conversationId, equals(convs.first.id),
              reason: '消息应关联到导入后的新对话 ID');
        }
        // 验证消息内容和顺序
        final sortedMsgs = msgs.toList()
          ..sort((a, b) => a.seq.compareTo(b.seq));
        expect(sortedMsgs[0].role, equals('user'));
        expect(sortedMsgs[0].content, equals('你好 Alice'));
        expect(sortedMsgs[1].role, equals('assistant'));
        expect(sortedMsgs[1].content, equals('你好！很高兴认识你'));
      } finally {
        await targetDb.close();
      }
    });
  });
}
