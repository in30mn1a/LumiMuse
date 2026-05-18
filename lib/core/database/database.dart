import 'dart:io';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
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
  TextColumn get characterId => text().named('character_id').references(Characters, #id)();
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
  TextColumn get conversationId => text().named('conversation_id').references(Conversations, #id)();
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
  TextColumn get characterId => text().named('character_id').references(Characters, #id)();
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
  TextColumn get characterId => text().named('character_id')();
  TextColumn get conversationId => text().named('conversation_id')();
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
  int get schemaVersion => 4;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (Migrator m) async {
      await m.createAll();
      // 创建索引
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
        // 如果旧表存在（可能是 TEXT datetime 格式），先删除再重建
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
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
          )
        ''');
      }
      if (from < 4) {
        // 修复 v3 迁移中 created_at 用了 TEXT datetime 格式的问题
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
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
          )
        ''');
      }
    },
  );
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

    return NativeDatabase.createInBackground(file);
  });
}
