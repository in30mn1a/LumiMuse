// Wave 2 任务 2.1 验证：Characters 表 user_image_tags 列在新建库与升级库都存在。
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:path/path.dart' as p;

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  group('schema v7 characters.user_image_tags', () {
    test('新建库含 user_image_tags 列', () async {
      final db = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(db.close);
      final cols = await _characterColumns(db);
      expect(cols, contains('user_image_tags'));
    });

    test('v6 升级到 v7 后追加 user_image_tags 列', () async {
      final file = await _newWorkspaceDbFile();
      await _seedV6Database(file);
      final db = _openDatabase(file);
      addTearDown(db.close);
      // 触发迁移：任意查询即可让 Drift 打开并升级到 schemaVersion=8
      // （v7→v8 仅新增 6 张扩展表，不影响 user_image_tags 列断言）
      await db.customSelect('SELECT COUNT(*) AS c FROM characters').get();
      expect(await _schemaVersion(db), 8);
      final cols = await _characterColumns(db);
      expect(cols, contains('user_image_tags'));
    });
  });
}

Future<Set<String>> _characterColumns(AppDatabase db) async {
  final rows = await db.customSelect('PRAGMA table_info(characters)').get();
  return rows.map((r) => r.read<String>('name')).toSet();
}

Future<int> _schemaVersion(AppDatabase db) async {
  final row = await db.customSelect('PRAGMA user_version').getSingle();
  return row.read<int>('user_version');
}

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
  final dir = await root.createTemp('characters_v7_');
  addTearDown(() async {
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  });
  return File(p.join(dir.path, 'lumimuse.db'));
}

/// 构造一个停在 v6 的数据库（user_version=6，characters 表无 user_image_tags，
/// 其余表为 v6 形态），让 AppDatabase 打开时走 v6→v7 迁移分支。
///
/// 必须建全所有表（不能只建 characters），否则 v7 迁移末尾的 `_createIndexes()`
/// 会因缺表（如 messages）抛 `no such table`。
Future<void> _seedV6Database(File file) async {
  final db = AppDatabase.forTesting(
    NativeDatabase(
      file,
      setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
      enableMigrations: false,
    ),
  );
  try {
    // characters — v6 形态（无 user_image_tags，该列由 v7 迁移 addColumn 补上）
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
    // memory_tasks — v6 形态（含 conversation FK + started_at/retry_count/error_message）
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
    await db.customStatement('PRAGMA user_version = 6');
  } finally {
    await db.close();
  }
}
