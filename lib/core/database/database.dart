import 'dart:io';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;

part 'database.g.dart';

// ═══════════════════════════════════════════════════════════════
// 表定义 — 与现有 Next.js 版 SQLite schema 保持一致
// ═══════════════════════════════════════════════════════════════

/// 角色表
class Characters extends Table {
  TextColumn get id => text()();
  TextColumn get name => text().withDefault(const Constant(''))();
  TextColumn get avatarUrl => text().named('avatar_url').nullable()();
  TextColumn get personality => text().withDefault(const Constant(''))();
  TextColumn get scenario => text().withDefault(const Constant(''))();
  TextColumn get greeting => text().withDefault(const Constant(''))();
  TextColumn get exampleDialogue => text().named('example_dialogue').withDefault(const Constant(''))();
  TextColumn get systemPrompt => text().named('system_prompt').withDefault(const Constant(''))();
  TextColumn get basicInfo => text().named('basic_info').withDefault(const Constant(''))();
  TextColumn get otherInfo => text().named('other_info').withDefault(const Constant(''))();
  TextColumn get imageTags => text().named('image_tags').withDefault(const Constant(''))();
  IntColumn get sortOrder => integer().named('sort_order').withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

/// 对话表
class Conversations extends Table {
  TextColumn get id => text()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get title => text().withDefault(const Constant(''))();
  IntColumn get ignoreMemory => integer().named('ignore_memory').withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

/// 消息表
class Messages extends Table {
  TextColumn get id => text()();
  TextColumn get conversationId => text()
      .named('conversation_id')
      .references(Conversations, #id, onDelete: KeyAction.cascade)();
  TextColumn get role => text()(); // user / assistant / system
  TextColumn get content => text().withDefault(const Constant(''))();
  IntColumn get tokenCount => integer().named('token_count').withDefault(const Constant(0))();
  IntColumn get seq => integer().withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  TextColumn get metadata => text().withDefault(const Constant('{}'))(); // JSON 字符串

  @override
  Set<Column> get primaryKey => {id};
}

/// 记忆表
class Memories extends Table {
  TextColumn get id => text()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get category => text()();
  TextColumn get content => text()();
  RealColumn get confidence => real().withDefault(const Constant(0.8))();
  TextColumn get tags => text().withDefault(const Constant('[]'))(); // JSON 数组
  TextColumn get sourceMsgIds => text().named('source_msg_ids').withDefault(const Constant('[]'))(); // JSON 数组
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

/// 设置表（键值对）
class Settings extends Table {
  TextColumn get key => text()();
  TextColumn get value => text()();

  @override
  Set<Column> get primaryKey => {key};
}

/// 记忆提取任务表
class MemoryTasks extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get conversationId => text()
      .named('conversation_id')
      .references(Conversations, #id, onDelete: KeyAction.cascade)();
  TextColumn get messageIds => text().named('message_ids').withDefault(const Constant('[]'))();
  TextColumn get status => text().withDefault(const Constant('pending'))(); // pending / processing / done / failed
  IntColumn get mergeCount => integer().named('merge_count').withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();
}

/// 模型缓存表
class ModelCache extends Table {
  TextColumn get apiBase => text().named('api_base')();
  TextColumn get models => text().withDefault(const Constant('[]'))();
  DateTimeColumn get cachedAt => dateTime().named('cached_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {apiBase};
}

/// API 供应商表（支持保存多个 API 配置并切换）
class ApiProviders extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get apiBase => text().named('api_base').withDefault(const Constant(''))();
  TextColumn get apiKey => text().named('api_key').withDefault(const Constant(''))();
  TextColumn get model => text().withDefault(const Constant(''))();
  RealColumn get temperature => real().withDefault(const Constant(1.0))();
  IntColumn get maxTokens => integer().named('max_tokens').withDefault(const Constant(4096))();
  IntColumn get contextWindow => integer().named('context_window').withDefault(const Constant(131072))();
  IntColumn get jsonMode => integer().named('json_mode').withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

// ═══════════════════════════════════════════════════════════════
// 数据库类
// ═══════════════════════════════════════════════════════════════

@DriftDatabase(tables: [
  Characters,
  Conversations,
  Messages,
  Memories,
  Settings,
  MemoryTasks,
  ModelCache,
  ApiProviders,
])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  /// 用于测试的构造函数 — 接受自定义 QueryExecutor（如内存数据库）
  AppDatabase.forTesting(super.e);

  @override
  int get schemaVersion => 6;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (Migrator m) async {
      await m.createAll();
      await _createIndexes();
    },
    onUpgrade: (Migrator m, int from, int to) async {
      if (from < 2) {
        await customStatement(
          "ALTER TABLE characters ADD COLUMN basic_info TEXT NOT NULL DEFAULT ''",
        );
        await customStatement(
          "ALTER TABLE characters ADD COLUMN other_info TEXT NOT NULL DEFAULT ''",
        );
      }
      if (from < 3) {
        // v3: 引入 api_providers 表（早期可能存在 TEXT datetime 格式的旧表，先清理）
        await customStatement('DROP TABLE IF EXISTS api_providers');
        await customStatement('''
          CREATE TABLE IF NOT EXISTS api_providers (
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
      if (from == 3) {
        // 仅当从 v3 升级时需要修复：v3 旧建表 SQL 用了秒级时间戳，
        // 而 Drift DateTimeColumn 在 SQLite 中存储毫秒级整数。
        // 用「拷贝到新表 → DROP 旧表 → 重命名」的方式保留数据。
        await customStatement('''
          CREATE TABLE api_providers_new (
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
        // 把秒级时间戳转换成毫秒级时间戳搬运到新表
        await customStatement('''
          INSERT INTO api_providers_new (
            id, name, api_base, api_key, model, temperature,
            max_tokens, context_window, json_mode, created_at
          )
          SELECT
            id, name, api_base, api_key, model, temperature,
            max_tokens, context_window, json_mode,
            CASE
              WHEN created_at < 100000000000 THEN created_at * 1000
              ELSE created_at
            END
          FROM api_providers
        ''');
        await customStatement('DROP TABLE api_providers');
        await customStatement(
          'ALTER TABLE api_providers_new RENAME TO api_providers',
        );
      }
      if (from < 5 && from != 3) {
        // v5: 之前 v4 迁移路径用了秒级时间戳默认值，统一修正为毫秒级。
        // 注意：from == 3 已在上一分支用「新表搬运」方式处理过秒→毫秒，无需再修正；
        // 这里仅处理「from == 4」这种走过 v4 旧路径但未走 v3 修复分支的历史数据。
        // 用 < 1e11 作秒级判定阈值（约对应 5138 年的毫秒值，足够安全）。
        await customStatement('''
          UPDATE api_providers
          SET created_at = created_at * 1000
          WHERE created_at < 100000000000
        ''');
      }
      if (from < 6) {
        await _migrateMemoryTasksToV6(from, to);
      }
      // 每次升级后都确保所有索引存在
      await _createIndexes();
    },
  );

  Future<void> _migrateMemoryTasksToV6(int from, int to) async {
    var step = 'count_orphan_memory_tasks';
    try {
      final orphanRows = await customSelect('''
        SELECT COUNT(*) AS cnt, GROUP_CONCAT(mt.id) AS ids
        FROM memory_tasks mt
        LEFT JOIN conversations c ON c.id = mt.conversation_id
        WHERE c.id IS NULL
      ''').getSingle();
      final orphanCount = orphanRows.read<int>('cnt');
      final orphanIds = orphanRows.readNullable<String>('ids') ?? '';
      if (orphanCount > 0) {
        debugPrint(
          '[database migration v6] skip_orphan_memory_tasks '
          'from=$from to=$to count=$orphanCount ids=$orphanIds',
        );
      }

      step = 'create_memory_tasks_v6';
      await customStatement('''
        CREATE TABLE memory_tasks_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id TEXT NOT NULL
            REFERENCES characters(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          message_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          merge_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        )
      ''');

      step = 'copy_valid_memory_tasks';
      await customStatement('''
        INSERT INTO memory_tasks_v6 (
          id, character_id, conversation_id, message_ids, status,
          merge_count, created_at, updated_at
        )
        SELECT
          mt.id,
          mt.character_id,
          mt.conversation_id,
          mt.message_ids,
          mt.status,
          mt.merge_count,
          mt.created_at,
          mt.updated_at
        FROM memory_tasks mt
        INNER JOIN conversations c ON c.id = mt.conversation_id
      ''');

      step = 'replace_memory_tasks_table';
      await customStatement('DROP TABLE memory_tasks');
      await customStatement(
        'ALTER TABLE memory_tasks_v6 RENAME TO memory_tasks',
      );
    } catch (e, s) {
      debugPrint(
        '[database migration v6] failed from=$from to=$to step=$step error=$e',
      );
      debugPrint('$s');
      rethrow;
    }
  }

  /// 创建所有索引（使用 IF NOT EXISTS，可重复调用）
  Future<void> _createIndexes() async {
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, seq)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_conversations_character ON conversations(character_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_characters_sort_order ON characters(sort_order)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_tasks_status ON memory_tasks(status)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_tasks_conversation ON memory_tasks(conversation_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_tasks_character ON memory_tasks(character_id)',
    );
  }
}

/// 打开数据库连接
LazyDatabase _openConnection() {
  return LazyDatabase(() async {
    final dbFolder = await getApplicationDocumentsDirectory();
    final file = File(p.join(dbFolder.path, 'LumiMuse', 'lumimuse.db'));

    // 确保目录存在
    if (!await file.parent.exists()) {
      await file.parent.create(recursive: true);
    }

    return NativeDatabase.createInBackground(
      file,
      // SQLite 默认未开启外键，需在每次连接时显式打开
      setup: (db) => db.execute('PRAGMA foreign_keys = ON'),
    );
  });
}
