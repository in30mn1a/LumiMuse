import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../database/database.dart';
import '../models/message_metadata.dart';
import '../utils/local_asset_utils.dart';

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

/// 物理文件统计信息
class OrphanFileStats {
  final int total;
  final int orphanCount;
  const OrphanFileStats({required this.total, required this.orphanCount});
}

/// 单个目录的物理清理统计
class FileCleanupStats {
  final int deleted;
  final int errors;
  const FileCleanupStats({required this.deleted, required this.errors});
}

/// 完整的清理结果
class CleanupResult {
  final int dbDeleted;
  final Map<String, FileCleanupStats> fileResults;
  const CleanupResult({required this.dbDeleted, required this.fileResults});
}

/// 数据维护结果
class OrphanCount {
  final int orphanMessages;
  final int orphanConversations;
  final int orphanMemories;
  final int orphanMemoryTasks;
  final Map<String, OrphanFileStats>? orphanFiles;

  const OrphanCount({
    this.orphanMessages = 0,
    this.orphanConversations = 0,
    this.orphanMemories = 0,
    this.orphanMemoryTasks = 0,
    this.orphanFiles,
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

class _DirScanResult {
  final int total;
  final List<String> orphans;
  const _DirScanResult({required this.total, required this.orphans});
}

/// 数据库维护服务 — 检查和清理孤儿数据
class MaintenanceService {
  final AppDatabase _db;

  MaintenanceService(this._db);

  /// 扫描全库当前被引用的绝对路径集合（包括 metadata、content 和角色头像）
  Future<Set<String>> _scanAllReferencedPaths() async {
    final referenced = <String>{};

    // 1) 全库消息 metadata 与 content
    final messageRows = await _db.customSelect(
      'SELECT metadata, content FROM messages',
      readsFrom: {_db.messages},
    ).get();
    for (final row in messageRows) {
      final rawMeta = row.read<String?>('metadata');
      if (rawMeta != null && rawMeta.isNotEmpty) {
        try {
          final meta = MessageMetadata.fromJsonString(rawMeta);
          referenced.addAll(extractLocalPaths(meta.toJson()));
        } catch (_) {}
      }
      final content = row.read<String?>('content');
      if (content != null && content.isNotEmpty) {
        referenced.addAll(collectLocalAssetUrlsFromContent(content));
      }
    }

    // 2) 全库角色头像
    final avatarRows = await _db.customSelect(
      'SELECT avatar_url FROM characters WHERE avatar_url IS NOT NULL',
      readsFrom: {_db.characters},
    ).get();
    for (final row in avatarRows) {
      final url = row.read<String?>('avatar_url');
      if (url != null && isLocalAssetPath(url)) {
        referenced.add(url);
      }
    }

    return referenced;
  }

  /// 扫描应用沙箱下的 avatars、attachments、generated 目录，返回孤儿文件
  Future<Map<String, _DirScanResult>> _scanAllDirs(Set<String> referenced) async {
    final docDir = await getApplicationDocumentsDirectory();
    final dirs = {
      'avatars': Directory(p.join(docDir.path, 'avatars')),
      'attachments': Directory(p.join(docDir.path, 'LumiMuse', 'attachments')),
      'generated': Directory(p.join(docDir.path, 'LumiMuse', 'generated')),
    };

    final normalizedReferenced = referenced.map((e) => p.normalize(p.absolute(e))).toSet();
    final results = <String, _DirScanResult>{};

    for (final entry in dirs.entries) {
      final dirName = entry.key;
      final dir = entry.value;

      if (!await dir.exists()) {
        results[dirName] = const _DirScanResult(total: 0, orphans: []);
        continue;
      }

      try {
        final files = await dir.list(recursive: false).where((entity) => entity is File).cast<File>().toList();
        final total = files.length;
        final orphans = <String>[];
        for (final file in files) {
          final filePathNorm = p.normalize(file.absolute.path);
          if (!normalizedReferenced.contains(filePathNorm)) {
            orphans.add(file.path);
          }
        }
        results[dirName] = _DirScanResult(total: total, orphans: orphans);
      } catch (_) {
        results[dirName] = const _DirScanResult(total: 0, orphans: []);
      }
    }

    return results;
  }

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

    // 统计物理孤儿文件
    final referenced = await _scanAllReferencedPaths();
    final scanResults = await _scanAllDirs(referenced);

    final orphanFiles = <String, OrphanFileStats>{};
    for (final entry in scanResults.entries) {
      orphanFiles[entry.key] = OrphanFileStats(
        total: entry.value.total,
        orphanCount: entry.value.orphans.length,
      );
    }

    return OrphanCount(
      orphanMessages: orphanMessages.read<int>('cnt'),
      orphanConversations: orphanConversations.read<int>('cnt'),
      orphanMemories: orphanMemories.read<int>('cnt'),
      orphanMemoryTasks: orphanMemoryTasks.read<int>('cnt'),
      orphanFiles: orphanFiles,
    );
  }

  /// 清理所有孤儿数据，返回清理详细统计结果
  Future<CleanupResult> cleanOrphans() async {
    // 先统计数据库孤儿数量
    final counts = await countOrphans();
    final dbDeleted = counts.total;

    // 1. 使用事务清理数据库孤儿行
    if (dbDeleted > 0) {
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
    }

    // 2. 清理物理孤儿文件
    // 重新扫描最新引用，确保事务提交后依然准确
    final referenced = await _scanAllReferencedPaths();
    final scanResults = await _scanAllDirs(referenced);

    final fileResults = <String, FileCleanupStats>{};
    for (final entry in scanResults.entries) {
      final dirName = entry.key;
      final orphans = entry.value.orphans;
      int deletedCount = 0;
      int errorCount = 0;

      for (final filePath in orphans) {
        try {
          final file = File(filePath);
          if (await file.exists()) {
            await file.delete();
            deletedCount++;
          }
        } catch (_) {
          errorCount++;
        }
      }

      fileResults[dirName] = FileCleanupStats(
        deleted: deletedCount,
        errors: errorCount,
      );
    }

    return CleanupResult(
      dbDeleted: dbDeleted,
      fileResults: fileResults,
    );
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
