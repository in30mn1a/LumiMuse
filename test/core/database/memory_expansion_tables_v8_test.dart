// Wave 7 任务 7.1 验证：v8 新增 6 张扩展表在新建库与升级库都存在、索引齐全、外键级联生效。
// 参考已有 memory_tasks_v6_migration_test.dart 与 characters_user_image_tags_v7_test.dart 的
// 全表 seed 模式（项目 memory drift-migration-test-full-schema：seed 旧版本库必须建全所有表，
// 否则 _createIndexes() 会因缺表报 no such table）。
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:path/path.dart' as p;

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  // v8 新增的 6 张扩展表名
  const expansionTables = <String>{
    'memory_embeddings',
    'memory_embedding_tasks',
    'character_memory_profiles',
    'character_memory_profile_update_tasks',
    'character_memory_profile_versions',
    'memory_extraction_candidates',
  };

  // v8 新增索引名（采样自 _createIndexes 的 v8 段，覆盖两类 unique/partial）
  const expansionIndexes = <String>{
    'idx_memory_embeddings_unique_model',
    'idx_memory_embeddings_character_status',
    'idx_memory_embeddings_memory',
    'idx_memory_embeddings_character',
    'idx_memory_embedding_tasks_active_memory',
    'idx_memory_embedding_tasks_status',
    'idx_memory_embedding_tasks_status_id',
    'idx_memory_embedding_tasks_memory',
    'idx_memory_embedding_tasks_memory_status',
    'idx_memory_embedding_tasks_character',
    'idx_memory_embedding_tasks_claim',
    'idx_memory_profile_update_tasks_character_status',
    'idx_memory_profile_update_tasks_claim',
    'idx_memory_profile_versions_character',
    'idx_memory_extraction_candidates_character_status',
  };

  group('schema v8 记忆扩展表', () {
    test('新建库 schemaVersion 为 8，6 张表与索引都存在', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(db.close);
      // 触发 onCreate
      await db.customSelect('SELECT COUNT(*) AS c FROM characters').get();
      expect(await _schemaVersion(db), 8);

      final tables = await _tableNames(db);
      for (final t in expansionTables) {
        expect(tables, contains(t), reason: '新建库缺表 $t');
      }

      final indexes = await _indexNames(db);
      for (final idx in expansionIndexes) {
        expect(indexes, contains(idx), reason: '新建库缺索引 $idx');
      }
    });

    test('v7 升级到 v8 后 6 张表出现、索引存在、schemaVersion=8', () async {
      final file = await _newWorkspaceDbFile();
      await _seedV7Database(file);
      final db = _openDatabase(file);
      addTearDown(db.close);
      // 触发迁移
      await db.customSelect('SELECT COUNT(*) AS c FROM characters').get();
      expect(await _schemaVersion(db), 8);

      final tables = await _tableNames(db);
      for (final t in expansionTables) {
        expect(tables, contains(t), reason: '升级库缺表 $t');
      }

      final indexes = await _indexNames(db);
      for (final idx in expansionIndexes) {
        expect(indexes, contains(idx), reason: '升级库缺索引 $idx');
      }
    });

    test('删除 memory 后 memory_embeddings 级联删除', () async {
      final db = AppDatabase.forTesting(
        NativeDatabase.memory(
          setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
        ),
      );
      addTearDown(db.close);
      // 插入 character + memory + embedding
      await db.customStatement(
        "INSERT INTO characters (id, name) VALUES ('c1', '测试角色')",
      );
      await db.customStatement(
        "INSERT INTO memories (id, character_id, category, content) "
        "VALUES ('m1', 'c1', '基础信息', '某条记忆')",
      );
      await db.customStatement(
        "INSERT INTO memory_embeddings "
        "(memory_id, character_id, provider, model, dimension, embedding_blob, "
        " embedding_text_hash) "
        "VALUES ('m1', 'c1', 'openai', 'text-embedding-3-small', 1536, "
        " X'00000000', 'hash-1')",
      );
      expect(await _countRows(db, 'memory_embeddings'), 1);

      await db.customStatement("DELETE FROM memories WHERE id = 'm1'");
      expect(await _countRows(db, 'memory_embeddings'), 0);
    });

    test('删除 character 后 character_memory_profiles 级联删除', () async {
      final db = AppDatabase.forTesting(
        NativeDatabase.memory(
          setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
        ),
      );
      addTearDown(db.close);
      await db.customStatement(
        "INSERT INTO characters (id, name) VALUES ('c2', '画像角色')",
      );
      await db.customStatement(
        "INSERT INTO memories (id, character_id, category, content) "
        "VALUES ('m2', 'c2', '基础信息', '画像记忆')",
      );
      await db.customStatement(
        "INSERT INTO character_memory_profiles (character_id) VALUES ('c2')",
      );
      await db.customStatement(
        "INSERT INTO memory_embeddings "
        "(memory_id, character_id, provider, model, dimension, embedding_blob, "
        " embedding_text_hash) "
        "VALUES ('m2', 'c2', 'openai', 'text-embedding-3-small', 1536, "
        " X'00000000', 'hash-2')",
      );
      expect(await _countRows(db, 'character_memory_profiles'), 1);

      await db.customStatement("DELETE FROM characters WHERE id = 'c2'");
      expect(await _countRows(db, 'character_memory_profiles'), 0);
      expect(await _countRows(db, 'memory_embeddings'), 0);
      expect(await _countRows(db, 'memories'), 0);
    });
  });
}

// ── 工具函数 ────────────────────────────────────────────────────

AppDatabase _openDatabase(File file) {
  return AppDatabase.forTesting(
    NativeDatabase(file, setup: (db) => db.execute('PRAGMA foreign_keys = ON')),
  );
}

Future<File> _newWorkspaceDbFile() async {
  final root = Directory(
    p.join(Directory.current.path, '.dart_tool', 'test_dbs'),
  );
  await root.create(recursive: true);
  final dir = await root.createTemp('memory_expansion_v8_');
  addTearDown(() async {
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  });
  return File(p.join(dir.path, 'lumimuse.db'));
}

Future<int> _schemaVersion(AppDatabase db) async {
  final row = await db.customSelect('PRAGMA user_version').getSingle();
  return row.read<int>('user_version');
}

Future<Set<String>> _tableNames(AppDatabase db) async {
  final rows = await db
      .customSelect(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'",
      )
      .get();
  return rows.map((r) => r.read<String>('name')).toSet();
}

Future<Set<String>> _indexNames(AppDatabase db) async {
  final rows = await db
      .customSelect(
        "SELECT name FROM sqlite_master WHERE type = 'index' "
        "AND name NOT LIKE 'sqlite_%'",
      )
      .get();
  return rows.map((r) => r.read<String>('name')).toSet();
}

Future<int> _countRows(AppDatabase db, String table) async {
  final row = await db
      .customSelect('SELECT COUNT(*) AS cnt FROM $table')
      .getSingle();
  return row.read<int>('cnt');
}

/// 构造一个停在 v7 的数据库（user_version=7，characters 含 user_image_tags，
/// 其余表为 v7 形态，但无 6 张扩展表），让 AppDatabase 打开时走 v7→v8 迁移分支。
///
/// 必须建全所有表（8 张基础表），否则 v8 迁移末尾的 _createIndexes()
/// 会因缺表（如 messages）抛 no such table。
Future<void> _seedV7Database(File file) async {
  final db = AppDatabase.forTesting(
    NativeDatabase(
      file,
      setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
      enableMigrations: false,
    ),
  );
  try {
    // characters — v7 形态（含 user_image_tags）
    await db.customStatement('''
      CREATE TABLE characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        personality TEXT NOT NULL DEFAULT '',
        scenario TEXT NOT NULL DEFAULT '',
        greeting TEXT NOT NULL DEFAULT '',
        example_dialogue TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        basic_info TEXT NOT NULL DEFAULT '',
        other_info TEXT NOT NULL DEFAULT '',
        image_tags TEXT NOT NULL DEFAULT '',
        user_image_tags TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
    await db.customStatement('''
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        ignore_memory INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
    await db.customStatement('''
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        token_count INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    ''');
    // memories — v6 形态（含 8 个分层字段）
    await db.customStatement('''
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        tags TEXT NOT NULL DEFAULT '[]',
        source_msg_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        memory_kind TEXT NOT NULL DEFAULT 'general',
        importance REAL NOT NULL DEFAULT 0.5,
        emotional_weight REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        usage_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      )
    ''');
    await db.customStatement('''
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    ''');
    // memory_tasks — v6 形态
    await db.customStatement('''
      CREATE TABLE memory_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        message_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        merge_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        started_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      )
    ''');
    await db.customStatement('''
      CREATE TABLE model_cache (
        api_base TEXT PRIMARY KEY,
        models TEXT NOT NULL DEFAULT '[]',
        cached_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
    await db.customStatement('''
      CREATE TABLE api_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_base TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 1.0,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        context_window INTEGER NOT NULL DEFAULT 131072,
        json_mode INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
    await db.customStatement(
      "INSERT INTO characters (id, name) VALUES ('c1', '测试角色')",
    );
    await db.customStatement('PRAGMA user_version = 7');
  } finally {
    await db.close();
  }
}
