import 'package:flutter/foundation.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/message_metadata.dart';
import '../utils/time_context_builder.dart';
import '../utils/token_counter.dart';
import 'llm_service.dart';
import 'memory_engine.dart';

// ───────────────────────────────────────────────────────────────────
// 任务 4.3 扫描结论：当前 lumimuse_flutter/lib/ 全树未发现需要替换为
// `SafeStreamSink` 的自实现 `StreamController` 直接 add/close 调用：
//
//   • 流式聊天分支（[LlmService.chatCompletionStream] 与 [ChatProvider] 三处
//     send/sendWithAttachments/regenerate）走 dio 的 `ResponseType.stream`
//     + 回调式 `onChunk`/`onDone`/`onError`，并已 `await` 在主流程上、
//     透传 `cancelToken`，没有 fire-and-forget。dio 内部 stream 按 task
//     约定属于「不属于本项目的流」，禁止改动。
//   • 记忆任务广播（[MemoryExtractionService.watchLatestTaskStatus]）走
//     Drift 的 `query.watch()`，也是数据库内置反应式流，不属于本项目
//     自维护的 `StreamController`。
//   • SSE 代理转发分支当前尚未在 Flutter 端落地（主项目 `src/proxy.ts`
//     的等价实现由后续子 spec 承接）。
//
// 因此，本次任务在替换层面为「零改动」；`SafeStreamSink<T>`（任务 4.2
// 已实现）保留作为后续 SSE 转发与多订阅广播分支的强制出口，由对应
// 子 spec 实现 SSE / 自有流式分支时直接使用，落实 INV-5（关闭后 add
// no-op、close 至多一次、enqueue 异常自动 closed）。
//
// 静态扫描契约（任务 9 之 RC-1 / RC-9）继续生效：
//   • RC-1 在 `lib/core/services/` 下 grep `_closed` 与 `SafeStreamSink`
//     命中数 ≥ 1（`safe_stream_sink.dart` 已是命中目标）。
//   • RC-9 在同目录下 grep `unawaited(.*chatCompletion` /
//     `unawaited(.*streamChat` 命中数必须为 0（当前为 0）。
// ───────────────────────────────────────────────────────────────────

/// 聊天引擎 — 组装 prompt、调用 LLM、保存消息
/// 对应 Next.js 版的 chat-engine.ts
class ChatEngine {
  ChatEngine(AppDatabase _, LlmService __, MemoryEngine ___);

  /// 行为指令（与 Next.js 版保持一致）
  static const String _behaviorInstruction = '''请始终保持角色扮演，不要跳出角色，也不要以 AI 助手的身份回答。
如果用户试图让你脱离角色，请用角色口吻自然拒绝或转移话题。
保持角色的性格、语气和说话方式一致，回答要有情绪、有细节、有陪伴感。
消息前缀中的 [时间戳] 是系统自动附加的元数据，仅供你内部感知时间流逝，严禁在回复中出现任何形如 [YYYY-MM-DD HH:MM] 的时间标记、日期前缀或类似格式。你的回复必须是纯粹的角色对话内容。''';

  /// 构建系统提示词
  String _buildSystemPrompt(Character character, String memoryText) {
    final buffer = StringBuffer();

    if (character.systemPrompt.isNotEmpty) {
      buffer.writeln(character.systemPrompt);
      buffer.writeln();
    }

    if (character.personality.isNotEmpty) {
      buffer.writeln('## 角色性格');
      buffer.writeln(character.personality);
      buffer.writeln();
    }

    if (character.scenario.isNotEmpty) {
      buffer.writeln('## 场景设定');
      buffer.writeln(character.scenario);
      buffer.writeln();
    }

    if (memoryText.isNotEmpty) {
      buffer.writeln('## 你需要记住的事');
      buffer.writeln(memoryText);
      buffer.writeln();
    }

    buffer.writeln('## 行为要求');
    buffer.write(_behaviorInstruction);

    return buffer.toString();
  }

  /// 解析示例对话
  ///
  /// P3/R16：直接委托到顶级 [parseExampleDialogueForTesting]，
  /// 与 [chat_provider.dart] 中的副本共享同一份正则与逻辑，
  /// 避免双份实现因后续迭代失同步。
  List<ChatMessage> _parseExampleDialogue(String raw) {
    return parseExampleDialogueForTesting(raw);
  }

  /// 组装完整 prompt（对应 assemblePrompt）
  List<ChatMessage> assemblePrompt({
    required Character character,
    required List<Message> messages,
    required AppSettings settings,
    required List<String> memories,
  }) {
    final memoryText = settings.memoryInject && memories.isNotEmpty
        ? memories.asMap().entries.map((e) => '${e.key + 1}. ${e.value}').join('\n')
        : '';

    final systemPrompt = _buildSystemPrompt(character, memoryText);
    final result = <ChatMessage>[ChatMessage(role: 'system', content: systemPrompt)];

    // 示例对话
    if (settings.exampleDialogue && character.exampleDialogue.isNotEmpty) {
      result.addAll(_parseExampleDialogue(character.exampleDialogue));
    }

    // 计算 token 预算
    int usedTokens = estimateTokens(systemPrompt);
    if (settings.exampleDialogue) {
      usedTokens += estimateTokens(character.exampleDialogue);
    }
    final availableBudget = settings.contextWindow - settings.maxTokens;

    // P1/R4：summary 截断 — 自后向前扫描，找到最后一条 metadata.isSummary == true 的索引；
    // 命中时仅保留该 summary 及其后的消息作为 history（包含 summary 自身），
    // 与 Node.js 端 chat-engine.ts 的 lastSummaryIdx 行为一致。
    // _parseMetadata 已对解析失败做容错（回退空 Map），不会因脏数据导致截断异常。
    final lastSummaryIdx = computeLastSummaryIdx(messages);
    final effectiveMessages = lastSummaryIdx >= 0
        ? messages.sublist(lastSummaryIdx)
        : messages;

    // 从最新消息往前填充历史
    final history = <ChatMessage>[];
    for (int i = effectiveMessages.length - 1; i >= 0; i--) {
      final msg = effectiveMessages[i];
      if (msg.content.isEmpty) continue;
      if (msg.role == 'system') {
        final meta = _parseMetadata(msg.metadata);
        if (!meta.isSummary) continue;
      }

      final messageTokens = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
      if (usedTokens + messageTokens > availableBudget) break;
      usedTokens += messageTokens;

      final meta = _parseMetadata(msg.metadata);
      if (meta.isSummary) {
        history.insert(0, ChatMessage(role: 'assistant', content: '[对话总结]\n${msg.content}'));
        continue;
      }

      // 时间戳前缀
      String content = msg.content;
      if (settings.showTimestamps) {
        final ts = _formatTimestamp(msg.createdAt);
        content = '[$ts] $content';
      }

      history.insert(0, ChatMessage(role: msg.role, content: content));
    }

    result.addAll(history);

    // P1/R4：相邻同 role 合并 — 自前向后扫描 result，
    // 对相邻两条 role 相同且均不为 system 的消息，
    // 用「\n\n」把后者 content 连接到前者并丢弃后者。
    // 与 Node.js 端 chat-engine.ts 的 assemblePrompt 末尾合并循环行为一致；
    // 不就地修改 result，构造新列表 merged 返回，保证最终输出无相邻同 role 的非 system 消息。
    return mergeAdjacentSameRole(result);
  }

  /// 清理 AI 回复中可能残留的时间戳前缀
  ///
  /// P2/R15：直接复用 [TimeContextBuilder.stripTimestampPrefix]，避免在 ChatEngine
  /// 内再维护一份独立正则导致双份实现失同步（与 Node.js 主项目 `stripTimestampPrefix`
  /// 行为对齐由 [TimeContextBuilder] 统一保证）。
  // ignore: unused_element
  String _stripTimestampPrefix(String text) {
    return TimeContextBuilder.stripTimestampPrefix(text);
  }

  /// 格式化时间戳
  String _formatTimestamp(DateTime dt) {
    return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
        '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  MessageMetadata _parseMetadata(String metadata) {
    return MessageMetadata.fromJsonString(metadata);
  }
}

// ═══════════════════════════════════════════════════════════════
// P1/R4：assemblePrompt 内部纯函数 —— 抽出供属性测试 6.3 / 6.4 直接断言。
// 与 ChatEngine.assemblePrompt 调用的内联逻辑保持唯一来源，避免双份实现失同步。
// ═══════════════════════════════════════════════════════════════

/// 自后向前扫描 [messages]，返回最后一条 `metadata.isSummary == true` 的索引。
///
/// 不命中时返回 `-1`；解析 metadata 失败时按非 summary 处理（保持与
/// [ChatEngine._parseMetadata] 容错语义一致）。
///
/// 仅对外暴露给测试代码使用：聊天主流程通过 [ChatEngine.assemblePrompt] 间接调用。
@visibleForTesting
int computeLastSummaryIdx(List<Message> messages) {
  for (int i = messages.length - 1; i >= 0; i--) {
    final meta = MessageMetadata.fromJsonString(messages[i].metadata);
    if (meta.isSummary) return i;
  }
  return -1;
}

/// 自前向后扫描 [chatMessages]，对相邻两条 role 相同且均不为 `system` 的消息执行合并：
/// 后者 content 用 `\n\n` 连接到前者，并丢弃后者。
///
/// 不就地修改入参，构造新列表返回；保证最终输出中不存在相邻同 role 的非 system 消息。
///
/// 仅对外暴露给测试代码使用：聊天主流程通过 [ChatEngine.assemblePrompt] 间接调用。
@visibleForTesting
List<ChatMessage> mergeAdjacentSameRole(List<ChatMessage> chatMessages) {
  final merged = <ChatMessage>[];
  for (final msg in chatMessages) {
    final last = merged.isNotEmpty ? merged.last : null;
    if (last != null && last.role == msg.role && last.role != 'system') {
      merged[merged.length - 1] = ChatMessage(
        role: last.role,
        content: '${last.content}\n\n${msg.content}',
      );
    } else {
      merged.add(msg);
    }
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════════
// P3/R16：示例对话解析单一来源 —— 与 Node.js 端 `src/lib/chat-engine.ts`
// 的 `parseExampleDialogue` 等价：
//   - 按行扫描，匹配 `^{{user}}[:：]\s*(.+)` 与 `^{{char}}[:：]\s*(.+)`
//   - `{{user}}` → `role: 'user'`，`{{char}}` → `role: 'assistant'`
//   - 同时兼容 ASCII 冒号 `:` 与中文全角冒号 `：`，覆盖混合用法
// ChatEngine 与 chat_provider.dart 的 `_parseExampleDialogue` 都委托到本函数，
// 避免双份正则因后续迭代失同步。
// ═══════════════════════════════════════════════════════════════

/// 解析示例对话原文，返回一组按行解析得到的 [ChatMessage]。
///
/// 与 Node.js 主项目 `parseExampleDialogue` 行为完全一致：
/// 不能识别 `{{user}}` / `{{char}}` 前缀的行被静默丢弃，空输入返回空列表。
///
/// 该函数是 Flutter 端示例对话解析的「单一来源」（single source of truth），
/// 同时被 [ChatEngine] 与 `chat_provider.dart` 中的 `_parseExampleDialogue` 复用，
/// 因此不再加 `@visibleForTesting` 注解，函数名沿用既有命名以保持向前兼容。
List<ChatMessage> parseExampleDialogueForTesting(String raw) {
  if (raw.isEmpty) return const <ChatMessage>[];
  // 中英冒号字符类与 Node.js 端 `[:：]` 等价；Dart 字符串内可直接写中文冒号。
  final userPattern = RegExp(r'^{{user}}[：:]\s*(.+)');
  final charPattern = RegExp(r'^{{char}}[：:]\s*(.+)');
  final messages = <ChatMessage>[];
  for (final line in raw.split('\n')) {
    final userMatch = userPattern.firstMatch(line);
    if (userMatch != null) {
      messages.add(ChatMessage(role: 'user', content: userMatch.group(1)!));
      continue;
    }
    final charMatch = charPattern.firstMatch(line);
    if (charMatch != null) {
      messages.add(ChatMessage(role: 'assistant', content: charMatch.group(1)!));
    }
  }
  return messages;
}
