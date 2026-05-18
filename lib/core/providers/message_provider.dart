import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/message_metadata.dart';
import '../utils/message_utils.dart';
import '../utils/token_counter.dart';
import 'database_provider.dart';

/// 某对话的消息列表 Provider
///
/// 数据出口统一兜底：在最终输出给 ListView 之前调用 `uniqueById`，
/// 用于导入对话备份后旧 ID / 新 ID 重叠的兜底防御，避免 Flutter
/// 因 `ValueKey('msg_${id}')` 重复触发 widgets 异常（参见 R17）。
final messageListProvider =
    StreamProvider.family<List<Message>, String>((ref, conversationId) {
  final db = ref.watch(databaseProvider);
  return (db.select(db.messages)
        ..where((t) => t.conversationId.equals(conversationId))
        ..orderBy([
          (t) => OrderingTerm(expression: t.createdAt, mode: OrderingMode.asc),
          (t) => OrderingTerm(expression: t.seq, mode: OrderingMode.asc),
        ]))
      .watch()
      .map((rows) => uniqueById(rows));
});

/// 消息操作
final messageActionsProvider = Provider<MessageActions>((ref) {
  return MessageActions(ref.read(databaseProvider));
});

class MessageActions {
  final AppDatabase _db;
  static const _uuid = Uuid();

  MessageActions(this._db);

  /// 插入用户消息
  Future<String> insertUserMessage({
    required String conversationId,
    required String content,
    List<Map<String, dynamic>>? attachments,
  }) async {
    final id = _uuid.v4().substring(0, 8);
    final now = DateTime.now();
    final tokenCount = estimateTokens(content);
    final nextSeq = await _getNextSeq(conversationId);

    String metadata = '{}';
    if (attachments != null && attachments.isNotEmpty) {
      metadata = jsonEncode({'attachments': attachments});
    }

    await _db.into(_db.messages).insert(MessagesCompanion.insert(
      id: id,
      conversationId: conversationId,
      role: 'user',
      content: Value(content),
      tokenCount: Value(tokenCount),
      seq: Value(nextSeq),
      createdAt: Value(now),
      metadata: Value(metadata),
    ));

    // 更新对话时间
    await (_db.update(_db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .write(ConversationsCompanion(updatedAt: Value(now)));

    return id;
  }

  /// 插入 AI 回复消息
  Future<String> insertAssistantMessage({
    required String conversationId,
    required String content,
  }) async {
    final id = _uuid.v4().substring(0, 8);
    final now = DateTime.now();
    final tokenCount = estimateTokens(content);
    final nextSeq = await _getNextSeq(conversationId);

    final meta = MessageMetadata(
      versions: [MessageVersion(content: content, tokenCount: tokenCount)],
      activeVersion: 0,
    ).toJsonString();

    await _db.into(_db.messages).insert(MessagesCompanion.insert(
      id: id,
      conversationId: conversationId,
      role: 'assistant',
      content: Value(content),
      tokenCount: Value(tokenCount),
      seq: Value(nextSeq),
      createdAt: Value(now),
      metadata: Value(meta),
    ));

    await (_db.update(_db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .write(ConversationsCompanion(updatedAt: Value(now)));

    return id;
  }

  /// 重新生成时更新 assistant 消息（版本系统）
  Future<void> updateAssistantRegenerate({
    required String messageId,
    required String newContent,
  }) async {
    final existing = await (_db.select(_db.messages)
          ..where((t) => t.id.equals(messageId)))
        .getSingle();

    final tokenCount = estimateTokens(newContent);
    final meta = MessageMetadata.fromJsonString(existing.metadata);

    var newVersions = List<MessageVersion>.from(meta.versions);

    if (newVersions.isEmpty) {
      newVersions.add(MessageVersion(
        content: existing.content,
        tokenCount: existing.tokenCount,
      ));
    }

    newVersions.add(MessageVersion(content: newContent, tokenCount: tokenCount));

    final newMeta = meta.copyWith(
      versions: newVersions,
      activeVersion: newVersions.length - 1,
    );

    await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
        .write(MessagesCompanion(
      content: Value(newContent),
      tokenCount: Value(tokenCount),
      metadata: Value(newMeta.toJsonString()),
    ));
  }

  /// 切换版本 — 更新 activeVersion 并同步 content/tokenCount
  Future<void> switchVersion(String messageId, int versionIndex) async {
    final existing = await (_db.select(_db.messages)
          ..where((t) => t.id.equals(messageId)))
        .getSingle();

    final meta = MessageMetadata.fromJsonString(existing.metadata);

    if (meta.versions.isEmpty || versionIndex < 0 || versionIndex >= meta.versions.length) {
      return;
    }

    final targetVersion = meta.versions[versionIndex];
    final content = targetVersion.content;
    final tokenCount = targetVersion.tokenCount ?? estimateTokens(content);

    final newMeta = meta.copyWith(activeVersion: versionIndex);

    await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
        .write(MessagesCompanion(
      content: Value(content),
      tokenCount: Value(tokenCount),
      metadata: Value(newMeta.toJsonString()),
    ));
  }

  /// 编辑消息内容
  ///
  /// 与 Node.js 主项目 `PUT /api/messages/[id]` 的行为对齐：
  /// - 顶层 `content` / `tokenCount` 必须更新；
  /// - 若 `metadata.versions` 非空且 `activeVersion` 是合法下标，
  ///   则同步 `versions[activeVersion].content` 与 `token_count`，
  ///   避免下次切换版本时被旧内容覆盖；
  /// - 若 `versions` 缺失或为空数组，不创建空数组，仅写顶层；
  /// - 若 `activeVersion` 越界，只写顶层并打印 `versionIndexOutOfRange` 警告。
  /// 三字段一并落库，事务保证原子性。
  Future<void> editContent(String messageId, String newContent) async {
    final newTokens = estimateTokens(newContent);

    await _db.transaction(() async {
      final existing = await (_db.select(_db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingle();

      final meta = MessageMetadata.fromJsonString(existing.metadata);

      bool metadataChanged = false;
      List<MessageVersion>? newVersions;

      if (meta.versions.isNotEmpty) {
        final activeRaw = meta.activeVersion;
        if (activeRaw != null && activeRaw >= 0 && activeRaw < meta.versions.length) {
          newVersions = List<MessageVersion>.from(meta.versions);
          newVersions[activeRaw] = newVersions[activeRaw].copyWith(
            content: newContent,
            tokenCount: newTokens,
          );
          metadataChanged = true;
        } else if (activeRaw != null) {
          // 越界（含负数）：仅写顶层，记录警告，不创建空数组
          // ignore: avoid_print
          print(
            '[editContent] versionIndexOutOfRange: '
            'activeVersion=$activeRaw, length=${meta.versions.length}, '
            'messageId=$messageId',
          );
        }
      }

      final newMeta = metadataChanged ? meta.copyWith(versions: newVersions) : meta;

      await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(
        content: Value(newContent),
        tokenCount: Value(newTokens),
        metadata: metadataChanged
            ? Value(newMeta.toJsonString())
            : const Value.absent(),
      ));
    });
  }

  /// 智能删除消息 — 多版本只删当前版本，仅剩一个版本时删整条消息
  Future<void> delete(String messageId) async {
    final existing = await (_db.select(_db.messages)
          ..where((t) => t.id.equals(messageId)))
        .getSingleOrNull();

    if (existing == null) return;

    final meta = MessageMetadata.fromJsonString(existing.metadata);

    if (meta.versions.length > 1) {
      final activeVersion = meta.activeVersion ?? 0;
      final newVersions = List<MessageVersion>.from(meta.versions);
      newVersions.removeAt(activeVersion);
      final newActive = activeVersion >= newVersions.length
          ? newVersions.length - 1
          : activeVersion;

      final targetVersion = newVersions[newActive];
      final content = targetVersion.content;
      final tokenCount = targetVersion.tokenCount ?? estimateTokens(content);

      final newMeta = meta.copyWith(
        versions: newVersions,
        activeVersion: newActive,
      );

      await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(
        content: Value(content),
        tokenCount: Value(tokenCount),
        metadata: Value(newMeta.toJsonString()),
      ));
    } else {
      // 只有一个版本或无版本信息，删除整条消息
      await (_db.delete(_db.messages)..where((t) => t.id.equals(messageId)))
          .go();
    }
  }

  /// 删除消息中的指定附件（按索引）
  Future<void> deleteAttachment(String messageId, int attachmentIndex) async {
    await _db.transaction(() async {
      final existing = await (_db.select(_db.messages)
            ..where((t) => t.id.equals(messageId)))
          .getSingleOrNull();
      if (existing == null) return;

      final meta = MessageMetadata.fromJsonString(existing.metadata);
      final attachments = List<AttachmentData>.from(meta.attachments);
      if (attachmentIndex < 0 || attachmentIndex >= attachments.length) return;

      attachments.removeAt(attachmentIndex);
      final newMeta = meta.copyWith(attachments: attachments);

      await (_db.update(_db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(
        metadata: Value(newMeta.toJsonString()),
      ));
    });
  }

  /// 获取下一个 seq
  Future<int> _getNextSeq(String conversationId) async {
    final result = await (_db.selectOnly(_db.messages)
          ..addColumns([_db.messages.seq.max()])
          ..where(_db.messages.conversationId.equals(conversationId)))
        .getSingleOrNull();
    final maxSeq = result?.read(_db.messages.seq.max()) ?? 0;
    return maxSeq + 1;
  }
}
