// 选择性导出完整性 & 名称去重 & ID 唯一性 属性测试
// Feature: flutter-data-management, Property 3: 选择性导出数据完整性
// Feature: flutter-data-management, Property 4: 导入名称去重不变量
// Feature: flutter-data-management, Property 5: 导入 ID 重建唯一性

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:drift/drift.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/backup_service.dart';

// ═══════════════════════════════════════════════════════════════
// 辅助数据生成
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
}) async {
  await db.into(db.characters).insert(
    CharactersCompanion.insert(
      id: id,
      name: Value(name),
      personality: const Value('测试性格'),
      scenario: const Value('测试场景'),
      greeting: const Value('你好'),
      exampleDialogue: const Value('示例对话'),
      systemPrompt: const Value('系统提示'),
      imageTags: const Value('标签'),
      basicInfo: const Value('基本信息'),
      otherInfo: const Value('其他信息'),
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

/// 生成合法的角色名称（非空、无特殊字符）
extension BackupTestGenerators on Any {
  /// 生成 1~5 个记忆数量
  Generator<int> get memoryCount => intInRange(1, 6);

  /// 生成 1~3 个对话数量
  Generator<int> get conversationCount => intInRange(1, 4);

  /// 生成 1~4 个消息数量
  Generator<int> get messageCount => intInRange(1, 5);

  /// 生成角色名称（确保非空且唯一性好）
  Generator<String> get characterName {
    return intInRange(1, 10000).map((i) => '角色$i');
  }
}

// ═══════════════════════════════════════════════════════════════
// Property 3: 选择性导出数据完整性
// ═══════════════════════════════════════════════════════════════

void main() {
  // **Validates: Requirements 2.3, 2.4**
  group('Property 3: 选择性导出数据完整性', () {
    Glados2(any.memoryCount, any.conversationCount,
            ExploreConfig(numRuns: 50))
        .test(
      '导出所有选项启用时，JSON 包含角色 + 记忆 + 对话（含嵌套消息）',
      (memCount, convCount) async {
        final db = createTestDb();
        try {
          final charId = await insertTestCharacter(db,
              id: 'char-export-all', name: '导出测试角色');

          // 插入记忆
          for (int i = 0; i < memCount; i++) {
            await insertTestMemory(db,
                id: 'mem-$i', characterId: charId, content: '记忆内容$i');
          }

          // 插入对话和消息
          for (int c = 0; c < convCount; c++) {
            await insertTestConversation(db,
                id: 'conv-$c', characterId: charId, title: '对话$c');
            // 每个对话 2 条消息
            await insertTestMessage(db,
                id: 'msg-$c-0',
                conversationId: 'conv-$c',
                role: 'user',
                content: '用户消息$c',
                seq: 0);
            await insertTestMessage(db,
                id: 'msg-$c-1',
                conversationId: 'conv-$c',
                role: 'assistant',
                content: '助手回复$c',
                seq: 1);
          }

          final service = BackupService(db);

          // 导出所有选项启用（使用 exportCharacterToJson 避免文件 I/O）
          final exported = await service.exportCharacterToJson(charId,
              options: const ExportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: true,
              ));

          // 验证 version 和 exported_at
          expect(exported['version'], equals(2));
          expect(exported.containsKey('exported_at'), isTrue);

          // 验证角色数据
          expect(exported.containsKey('character'), isTrue);
          final charData = exported['character'] as Map<String, dynamic>;
          expect(charData['id'], equals(charId));
          expect(charData['name'], equals('导出测试角色'));

          // 验证记忆数据
          expect(exported.containsKey('memories'), isTrue);
          final memories = exported['memories'] as List;
          expect(memories.length, equals(memCount));
          for (final m in memories) {
            final memMap = m as Map<String, dynamic>;
            expect(memMap['character_id'], equals(charId));
          }

          // 验证对话数据（含嵌套消息）
          expect(exported.containsKey('conversations'), isTrue);
          final conversations = exported['conversations'] as List;
          expect(conversations.length, equals(convCount));
          for (final c in conversations) {
            final convMap = c as Map<String, dynamic>;
            expect(convMap['character_id'], equals(charId));
            expect(convMap.containsKey('messages'), isTrue);
            final msgs = convMap['messages'] as List;
            expect(msgs.length, equals(2));
          }
        } finally {
          await db.close();
        }
      },
    );

    Glados(any.memoryCount, ExploreConfig(numRuns: 50)).test(
      '禁用某选项时，导出 JSON 不包含该数据类型',
      (memCount) async {
        final db = createTestDb();
        try {
          final charId = await insertTestCharacter(db,
              id: 'char-partial', name: '部分导出角色');

          // 插入记忆
          for (int i = 0; i < memCount; i++) {
            await insertTestMemory(db,
                id: 'mem-p-$i', characterId: charId, content: '记忆$i');
          }

          // 插入对话
          await insertTestConversation(db,
              id: 'conv-p-0', characterId: charId, title: '对话0');
          await insertTestMessage(db,
              id: 'msg-p-0',
              conversationId: 'conv-p-0',
              role: 'user',
              content: '消息',
              seq: 0);

          final service = BackupService(db);

          // 不包含记忆
          final exported1 = await service.exportCharacterToJson(charId,
              options: const ExportOptions(
                includeCharacter: true,
                includeMemories: false,
                includeConversations: true,
              ));
          expect(exported1.containsKey('character'), isTrue);
          expect(exported1.containsKey('memories'), isFalse);
          expect(exported1.containsKey('conversations'), isTrue);

          // 不包含对话
          final exported2 = await service.exportCharacterToJson(charId,
              options: const ExportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: false,
              ));
          expect(exported2.containsKey('character'), isTrue);
          expect(exported2.containsKey('memories'), isTrue);
          expect(exported2.containsKey('conversations'), isFalse);

          // 不包含角色
          final exported3 = await service.exportCharacterToJson(charId,
              options: const ExportOptions(
                includeCharacter: false,
                includeMemories: true,
                includeConversations: true,
              ));
          expect(exported3.containsKey('character'), isFalse);
          expect(exported3.containsKey('memories'), isTrue);
          expect(exported3.containsKey('conversations'), isTrue);
        } finally {
          await db.close();
        }
      },
    );
  });

  // **Validates: Requirements 3.3**
  group('Property 4: 导入名称去重不变量', () {
    Glados(any.characterName, ExploreConfig(numRuns: 100)).test(
      '同名角色导入时跳过，idMap 正确映射到已有角色 ID',
      (name) async {
        final db = createTestDb();
        try {
          // 先插入一个已有角色
          final existingId =
              await insertTestCharacter(db, id: 'existing-char', name: name);

          // 构建导入数据：包含同名角色
          final importJson = jsonEncode({
            'version': 2,
            'exported_at': DateTime.now().toIso8601String(),
            'character': {
              'id': 'import-char-original',
              'name': name,
              'personality': '导入性格',
              'scenario': '导入场景',
              'greeting': '导入开场白',
              'example_dialogue': '',
              'system_prompt': '',
              'image_tags': '',
              'basic_info': '',
              'other_info': '',
              'sort_order': 0,
              'created_at': '2026-02-01T00:00:00.000Z',
              'updated_at': '2026-02-01T00:00:00.000Z',
            },
            'memories': [
              {
                'id': 'mem-import-1',
                'character_id': 'import-char-original',
                'category': 'fact',
                'content': '导入的记忆',
                'confidence': 0.8,
                'tags': '[]',
                'source_msg_ids': '[]',
                'created_at': '2026-02-01T00:00:00.000Z',
                'updated_at': '2026-02-01T00:00:00.000Z',
              }
            ],
            'conversations': [],
          });

          final service = BackupService(db);
          final result = await service.importWithOptions(importJson,
              options: const ImportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: true,
              ));

          // 验证：角色被跳过
          expect(result.skippedCount, greaterThanOrEqualTo(1));

          // 验证：数据库中仍然只有一个同名角色
          final chars = await (db.select(db.characters)
                ..where((t) => t.name.equals(name)))
              .get();
          expect(chars.length, equals(1));
          expect(chars.first.id, equals(existingId));

          // 验证：记忆的 character_id 映射到已有角色 ID
          final memories = await db.select(db.memories).get();
          final importedMemory =
              memories.where((m) => m.content == '导入的记忆');
          expect(importedMemory.isNotEmpty, isTrue);
          expect(importedMemory.first.characterId, equals(existingId));
        } finally {
          await db.close();
        }
      },
    );
  });

  // **Validates: Requirements 3.4**
  group('Property 5: 导入 ID 重建唯一性', () {
    Glados2(any.conversationCount, any.messageCount,
            ExploreConfig(numRuns: 50))
        .test(
      '同一批次导入中所有生成的 ID 唯一（无碰撞）',
      (convCount, msgPerConv) async {
        final db = createTestDb();
        try {
          // 先插入角色
          await insertTestCharacter(db, id: 'char-id-test', name: 'ID测试角色');

          // 构建导入数据：多个对话，每个对话多条消息
          final conversations = <Map<String, dynamic>>[];
          for (int c = 0; c < convCount; c++) {
            final messages = <Map<String, dynamic>>[];
            for (int m = 0; m < msgPerConv; m++) {
              messages.add({
                'id': 'orig-msg-$c-$m',
                'conversation_id': 'orig-conv-$c',
                'role': m % 2 == 0 ? 'user' : 'assistant',
                'content': '消息内容 $c-$m',
                'token_count': 5,
                'seq': m,
                'created_at': '2026-03-01T00:00:0$m.000Z',
                'metadata': '{}',
              });
            }
            conversations.add({
              'id': 'orig-conv-$c',
              'character_id': 'char-id-test',
              'title': '对话$c',
              'ignore_memory': 0,
              'created_at': '2026-03-01T00:00:00.000Z',
              'updated_at': '2026-03-01T00:00:00.000Z',
              'messages': messages,
            });
          }

          final importJson = jsonEncode({
            'version': 2,
            'exported_at': DateTime.now().toIso8601String(),
            'character': {
              'id': 'char-id-test',
              'name': 'ID测试角色',
              'personality': '',
              'scenario': '',
              'greeting': '',
              'example_dialogue': '',
              'system_prompt': '',
              'image_tags': '',
              'basic_info': '',
              'other_info': '',
              'sort_order': 0,
              'created_at': '2026-01-01T00:00:00.000Z',
              'updated_at': '2026-01-01T00:00:00.000Z',
            },
            'memories': [],
            'conversations': conversations,
          });

          final service = BackupService(db);
          final result = await service.importWithOptions(importJson,
              options: const ImportOptions(
                includeCharacter: true,
                includeMemories: true,
                includeConversations: true,
              ));

          // 验证：导入的对话数量正确
          expect(result.conversationsImported, equals(convCount));
          expect(result.messagesImported, equals(convCount * msgPerConv));

          // 验证：所有对话 ID 唯一
          final allConvs = await db.select(db.conversations).get();
          final convIds = allConvs.map((c) => c.id).toList();
          expect(convIds.toSet().length, equals(convIds.length),
              reason: '对话 ID 不应有重复');

          // 验证：所有消息 ID 唯一
          final allMsgs = await db.select(db.messages).get();
          final msgIds = allMsgs.map((m) => m.id).toList();
          expect(msgIds.toSet().length, equals(msgIds.length),
              reason: '消息 ID 不应有重复');

          // 验证：生成的 ID 与原始 ID 不同（确认是新生成的）
          for (final conv in allConvs) {
            expect(conv.id.startsWith('orig-'), isFalse,
                reason: '对话 ID 应为新生成的 UUID，不应保留原始 ID');
          }
          for (final msg in allMsgs) {
            expect(msg.id.startsWith('orig-'), isFalse,
                reason: '消息 ID 应为新生成的 UUID，不应保留原始 ID');
          }

          // 验证：所有 ID 互不相同（对话 ID 和消息 ID 之间也不碰撞）
          final allIds = <String>{...convIds, ...msgIds};
          expect(allIds.length, equals(convIds.length + msgIds.length),
              reason: '对话 ID 和消息 ID 之间不应有碰撞');
        } finally {
          await db.close();
        }
      },
    );
  });
}
