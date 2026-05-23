/// 角色图片管理 — 列出与删除生图条目（R11）
///
/// 与 Node.js 主项目 `src/app/api/characters/[id]/images/route.ts` 在语义上等价：
/// - 把每条 assistant 消息 `metadata.generatedImages` 中每个 image 的每个 version
///   展开成独立条目，供「角色图片管理页」做网格展示与多选删除。
/// - 兼容旧消息：当 `image.versions` 缺失或为空时，归一化为
///   `[{ id: image.id, url: image.url, prompt: image.prompt }]`，与 Node.js
///   `normalizeVersions` 行为一致。
///
/// 当前阶段进度：
/// - Task 12.1：[listImages] 与公开数据类
/// - Task 12.2：[deleteImages] 事务内 metadata 更新与统计
/// - Task 12.3：事务外的全库引用扫描 + 本地文件安全删除（本任务）
library;

import 'dart:io';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../database/database.dart';
import '../models/message_metadata.dart';
import '../utils/local_asset_utils.dart';
import 'database_provider.dart';

/// 一条角色图片条目（每个版本独立展开）
///
/// 字段命名遵循 design.md「P1 / R11」要求：
/// - `localPath`：版本对应的本地文件路径（与 metadata 中的 `url` 字段同义，
///   Flutter 端因为不走 HTTP，直接保存绝对路径）
class CharacterImageItem {
  /// 所属消息 ID
  final String messageId;

  /// 所属对话 ID
  final String conversationId;

  /// 对话标题（直接使用 `conversations.title`）
  final String conversationTitle;

  /// 消息创建时间，用于排序与 UI 展示
  final DateTime createdAt;

  /// 图片稳定 ID（与 metadata 中的 `image.id` 一致，删除局部版本后保持不变）
  final String imageId;

  /// 当前展开版本的 ID（与 metadata 中的 `version.id` 或归一化后的 `image.id` 一致）
  final String versionId;

  /// 本地文件路径（来源 `version.url`，旧消息回退 `version.path`）
  final String localPath;

  /// 本次生图使用的 positive prompt
  final String prompt;

  const CharacterImageItem({
    required this.messageId,
    required this.conversationId,
    required this.conversationTitle,
    required this.createdAt,
    required this.imageId,
    required this.versionId,
    required this.localPath,
    required this.prompt,
  });
}

/// 待删除目标三元组：`(messageId, imageId, versionId)`
///
/// 12.2 删除流程会按 `messageId` 聚合，再逐消息处理，避免循环中改稳定 imageId
/// 后选中失效（与 Node.js 端行为一致）。
class DeleteImageTarget {
  final String messageId;
  final String imageId;
  final String versionId;

  const DeleteImageTarget({
    required this.messageId,
    required this.imageId,
    required this.versionId,
  });
}

/// 批量删除结果
///
/// - [deletedCount]：实际从 metadata 中移除的 version 总条数（与 Node.js 端
///   响应字段 `deletedCount` 语义一致）
/// - [deletedPaths]：被移除 version 对应的本地文件路径集合，**事务外**由
///   Task 12.3 的引用扫描判断是否真正删文件
class DeleteImageResult {
  final int deletedCount;
  final Set<String> deletedPaths;

  const DeleteImageResult({
    required this.deletedCount,
    required this.deletedPaths,
  });
}

// ════════════════════════════════════════════════════════════════
// Riverpod Provider
// ════════════════════════════════════════════════════════════════

/// 角色图片操作 Notifier
final characterImagesActionsProvider = Provider<CharacterImagesActions>((ref) {
  return CharacterImagesActions(ref.read(databaseProvider));
});

/// 角色图片管理操作集合（封装 listImages / deleteImages 等纯数据库逻辑）
class CharacterImagesActions {
  final AppDatabase _db;

  CharacterImagesActions(this._db);

  /// 列出指定角色的所有生图条目（每个版本独立成行）
  ///
  /// 排序规则：
  /// 1. 按消息 `created_at DESC, seq DESC` 排序（与 Node.js 端 SQL 完全一致）
  /// 2. 同一 image 内多版本按数组反向展开（最新版本在前），与 UI 「新图先显示」
  ///    的展示约定保持一致
  ///
  /// 兼容性：
  /// - `image.versions` 缺失或空 → 归一化为单版本 `[{ id, url/path, prompt }]`
  /// - 老消息字段命名 `path` 也会被识别为本地路径（向前兼容当前 Flutter 实现）
  Future<List<CharacterImageItem>> listImages(String characterId) async {
    // 用 customSelect 直连原生 SQL，便于一次性 JOIN 出对话标题，避免在 Dart 端
    // 逐消息再查 conversation 造成 N+1。
    final rows = await _db.customSelect(
      '''
      SELECT
        messages.id           AS messageId,
        messages.created_at   AS createdAt,
        messages.metadata     AS metadata,
        conversations.id      AS conversationId,
        conversations.title   AS conversationTitle
      FROM messages
      INNER JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.character_id = ?
        AND messages.role = 'assistant'
      ORDER BY messages.created_at DESC, messages.seq DESC
      ''',
      variables: [Variable<String>(characterId)],
      readsFrom: {_db.messages, _db.conversations},
    ).get();

    final result = <CharacterImageItem>[];

    for (final row in rows) {
      final messageId = row.read<String>('messageId');
      final conversationId = row.read<String>('conversationId');
      final conversationTitle = row.read<String?>('conversationTitle') ?? '';
      // SQLite 的 DateTime 列在 Drift 中以 unix 秒（int）存储；customSelect 不能
      // 自动反序列化，这里手工读取
      final createdAtRaw = row.read<int>('createdAt');
      final createdAt =
          DateTime.fromMillisecondsSinceEpoch(createdAtRaw * 1000, isUtc: false);

      final metadataStr = row.read<String?>('metadata') ?? '{}';
      final meta = MessageMetadata.fromJsonString(metadataStr);

      if (meta.generatedImages.isEmpty) continue;

      for (final image in meta.generatedImages) {
        final imageId = image.id;
        if (imageId.isEmpty) continue;

        final versions = _normalizeImageVersions(image);
        for (var i = versions.length - 1; i >= 0; i--) {
          final v = versions[i];
          final localPath = _readVersionLocalPath(v);
          if (localPath.isEmpty) continue;
          result.add(CharacterImageItem(
            messageId: messageId,
            conversationId: conversationId,
            conversationTitle: conversationTitle,
            createdAt: createdAt,
            imageId: imageId,
            versionId: v.id.isEmpty ? imageId : v.id,
            localPath: localPath,
            prompt: v.prompt ?? '',
          ));
        }
      }
    }

    return result;
  }

  /// 批量删除生图版本（事务内 metadata 更新与统计，Task 12.2）
  ///
  /// 行为对齐 Node.js 端 `src/app/api/characters/[id]/images/route.ts` 的 DELETE：
  ///
  /// 1. 先按 `messageId` 分组 `items`，避免循环中修改 image 稳定 ID 后选中失效。
  /// 2. 在 Drift 事务内对每条命中消息：
  ///    - 若某 image 的所有 version 都在删除集合 → 整条移除该 image；
  ///    - 仅部分 version 被删 → 保留 `image.id` 不变，仅从 `image.versions`
  ///      移除对应 version；`activeVersion` 指向被删 version 时重新指向
  ///      `min(prevActive, remaining.length - 1)`，并把顶层 `url` / `prompt`
  ///      同步到新的 active version。
  /// 3. 收集被移除 version 的本地文件路径与计数。
  /// 4. **事务外**调用 [_scanAllReferencedPaths] 扫描全库消息 metadata 与角色头像，
  ///    仅对「不再被任何引用」的本地路径调用 [_safeDeleteFile] 真正删除文件；
  ///    删除失败仅记录日志，不抛错（与 design.md「P1 / R11」对齐）。
  Future<DeleteImageResult> deleteImages(
    String characterId,
    List<DeleteImageTarget> items,
  ) async {
    if (items.isEmpty) {
      return const DeleteImageResult(deletedCount: 0, deletedPaths: <String>{});
    }

    final byMsg = <String, List<DeleteImageTarget>>{};
    for (final t in items) {
      (byMsg[t.messageId] ??= <DeleteImageTarget>[]).add(t);
    }

    final deletedPaths = <String>{};
    var deletedCount = 0;

    await _db.transaction(() async {
      for (final entry in byMsg.entries) {
        final rows = await _db.customSelect(
          '''
          SELECT messages.id AS messageId, messages.metadata AS metadata
          FROM messages
          INNER JOIN conversations ON conversations.id = messages.conversation_id
          WHERE messages.id = ?
            AND conversations.character_id = ?
          LIMIT 1
          ''',
          variables: [
            Variable<String>(entry.key),
            Variable<String>(characterId),
          ],
          readsFrom: {_db.messages, _db.conversations},
        ).get();
        if (rows.isEmpty) continue;

        final row = rows.first;
        final messageId = row.read<String>('messageId');
        final metadataStr = row.read<String?>('metadata') ?? '{}';
        final meta = MessageMetadata.fromJsonString(metadataStr);

        if (meta.generatedImages.isEmpty) continue;

        final newImgs = <GeneratedImage>[];
        for (final image in meta.generatedImages) {
          final imageId = image.id;

          final delIds = entry.value
              .where((t) => t.imageId == imageId)
              .map((t) => t.versionId)
              .toSet();
          if (delIds.isEmpty) {
            newImgs.add(image);
            continue;
          }

          final versions = _normalizeImageVersions(image);

          for (final v in versions) {
            if (delIds.contains(v.id.isEmpty ? imageId : v.id)) {
              final p = _readVersionLocalPath(v);
              if (p.isNotEmpty) deletedPaths.add(p);
              deletedCount++;
            }
          }

          final remaining = versions
              .where((v) => !delIds.contains(v.id.isEmpty ? imageId : v.id))
              .toList();
          if (remaining.isEmpty) {
            continue;
          }

          final prevActive = image.activeVersion;
          final clampedActive = prevActive < 0 ? 0 : prevActive;
          final nextActive = clampedActive >= remaining.length
              ? remaining.length - 1
              : clampedActive;
          final cur = remaining[nextActive];
          newImgs.add(image.copyWith(
            url: cur.url.isNotEmpty ? cur.url : (cur.path ?? image.url),
            prompt: cur.prompt ?? image.prompt ?? '',
            versions: remaining,
            activeVersion: nextActive,
          ));
        }

        final newMeta = meta.copyWith(generatedImages: newImgs);
        await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
            .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
      }
    });

    await scanAndDeleteOrphanFiles(deletedPaths);

    return DeleteImageResult(
      deletedCount: deletedCount,
      deletedPaths: deletedPaths,
    );
  }

  /// 事务外：在事务提交后调用 [scanAndDeleteOrphanFiles]，对收集到的待删本地路径
  /// 做引用扫描，仅删除已无任何引用的文件
  ///
  /// 设计动机：把「写库」与「删文件」拆成两阶段，避免事务回滚后留下孤儿文件，
  /// 也避免误删仍被其它消息 / 角色 avatar 引用的资产（与 R10 共享 [extractLocalPaths]
  /// 工具，确保扫描位置一致）。删文件失败不会再抛回调用方，仅打印日志。
  ///
  /// 抽出独立公开方法供测试单独覆盖与未来批量清理复用。
  Future<void> scanAndDeleteOrphanFiles(Set<String> deletedPaths) async {
    if (deletedPaths.isEmpty) return;
    final stillReferenced = await _scanAllReferencedPaths();
    for (final path in deletedPaths) {
      if (path.isEmpty) continue;
      if (stillReferenced.contains(path)) continue;
      await _safeDeleteFile(path);
    }
  }

  /// 扫描全库当前仍被引用的本地资产路径集合
  ///
  /// 扫描位置：
  /// 1. 所有 `messages.metadata` 中 [extractLocalPaths] 涵盖的四类字段
  /// 2. 所有 `characters.avatar_url` 中的本地路径
  ///
  /// 返回去重后的 Set，调用方可直接 `contains` 判断单个路径是否仍有引用。
  Future<Set<String>> _scanAllReferencedPaths() async {
    final referenced = <String>{};

    // 1) 全库消息 metadata 与 content
    final messageRows = await _db.customSelect(
      'SELECT metadata, content FROM messages',
      readsFrom: {_db.messages},
    ).get();
    for (final row in messageRows) {
      final raw = row.read<String?>('metadata');
      if (raw != null && raw.isNotEmpty) {
        final meta = MessageMetadata.fromJsonString(raw);
        referenced.addAll(extractLocalPaths(meta.toJson()));
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

  /// 安全删除单个本地文件：异常仅记录日志，不抛回调用方
  ///
  /// - 文件不存在视为成功
  /// - 删除失败（权限不足、占用等）打印一条警告日志后吞掉，避免一次失败阻塞批量
  Future<void> _safeDeleteFile(String path) async {
    try {
      final f = File(path);
      if (await f.exists()) {
        await f.delete();
      }
    } catch (e) {
      // 与 R10 `_safeDeletePendingFiles` 保持一致的日志风格
      debugPrint('[CharacterImagesActions.deleteImages] 删除本地文件失败: $path（$e）');
    }
  }

  // ───────────────────────── 内部辅助 ─────────────────────────

  List<ImageVersion> _normalizeImageVersions(GeneratedImage image) {
    if (image.versions.isNotEmpty) return image.versions;
    final imageLocalPath = _readImageLocalPath(image);
    return [
      ImageVersion(id: image.id, url: imageLocalPath, prompt: image.prompt ?? ''),
    ];
  }

  String _readImageLocalPath(GeneratedImage image) {
    if (image.url.isNotEmpty) return image.url;
    if (image.path != null && image.path!.isNotEmpty) return image.path!;
    return '';
  }

  String _readVersionLocalPath(ImageVersion v) {
    if (v.url.isNotEmpty) return v.url;
    if (v.path != null && v.path!.isNotEmpty) return v.path!;
    return '';
  }
}
