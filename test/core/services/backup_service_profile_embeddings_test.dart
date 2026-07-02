// Wave 15.1-A：profiles / versions / embeddings 扩展导出导入测试
// 对齐主项目 src/app/api/export/route.ts 和 import/route.ts 的 5 选项 + 3 张扩展表。
// 覆盖场景：全量往返、含 embeddings 往返、单角色往返、主项目 Buffer 格式兼容、
// 单角色 memory_profile 单数格式兼容、5 选项过滤、孤儿 embedding 跳过。

import 'dart:convert';

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/backup_service.dart';

// ─────────────────────────────────────────────────────────────
// 测试辅助
// ─────────────────────────────────────────────────────────────

const _charId = 'char-test-1';
const _memId = 'mem-test-1';
const _nowIso = '2026-06-15T10:00:00.000Z';

AppDatabase createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> insertCharacter(
  AppDatabase db, {
  String id = _charId,
  String name = '测试角色',
}) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: Value(name),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

Future<void> insertMemory(
  AppDatabase db, {
  String id = _memId,
  String characterId = _charId,
  String content = '测试记忆内容',
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: characterId,
          category: 'fact',
          content: content,
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

Future<void> insertProfile(
  AppDatabase db, {
  String characterId = _charId,
  String profileName = '画像名',
  String relationshipState = '朋友',
  String openThreads = '["话题A","话题B"]',
}) async {
  await db.into(db.characterMemoryProfiles).insert(
        CharacterMemoryProfilesCompanion.insert(
          characterId: characterId,
          profileName: Value(profileName),
          relationshipState: Value(relationshipState),
          recentStoryState: const Value('最近故事'),
          emotionalBaseline: const Value('情绪基线'),
          openThreads: Value(openThreads),
          userProfileSummary: const Value('用户摘要'),
          pinnedSummary: const Value('置顶摘要'),
          updatedAt: Value(DateTime.parse(_nowIso)),
        ),
      );
}

Future<int> insertProfileVersion(
  AppDatabase db, {
  String characterId = _charId,
  int versionNumber = 1,
  String snapshotJson = '{"snapshot":"v1"}',
  String reason = 'initial',
  int? taskId,
}) async {
  return await db.into(db.characterMemoryProfileVersions).insert(
        CharacterMemoryProfileVersionsCompanion.insert(
          characterId: characterId,
          versionNumber: versionNumber,
          snapshotJson: snapshotJson,
          reason: reason,
          taskId: Value(taskId),
          createdAt: Value(DateTime.parse(_nowIso)),
        ),
      );
}

Future<int> insertEmbedding(
  AppDatabase db, {
  String memoryId = _memId,
  String characterId = _charId,
  String provider = 'openai-compatible',
  String model = 'text-embedding-3-small',
  int dimension = 4,
  List<int> blob = const [0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 128, 64],
  int normalized = 1,
  String textHash = 'hash-abc',
  String status = 'ready',
  String? errorMessage,
}) async {
  return await db.into(db.memoryEmbeddings).insert(
        MemoryEmbeddingsCompanion.insert(
          memoryId: memoryId,
          characterId: characterId,
          provider: provider,
          model: model,
          dimension: dimension,
          embeddingBlob: Uint8List.fromList(blob),
          normalized: Value(normalized),
          embeddingTextHash: textHash,
          status: Value(status),
          errorMessage: Value(errorMessage),
          createdAt: Value(DateTime.parse(_nowIso)),
          updatedAt: Value(DateTime.parse(_nowIso)),
        ),
      );
}

// ─────────────────────────────────────────────────────────────
// 测试主体
// ─────────────────────────────────────────────────────────────

void main() {
  // ── 场景 1：全量导出/导入往返（默认：含 profiles，不含 embeddings）───
  test('全量导出默认含 profiles 不含 embeddings，导入后数据一致', () async {
    final sourceDb = createTestDb();
    try {
      await insertCharacter(sourceDb);
      await insertMemory(sourceDb);
      await insertProfile(sourceDb);
      await insertProfileVersion(sourceDb, versionNumber: 1);
      await insertProfileVersion(sourceDb, versionNumber: 2, reason: 'patch');
      // ready embedding — 默认不导出
      await insertEmbedding(sourceDb, status: 'ready');
      // failed embedding — 即使开 includeEmbeddings 也不导出
      // 用不同 model 避开唯一索引 (memory_id, provider, model, dimension)
      await insertEmbedding(
          sourceDb, status: 'failed', textHash: 'hash-fail', model: 'other-model');

      final service = BackupService(sourceDb);
      // 默认 options：includeProfiles=true, includeEmbeddings=false
      final jsonStr = await service.exportToJson();
      final data = jsonDecode(jsonStr) as Map<String, dynamic>;

      // 验证默认导出含 memory_profiles + memory_profile_versions
      expect(data.containsKey('memory_profiles'), isTrue);
      expect(data.containsKey('memory_profile_versions'), isTrue);
      expect((data['memory_profiles'] as List).length, equals(1));
      expect((data['memory_profile_versions'] as List).length, equals(2));
      // 验证默认不含 memory_embeddings
      expect(data.containsKey('memory_embeddings'), isFalse);

      // 导入到新空库
      final targetDb = createTestDb();
      try {
        final targetService = BackupService(targetDb);
        final result = await targetService.importFromJson(jsonStr);

        // 验证导入统计
        expect(result.profilesImported, equals(1));
        expect(result.profileVersionsImported, equals(2));
        expect(result.embeddingsImported, equals(0));
        expect(result.memoriesImported, equals(1));

        // 验证画像字段一致
        final profiles = await targetDb.select(targetDb.characterMemoryProfiles).get();
        expect(profiles.length, equals(1));
        expect(profiles.first.profileName, equals('画像名'));
        expect(profiles.first.relationshipState, equals('朋友'));
        expect(profiles.first.openThreads, equals('["话题A","话题B"]'));
        // 用毫秒比较避免 UTC / 本地时区差异导致 DateTime == 失败
        expect(
          profiles.first.updatedAt.millisecondsSinceEpoch,
          equals(DateTime.parse(_nowIso).millisecondsSinceEpoch),
        );

        // 验证画像版本
        final versions = await targetDb
            .select(targetDb.characterMemoryProfileVersions)
            .get();
        expect(versions.length, equals(2));
        expect(versions[0].versionNumber, equals(1));
        expect(versions[0].reason, equals('initial'));
        expect(versions[1].versionNumber, equals(2));
        expect(versions[1].reason, equals('patch'));

        // 验证 embedding 表为空（默认不导入）
        final embeddings = await targetDb.select(targetDb.memoryEmbeddings).get();
        expect(embeddings.length, equals(0));
      } finally {
        await targetDb.close();
      }
    } finally {
      await sourceDb.close();
    }
  });

  // ── 场景 2：含 embeddings 导出/导入往返 ───────────────────
  test('含 embeddings 导出导入往返，只导出 ready 状态', () async {
    final sourceDb = createTestDb();
    try {
      await insertCharacter(sourceDb);
      await insertMemory(sourceDb);
      await insertEmbedding(sourceDb, status: 'ready', textHash: 'hash-ready');
      // 用不同 model 避开唯一索引 (memory_id, provider, model, dimension)
      await insertEmbedding(
          sourceDb, status: 'failed', textHash: 'hash-fail', model: 'other-model');

      final service = BackupService(sourceDb);
      final jsonStr = await service.exportToJson(
        options: const ExportOptions(includeEmbeddings: true),
      );
      final data = jsonDecode(jsonStr) as Map<String, dynamic>;

      // 验证 memory_embeddings 只含 ready 那条
      expect(data.containsKey('memory_embeddings'), isTrue);
      final embeddings = data['memory_embeddings'] as List;
      expect(embeddings.length, equals(1));
      expect((embeddings[0] as Map)['status'], equals('ready'));
      expect((embeddings[0] as Map)['embedding_text_hash'], equals('hash-ready'));

      // 导入到新空库
      final targetDb = createTestDb();
      try {
        final targetService = BackupService(targetDb);
        final result = await targetService.importFromJson(
          jsonStr,
          options: const ImportOptions(includeEmbeddings: true),
        );

        expect(result.embeddingsImported, equals(1));
        expect(result.profilesImported, equals(0)); // 没有画像

        // 验证 embedding 表只有 1 条 ready
        final rows = await targetDb.select(targetDb.memoryEmbeddings).get();
        expect(rows.length, equals(1));
        expect(rows.first.status, equals('ready'));
        expect(rows.first.embeddingTextHash, equals('hash-ready'));
        // 验证 blob 还原正确
        expect(
          rows.first.embeddingBlob,
          equals(Uint8List.fromList(
              [0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 128, 64])),
        );
        expect(rows.first.provider, equals('openai-compatible'));
        expect(rows.first.dimension, equals(4));
      } finally {
        await targetDb.close();
      }
    } finally {
      await sourceDb.close();
    }
  });

  // ── 场景 3：单角色导出/导入往返 ───────────────────────────
  test('单角色导出导入往返，含 profile + version + embedding', () async {
    final sourceDb = createTestDb();
    try {
      await insertCharacter(sourceDb);
      await insertMemory(sourceDb);
      await insertProfile(sourceDb);
      await insertProfileVersion(sourceDb, versionNumber: 1);
      await insertEmbedding(sourceDb, status: 'ready');

      final service = BackupService(sourceDb);
      final exportData = await service.exportCharacterToJson(
        _charId,
        options: const ExportOptions(
          includeProfiles: true,
          includeEmbeddings: true,
        ),
      );

      // 验证单角色格式：memory_profile 单数 + memory_profile_versions + memory_embeddings
      expect(exportData.containsKey('memory_profile'), isTrue);
      expect(exportData['memory_profile'], isA<Map>());
      expect(exportData.containsKey('memory_profile_versions'), isTrue);
      expect((exportData['memory_profile_versions'] as List).length, equals(1));
      expect(exportData.containsKey('memory_embeddings'), isTrue);
      expect((exportData['memory_embeddings'] as List).length, equals(1));

      final jsonStr = jsonEncode(exportData);

      // 导入到新库：先手动插入 character + memory（importFromJson 用原 ID）
      final targetDb = createTestDb();
      try {
        final targetService = BackupService(targetDb);
        final result = await targetService.importFromJson(
          jsonStr,
          options: const ImportOptions(
            includeProfiles: true,
            includeEmbeddings: true,
          ),
        );

        // 验证导入统计
        expect(result.profilesImported, equals(1));
        expect(result.profileVersionsImported, equals(1));
        expect(result.embeddingsImported, equals(1));

        // 验证画像
        final profiles = await targetDb.select(targetDb.characterMemoryProfiles).get();
        expect(profiles.length, equals(1));
        expect(profiles.first.characterId, equals(_charId));

        // 验证画像版本
        final versions = await targetDb
            .select(targetDb.characterMemoryProfileVersions)
            .get();
        expect(versions.length, equals(1));
        expect(versions.first.versionNumber, equals(1));

        // 验证 embedding
        final embeddings = await targetDb.select(targetDb.memoryEmbeddings).get();
        expect(embeddings.length, equals(1));
        expect(embeddings.first.memoryId, equals(_memId));
        expect(embeddings.first.characterId, equals(_charId));
      } finally {
        await targetDb.close();
      }
    } finally {
      await sourceDb.close();
    }
  });

  // ── 场景 4：主项目格式兼容（{type:'Buffer', data:[...]}）────────
  test('主项目 Buffer 格式 embedding_blob 可正确导入', () async {
    final targetDb = createTestDb();
    try {
      await insertCharacter(targetDb);
      await insertMemory(targetDb);

      // 手工构造主项目格式备份 JSON
      final backupData = {
        'version': 2,
        'exported_at': _nowIso,
        'characters': [
          {
            'id': _charId,
            'name': '测试角色',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'conversations': [],
        'memories': [
          {
            'id': _memId,
            'character_id': _charId,
            'category': 'fact',
            'content': '记忆内容',
            'confidence': 0.8,
            'tags': '[]',
            'source_msg_ids': '[]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'memory_embeddings': [
          {
            'id': 1,
            'memory_id': _memId,
            'character_id': _charId,
            'provider': 'openai-compatible',
            'model': 'text-embedding-3-small',
            'dimension': 2,
            // 主项目 better-sqlite3 Buffer 格式
            'embedding_blob': {
              'type': 'Buffer',
              'data': [0, 0, 128, 63, 0, 0, 0, 64],
            },
            'normalized': 1,
            'embedding_text_hash': 'hash-buffer',
            'status': 'ready',
            'error_message': null,
            'created_at': _nowIso,
            'updated_at': _nowIso,
          }
        ],
      };

      final jsonStr = jsonEncode(backupData);
      final service = BackupService(targetDb);

      // importFromJson 用原 ID，但 character + memory 已存在会被跳过
      // embedding 仍应导入（memoryIdMap 是恒等映射）
      final result = await service.importFromJson(
        jsonStr,
        options: const ImportOptions(includeEmbeddings: true),
      );

      expect(result.embeddingsImported, equals(1));

      final embeddings = await targetDb.select(targetDb.memoryEmbeddings).get();
      expect(embeddings.length, equals(1));
      // 验证 Buffer 格式正确还原为 Uint8List
      expect(
        embeddings.first.embeddingBlob,
        equals(Uint8List.fromList([0, 0, 128, 63, 0, 0, 0, 64])),
      );
      expect(embeddings.first.embeddingTextHash, equals('hash-buffer'));
      expect(embeddings.first.dimension, equals(2));
    } finally {
      await targetDb.close();
    }
  });

  // ── 场景 5：单角色格式兼容（memory_profile 单数字段）──────────
  test('单角色 memory_profile 单数格式可正确导入画像', () async {
    final targetDb = createTestDb();
    try {
      await insertCharacter(targetDb);
      await insertMemory(targetDb);

      // 手工构造 v2 单角色备份，含 memory_profile（单个对象）
      final backupData = {
        'version': 2,
        'exported_at': _nowIso,
        'character': {
          'id': _charId,
          'name': '测试角色',
          'created_at': '2026-01-01T00:00:00.000Z',
          'updated_at': '2026-01-01T00:00:00.000Z',
        },
        'memories': [
          {
            'id': _memId,
            'character_id': _charId,
            'category': 'fact',
            'content': '记忆内容',
            'confidence': 0.8,
            'tags': '[]',
            'source_msg_ids': '[]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'conversations': [],
        // 单角色格式：memory_profile 是单个对象（非数组）
        'memory_profile': {
          'character_id': _charId,
          'profile_name': '单角色画像',
          'relationship_state': '恋人',
          'recent_story_state': '故事',
          'emotional_baseline': '开心',
          'open_threads': '["线程1"]',
          'user_profile_summary': '用户',
          'pinned_summary': '置顶',
          'updated_at': _nowIso,
        },
        'memory_profile_versions': [
          {
            'id': 1,
            'character_id': _charId,
            'version_number': 1,
            'snapshot_json': '{"v":1}',
            'reason': 'initial',
            'task_id': null,
            'created_at': _nowIso,
          }
        ],
      };

      final jsonStr = jsonEncode(backupData);
      final service = BackupService(targetDb);

      final result = await service.importFromJson(
        jsonStr,
        options: const ImportOptions(includeProfiles: true),
      );

      expect(result.profilesImported, equals(1));
      expect(result.profileVersionsImported, equals(1));

      // 验证画像写入
      final profiles = await targetDb.select(targetDb.characterMemoryProfiles).get();
      expect(profiles.length, equals(1));
      expect(profiles.first.profileName, equals('单角色画像'));
      expect(profiles.first.relationshipState, equals('恋人'));
      expect(profiles.first.openThreads, equals('["线程1"]'));

      // 验证画像版本写入
      final versions = await targetDb
          .select(targetDb.characterMemoryProfileVersions)
          .get();
      expect(versions.length, equals(1));
      expect(versions.first.versionNumber, equals(1));
      expect(versions.first.reason, equals('initial'));
    } finally {
      await targetDb.close();
    }
  });

  // ── 场景 6：5 选项过滤测试 ─────────────────────────────────
  test('ExportOptions.includeProfiles=false 不导出画像；ImportOptions.includeProfiles=false 不导入', () async {
    final sourceDb = createTestDb();
    try {
      await insertCharacter(sourceDb);
      await insertMemory(sourceDb);
      await insertProfile(sourceDb);
      await insertProfileVersion(sourceDb);

      final service = BackupService(sourceDb);

      // 导出时排除 profiles
      final jsonStr = await service.exportToJson(
        options: const ExportOptions(includeProfiles: false),
      );
      final data = jsonDecode(jsonStr) as Map<String, dynamic>;

      // 验证不含 memory_profiles / memory_profile_versions
      expect(data.containsKey('memory_profiles'), isFalse);
      expect(data.containsKey('memory_profile_versions'), isFalse);

      // 导入时即使 JSON 没有画像也不应报错
      final targetDb = createTestDb();
      try {
        final targetService = BackupService(targetDb);
        final result = await targetService.importFromJson(jsonStr);

        expect(result.profilesImported, equals(0));
        expect(result.profileVersionsImported, equals(0));

        final profiles = await targetDb.select(targetDb.characterMemoryProfiles).get();
        expect(profiles.length, equals(0));
      } finally {
        await targetDb.close();
      }

      // 再测：导出含 profiles，但导入时 includeProfiles=false
      final jsonStrWithProfiles = await service.exportToJson();
      final dataWith = jsonDecode(jsonStrWithProfiles) as Map<String, dynamic>;
      expect(dataWith.containsKey('memory_profiles'), isTrue);

      final targetDb2 = createTestDb();
      try {
        final targetService2 = BackupService(targetDb2);
        final result2 = await targetService2.importFromJson(
          jsonStrWithProfiles,
          options: const ImportOptions(includeProfiles: false),
        );

        expect(result2.profilesImported, equals(0));
        final profiles = await targetDb2.select(targetDb2.characterMemoryProfiles).get();
        expect(profiles.length, equals(0));
      } finally {
        await targetDb2.close();
      }
    } finally {
      await sourceDb.close();
    }
  });

  // ── 场景 7：孤儿 embedding 跳过 ───────────────────────────
  test('embedding 的 memory_id 在备份 memories 中不存在时跳过', () async {
    final targetDb = createTestDb();
    try {
      // 只插入 character，不插入 memory
      await insertCharacter(targetDb);

      // 构造 JSON：memory_embeddings 引用了一个不在 memories 数组里的 memory_id
      final backupData = {
        'version': 2,
        'exported_at': _nowIso,
        'characters': [
          {
            'id': _charId,
            'name': '测试角色',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'conversations': [],
        'memories': [], // 空数组 — 没有记忆
        'memory_embeddings': [
          {
            'id': 1,
            'memory_id': 'nonexistent-mem-id', // 孤儿 memory_id
            'character_id': _charId,
            'provider': 'openai-compatible',
            'model': 'text-embedding-3-small',
            'dimension': 4,
            'embedding_blob': [0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 128, 64],
            'normalized': 1,
            'embedding_text_hash': 'hash-orphan',
            'status': 'ready',
            'error_message': null,
            'created_at': _nowIso,
            'updated_at': _nowIso,
          }
        ],
      };

      final jsonStr = jsonEncode(backupData);
      final service = BackupService(targetDb);

      final result = await service.importFromJson(
        jsonStr,
        options: const ImportOptions(includeEmbeddings: true),
      );

      // embedding 应被跳过（memoryIdMap 无映射）
      expect(result.embeddingsImported, equals(0));
      final embeddings = await targetDb.select(targetDb.memoryEmbeddings).get();
      expect(embeddings.length, equals(0));
    } finally {
      await targetDb.close();
    }
  });

  // ── 额外：画像 UPSERT 重复导入不报错 ──────────────────────
  test('画像重复导入走 UPSERT 不报错，版本号冲突跳过', () async {
    final targetDb = createTestDb();
    try {
      await insertCharacter(targetDb);
      await insertMemory(targetDb);

      final backupData = {
        'version': 2,
        'exported_at': _nowIso,
        'characters': [
          {
            'id': _charId,
            'name': '测试角色',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'conversations': [],
        'memories': [
          {
            'id': _memId,
            'character_id': _charId,
            'category': 'fact',
            'content': '记忆',
            'confidence': 0.8,
            'tags': '[]',
            'source_msg_ids': '[]',
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
          }
        ],
        'memory_profiles': [
          {
            'character_id': _charId,
            'profile_name': '画像V1',
            'relationship_state': '朋友',
            'recent_story_state': '',
            'emotional_baseline': '',
            'open_threads': '[]',
            'user_profile_summary': '',
            'pinned_summary': '',
            'updated_at': _nowIso,
          }
        ],
        'memory_profile_versions': [
          {
            'id': 1,
            'character_id': _charId,
            'version_number': 1,
            'snapshot_json': '{"v":1}',
            'reason': 'initial',
            'task_id': null,
            'created_at': _nowIso,
          }
        ],
      };

      final jsonStr = jsonEncode(backupData);
      final service = BackupService(targetDb);

      // 第一次导入
      final result1 = await service.importFromJson(jsonStr);
      expect(result1.profilesImported, equals(1));
      expect(result1.profileVersionsImported, equals(1));

      // 第二次导入同一备份 — 画像走 UPSERT（更新），版本号冲突跳过
      final result2 = await service.importFromJson(jsonStr);
      expect(result2.profilesImported, equals(1)); // UPSERT 仍计数
      expect(result2.profileVersionsImported, equals(0)); // 版本号冲突跳过
      expect(result2.skippedCount, greaterThan(0)); // 版本被 skip

      // 验证画像被更新（profileName 应为 '画像V1'）
      final profiles = await targetDb.select(targetDb.characterMemoryProfiles).get();
      expect(profiles.length, equals(1));
      expect(profiles.first.profileName, equals('画像V1'));

      // 验证版本只有 1 条（不重复）
      final versions = await targetDb
          .select(targetDb.characterMemoryProfileVersions)
          .get();
      expect(versions.length, equals(1));
    } finally {
      await targetDb.close();
    }
  });
}
