import 'dart:math' as math;

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/message_metadata.dart';
import '../utils/token_counter.dart';
import 'llm_service.dart';
import 'memory_profile_service.dart';

/// 对话总结服务 — 对照主项目 `src/app/api/summarize/route.ts`。
///
/// 与主项目的行为对等点：
/// - 只总结「最后一次总结消息之后」的内容（findLastSummaryIdx）
/// - 至少 2 条消息才值得总结
/// - 注入角色 4 字段（basic_info/personality/scenario/other_info）+ 记忆画像
///   （readMemoryProfile + renderMemoryProfile，Wave 9）
/// - 第一人称口吻 prompt（角色自称"我"，称呼用户"你"）
/// - 推理模型安全 max_tokens 下限：max(settings.max_tokens, reasoningSafeMaxTokens)
/// - 后台模型支持：主项目用 `resolveBackgroundConfig` 切换后台供应商/模型；
///   Flutter 端 AppSettings 尚无后台模型字段（Wave 13 才加 MemoryEngineSettings），
///   这里沿用主 settings 调用 `chatCompletion`，标 `TODO(Wave13)`。
class SummarizeService {
  final AppDatabase _db;
  final LlmService _llm;
  static const _uuid = Uuid();

  /// `[llm]` 可选参数仅供测试注入 mock；生产路径留空走默认 [LlmService]。
  SummarizeService(this._db, [LlmService? llm]) : _llm = llm ?? LlmService();

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

    // 2. 找到最后一条总结消息的位置（metadata.isSummary=true）
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

    // 4. 获取对话 + 角色（含 4 人设字段 + 名字）
    final conversation = await (_db.select(_db.conversations)
          ..where((t) => t.id.equals(conversationId)))
        .getSingleOrNull();
    if (conversation == null) return;

    final character = await (_db.select(_db.characters)
          ..where((t) => t.id.equals(conversation.characterId)))
        .getSingleOrNull();
    if (character == null) return;
    final characterName = character.name;

    // 5. 读取当前角色的记忆画像 — 对照 route.ts:69-70
    final profileService = MemoryProfileService(_db, _llm);
    final profile = await profileService.readMemoryProfile(
      conversation.characterId,
    );
    final renderedProfile = profile != null ? renderMemoryProfile(profile) : '';

    // 6. 拼接角色人设背景 + 记忆画像 — 对照 route.ts:73-83
    final charDetailsList = <String>[
      if (character.basicInfo.trim().isNotEmpty)
        '【基本信息】\n${character.basicInfo.trim()}',
      if (character.personality.trim().isNotEmpty)
        '【性格特征】\n${character.personality.trim()}',
      if (character.scenario.trim().isNotEmpty)
        '【场景与世界观】\n${character.scenario.trim()}',
      if (character.otherInfo.trim().isNotEmpty)
        '【其他信息】\n${character.otherInfo.trim()}',
      if (renderedProfile.trim().isNotEmpty)
        '【当前记忆画像】\n${renderedProfile.trim()}',
    ];
    final charDetailsText = charDetailsList.isNotEmpty
        ? '### 🎭 角色设定与记忆背景：\n${charDetailsList.join('\n\n')}\n\n'
        : '';

    // 7. 构建对话文本 — user 标"你"，assistant 标角色名 — 对照 route.ts:86-89
    final convBuffer = StringBuffer();
    for (final msg in messagesToSummarize) {
      if (msg.content.isEmpty) continue;
      if (msg.role != 'user' && msg.role != 'assistant') continue;
      final roleLabel = msg.role == 'user' ? '你' : characterName;
      convBuffer.writeln('$roleLabel: ${msg.content}');
      convBuffer.writeln();
    }
    final conversationText = convBuffer.toString();
    if (conversationText.trim().isEmpty) return;

    // 8. 第一人称总结 prompt — 逐字对齐 route.ts:91-107
    final summaryPrompt =
        '你是一个对话总结助手。请结合以下提供的人设背景和记忆画像，根据对话内容，以角色 $characterName 的第一人称口吻，生成一份仅供 $characterName 自己阅读的内心备忘日记，格式如下：\n\n'
        '## 📖 最近发生的事\n'
        '（用 2-4 句话以第一人称概括"我"最近和你发生的主要事情，重点记录"我"的内心感受、情感走向和关键交互事件）\n\n'
        '## 💡 接下来我可以聊\n'
        '（给出 2-3 条"我"接下来可以主动发起或提及的对话切入点，要自然并符合"我"的性格与人设）\n\n'
        '注意：\n'
        '- 必须全程使用角色 $characterName 的第一人称口吻（自称"我"或符合性格的自称，称呼用户时使用"你"）\n'
        '- 这是写给 $characterName 自己看的备忘录，不能使用第三人称或旁观者叙事视角，也不要写成是给"你"看的内容\n'
        '- 总结和后续话题建议必须深度契合人设背景和当前记忆画像\n'
        '- 不要列举每一条消息，要提炼核心\n'
        '- 建议要具体，不要太泛泛\n\n'
        '$charDetailsText'
        '对话内容：\n$conversationText';

    final messages = [
      ChatMessage(role: 'user', content: summaryPrompt),
    ];

    // 9. 调用 LLM — 后台模型支持：TODO(Wave13)，沿用主 settings
    //    max_tokens 取 max(settings.max_tokens, reasoningSafeMaxTokens)
    //    对照 route.ts:112-131
    final effectiveMaxTokens = math.max(
      settings.maxTokens,
      reasoningSafeMaxTokens,
    );
    final effectiveSettings = settings.copyWith(maxTokens: effectiveMaxTokens);
    // TODO(Wave13): AppSettings 引入 background 模型字段后，
    //   按 resolveBackgroundConfig 切换后台供应商/模型；当前沿用主接口。

    final summaryText = await _llm.chatCompletion(
      settings: effectiveSettings,
      messages: messages,
    );

    if (summaryText.trim().isEmpty) return;

    // 10. 插入总结消息 — 使用完整 UUID v4，避免截断碰撞
    final id = _uuid.v4();
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
