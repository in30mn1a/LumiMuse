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
  // 用户外貌标签（生图时保持用户形象一致）。
  // 主项目 db.ts 中 user_image_tags 为 nullable TEXT 无默认值，
  // 这里沿用 imageTags 的 withDefault('') 风格保持代码对称、避免 nullable 解析负担。
  TextColumn get userImageTags => text().named('user_image_tags').withDefault(const Constant(''))();
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
  // v6 新增字段 — 记忆分层与生命周期管理
  TextColumn get memoryKind => text().named('memory_kind').withDefault(const Constant('general'))(); // 记忆类型
  RealColumn get importance => real().withDefault(const Constant(0.5))(); // 重要性 0.0-1.0
  RealColumn get emotionalWeight => real().named('emotional_weight').withDefault(const Constant(0.5))(); // 情感权重 0.0-1.0
  TextColumn get status => text().withDefault(const Constant('active'))(); // active / archived / decayed
  BoolColumn get pinned => boolean().withDefault(const Constant(false))(); // 是否置顶（不受裁剪影响）
  IntColumn get lastUsedAt => integer().named('last_used_at').nullable()(); // 毫秒级时间戳，最后一次参与检索
  IntColumn get usageCount => integer().named('usage_count').withDefault(const Constant(0))(); // 检索命中次数
  TextColumn get metadata => text().nullable()(); // JSON 字符串，扩展元数据

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
  // v6 新增字段 — 任务追踪与重试
  IntColumn get startedAt => integer().named('started_at').nullable()(); // 毫秒级时间戳，进入 processing 的时间
  IntColumn get retryCount => integer().named('retry_count').withDefault(const Constant(0))(); // 重试次数
  TextColumn get errorMessage => text().named('error_message').nullable()(); // 失败原因
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
// v8 扩展表 — 记忆向量化 / 角色画像 / 提取候选
// 对照主项目 src/lib/memory-embedding-schema.ts 与 src/lib/db.ts
// ═══════════════════════════════════════════════════════════════

/// 记忆向量表 — 存放每条记忆的 embedding（多 provider/model/dimension 共存）。
/// 对照主项目 memory-embedding-schema.ts 第 4-17 行。
/// 偏差：主项目此表无显式主键（靠 rowid 隐式），Drift 要求每表有显式主键，
/// 故加 `id INTEGER PRIMARY KEY AUTOINCREMENT` 作代理键；业务唯一性仍由
/// unique 索引 idx_memory_embeddings_unique_model(memory_id+provider+model+dimension) 保证。
class MemoryEmbeddings extends Table {
  // 代理主键（偏差：主项目无此列，用 rowid 隐式）
  IntColumn get id => integer().autoIncrement()();
  TextColumn get memoryId => text()
      .named('memory_id')
      .references(Memories, #id, onDelete: KeyAction.cascade)();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get provider => text()();
  TextColumn get model => text()();
  IntColumn get dimension => integer()();
  BlobColumn get embeddingBlob => blob().named('embedding_blob')();
  // 0/1 布尔语义：向量是否已归一化
  IntColumn get normalized => integer().withDefault(const Constant(1))();
  TextColumn get embeddingTextHash => text().named('embedding_text_hash')();
  TextColumn get status => text().withDefault(const Constant('ready'))();
  TextColumn get errorMessage => text().named('error_message').nullable()();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();
}

/// 记忆向量化任务表 — 异步生成 embedding 的任务队列。
/// 对照主项目 memory-embedding-schema.ts 第 19-30 行。
class MemoryEmbeddingTasks extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get memoryId => text()
      .named('memory_id')
      .references(Memories, #id, onDelete: KeyAction.cascade)();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get reason => text()();
  TextColumn get status => text().withDefault(const Constant('pending'))();
  TextColumn get claimToken => text().named('claim_token').nullable()();
  IntColumn get retryCount => integer().named('retry_count').withDefault(const Constant(0))();
  TextColumn get errorMessage => text().named('error_message').nullable()();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();
}

/// 角色记忆画像表 — 每角色一行，存放关系/故事/情感基线等聚合状态。
/// 对照主项目 src/lib/db.ts 第 131-141 行。
class CharacterMemoryProfiles extends Table {
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get profileName => text().named('profile_name').withDefault(const Constant(''))();
  TextColumn get relationshipState => text().named('relationship_state').withDefault(const Constant(''))();
  TextColumn get recentStoryState => text().named('recent_story_state').withDefault(const Constant(''))();
  TextColumn get emotionalBaseline => text().named('emotional_baseline').withDefault(const Constant(''))();
  TextColumn get openThreads => text().named('open_threads').withDefault(const Constant('[]'))();
  TextColumn get userProfileSummary => text().named('user_profile_summary').withDefault(const Constant(''))();
  TextColumn get pinnedSummary => text().named('pinned_summary').withDefault(const Constant(''))();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {characterId};
}

/// 角色记忆画像更新任务表 — 异步 patch 队列。
/// 对照主项目 src/lib/db.ts 第 143-155 行。
/// 偏差：主项目 lease_expires_at 为 TEXT（存 datetime('now') 文本），
/// 这里改为 IntColumn nullable 存毫秒级时间戳，与项目 DateTime 约定一致。
class CharacterMemoryProfileUpdateTasks extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get reason => text()();
  TextColumn get patchJson => text().named('patch_json')();
  TextColumn get status => text().withDefault(const Constant('pending'))();
  TextColumn get claimToken => text().named('claim_token').nullable()();
  // 偏差：主项目为 TEXT datetime，这里用毫秒整数（项目约定）
  IntColumn get leaseExpiresAt => integer().named('lease_expires_at').nullable()();
  IntColumn get retryCount => integer().named('retry_count').withDefault(const Constant(0))();
  TextColumn get errorMessage => text().named('error_message').nullable()();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();
}

/// 角色记忆画像版本快照表 — 每次画像变更存一份 snapshot。
/// 对照主项目 src/lib/db.ts 第 157-165 行。
class CharacterMemoryProfileVersions extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  IntColumn get versionNumber => integer().named('version_number')();
  TextColumn get snapshotJson => text().named('snapshot_json')();
  TextColumn get reason => text()();
  // 主项目仅引用 update_tasks.id，无 FK 声明
  IntColumn get taskId => integer().named('task_id').nullable()();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
}

/// 记忆提取候选表 — 隔离原始 LLM 提取响应，过滤后再入正式 memories。
/// 对照主项目 src/lib/db.ts 第 314-325 行。
/// task_id / conversation_id 主项目均无 FK 声明（仅引用/TEXT），这里保持一致。
class MemoryExtractionCandidates extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get taskId => integer().named('task_id').nullable()();
  TextColumn get characterId => text()
      .named('character_id')
      .references(Characters, #id, onDelete: KeyAction.cascade)();
  TextColumn get conversationId => text().named('conversation_id').nullable()();
  TextColumn get rawCandidateJson => text().named('raw_candidate_json').nullable()();
  TextColumn get rawResponse => text().named('raw_response').nullable()();
  TextColumn get status => text()();
  TextColumn get errorReason => text().named('error_reason').nullable()();
  DateTimeColumn get createdAt => dateTime().named('created_at').withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().named('updated_at').withDefault(currentDateAndTime)();
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
  // v8 扩展表
  MemoryEmbeddings,
  MemoryEmbeddingTasks,
  CharacterMemoryProfiles,
  CharacterMemoryProfileUpdateTasks,
  CharacterMemoryProfileVersions,
  MemoryExtractionCandidates,
])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  /// 用于测试的构造函数 — 接受自定义 QueryExecutor（如内存数据库）
  AppDatabase.forTesting(super.e);

  @override
  int get schemaVersion => 8;

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
        // 重建 memory_tasks 表（补 conversation FK + 加 3 个新列）
        await _migrateMemoryTasksToV6(from, to);
        // Memories 表追加 8 列（无 FK 变化，用 addColumn 即可）
        await m.addColumn(memories, memories.memoryKind);
        await m.addColumn(memories, memories.importance);
        await m.addColumn(memories, memories.emotionalWeight);
        await m.addColumn(memories, memories.status);
        await m.addColumn(memories, memories.pinned);
        await m.addColumn(memories, memories.lastUsedAt);
        await m.addColumn(memories, memories.usageCount);
        await m.addColumn(memories, memories.metadata);
      }
      if (from < 7) {
        // v7: Characters 表新增 user_image_tags（用户外貌标签，生图时保持用户形象一致）
        await m.addColumn(characters, characters.userImageTags);
      }
      if (from < 8) {
        // v8: 记忆系统扩展表 — 向量化 / 角色画像 / 提取候选
        // 用 createTable 逐表建（IF NOT EXISTS 语义），避免 createAll 重建已有表
        await m.createTable(memoryEmbeddings);
        await m.createTable(memoryEmbeddingTasks);
        await m.createTable(characterMemoryProfiles);
        await m.createTable(characterMemoryProfileUpdateTasks);
        await m.createTable(characterMemoryProfileVersions);
        await m.createTable(memoryExtractionCandidates);
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
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          started_at INTEGER,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
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
    // v6 新增复合索引 — 支持按状态过滤的检索与过期清理
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memories_character_status_category '
      'ON memories(character_id, status, category)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memories_status_updated '
      'ON memories(status, updated_at)',
    );
    // v8 扩展表索引 — 对照主项目 memory-embedding-schema.ts 第 65-80 行
    // 与 src/lib/db.ts 第 167-189、327 行
    // memory_embeddings：业务唯一性 + 检索
    await customStatement(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_unique_model '
      'ON memory_embeddings(memory_id, provider, model, dimension)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embeddings_character_status '
      'ON memory_embeddings(character_id, status)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory '
      'ON memory_embeddings(memory_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embeddings_character '
      'ON memory_embeddings(character_id, status, provider, model)',
    );
    // memory_embedding_tasks：活跃任务去重 + 状态检索
    await customStatement(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embedding_tasks_active_memory '
      'ON memory_embedding_tasks(memory_id) '
      "WHERE status IN ('pending', 'processing')",
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_status '
      'ON memory_embedding_tasks(status)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_status_id '
      'ON memory_embedding_tasks(status, id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_memory '
      'ON memory_embedding_tasks(memory_id)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_memory_status '
      'ON memory_embedding_tasks(memory_id, status)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_character '
      'ON memory_embedding_tasks(character_id)',
    );
    // memory_embedding_tasks：partial 索引（仅 claim_token 非空行）
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_claim '
      'ON memory_embedding_tasks(claim_token) '
      'WHERE claim_token IS NOT NULL',
    );
    // character_memory_profiles：PK 即 character_id，无额外索引
    // character_memory_profile_update_tasks
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_profile_update_tasks_character_status '
      'ON character_memory_profile_update_tasks(character_id, status)',
    );
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_profile_update_tasks_claim '
      'ON character_memory_profile_update_tasks(claim_token) '
      'WHERE claim_token IS NOT NULL',
    );
    // character_memory_profile_versions
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_profile_versions_character '
      'ON character_memory_profile_versions(character_id, version_number DESC)',
    );
    // memory_extraction_candidates
    await customStatement(
      'CREATE INDEX IF NOT EXISTS idx_memory_extraction_candidates_character_status '
      'ON memory_extraction_candidates(character_id, status)',
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
      setup: (db) {
        db.execute('PRAGMA foreign_keys = ON');
        // v6 新增：繁忙时等待 5 秒再报 SQLITE_BUSY，避免并发写入冲突
        db.execute('PRAGMA busy_timeout = 5000');
      },
    );
  });
}
