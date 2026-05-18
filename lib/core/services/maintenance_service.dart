import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../database/database.dart';
import '../models/message_metadata.dart';

/// 数据库统计结果
///
/// - [tables]：表名到行数的映射；任一表 `COUNT(*)` 失败时，对应键会被缺省
///   （例如 Flutter 端尚未建立 `glossary` 表，查询会自然抛错并被忽略）。
/// - [totalBytes]：`lumimuse.db` 主文件加上同目录下 `-wal` / `-shm` 文件
///   （若存在）的字节数之和；任一文件读取失败会回退为 0，与 P2 / R14 描述一致。
/// - [imageCount]：所有消息 metadata 中 `generatedImages` 的图片总数
/// - [imageReadyCount]：状态为 `ready` 的图片数
/// - [imageFailedCount]：状态为 `failed` 的图片数
/// - [attachmentCount]：所有消息 metadata 中 `attachments` 的附件总数
class DatabaseStats {
  final Map<String, int> tables;
  final int totalBytes;
  final int imageCount;
  final int imageReadyCount;
  final int imageFailedCount;
  final int attachmentCount;

  const DatabaseStats({
    required this.tables,
    required this.totalBytes,
    this.imageCount = 0,
    this.imageReadyCount = 0,
    this.imageFailedCount = 0,
    this.attachmentCount = 0,
  });
}

/// 数据维护结果
class OrphanCount {
  final int orphanMessages;
  final int orphanConversations;
  final int orphanMemories;
  final int orphanMemoryTasks;

  const OrphanCount({
    this.orphanMessages = 0,
    this.orphanConversations = 0,
    this.orphanMemories = 0,
    this.orphanMemoryTasks = 0,
  });

  int get total =>
      orphanMessages + orphanConversations + orphanMemories + orphanMemoryTasks;

  @override
  String toString() {
    return '孤儿消息: $orphanMessages\n'
        '孤儿对话: $orphanConversations\n'
        '孤儿记忆: $orphanMemories\n'
        '孤儿记忆任务: $orphanMemoryTasks\n'
        '合计: $total';
  }
}

/// 数据库维护服务 — 检查和清理孤儿数据
class MaintenanceService {
  final AppDatabase _db;

  MaintenanceService(this._db);

  /// 统计孤儿数据数量
  Future<OrphanCount> countOrphans() async {
    // 孤儿消息：conversation_id 不存在于 conversations 表
    final orphanMessages = await _db.customSelect(
      'SELECT COUNT(*) AS cnt FROM messages '
      'WHERE conversation_id NOT IN (SELECT id FROM conversations)',
    ).getSingle();

    // 孤儿对话：character_id 不存在于 characters 表
    final orphanConversations = await _db.customSelect(
      'SELECT COUNT(*) AS cnt FROM conversations '
      'WHERE character_id NOT IN (SELECT id FROM characters)',
    ).getSingle();

    // 孤儿记忆：character_id 不存在于 characters 表
    final orphanMemories = await _db.customSelect(
      'SELECT COUNT(*) AS cnt FROM memories '
      'WHERE character_id NOT IN (SELECT id FROM characters)',
    ).getSingle();

    // 孤儿记忆任务：conversation_id 不存在于 conversations 表
    final orphanMemoryTasks = await _db.customSelect(
      'SELECT COUNT(*) AS cnt FROM memory_tasks '
      'WHERE conversation_id NOT IN (SELECT id FROM conversations)',
    ).getSingle();

    return OrphanCount(
      orphanMessages: orphanMessages.read<int>('cnt'),
      orphanConversations: orphanConversations.read<int>('cnt'),
      orphanMemories: orphanMemories.read<int>('cnt'),
      orphanMemoryTasks: orphanMemoryTasks.read<int>('cnt'),
    );
  }

  /// 清理所有孤儿数据，返回删除总数
  Future<int> cleanOrphans() async {
    // 先统计数量
    final counts = await countOrphans();
    final total = counts.total;

    if (total == 0) return 0;

    // 使用事务确保原子性，中途崩溃不会留下不一致状态
    await _db.transaction(() async {
      await _db.customStatement(
        'DELETE FROM messages '
        'WHERE conversation_id NOT IN (SELECT id FROM conversations)',
      );

      await _db.customStatement(
        'DELETE FROM conversations '
        'WHERE character_id NOT IN (SELECT id FROM characters)',
      );

      await _db.customStatement(
        'DELETE FROM memories '
        'WHERE character_id NOT IN (SELECT id FROM characters)',
      );

      await _db.customStatement(
        'DELETE FROM memory_tasks '
        'WHERE conversation_id NOT IN (SELECT id FROM conversations)',
      );
    });

    return total;
  }

  /// 候选统计表名，与 design.md「P2 / R14」一致。
  ///
  /// 注意：Flutter 端 Drift schema 暂未创建 `glossary` 表，
  /// 真正执行 `SELECT COUNT(*)` 时会抛错并被 try/catch 吞掉，
  /// 对应键不会出现在返回的 [DatabaseStats.tables] 中。
  static const List<String> _statsTableNames = <String>[
    'characters',
    'conversations',
    'messages',
    'memories',
    'memory_tasks',
    'settings',
    'model_cache',
  ];

  /// 获取数据库统计：每张表行数 + 数据库文件总字节数
  ///
  /// - 任一表 `COUNT(*)` 抛错（例如表不存在）→ 该键缺省，不计入 [DatabaseStats.tables]。
  /// - 文件读取链路任一步抛错 → [DatabaseStats.totalBytes] 回退为 0。
  Future<DatabaseStats> getDatabaseStats() async {
    // 1. 表行数（按表逐个 try/catch，互不影响）
    final tables = <String, int>{};
    for (final name in _statsTableNames) {
      try {
        final row = await _db
            .customSelect('SELECT COUNT(*) AS cnt FROM $name')
            .getSingle();
        tables[name] = row.read<int>('cnt');
      } catch (_) {
        // 表不存在或查询失败：按设计缺省该键
      }
    }

    // 2. 图片与附件统计（从消息 metadata 中提取）
    int imageCount = 0;
    int imageReadyCount = 0;
    int imageFailedCount = 0;
    int attachmentCount = 0;
    try {
      final rows = await _db.customSelect(
        'SELECT metadata FROM messages WHERE metadata IS NOT NULL AND metadata != \'\'',
      ).get();
      for (final row in rows) {
        final raw = row.read<String>('metadata');
        final meta = MessageMetadata.fromJsonString(raw);
        for (final img in meta.generatedImages) {
          imageCount++;
          if (img.status == 'ready') {
            imageReadyCount++;
          } else if (img.status == 'failed') {
            imageFailedCount++;
          }
        }
        attachmentCount += meta.attachments.length;
      }
    } catch (_) {
      // 解析失败时保持 0
    }

    // 3. 数据库文件大小（主文件 + -wal + -shm）
    int totalBytes = 0;
    try {
      final dbFolder = await getApplicationDocumentsDirectory();
      final basePath = p.join(dbFolder.path, 'LumiMuse', 'lumimuse.db');
      for (final path in <String>[
        basePath,
        '$basePath-wal',
        '$basePath-shm',
      ]) {
        final file = File(path);
        if (await file.exists()) {
          totalBytes += await file.length();
        }
      }
    } catch (_) {
      // 任意 IO 异常 → 回退 0，与设计一致
      totalBytes = 0;
    }

    return DatabaseStats(
      tables: tables,
      totalBytes: totalBytes,
      imageCount: imageCount,
      imageReadyCount: imageReadyCount,
      imageFailedCount: imageFailedCount,
      attachmentCount: attachmentCount,
    );
  }
}
