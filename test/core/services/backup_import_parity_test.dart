// 任务 1.3 / 1.4 / 1.5 集成与单元测试
// 1.3 makeUniqueCharacterName 同名重命名：单测 + importWithOptions 集成
// 1.4 remapSourceMessageIds 记忆来源重映射：单测 + importWithOptions 集成
// 1.5 导入大小 100→200MB + 导出版本 1→2：常量与版本校验

import 'dart:convert';

import 'package:drift/drift.dart' show Value, driftRuntimeOptions;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/backup_service.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 构造单角色 v2 备份（含对话/消息/记忆），便于集成测试。
Map<String, dynamic> _singleCharacterBackup({
  required String characterId,
  required String characterName,
  required List<Map<String, dynamic>> conversations,
  required List<Map<String, dynamic>> memories,
}) {
  return {
    'version': 2,
    'schema_version': BackupService.currentSchemaVersion,
    'exported_at': '2026-01-01T00:00:00.000Z',
    'character': {
      'id': characterId,
      'name': characterName,
      'created_at': '2026-01-01T00:00:00.000Z',
      'updated_at': '2026-01-01T00:00:00.000Z',
    },
    'conversations': conversations,
    'memories': memories,
  };
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // 任务 1.3：makeUniqueCharacterName
  // ═══════════════════════════════════════════════════════════════
  group('makeUniqueCharacterName', () {
    test('无冲突原样返回', () {
      expect(
        BackupService.makeUniqueCharacterName({'其他角色'}, '艾莉丝'),
        equals('艾莉丝'),
      );
    });

    test('空名兜底为「导入角色」', () {
      expect(
        BackupService.makeUniqueCharacterName({'其他角色'}, ''),
        equals('导入角色'),
      );
    });

    test('单次冲突追加 (1)', () {
      expect(
        BackupService.makeUniqueCharacterName({'艾莉丝'}, '艾莉丝'),
        equals('艾莉丝 (1)'),
      );
    });

    test('连续多次冲突递增到首个不冲突后缀', () {
      final existing = <String>{'艾莉丝', '艾莉丝 (1)', '艾莉丝 (2)'};
      expect(
        BackupService.makeUniqueCharacterName(existing, '艾莉丝'),
        equals('艾莉丝 (3)'),
      );
    });

    test('空名且「导入角色」已存在时递增', () {
      final existing = <String>{'导入角色', '导入角色 (1)'};
      expect(
        BackupService.makeUniqueCharacterName(existing, ''),
        equals('导入角色 (2)'),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 任务 1.3 集成：importWithOptions 同名重命名新建独立角色
  // ═══════════════════════════════════════════════════════════════
  group('importWithOptions 同名重命名', () {
    test('同名角色不再跳过，而是追加后缀新建独立记录', () async {
      final db = _createTestDb();
      addTearDown(db.close);
      // 预置同名角色
      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: 'existing-char',
              name: const Value('艾莉丝'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );

      final backup = _singleCharacterBackup(
        characterId: 'incoming-char',
        characterName: '艾莉丝',
        conversations: const [],
        memories: const [],
      );
      final result = await BackupService(db).importWithOptions(
        jsonEncode(backup),
      );

      // 新增 1 个角色（非跳过）
      expect(result.addedCount, 1);
      expect(result.skippedCount, 0);

      final chars = await db.select(db.characters).get();
      // 原角色 + 重命名后的新角色
      expect(chars, hasLength(2));
      final names = chars.map((c) => c.name).toSet();
      expect(names, contains('艾莉丝'));
      expect(names, contains('艾莉丝 (1)'));
      // 两个角色 ID 不同
      final ids = chars.map((c) => c.id).toSet();
      expect(ids.length, 2);
    });

    test('生成的重命名角色确实写入 DB 且不与现有重名', () async {
      final db = _createTestDb();
      addTearDown(db.close);
      // 预置两个同名变体
      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: 'c0',
              name: const Value('猫娘'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );
      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: 'c1',
              name: const Value('猫娘 (1)'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );

      final backup = _singleCharacterBackup(
        characterId: 'incoming',
        characterName: '猫娘',
        conversations: const [],
        memories: const [],
      );
      await BackupService(db).importWithOptions(jsonEncode(backup));

      final chars = await db.select(db.characters).get();
      final names = chars.map((c) => c.name).toSet();
      // 新角色应递增到 (2)，不与现有重名
      expect(names, contains('猫娘 (2)'));
      expect(names.where((n) => n == '猫娘 (2)'), hasLength(1));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 任务 1.4：remapSourceMessageIds
  // ═══════════════════════════════════════════════════════════════
  group('remapSourceMessageIds', () {
    test('JSON 字符串全部映射到新消息 ID', () {
      const raw = '["old-1","old-2"]';
      const map = {'old-1': 'new-1', 'old-2': 'new-2'};
      final out = BackupService.remapSourceMessageIds(raw, map);
      expect(jsonDecode(out), equals(['new-1', 'new-2']));
    });

    test('原始 List 全部映射到新消息 ID', () {
      const raw = ['old-1', 'old-2'];
      const map = {'old-1': 'new-1', 'old-2': 'new-2'};
      final out = BackupService.remapSourceMessageIds(raw, map);
      expect(jsonDecode(out), equals(['new-1', 'new-2']));
    });

    test('无映射的旧 ID 被剔除', () {
      const raw = '["old-1","orphan","old-2"]';
      const map = {'old-1': 'new-1', 'old-2': 'new-2'};
      final out = BackupService.remapSourceMessageIds(raw, map);
      expect(jsonDecode(out), equals(['new-1', 'new-2']));
    });

    test('全部无映射时返回空数组', () {
      const raw = '["orphan-1","orphan-2"]';
      final out = BackupService.remapSourceMessageIds(raw, {});
      expect(jsonDecode(out), equals(<String>[]));
    });

    test('空映射时字段清空（targetCharacterId 场景）', () {
      const raw = '["old-1","old-2"]';
      // targetCharacterId 模式：消息属其他角色未导入，msgIdMap 为空
      final out = BackupService.remapSourceMessageIds(raw, {});
      expect(jsonDecode(out), equals(<String>[]));
    });

    test('非法 JSON 字符串返回空数组', () {
      final out = BackupService.remapSourceMessageIds('not-json', {});
      expect(jsonDecode(out), equals(<String>[]));
    });

    test('null 返回空数组', () {
      final out = BackupService.remapSourceMessageIds(null, {});
      expect(jsonDecode(out), equals(<String>[]));
    });

    test('非 String/List 类型返回空数组', () {
      final out = BackupService.remapSourceMessageIds(123, {});
      expect(jsonDecode(out), equals(<String>[]));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 任务 1.4 集成：importWithOptions 记忆 source_msg_ids 重映射
  // ═══════════════════════════════════════════════════════════════
  group('importWithOptions 记忆来源重映射', () {
    test('导入后记忆 source_msg_ids 全部映射到新消息 ID', () async {
      final db = _createTestDb();
      addTearDown(db.close);

      final backup = _singleCharacterBackup(
        characterId: 'char-src',
        characterName: '来源角色',
        conversations: [
          {
            'id': 'conv-src',
            'character_id': 'char-src',
            'title': '对话',
            'ignore_memory': 0,
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
            'messages': [
              {
                'id': 'msg-old-1',
                'conversation_id': 'conv-src',
                'role': 'user',
                'content': '你好',
                'token_count': 0,
                'seq': 0,
                'created_at': '2026-01-01T00:00:00.000Z',
                'metadata': '{}',
              },
              {
                'id': 'msg-old-2',
                'conversation_id': 'conv-src',
                'role': 'assistant',
                'content': '你好呀',
                'token_count': 0,
                'seq': 1,
                'created_at': '2026-01-01T00:00:01.000Z',
                'metadata': '{}',
              },
            ],
          },
        ],
        memories: [
          {
            'id': 'mem-src',
            'character_id': 'char-src',
            'category': '关系动态',
            'content': '用户打过招呼',
            'confidence': 0.8,
            'tags': '[]',
            'source_msg_ids': '["msg-old-1","msg-old-2"]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          },
        ],
      );

      await BackupService(db).importWithOptions(jsonEncode(backup));

      // 取新消息 ID
      final msgs = await db.select(db.messages).get();
      expect(msgs, hasLength(2));
      final newMsgIds = msgs.map((m) => m.id).toSet();

      // 取记忆，校验 source_msg_ids 已映射到新消息 ID
      final mems = await db.select(db.memories).get();
      expect(mems, hasLength(1));
      final srcIds = (jsonDecode(mems.single.sourceMsgIds) as List)
          .cast<String>();
      expect(srcIds.length, 2);
      // 全部命中新消息 ID，且不含任何旧 ID
      for (final id in srcIds) {
        expect(newMsgIds.contains(id), isTrue, reason: '应映射到新消息 ID: $id');
      }
      expect(srcIds.contains('msg-old-1'), isFalse);
      expect(srcIds.contains('msg-old-2'), isFalse);
    });

    test('记忆 source_msg_ids 中无映射的旧 ID 被剔除', () async {
      final db = _createTestDb();
      addTearDown(db.close);

      final backup = _singleCharacterBackup(
        characterId: 'char-orphan',
        characterName: '孤儿来源',
        conversations: [
          {
            'id': 'conv-orphan',
            'character_id': 'char-orphan',
            'title': '对话',
            'ignore_memory': 0,
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
            'messages': [
              {
                'id': 'msg-kept',
                'conversation_id': 'conv-orphan',
                'role': 'user',
                'content': '保留',
                'token_count': 0,
                'seq': 0,
                'created_at': '2026-01-01T00:00:00.000Z',
                'metadata': '{}',
              },
            ],
          },
        ],
        memories: [
          {
            'id': 'mem-orphan',
            'character_id': 'char-orphan',
            'category': '关系动态',
            'content': '混合来源',
            'confidence': 0.8,
            'tags': '[]',
            // msg-kept 会映射；msg-gone 无对应消息应被丢弃
            'source_msg_ids': '["msg-kept","msg-gone"]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          },
        ],
      );

      await BackupService(db).importWithOptions(jsonEncode(backup));

      final mems = await db.select(db.memories).get();
      expect(mems, hasLength(1));
      final srcIds = (jsonDecode(mems.single.sourceMsgIds) as List)
          .cast<String>();
      expect(srcIds, hasLength(1));
      expect(srcIds.contains('msg-gone'), isFalse);
      expect(srcIds.contains('msg-kept'), isFalse,
          reason: '旧 ID 不应残留，应只剩映射后的新 ID');
    });

    test('targetCharacterId 模式下消息属其他角色、映射为空时 source 清空',
            () async {
      final db = _createTestDb();
      addTearDown(db.close);
      // 预置目标角色
      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: 'target-char',
              name: const Value('目标角色'),
              createdAt: Value(DateTime(2026, 1, 1)),
              updatedAt: Value(DateTime(2026, 1, 1)),
            ),
          );

      // 备份只含记忆，不含对话/消息 → msgIdMap 为空 → source 应清空
      final backup = _singleCharacterBackup(
        characterId: 'other-char',
        characterName: '其他角色',
        conversations: const [],
        memories: [
          {
            'id': 'mem-other',
            'character_id': 'other-char',
            'category': '基础信息',
            'content': '无来源记忆',
            'confidence': 0.8,
            'tags': '[]',
            'source_msg_ids': '["msg-x","msg-y"]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          },
        ],
      );

      await BackupService(db).importWithOptions(
        jsonEncode(backup),
        targetCharacterId: 'target-char',
      );

      final mems = await db.select(db.memories).get();
      expect(mems, hasLength(1));
      final srcIds = (jsonDecode(mems.single.sourceMsgIds) as List)
          .cast<String>();
      expect(srcIds, isEmpty, reason: '无消息导入时 source_msg_ids 应清空');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 任务 1.5：导入大小 100→200MB + 导出版本 1→2
  // ═══════════════════════════════════════════════════════════════
  group('导入大小与版本常量', () {
    test('maxImportFileSize 为 200MB', () {
      expect(maxImportFileSize, equals(200 * 1024 * 1024));
    });

    test('currentFullBackupVersion 为 2', () {
      expect(BackupService.currentFullBackupVersion, equals(2));
    });

    test('checkFileSize 在 200MB 以内通过', () {
      expect(BackupService.checkFileSize(200 * 1024 * 1024), isNull);
    });

    test('checkFileSize 超过 200MB 提示 200MB', () {
      final msg = BackupService.checkFileSize(201 * 1024 * 1024);
      expect(msg, isNotNull);
      expect(msg, contains('200MB'));
      // 确保旧 100MB 文案不再出现
      expect(msg!.contains('100MB'), isFalse);
    });

    test('validateBackupJson 接受 v1 旧备份', () {
      final v1 = {
        'version': 1,
        'exported_at': '2026-01-01T00:00:00.000Z',
        'characters': <Map<String, dynamic>>[],
        'conversations': <Map<String, dynamic>>[],
        'memories': <Map<String, dynamic>>[],
      };
      final result = BackupService.validateBackupJson(jsonEncode(v1));
      expect(result.isValid, isTrue);
    });

    test('validateBackupJson 接受 v2 备份', () {
      final v2 = {
        'version': 2,
        'schema_version': BackupService.currentSchemaVersion,
        'exported_at': '2026-01-01T00:00:00.000Z',
        'character': {
          'id': 'c1',
          'name': '角色',
          'created_at': '2026-01-01T00:00:00.000Z',
          'updated_at': '2026-01-01T00:00:00.000Z',
        },
        'conversations': <Map<String, dynamic>>[],
        'memories': <Map<String, dynamic>>[],
      };
      final result = BackupService.validateBackupJson(jsonEncode(v2));
      expect(result.isValid, isTrue);
    });

    test('validateBackupJson 拒绝 v3 未来版本', () {
      final v3 = {
        'version': 3,
        'exported_at': '2026-01-01T00:00:00.000Z',
        'characters': <Map<String, dynamic>>[],
        'conversations': <Map<String, dynamic>>[],
        'memories': <Map<String, dynamic>>[],
      };
      final result = BackupService.validateBackupJson(jsonEncode(v3));
      expect(result.isValid, isFalse);
      expect(result.errorMessage, contains('version'));
    });
  });
}
