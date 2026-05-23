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
          (t) => OrderingTerm(expression: t.updatedAt, mode: OrderingMode.desc),
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

    await _db.into(_db.conversations).insert(ConversationsCompanion.insert(
      id: id,
      characterId: characterId,
      title: Value(title),
      createdAt: Value(now),
      updatedAt: Value(now),
    ));

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
    final msgs = await (_db.select(_db.messages)
          ..where((t) => t.conversationId.equals(id)))
        .get();
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
      await (_db.delete(_db.messages)
            ..where((t) => t.conversationId.equals(id)))
          .go();
      await (_db.delete(_db.memoryTasks)
            ..where((t) => t.conversationId.equals(id)))
          .go();
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
  Future<String> duplicate(String id) async {
    final original = await (_db.select(_db.conversations)
          ..where((t) => t.id.equals(id)))
        .getSingle();

    final newId = _uuid.v4();
    final now = DateTime.now();

    await _db.into(_db.conversations).insert(ConversationsCompanion.insert(
      id: newId,
      characterId: original.characterId,
      title: Value('${original.title} (副本)'),
      createdAt: Value(now),
      updatedAt: Value(now),
    ));

    // 复制所有消息
    final messages = await (_db.select(_db.messages)
          ..where((t) => t.conversationId.equals(id))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .get();

    for (final msg in messages) {
      final msgId = _uuid.v4();
      await _db.into(_db.messages).insert(MessagesCompanion.insert(
        id: msgId,
        conversationId: newId,
        role: msg.role,
        content: Value(msg.content),
        tokenCount: Value(msg.tokenCount),
        seq: Value(msg.seq),
        createdAt: Value(msg.createdAt),
        metadata: Value(msg.metadata),
      ));
    }

    return newId;
  }

  /// 记忆提取状态批量重置 / 标记
  ///
  /// - [conversationId]：目标对话
  /// - [messageIds]：可选的目标消息 ID 列表；缺省时作用范围为该对话所有 assistant 消息
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
    // 选择目标消息：传入 messageIds 时按 ID 过滤；缺省时取所有 assistant 消息
    final query = _db.select(_db.messages)
      ..where((t) {
        final scoped = t.conversationId.equals(conversationId);
        if (messageIds != null && messageIds.isNotEmpty) {
          return scoped & t.id.isIn(messageIds);
        }
        return scoped & t.role.equals('assistant');
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
          await (_db.update(_db.messages)..where((t) => t.id.equals(m.id)))
              .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
        } else {
          if (!cur) continue;
          final newMeta = meta.copyWith(memoryExtracted: false);
          await (_db.update(_db.messages)..where((t) => t.id.equals(m.id)))
              .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
        }

        count++;
      }
    });

    return ResetExtractionResult(affectedCount: count, action: action);
  }
}
