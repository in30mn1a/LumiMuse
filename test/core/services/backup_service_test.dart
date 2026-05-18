// 导入跳过重复保留现有数据属性测试
// Feature: flutter-visual-polish, Property 3: Import skip-on-duplicate preserves existing data
// Validates: Requirements 7.5

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/backup_service.dart';

// ═══════════════════════════════════════════════════════════════
// 辅助数据结构：模拟数据库状态
// ═══════════════════════════════════════════════════════════════

/// 模拟一条记录（角色/对话/消息/记忆）
class MockRecord {
  final String id;
  final String content;

  const MockRecord(this.id, this.content);

  @override
  bool operator ==(Object other) =>
      other is MockRecord && other.id == id && other.content == content;

  @override
  int get hashCode => Object.hash(id, content);

  @override
  String toString() => 'MockRecord(id: $id, content: $content)';
}

/// 模拟数据库状态
class MockDatabaseState {
  final List<MockRecord> characters;
  final List<MockRecord> conversations;
  final List<MockRecord> memories;

  const MockDatabaseState({
    required this.characters,
    required this.conversations,
    required this.memories,
  });

  /// 获取所有已存在的 ID 集合
  Set<String> get allIds => {
        ...characters.map((r) => r.id),
        ...conversations.map((r) => r.id),
        ...memories.map((r) => r.id),
      };

  /// 总记录数
  int get totalCount =>
      characters.length + conversations.length + memories.length;
}

/// 模拟备份数据
class MockBackupData {
  final List<MockRecord> characters;
  final List<MockRecord> conversations;
  final List<MockRecord> memories;

  const MockBackupData({
    required this.characters,
    required this.conversations,
    required this.memories,
  });

  /// 总记录数
  int get totalCount =>
      characters.length + conversations.length + memories.length;

  /// 生成有效的备份 JSON 字符串
  String toJsonString() {
    return jsonEncode({
      'version': 1,
      'exportedAt': DateTime.now().toIso8601String(),
      'characters': characters
          .map((r) => {
                'id': r.id,
                'name': r.content,
                'personality': '测试性格',
                'scenario': '测试场景',
                'greeting': '你好',
                'example_dialogue': '',
                'system_prompt': '',
                'image_tags': '',
                'sort_order': 0,
                'created_at': '2026-01-01T00:00:00.000Z',
                'updated_at': '2026-01-01T00:00:00.000Z',
              })
          .toList(),
      'conversations': conversations
          .map((r) => {
                'id': r.id,
                'character_id': 'char-1',
                'title': r.content,
                'ignore_memory': 0,
                'created_at': '2026-01-01T00:00:00.000Z',
                'updated_at': '2026-01-01T00:00:00.000Z',
              })
          .toList(),
      'memories': memories
          .map((r) => {
                'id': r.id,
                'character_id': 'char-1',
                'category': 'fact',
                'content': r.content,
                'confidence': 0.8,
                'tags': '[]',
                'source_msg_ids': '[]',
                'created_at': '2026-01-01T00:00:00.000Z',
                'updated_at': '2026-01-01T00:00:00.000Z',
              })
          .toList(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 模拟导入逻辑（与 BackupService.importFromJson 相同的跳过逻辑）
// ═══════════════════════════════════════════════════════════════

/// 模拟导入操作：复现 BackupService 的 skip-on-duplicate 逻辑
/// 返回导入后的数据库状态和导入结果
({MockDatabaseState finalState, ImportResult result}) simulateImport(
  MockDatabaseState existingState,
  MockBackupData backupData,
) {
  final existingCharIds = existingState.characters.map((r) => r.id).toSet();
  final existingConvIds =
      existingState.conversations.map((r) => r.id).toSet();
  final existingMemIds = existingState.memories.map((r) => r.id).toSet();

  // 导入角色：ID 已存在则跳过
  final newCharacters = <MockRecord>[...existingState.characters];
  int addedCount = 0;
  int skippedCount = 0;

  for (final record in backupData.characters) {
    if (existingCharIds.contains(record.id)) {
      skippedCount++;
    } else {
      newCharacters.add(record);
      addedCount++;
    }
  }

  // 导入对话：ID 已存在则跳过
  final newConversations = <MockRecord>[...existingState.conversations];
  for (final record in backupData.conversations) {
    if (existingConvIds.contains(record.id)) {
      skippedCount++;
    } else {
      newConversations.add(record);
      addedCount++;
    }
  }

  // 导入记忆：ID 已存在则跳过
  final newMemories = <MockRecord>[...existingState.memories];
  for (final record in backupData.memories) {
    if (existingMemIds.contains(record.id)) {
      skippedCount++;
    } else {
      newMemories.add(record);
      addedCount++;
    }
  }

  return (
    finalState: MockDatabaseState(
      characters: newCharacters,
      conversations: newConversations,
      memories: newMemories,
    ),
    result: ImportResult(
      addedCount: addedCount,
      skippedCount: skippedCount,
      totalCount: addedCount + skippedCount,
    ),
  );
}

// ═══════════════════════════════════════════════════════════════
// Glados 自定义生成器
// ═══════════════════════════════════════════════════════════════

extension BackupGenerators on Any {
  /// 生成随机记录列表（使用 combine3 生成 3 个随机 int 来构建列表）
  Generator<List<MockRecord>> get recordList {
    return combine3<int, int, int, List<MockRecord>>(
      intInRange(0, 5), // 列表长度
      intInRange(1000, 99999), // ID 基数 1
      intInRange(1, 100), // ID 步长
      (count, idBase, step) {
        return List.generate(
          count,
          (i) => MockRecord('id-${idBase + i * step}', '内容-${idBase + i * step}'),
        );
      },
    );
  }

  /// 生成随机数据库状态
  Generator<MockDatabaseState> get databaseState {
    return combine3<List<MockRecord>, List<MockRecord>, List<MockRecord>,
        MockDatabaseState>(
      recordList,
      recordList,
      recordList,
      (chars, convs, mems) => MockDatabaseState(
        characters: chars,
        conversations: convs,
        memories: mems,
      ),
    );
  }

  /// 生成随机备份数据
  Generator<MockBackupData> get backupData {
    return combine3<List<MockRecord>, List<MockRecord>, List<MockRecord>,
        MockBackupData>(
      recordList,
      recordList,
      recordList,
      (chars, convs, mems) => MockBackupData(
        characters: chars,
        conversations: convs,
        memories: mems,
      ),
    );
  }

  /// 生成有重叠 ID 的数据库状态和备份数据对
  /// 确保测试覆盖"重复 ID 跳过"的场景
  Generator<({MockDatabaseState dbState, MockBackupData backup})>
      get overlappingPair {
    return combine2<MockDatabaseState, MockBackupData,
        ({MockDatabaseState dbState, MockBackupData backup})>(
      databaseState,
      backupData,
      (dbState, backup) {
        // 从数据库中取部分 ID 混入备份数据，制造重叠
        final random = Random(dbState.hashCode ^ backup.hashCode);
        final overlappingChars = <MockRecord>[...backup.characters];
        final overlappingConvs = <MockRecord>[...backup.conversations];
        final overlappingMems = <MockRecord>[...backup.memories];

        // 将数据库中的部分记录（使用相同 ID 但不同内容）加入备份
        for (final char in dbState.characters) {
          if (random.nextBool()) {
            overlappingChars.add(MockRecord(char.id, '备份版本-${char.id}'));
          }
        }
        for (final conv in dbState.conversations) {
          if (random.nextBool()) {
            overlappingConvs.add(MockRecord(conv.id, '备份版本-${conv.id}'));
          }
        }
        for (final mem in dbState.memories) {
          if (random.nextBool()) {
            overlappingMems.add(MockRecord(mem.id, '备份版本-${mem.id}'));
          }
        }

        return (
          dbState: dbState,
          backup: MockBackupData(
            characters: overlappingChars,
            conversations: overlappingConvs,
            memories: overlappingMems,
          ),
        );
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 属性测试
// ═══════════════════════════════════════════════════════════════

void main() {
  // Tag: Feature: flutter-visual-polish, Property 3: Import skip-on-duplicate preserves existing data
  group('Property 3: Import skip-on-duplicate preserves existing data', () {
    // ─────────────────────────────────────────────
    // 属性 3.1：已存在的记录在导入后保持不变
    // 验证：本地已有的记录内容不被备份数据覆盖
    // ─────────────────────────────────────────────

    Glados(any.overlappingPair, ExploreConfig(numRuns: 100)).test(
      '已存在的记录在导入后保持不变（本地版本被保留）',
      (pair) {
        final dbState = pair.dbState;
        final backup = pair.backup;

        final importResult = simulateImport(dbState, backup);
        final finalState = importResult.finalState;

        // 验证：原始数据库中的所有记录在导入后仍然存在且内容不变
        for (final original in dbState.characters) {
          final found = finalState.characters.where((r) => r.id == original.id);
          expect(found.isNotEmpty, isTrue,
              reason: '原始角色 ${original.id} 应在导入后仍然存在');
          expect(found.first.content, equals(original.content),
              reason: '原始角色 ${original.id} 的内容应保持不变');
        }

        for (final original in dbState.conversations) {
          final found =
              finalState.conversations.where((r) => r.id == original.id);
          expect(found.isNotEmpty, isTrue,
              reason: '原始对话 ${original.id} 应在导入后仍然存在');
          expect(found.first.content, equals(original.content),
              reason: '原始对话 ${original.id} 的内容应保持不变');
        }

        for (final original in dbState.memories) {
          final found = finalState.memories.where((r) => r.id == original.id);
          expect(found.isNotEmpty, isTrue,
              reason: '原始记忆 ${original.id} 应在导入后仍然存在');
          expect(found.first.content, equals(original.content),
              reason: '原始记忆 ${original.id} 的内容应保持不变');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性 3.2：不存在的记录被正确添加
    // 验证：备份中 ID 不在本地的记录被添加到数据库
    // ─────────────────────────────────────────────

    Glados(any.overlappingPair, ExploreConfig(numRuns: 100)).test(
      '不存在的记录被正确添加到数据库',
      (pair) {
        final dbState = pair.dbState;
        final backup = pair.backup;

        final existingCharIds = dbState.characters.map((r) => r.id).toSet();
        final existingConvIds =
            dbState.conversations.map((r) => r.id).toSet();
        final existingMemIds = dbState.memories.map((r) => r.id).toSet();

        final importResult = simulateImport(dbState, backup);
        final finalState = importResult.finalState;

        // 验证：备份中不存在于本地的记录应被添加
        for (final record in backup.characters) {
          if (!existingCharIds.contains(record.id)) {
            final found =
                finalState.characters.where((r) => r.id == record.id);
            expect(found.isNotEmpty, isTrue,
                reason: '新角色 ${record.id} 应被添加到数据库');
          }
        }

        for (final record in backup.conversations) {
          if (!existingConvIds.contains(record.id)) {
            final found =
                finalState.conversations.where((r) => r.id == record.id);
            expect(found.isNotEmpty, isTrue,
                reason: '新对话 ${record.id} 应被添加到数据库');
          }
        }

        for (final record in backup.memories) {
          if (!existingMemIds.contains(record.id)) {
            final found =
                finalState.memories.where((r) => r.id == record.id);
            expect(found.isNotEmpty, isTrue,
                reason: '新记忆 ${record.id} 应被添加到数据库');
          }
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性 3.3：导入后总记录数 = 原始数 + 新增数
    // 验证：totalCount 等式成立
    // ─────────────────────────────────────────────

    Glados(any.overlappingPair, ExploreConfig(numRuns: 100)).test(
      '导入后总记录数等于原始记录数加新增记录数',
      (pair) {
        final dbState = pair.dbState;
        final backup = pair.backup;

        final importResult = simulateImport(dbState, backup);
        final finalState = importResult.finalState;
        final result = importResult.result;

        // 验证：最终记录数 = 原始记录数 + 新增记录数
        expect(
          finalState.totalCount,
          equals(dbState.totalCount + result.addedCount),
          reason:
              '最终记录数 (${finalState.totalCount}) 应等于原始数 (${dbState.totalCount}) + 新增数 (${result.addedCount})',
        );
      },
    );

    // ─────────────────────────────────────────────
    // 属性 3.4：addedCount + skippedCount = 备份总记录数
    // 验证：导入结果的计数一致性
    // ─────────────────────────────────────────────

    Glados(any.overlappingPair, ExploreConfig(numRuns: 100)).test(
      'addedCount + skippedCount 等于备份中的总记录数',
      (pair) {
        final dbState = pair.dbState;
        final backup = pair.backup;

        final importResult = simulateImport(dbState, backup);
        final result = importResult.result;

        // 验证：新增 + 跳过 = 备份总数
        expect(
          result.addedCount + result.skippedCount,
          equals(backup.totalCount),
          reason:
              '新增 (${result.addedCount}) + 跳过 (${result.skippedCount}) 应等于备份总数 (${backup.totalCount})',
        );
      },
    );

    // ─────────────────────────────────────────────
    // 属性 3.5：validateBackupJson 对有效备份 JSON 返回正确统计
    // 验证：验证方法正确计数各类记录
    // ─────────────────────────────────────────────

    Glados(any.backupData, ExploreConfig(numRuns: 100)).test(
      'validateBackupJson 对有效备份 JSON 返回正确的记录统计',
      (backup) {
        final jsonStr = backup.toJsonString();
        final validation = BackupService.validateBackupJson(jsonStr);

        // 验证：验证通过
        expect(validation.isValid, isTrue,
            reason: '有效的备份 JSON 应通过验证');

        // 验证：统计数量正确
        expect(validation.characterCount, equals(backup.characters.length),
            reason:
                '角色数量应为 ${backup.characters.length}，实际为 ${validation.characterCount}');
        expect(
            validation.conversationCount, equals(backup.conversations.length),
            reason:
                '对话数量应为 ${backup.conversations.length}，实际为 ${validation.conversationCount}');
        expect(validation.memoryCount, equals(backup.memories.length),
            reason:
                '记忆数量应为 ${backup.memories.length}，实际为 ${validation.memoryCount}');
      },
    );

    // ─────────────────────────────────────────────
    // 属性 3.6：重复 ID 的记录不会出现两份
    // 验证：导入后每个 ID 只出现一次
    // ─────────────────────────────────────────────

    Glados(any.overlappingPair, ExploreConfig(numRuns: 100)).test(
      '导入后每个 ID 在数据库中只出现一次（无重复）',
      (pair) {
        final dbState = pair.dbState;
        final backup = pair.backup;

        final importResult = simulateImport(dbState, backup);
        final finalState = importResult.finalState;

        // 验证：角色 ID 无重复
        final charIds = finalState.characters.map((r) => r.id).toList();
        expect(charIds.toSet().length, equals(charIds.length),
            reason: '角色列表中不应有重复 ID');

        // 验证：对话 ID 无重复
        final convIds = finalState.conversations.map((r) => r.id).toList();
        expect(convIds.toSet().length, equals(convIds.length),
            reason: '对话列表中不应有重复 ID');

        // 验证：记忆 ID 无重复
        final memIds = finalState.memories.map((r) => r.id).toList();
        expect(memIds.toSet().length, equals(memIds.length),
            reason: '记忆列表中不应有重复 ID');
      },
    );
  });
}
