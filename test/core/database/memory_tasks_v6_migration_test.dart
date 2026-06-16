import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:path/path.dart' as p;

void main() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;

  group('schema v6 memory_tasks 迁移', () {
    test('v5 升级到 v6 后保留合法任务，清理孤儿任务，并添加 conversation FK', () async {
      final file = await _newWorkspaceDbFile();
      await _seedV5Database(file);

      final db = _openDatabase(file);
      addTearDown(db.close);

      expect(await _schemaVersion(db), 6);

      final tasks = await db
          .customSelect(
            'SELECT id, character_id, conversation_id, status, merge_count '
            'FROM memory_tasks ORDER BY id',
          )
          .get();
      expect(tasks, hasLength(1));
      expect(tasks.single.read<int>('id'), 1);
      expect(tasks.single.read<String>('character_id'), 'char-1');
      expect(tasks.single.read<String>('conversation_id'), 'conv-1');
      expect(tasks.single.read<String>('status'), 'done');
      expect(tasks.single.read<int>('merge_count'), 2);

      final fkRows = await db
          .customSelect('PRAGMA foreign_key_list(memory_tasks)')
          .get();
      final conversationFk = fkRows.where((row) {
        return row.read<String>('table') == 'conversations' &&
            row.read<String>('from') == 'conversation_id' &&
            row.read<String>('to') == 'id';
      }).toList();
      expect(conversationFk, hasLength(1));
      expect(conversationFk.single.read<String>('on_delete'), 'CASCADE');
    });

    test('删除 conversation 后对应 memory_tasks 会级联删除', () async {
      final file = await _newWorkspaceDbFile();
      await _seedV5Database(file);

      final db = _openDatabase(file);
      addTearDown(db.close);
      expect(await _countTasks(db), 1);

      await db.customStatement('DELETE FROM conversations WHERE id = ?', [
        'conv-1',
      ]);

      expect(await _countTasks(db), 0);
    });

    test('v6 迁移失败时记录版本和步骤信息，并 rethrow', () async {
      final file = await _newWorkspaceDbFile();
      await _seedMalformedV5Database(file);

      final logs = <String>[];
      final previousDebugPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {
        logs.add(message ?? '');
      };
      addTearDown(() {
        debugPrint = previousDebugPrint;
      });

      final db = _openDatabase(file);
      addTearDown(db.close);

      await expectLater(
        db.customSelect('SELECT COUNT(*) AS cnt FROM memory_tasks').get(),
        throwsA(anything),
      );

      expect(
        logs,
        contains(
          allOf(
            contains('v6'),
            contains('from=5'),
            contains('to=6'),
            contains('copy_valid_memory_tasks'),
          ),
        ),
      );
    });
  });
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
  final dir = await root.createTemp('memory_tasks_v6_');
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

Future<int> _countTasks(AppDatabase db) async {
  final row = await db
      .customSelect('SELECT COUNT(*) AS cnt FROM memory_tasks')
      .getSingle();
  return row.read<int>('cnt');
}

Future<void> _seedV5Database(File file) async {
  final db = AppDatabase.forTesting(
    NativeDatabase(
      file,
      setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
      enableMigrations: false,
    ),
  );
  try {
    await _createV5Schema(db, includeCompleteMemoryTasks: true);
    await db.customStatement(
      "INSERT INTO characters (id, name, created_at, updated_at) "
      "VALUES ('char-1', '测试角色', 1760000000000, 1760000000000)",
    );
    await db.customStatement(
      "INSERT INTO conversations (id, character_id, title, created_at, updated_at) "
      "VALUES ('conv-1', 'char-1', '合法对话', 1760000001000, 1760000001000)",
    );
    await db.customStatement(
      "INSERT INTO memory_tasks "
      "(id, character_id, conversation_id, message_ids, status, merge_count, created_at, updated_at) "
      "VALUES "
      "(1, 'char-1', 'conv-1', '[\"msg-1\"]', 'done', 2, 1760000002000, 1760000002000), "
      "(2, 'char-1', 'missing-conv', '[\"msg-orphan\"]', 'pending', 0, 1760000003000, 1760000003000)",
    );
    await db.customStatement('PRAGMA user_version = 5');
  } finally {
    await db.close();
  }
}

Future<void> _seedMalformedV5Database(File file) async {
  final db = AppDatabase.forTesting(
    NativeDatabase(
      file,
      setup: (rawDb) => rawDb.execute('PRAGMA foreign_keys = ON'),
      enableMigrations: false,
    ),
  );
  try {
    await _createV5Schema(db, includeCompleteMemoryTasks: false);
    await db.customStatement('PRAGMA user_version = 5');
  } finally {
    await db.close();
  }
}

Future<void> _createV5Schema(
  AppDatabase db, {
  required bool includeCompleteMemoryTasks,
}) async {
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
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  ''');
  await db.customStatement('''
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  ''');
  if (includeCompleteMemoryTasks) {
    await db.customStatement('''
      CREATE TABLE memory_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        message_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        merge_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
  } else {
    await db.customStatement('''
      CREATE TABLE memory_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        merge_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )
    ''');
  }
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
}
