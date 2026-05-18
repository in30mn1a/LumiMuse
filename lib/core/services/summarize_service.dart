import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/message_metadata.dart';
import '../utils/token_counter.dart';
import 'llm_service.dart';

/// 对话总结服务
class SummarizeService {
  final AppDatabase _db;
  final LlmService _llm;
  static const _uuid = Uuid();

  SummarizeService(this._db) : _llm = LlmService();

  /// 总结对话 — 加载最后一次总结之后的所有消息，生成总结并插入为系统消息
  Future<void> summarize(String conversationId, AppSettings settings) async {
    // 1. 加载所有消息
    final allMessages = await (_db.select(_db.messages)
          ..where((t) => t.conversationId.equals(conversationId))
          ..orderBy([
            (t) => OrderingTerm.asc(t.createdAt),
            (t) => OrderingTerm.asc(t.seq),
          ]))
        .get();

    if (allMessages.isEmpty) return;

    // 2. 找到最后一条总结消息的位置
    int lastSummaryIdx = -1;
    for (int i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role == 'system') {
        final meta = MessageMetadata.fromJsonString(allMessages[i].metadata);
        if (meta.isSummary) {
          lastSummaryIdx = i;
          break;
        }
      }
    }

    // 3. 获取需要总结的消息（最后一次总结之后的）
    final messagesToSummarize = lastSummaryIdx >= 0
        ? allMessages.sublist(lastSummaryIdx + 1)
        : allMessages;

    if (messagesToSummarize.isEmpty) return;
    // 对照主项目：至少 2 条消息才值得总结
    if (messagesToSummarize.length < 2) return;

    // 4. 构建总结 prompt — 对照主项目 src/app/api/summarize/route.ts
    // 获取角色名称
    final conversation = await (_db.select(_db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .getSingleOrNull();
    String characterName = '角色';
    if (conversation != null) {
      final character = await (_db.select(_db.characters)
            ..where((t) => t.id.equals(conversation.characterId)))
          .getSingleOrNull();
      if (character != null) characterName = character.name;
    }

    final convBuffer = StringBuffer();
    for (final msg in messagesToSummarize) {
      if (msg.content.isEmpty) continue;
      if (msg.role != 'user' && msg.role != 'assistant') continue;
      final roleLabel = msg.role == 'user' ? '用户' : characterName;
      convBuffer.writeln('$roleLabel: ${msg.content}');
      convBuffer.writeln();
    }

    final conversationText = convBuffer.toString();
    if (conversationText.trim().isEmpty) return;

    final summaryPrompt = '你是一个对话总结助手。请根据以下对话内容，生成一份简洁的总结，格式如下：\n\n'
        '## 📖 近期对话回顾\n'
        '（用 2-4 句话概括最近发生的主要事情，重点是情感走向和关键事件）\n\n'
        '## 💡 接下来可以聊\n'
        '（给出 2-3 条自然的对话延续建议，语气轻松，像朋友提议一样）\n\n'
        '注意：\n'
        '- 总结要温柔、有陪伴感，符合角色 $characterName 的风格\n'
        '- 不要列举每一条消息，要提炼核心\n'
        '- 建议要具体，不要太泛泛\n\n'
        '对话内容：\n$conversationText';

    final messages = [
      ChatMessage(role: 'user', content: summaryPrompt),
    ];

    // 5. 调用 LLM
    final summaryText = await _llm.chatCompletion(
      settings: settings,
      messages: messages,
    );

    if (summaryText.trim().isEmpty) return;

    // 6. 插入总结消息
    final id = _uuid.v4().substring(0, 8);
    final now = DateTime.now();
    final tokenCount = estimateTokens(summaryText);

    // 获取下一个 seq
    final result = await (_db.selectOnly(_db.messages)
          ..addColumns([_db.messages.seq.max()])
          ..where(_db.messages.conversationId.equals(conversationId)))
        .getSingleOrNull();
    final maxSeq = result?.read(_db.messages.seq.max()) ?? 0;
    final nextSeq = maxSeq + 1;

    final meta = MessageMetadata(
      isSummary: true,
      summarizedIds: messagesToSummarize.map((m) => m.id).toList(),
    ).toJsonString();

    await _db.into(_db.messages).insert(MessagesCompanion.insert(
      id: id,
      conversationId: conversationId,
      role: 'system',
      content: Value(summaryText),
      tokenCount: Value(tokenCount),
      seq: Value(nextSeq),
      createdAt: Value(now),
      metadata: Value(meta),
    ));

    // 更新对话时间
    await (_db.update(_db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .write(ConversationsCompanion(updatedAt: Value(now)));
  }

  void dispose() {
    _llm.dispose();
  }
}
