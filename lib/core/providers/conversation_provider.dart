import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/message_metadata.dart';
import '../utils/local_asset_utils.dart';
import 'character_images_actions.dart';
import 'database_provider.dart';

/// 记忆提取操作类型
///
/// 替换原先的字符串参数 `'reset'` / `'mark'`，编译期即可校验合法性。
enum ExtractionAction { reset, mark }

/// 记忆提取重置 / 标记结果
///
/// - [affectedCount]：实际发生 metadata 变更的消息条数（已经为目标状态的消息不计入）
/// - [action]：本次执行的动作
class ResetExtractionResult {
  final int affectedCount;
  final ExtractionAction action;

  const ResetExtractionResult({
    required this.affectedCount,
    required this.action,
  });
}

/// 某角色的对话列表 Provider
final conversationListProvider =
    StreamProvider.family<List<Conversation>, String>((ref, characterId) {
      final db = ref.watch(databaseProvider);
      return (db.select(db.conversations)
            ..where((t) => t.characterId.equals(characterId))
            ..orderBy([
              (t) => OrderingTerm(
                expression: t.updatedAt,
                mode: OrderingMode.desc,
              ),
            ]))
          .watch();
    });

/// 当前活跃对话 ID
final activeConversationIdProvider = StateProvider<String?>((ref) => null);

/// 对话操作
final conversationActionsProvider = Provider<ConversationActions>((ref) {
  return ConversationActions(
    ref.read(databaseProvider),
    ref.read(characterImagesActionsProvider),
  );
});

class ConversationActions {
  final AppDatabase _db;
  final CharacterImagesActions _imagesActions;
  static const _uuid = Uuid();

  ConversationActions(this._db, [CharacterImagesActions? imagesActions])
    : _imagesActions = imagesActions ?? CharacterImagesActions(_db);

  /// 创建对话
  Future<String> create({
    required String characterId,
    String title = '新的对话',
  }) async {
    final id = _uuid.v4();
    final now = DateTime.now();

    await _db
        .into(_db.conversations)
        .insert(
          ConversationsCompanion.insert(
            id: id,
            characterId: characterId,
            title: Value(title),
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );

    return id;
  }

  /// 重命名对话
  Future<void> rename(String id, String title) async {
    await (_db.update(_db.conversations)..where((t) => t.id.equals(id))).write(
      ConversationsCompanion(
        title: Value(title),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  /// 切换忽略记忆
  Future<void> toggleIgnoreMemory(String id, bool ignore) async {
    await (_db.update(_db.conversations)..where((t) => t.id.equals(id))).write(
      ConversationsCompanion(
        ignoreMemory: Value(ignore ? 1 : 0),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  /// 删除对话（级联删除消息和记忆任务，并清理本地资产文件）
  ///
  /// P0-1 修复：之前仅删数据库，会留下消息中引用的生图/附件等孤儿文件。
  /// 策略与 [CharacterActions.delete] 一致：
  /// 1. 事务前扫描对话下所有消息 metadata，收集本地路径；
  /// 2. 事务内级联删除数据库行；
  /// 3. 事务提交后调用 [CharacterImagesActions.scanAndDeleteOrphanFiles]，
  ///    扫描全库引用后仅删除不再被任何记录引用的文件。
  Future<void> delete(String id) async {
    // 1. 事务前收集本对话所有消息中的本地资产路径
    final pendingDelete = <String>{};
    final msgs = await (_db.select(
      _db.messages,
    )..where((t) => t.conversationId.equals(id))).get();
    for (final msg in msgs) {
      try {
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        pendingDelete.addAll(extractLocalPaths(meta.toJson()));
      } catch (_) {
        // 单条 metadata 解析失败不阻塞删除
      }
      if (msg.content.isNotEmpty) {
        pendingDelete.addAll(collectLocalAssetUrlsFromContent(msg.content));
      }
    }

    // 2. 事务内级联删除数据库行
    await _db.transaction(() async {
      await (_db.delete(
        _db.messages,
      )..where((t) => t.conversationId.equals(id))).go();
      await (_db.delete(
        _db.memoryTasks,
      )..where((t) => t.conversationId.equals(id))).go();
      await (_db.delete(_db.conversations)..where((t) => t.id.equals(id))).go();
    });

    // 3. 事务成功后做引用扫描 + 安全删除孤儿文件（best-effort）
    try {
      await _imagesActions.scanAndDeleteOrphanFiles(pendingDelete);
    } catch (e) {
      debugPrint('[ConversationActions.delete] 清理孤儿文件失败: $e');
    }
  }

  /// 复制对话（含所有消息）
  ///
  /// FIX(Major-2)：原实现只复制 DB 行，message metadata 中的 url/path
  /// 仍然指向原对话的本地文件。当用户后续删除原对话时，孤儿清理流程会扫描全库
  /// 引用，新对话与原对话共享同一物理文件意味着删除一方仍能保留文件；但反过来，
  /// 若用户先在副本里删除某张图片，扫描结果显示「仍被原对话引用」→ 文件保留，
  /// 表面看起来正常；可一旦原对话先被删，扫描仍会因为副本引用而保留文件——
  /// 但此时副本里的引用其实指向**未隔离的同一物理文件**，跨对话的删除/编辑
  /// 会互相影响（例如 R11 角色图片管理批量删除时把"另一份副本"也清掉）。
  ///
  /// 修复策略与 [CharacterActions.duplicate] 对齐，分三步：
  /// 1. pre-tx：扫描全部消息 metadata 收集本地路径（去重），逐个复制文件，
  ///            构造旧→新路径映射 `pathMapping`，把每个新文件路径记入
  ///            `pendingNewFiles`（局部变量，不复用实例字段）。
  /// 2. tx：插入新对话与新消息时，用 `remapLocalPaths` 把 metadata 中的
  ///            url/path 全部改写为新文件路径。
  /// 3. 失败回滚：复制阶段自身失败、事务抛错都清理 `pendingNewFiles`，
  ///            清理 IO 异常仅记录日志，不再次抛出。
  Future<String> duplicate(String id) async {
    final original = await (_db.select(
      _db.conversations,
    )..where((t) => t.id.equals(id))).getSingle();

    // 预读全部消息，pre-tx 阶段先扫描资产
    final messages =
        await (_db.select(_db.messages)
              ..where((t) => t.conversationId.equals(id))
              ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
            .get();

    // FIX(Major-2)：收集所有消息 metadata 中的本地资产路径（去重）
    final assetSet = <String>{};
    for (final msg in messages) {
      try {
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        assetSet.addAll(extractLocalPaths(meta.toJson()));
      } catch (_) {
        // 单条 metadata 解析失败不阻塞复制流程
      }
    }

    // FIX(Major-2)：每个旧路径只复制一次，构造「旧→新」映射；
    // 局部变量随方法调用栈生命周期管理，避免跨调用串扰。
    final pendingNewFiles = <String>[];
    final pathMapping = <String, String>{};
    try {
      for (final oldPath in assetSet) {
        final newPath = await copyLocalAsset(oldPath);
        pendingNewFiles.add(newPath);
        pathMapping[oldPath] = newPath;
      }
    } catch (_) {
      // 复制阶段自身失败：清理已成功的新文件，避免孤儿
      await _safeDeletePendingFiles(pendingNewFiles);
      rethrow;
    }

    final newId = _uuid.v4();
    final now = DateTime.now();

    // FIX(Major-2)：DB 写入用事务包住，任一失败回滚后再清理已复制的新文件
    try {
      await _db.transaction(() async {
        await _db
            .into(_db.conversations)
            .insert(
              ConversationsCompanion.insert(
                id: newId,
                characterId: original.characterId,
                title: Value('${original.title} (副本)'),
                createdAt: Value(now),
                updatedAt: Value(now),
              ),
            );

        for (final msg in messages) {
          final msgId = _uuid.v4();

          // FIX(Major-2)：解析 metadata，按 pathMapping 重写 url/path 字段
          String newMetadataJson = msg.metadata;
          try {
            final meta = MessageMetadata.fromJsonString(msg.metadata);
            final remapped = remapLocalPaths(meta.toJson(), pathMapping);
            newMetadataJson = jsonEncode(remapped);
          } catch (_) {
            // 解析失败保留原 metadata；assetSet 里若没有它的路径就不会出问题，
            // 若解析就失败的 metadata 包含本地路径则属于历史脏数据，不在本次修复范围。
          }

          await _db
              .into(_db.messages)
              .insert(
                MessagesCompanion.insert(
                  id: msgId,
                  conversationId: newId,
                  role: msg.role,
                  content: Value(msg.content),
                  tokenCount: Value(msg.tokenCount),
                  seq: Value(msg.seq),
                  createdAt: Value(msg.createdAt),
                  metadata: Value(newMetadataJson),
                ),
              );
        }
      });
    } catch (_) {
      // FIX(Major-2)：事务失败时清理已复制出的新文件，避免孤儿
      await _safeDeletePendingFiles(pendingNewFiles);
      rethrow;
    }

    return newId;
  }

  /// 兜底：删除已复制出的新文件（IO 异常仅吞掉不再次抛出）
  ///
  /// FIX(Major-2)：与 [CharacterActions._safeDeletePendingFiles] 同构。
  /// 参数化为 `pendingFiles`（局部 List），不依赖任何实例字段，避免跨调用串扰。
  Future<void> _safeDeletePendingFiles(List<String> pendingFiles) async {
    for (final path in pendingFiles) {
      try {
        final f = File(path);
        if (await f.exists()) {
          await f.delete();
        }
      } catch (_) {
        debugPrint('[ConversationActions.duplicate] 清理新文件失败: $path');
      }
    }
  }

  /// 记忆提取状态批量重置 / 标记
  ///
  /// - [conversationId]：目标对话
  /// - [messageIds]：可选的目标消息 ID 列表；缺省时作用范围为该对话所有 user 消息
  /// - [action]：[ExtractionAction.reset] 清除 `memory_extracted`；
  ///   [ExtractionAction.mark] 写入 `memory_extracted = true`
  ///
  /// 仅在 metadata 实际发生变化时计入 [ResetExtractionResult.affectedCount]，
  /// 因此连续两次同 action 调用，第二次返回的 affectedCount 会为 0（幂等）。
  Future<ResetExtractionResult> resetExtraction(
    String conversationId, {
    List<String>? messageIds,
    required ExtractionAction action,
  }) async {
    // 选择目标消息：传入 messageIds 时按 ID 过滤；缺省时与未提取计数保持一致，取所有 user 消息。
    final query = _db.select(_db.messages)
      ..where((t) {
        final scoped = t.conversationId.equals(conversationId);
        if (messageIds != null && messageIds.isNotEmpty) {
          return scoped & t.id.isIn(messageIds);
        }
        return scoped & t.role.equals('user');
      });
    final rows = await query.get();

    var count = 0;
    await _db.transaction(() async {
      for (final m in rows) {
        final meta = MessageMetadata.fromJsonString(m.metadata);

        final cur = meta.memoryExtracted;
        if (action == ExtractionAction.mark) {
          if (cur) continue;
          final newMeta = meta.copyWith(memoryExtracted: true);
          await (_db.update(
            _db.messages,
          )..where((t) => t.id.equals(m.id))).write(
            MessagesCompanion(metadata: Value(newMeta.toJsonString())),
          );
        } else {
          if (!cur) continue;
          final newMeta = meta.copyWith(memoryExtracted: false);
          await (_db.update(
            _db.messages,
          )..where((t) => t.id.equals(m.id))).write(
            MessagesCompanion(metadata: Value(newMeta.toJsonString())),
          );
        }

        count++;
      }
    });

    return ResetExtractionResult(affectedCount: count, action: action);
  }
}
