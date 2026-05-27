import 'dart:async';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/foundation.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../models/attachment_item.dart';
import '../models/message_metadata.dart';
import '../services/image_gen_service.dart';
import '../services/image_prompt_service.dart';
import '../services/llm_service.dart';
import '../services/memory_engine.dart';
import '../services/memory_extraction_service.dart';
import '../services/chat_engine.dart' show parseExampleDialogueForTesting;
import '../utils/attachment_processor.dart';
import '../utils/local_asset_utils.dart';
import '../utils/system_prompt_builder.dart';
import '../utils/time_context_builder.dart';
import '../utils/token_counter.dart';
import 'character_images_actions.dart';
import 'database_provider.dart';
import 'message_provider.dart';
import 'settings_provider.dart';

/// 记忆注入「无上限」时使用的占位上限值。
///
/// 替换原先散落在多处的硬编码 `9999`，避免魔法值；
/// 取一个足够大但远小于 int 上限的常量，保证下游 SQL/数组操作不会溢出。
const int _kMaxMemoriesUnlimited = 100000;

/// 聊天状态
class ChatState {
  final bool isGenerating;
  final String currentStreamText;
  final String? streamingTargetMessageId;
  final String? error;

  const ChatState({
    this.isGenerating = false,
    this.currentStreamText = '',
    this.streamingTargetMessageId,
    this.error,
  });

  ChatState copyWith({
    bool? isGenerating,
    String? currentStreamText,
    String? streamingTargetMessageId,
    bool clearStreamingTargetMessageId = false,
    String? error,
  }) {
    return ChatState(
      isGenerating: isGenerating ?? this.isGenerating,
      currentStreamText: currentStreamText ?? this.currentStreamText,
      streamingTargetMessageId: clearStreamingTargetMessageId
          ? null
          : (streamingTargetMessageId ?? this.streamingTargetMessageId),
      error: error,
    );
  }
}

/// 聊天控制器 — 管理发送消息、流式生成、停止等
///
/// 使用 StateNotifierProvider.autoDispose.family：
/// - 每个 conversationId 拥有独立的 ChatController 实例
/// - 当所有监听者移除后实例会被自动销毁，避免内存泄漏
/// - dispose 时会取消正在进行的流式请求（CancelToken.cancel），
///   防止过期回调误触发 onDone/onError 写库
/// - 错误状态记录在各自实例的 state 中，不会跨对话污染
final chatControllerProvider = StateNotifierProvider.autoDispose
    .family<ChatController, ChatState, String>(
      (ref, conversationId) => ChatController(ref, conversationId),
    );

class ChatController extends StateNotifier<ChatState> {
  final Ref _ref;
  final String _conversationId;
  final LlmService _llm = LlmService();
  CancelToken? _cancelToken;

  /// 请求自增序号，用于异步流式回调的「防重入」校验。
  ///
  /// 每次 sendMessage / sendMessageWithAttachments / regenerate /
  /// sendMessageSkipUserInsert 进入新一轮请求时会 `++_requestSeq`，并把当时的
  /// 值快照到本地 `mySeq`；流式 onDone/onError 异步回调进入时若发现
  /// `mySeq != _requestSeq`，说明本回调来自被覆盖的上一轮请求，必须直接
  /// return 跳过，避免把上一轮内容写入新一轮的对话状态或重复入库。
  int _requestSeq = 0;

  /// 记忆触发：未提取消息计数
  int _unextractedMessageCount = 0;

  /// 记忆触发：上次提取完成时间
  DateTime? _lastExtractionTime;

  /// 最近一条用户消息内容（用于关键词检测和自动生图）
  String _lastUserContent = '';

  /// 同步请求锁，覆盖插入用户消息前的短竞态窗口。
  bool _requestInFlight = false;

  /// 本轮请求 finalize 互斥位：onDone（流式收尾落库）与 stop()（中断时落库
  /// partial）之间的 CAS 锁。每次新请求开始时（mySeq++ 后）重置为 false；
  /// 任一路径在写入 assistant 消息前调用 [_claimFinalize] 抢占；失败方直接 return。
  ///
  /// 修复场景：onDone 已经过了 mySeq/cancelled 检查、进入 `await insertAssistantMessage`
  /// 的 microtask 期间，用户点 stop()——若没有此锁，stop 也会写入一条 partial
  /// 消息，导致同一轮对话出现 partial + 完整 两条 assistant 消息。
  bool _finalized = false;

  /// CAS：在 [insertAssistantMessage] / [updateAssistantRegenerate] 之前调用。
  /// 返回 true 表示当前路径成功抢占 finalize，可继续写库；
  /// 返回 false 表示已被其他路径（通常是 stop()）抢占，调用方应立即 return。
  bool _claimFinalize() {
    if (_finalized) return false;
    _finalized = true;
    return true;
  }

  ChatController(this._ref, this._conversationId) : super(const ChatState());

  /// 流式 / 非流式生成完成后统一收尾。
  ///
  /// 主项目 ChatView.tsx 第 771~795 行的关键顺序：
  ///   1) await refreshMessages()   — 等消息列表刷新到含新 assistant 消息
  ///   2) setStreamingText('')      — 关闭流式气泡
  ///   3) setIsLoading(false)       — 关闭"生成中"状态
  ///
  /// 之前 Flutter 端的 onDone 是 `await insertAssistantMessage` → 立刻
  /// `state = ChatState(isGenerating: false, ...)`，但 [messageListProvider]
  /// 是 Drift `.watch()` 流式订阅，新插入的消息**异步**推送（≥ 1 帧后），导致：
  ///   - 流式气泡先消失（state 同步切换）
  ///   - watcher 还没把新消息推到 list，UI 显示的仍是旧 list
  ///   - 视觉上"气泡突然消失"或"重生成跳回旧消息"
  ///
  /// 修复思路：
  /// 1) 直接查一次数据库读到最新行（绕过 watcher 时序），
  ///    确认新插入的 messageId 已可见
  /// 2) 多等一帧让 Drift watcher 把含新行的列表派发给 UI 订阅者
  /// 3) 再切换 state，UI 只会经历"新列表 + 仍 isGenerating" → "新列表 +
  ///    isGenerating: false" 两个稳定状态，看不到中间空白
  Future<void> _waitForMessagesUpdate() async {
    try {
      // (1) 先 read 一次拉到最新值（这本身会触发 watcher 派发一帧）
      await _ref.read(messageListProvider(_conversationId).future);
      // (2) 等待帧结束，确保 Drift watcher 把含新行的列表派发给 UI 订阅者
      await SchedulerBinding.instance.endOfFrame;
    } catch (_) {
      // 即使等待失败也不能阻塞收尾，避免卡住 isGenerating
    }
  }

  /// 空响应也必须完成收尾，否则 UI 会停留在生成中。
  Future<void> _finishEmptyResponse(int requestSeq) async {
    if (requestSeq != _requestSeq) return;
    await _waitForMessagesUpdate();
    if (requestSeq != _requestSeq) return;
    _requestInFlight = false;
    if (mounted) {
      state = const ChatState(
        isGenerating: false,
        currentStreamText: '',
        error: '模型返回了空响应，请重试',
      );
    }
  }

  void _finishWithError(int requestSeq, String error) {
    if (requestSeq != _requestSeq) return;
    _requestInFlight = false;
    if (mounted) {
      state = ChatState(
        isGenerating: false,
        currentStreamText: '',
        error: error,
      );
    }
  }

  void _releaseRequestLock(int requestSeq) {
    if (requestSeq == _requestSeq) {
      _requestInFlight = false;
    }
  }

  /// 发送消息并获取 AI 回复
  Future<void> sendMessage(String content) async {
    if (content.trim().isEmpty || state.isGenerating || _requestInFlight) {
      return;
    }
    _requestInFlight = true;

    // 进入新一轮请求：自增序号并快照本轮序号，用于异步回调防重入
    final mySeq = ++_requestSeq;
    _finalized = false; // 抢占新一轮 finalize 锁

    try {
      final db = _ref.read(databaseProvider);
      final messageActions = _ref.read(messageActionsProvider);
      final settingsAsync = _ref.read(settingsProvider);
      final settings = settingsAsync.valueOrNull ?? const AppSettings();

      // 记录用户消息内容（用于后续记忆关键词和自动生图检测）
      _lastUserContent = content;
      _unextractedMessageCount += 1; // 用户消息计数

      // 1. 插入用户消息
      await messageActions.insertUserMessage(
        conversationId: _conversationId,
        content: content,
      );

      // 2. 开始生成
      state = const ChatState(isGenerating: true, currentStreamText: '');
      final cancelToken = CancelToken();
      _cancelToken = cancelToken;

      // 3. 加载上下文
      final conversation = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingle();

      final character = await (db.select(
        db.characters,
      )..where((t) => t.id.equals(conversation.characterId))).getSingle();

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_conversationId))
                ..orderBy([
                  (t) => OrderingTerm.asc(t.createdAt),
                  (t) => OrderingTerm.asc(t.seq),
                ]))
              .get();

      // 4. 检索相关记忆
      List<String> memoryContents = [];
      if (settings.memoryInject) {
        final memoryEngine = MemoryEngine(db, _llm);
        final relevant = await memoryEngine.retrieveRelevantMemories(
          queryText: content,
          characterId: conversation.characterId,
          maxMemories: settings.limitInject
              ? settings.memoryMaxInject
              : _kMaxMemoriesUnlimited,
        );
        memoryContents = relevant.map((m) => m.content).toList();
      }

      // 5. 组装 prompt（普通发送使用当前时间）
      final chatMessages = _assemblePrompt(
        character: character,
        messages: messages,
        settings: settings,
        memories: memoryContents,
        timeContext: DateTime.now(),
      );

      // 6. 调用 LLM
      // 注意：chatControllerProvider 已改为 autoDispose，dispose 时会取消 cancel token；
      // onDone/onError 异步回调还会通过 mySeq != _requestSeq 防重入校验，
      // 跳过来自上一轮已覆盖请求的过期回调。
      if (settings.streaming) {
        String fullText = '';
        await _llm.chatCompletionStream(
          settings: settings,
          messages: chatMessages,
          onChunk: (text) {
            fullText += text;
            if (mounted && mySeq == _requestSeq) {
              state = state.copyWith(currentStreamText: fullText);
            }
          },
          onDone: (finalText) async {
            // 过期或已取消回调直接跳过，避免污染新一轮请求的状态与数据库
            if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
            final cleaned = _stripTimestampPrefix(finalText);
            if (cleaned.trim().isEmpty) {
              await _finishEmptyResponse(mySeq);
              return;
            }
            await messageActions.insertAssistantMessage(
              conversationId: _conversationId,
              content: cleaned,
            );
            await _waitForMessagesUpdate();
            if (mySeq != _requestSeq) return;
            _releaseRequestLock(mySeq);
            if (mounted) {
              state = const ChatState(
                isGenerating: false,
                currentStreamText: '',
              );
            }
            // 后处理：记忆触发 → 自动生图
            _unextractedMessageCount += 1; // AI 回复计数
            await _postReplyProcessing(settings, conversation.characterId);
          },
          onError: (error) {
            _finishWithError(mySeq, error);
          },
          cancelToken: cancelToken,
        );
      } else {
        final result = await _llm.chatCompletion(
          settings: settings,
          messages: chatMessages,
          cancelToken: cancelToken,
        );
        // 非流式分支也做防重入与取消校验：在 await 期间若已停止或被新请求覆盖，丢弃结果
        if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
        final cleaned = _stripTimestampPrefix(result);
        if (cleaned.trim().isEmpty) {
          await _finishEmptyResponse(mySeq);
          return;
        }
        await messageActions.insertAssistantMessage(
          conversationId: _conversationId,
          content: cleaned,
        );
        await _waitForMessagesUpdate();
        if (mySeq != _requestSeq) return;
        _releaseRequestLock(mySeq);
        if (mounted) {
          state = const ChatState(isGenerating: false, currentStreamText: '');
        }
        // 后处理：记忆触发 → 自动生图
        _unextractedMessageCount += 1; // AI 回复计数
        await _postReplyProcessing(settings, conversation.characterId);
      }
    } catch (e) {
      _finishWithError(mySeq, e.toString());
    }
  }

  /// 发送带附件的消息并获取 AI 回复
  ///
  /// 图片附件编码为 base64 后以 vision API 多模态格式发送，
  /// 超过 5MB 的图片降级为文字描述。
  /// 文本附件读取内容追加到消息文本末尾。
  /// 附件信息持久化到消息 metadata.attachments 字段。
  Future<void> sendMessageWithAttachments(
    String content,
    List<AttachmentItem> attachments,
  ) async {
    if (state.isGenerating || _requestInFlight) return;
    _requestInFlight = true;

    // 进入新一轮请求：自增序号并快照本轮序号，用于异步回调防重入
    final mySeq = ++_requestSeq;
    _finalized = false; // 抢占新一轮 finalize 锁

    try {
      final db = _ref.read(databaseProvider);
      final messageActions = _ref.read(messageActionsProvider);
      final settingsAsync = _ref.read(settingsProvider);
      final settings = settingsAsync.valueOrNull ?? const AppSettings();

      // 记录用户消息内容（用于后续记忆关键词和自动生图检测）
      _lastUserContent = content;
      _unextractedMessageCount += 1; // 用户消息计数

      // 1. 处理文本附件 — 追加到消息文本
      String enrichedContent = content;
      for (final att in attachments) {
        if (att.type == AttachmentType.text) {
          final textContent = await AttachmentProcessor.readTextFile(
            att.filePath,
            fileName: att.fileName,
          );
          enrichedContent = enrichedContent.isEmpty
              ? textContent
              : '$enrichedContent\n\n$textContent';
        }
      }

      // 2. 插入用户消息（含附件 metadata）
      final attachmentsMeta = attachments.map((a) => a.toJson()).toList();
      await messageActions.insertUserMessage(
        conversationId: _conversationId,
        content: enrichedContent,
        attachments: attachmentsMeta,
      );

      // 3. 开始生成
      state = const ChatState(
        isGenerating: true,
        currentStreamText: '',
        streamingTargetMessageId: null,
      );
      final cancelToken = CancelToken();
      _cancelToken = cancelToken;

      // 4. 加载上下文
      final conversation = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingle();

      final character = await (db.select(
        db.characters,
      )..where((t) => t.id.equals(conversation.characterId))).getSingle();

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_conversationId))
                ..orderBy([
                  (t) => OrderingTerm.asc(t.createdAt),
                  (t) => OrderingTerm.asc(t.seq),
                ]))
              .get();

      // 5. 检索相关记忆
      List<String> memoryContents = [];
      if (settings.memoryInject) {
        final memoryEngine = MemoryEngine(db, _llm);
        final relevant = await memoryEngine.retrieveRelevantMemories(
          queryText: enrichedContent,
          characterId: conversation.characterId,
          maxMemories: settings.limitInject
              ? settings.memoryMaxInject
              : _kMaxMemoriesUnlimited,
        );
        memoryContents = relevant.map((m) => m.content).toList();
      }

      // 6. 组装 prompt
      final chatMessages = _assemblePrompt(
        character: character,
        messages: messages,
        settings: settings,
        memories: memoryContents,
        timeContext: DateTime.now(),
      );

      // 7. 如果有图片附件，构建多模态内容替换最后一条用户消息
      final imageAttachments = attachments
          .where((a) => a.type == AttachmentType.image)
          .toList();
      if (imageAttachments.isNotEmpty && chatMessages.isNotEmpty) {
        final lastUserIdx = chatMessages.lastIndexWhere(
          (m) => m.role == 'user',
        );
        if (lastUserIdx >= 0) {
          final multimodalContent =
              await AttachmentProcessor.buildMultimodalContent(
                chatMessages[lastUserIdx].content as String? ?? '',
                imageAttachments,
              );
          // 替换为多模态内容（content 为 List 时 API 按 vision 格式发送）
          chatMessages[lastUserIdx] = ChatMessage(
            role: 'user',
            content: multimodalContent,
          );
        }
      }

      // 8. 调用 LLM
      if (settings.streaming) {
        String fullText = '';
        await _llm.chatCompletionStream(
          settings: settings,
          messages: chatMessages,
          onChunk: (text) {
            fullText += text;
            if (mounted && mySeq == _requestSeq) {
              state = state.copyWith(currentStreamText: fullText);
            }
          },
          onDone: (finalText) async {
            if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
            final cleaned = _stripTimestampPrefix(finalText);
            if (cleaned.trim().isEmpty) {
              await _finishEmptyResponse(mySeq);
              return;
            }
            await messageActions.insertAssistantMessage(
              conversationId: _conversationId,
              content: cleaned,
            );
            await _waitForMessagesUpdate();
            if (mySeq != _requestSeq) return;
            _releaseRequestLock(mySeq);
            if (mounted) {
              state = const ChatState(
                isGenerating: false,
                currentStreamText: '',
              );
            }
            // 后处理：记忆触发 → 自动生图
            _unextractedMessageCount += 1;
            await _postReplyProcessing(settings, conversation.characterId);
          },
          onError: (error) {
            _finishWithError(mySeq, error);
          },
          cancelToken: cancelToken,
        );
      } else {
        final result = await _llm.chatCompletion(
          settings: settings,
          messages: chatMessages,
          cancelToken: cancelToken,
        );
        if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
        final cleaned = _stripTimestampPrefix(result);
        if (cleaned.trim().isEmpty) {
          await _finishEmptyResponse(mySeq);
          return;
        }
        await messageActions.insertAssistantMessage(
          conversationId: _conversationId,
          content: cleaned,
        );
        await _waitForMessagesUpdate();
        if (mySeq != _requestSeq) return;
        _releaseRequestLock(mySeq);
        if (mounted) {
          state = const ChatState(isGenerating: false, currentStreamText: '');
        }
        // 后处理：记忆触发 → 自动生图
        _unextractedMessageCount += 1;
        await _postReplyProcessing(settings, conversation.characterId);
      }
    } catch (e) {
      _finishWithError(mySeq, e.toString());
    }
  }

  /// 重新生成指定 assistant 消息
  Future<void> regenerate(String messageId) async {
    if (state.isGenerating || _requestInFlight) return;
    _requestInFlight = true;

    // 进入新一轮请求：自增序号并快照本轮序号，用于异步回调防重入
    final mySeq = ++_requestSeq;
    _finalized = false; // 抢占新一轮 finalize 锁

    final db = _ref.read(databaseProvider);
    final messageActions = _ref.read(messageActionsProvider);
    final settingsAsync = _ref.read(settingsProvider);
    final settings = settingsAsync.valueOrNull ?? const AppSettings();

    state = ChatState(
      isGenerating: true,
      currentStreamText: '',
      streamingTargetMessageId: messageId,
    );
    final cancelToken = CancelToken();
    _cancelToken = cancelToken;

    try {
      final conversation = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingle();

      final character = await (db.select(
        db.characters,
      )..where((t) => t.id.equals(conversation.characterId))).getSingle();

      final allMessages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_conversationId))
                ..orderBy([
                  (t) => OrderingTerm.asc(t.createdAt),
                  (t) => OrderingTerm.asc(t.seq),
                ]))
              .get();

      // 排除目标消息及之后的消息
      final targetIdx = allMessages.indexWhere((m) => m.id == messageId);
      final contextMessages = targetIdx >= 0
          ? allMessages.sublist(0, targetIdx)
          : allMessages;

      // 获取被重新生成消息的 created_at 作为时间上下文
      DateTime? regenTimeContext;
      if (targetIdx >= 0) {
        try {
          regenTimeContext = allMessages[targetIdx].createdAt;
        } catch (_) {
          // created_at 解析无效时回退到当前时间
          regenTimeContext = DateTime.now();
        }
      }
      regenTimeContext ??= DateTime.now();

      // 检索记忆
      final queryText = contextMessages.isNotEmpty
          ? contextMessages.reversed.take(4).map((m) => m.content).join(' ')
          : '';
      List<String> memoryContents = [];
      if (settings.memoryInject) {
        final memoryEngine = MemoryEngine(db, _llm);
        final relevant = await memoryEngine.retrieveRelevantMemories(
          queryText: queryText,
          characterId: conversation.characterId,
          maxMemories: settings.limitInject
              ? settings.memoryMaxInject
              : _kMaxMemoriesUnlimited,
        );
        memoryContents = relevant.map((m) => m.content).toList();
      }

      // 重新生成使用消息的 created_at 作为时间上下文
      final chatMessages = _assemblePrompt(
        character: character,
        messages: contextMessages,
        settings: settings,
        memories: memoryContents,
        timeContext: regenTimeContext,
      );

      if (settings.streaming) {
        String fullText = '';
        await _llm.chatCompletionStream(
          settings: settings,
          messages: chatMessages,
          onChunk: (text) {
            fullText += text;
            if (mounted && mySeq == _requestSeq) {
              state = state.copyWith(currentStreamText: fullText);
            }
          },
          onDone: (finalText) async {
            if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
            final cleaned = _stripTimestampPrefix(finalText);
            if (cleaned.trim().isEmpty) {
              await _finishEmptyResponse(mySeq);
              return;
            }
            await messageActions.updateAssistantRegenerate(
              messageId: messageId,
              newContent: cleaned,
            );
            await _waitForMessagesUpdate();
            if (mySeq != _requestSeq) return;
            _releaseRequestLock(mySeq);
            if (mounted) {
              state = const ChatState(
                isGenerating: false,
                currentStreamText: '',
              );
            }
          },
          onError: (error) {
            _finishWithError(mySeq, error);
          },
          cancelToken: cancelToken,
        );
      } else {
        final result = await _llm.chatCompletion(
          settings: settings,
          messages: chatMessages,
          cancelToken: cancelToken,
        );
        if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
        final cleaned = _stripTimestampPrefix(result);
        if (cleaned.trim().isEmpty) {
          await _finishEmptyResponse(mySeq);
          return;
        }
        await messageActions.updateAssistantRegenerate(
          messageId: messageId,
          newContent: cleaned,
        );
        await _waitForMessagesUpdate();
        if (mySeq != _requestSeq) return;
        _releaseRequestLock(mySeq);
        if (mounted) {
          state = const ChatState(isGenerating: false, currentStreamText: '');
        }
      }
    } catch (e) {
      _finishWithError(mySeq, e.toString());
    }
  }

  /// 在下方重新回答 — 跳过用户消息插入，直接用已有用户内容生成 AI 回复
  ///
  /// 与主项目 `callChatStream(convId, userContent, undefined, true)` 对齐：
  /// - 不插入新的用户消息（skipUserInsert = true）
  /// - streamingTargetMessageId 为 null，流式气泡追加在消息列表末尾
  Future<void> sendMessageSkipUserInsert(String userContent) async {
    if (userContent.trim().isEmpty || state.isGenerating || _requestInFlight) {
      return;
    }
    _requestInFlight = true;

    // 进入新一轮请求：自增序号并快照本轮序号，用于异步回调防重入
    final mySeq = ++_requestSeq;
    _finalized = false; // 抢占新一轮 finalize 锁

    final db = _ref.read(databaseProvider);
    final settingsAsync = _ref.read(settingsProvider);
    final settings = settingsAsync.valueOrNull ?? const AppSettings();

    _lastUserContent = userContent;

    state = const ChatState(isGenerating: true, currentStreamText: '');
    final cancelToken = CancelToken();
    _cancelToken = cancelToken;

    try {
      final conversation = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingle();

      final character = await (db.select(
        db.characters,
      )..where((t) => t.id.equals(conversation.characterId))).getSingle();

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_conversationId))
                ..orderBy([
                  (t) => OrderingTerm.asc(t.createdAt),
                  (t) => OrderingTerm.asc(t.seq),
                ]))
              .get();

      List<String> memoryContents = [];
      if (settings.memoryInject) {
        final memoryEngine = MemoryEngine(db, _llm);
        final relevant = await memoryEngine.retrieveRelevantMemories(
          queryText: userContent,
          characterId: conversation.characterId,
          maxMemories: settings.limitInject
              ? settings.memoryMaxInject
              : _kMaxMemoriesUnlimited,
        );
        memoryContents = relevant.map((m) => m.content).toList();
      }

      final chatMessages = _assemblePrompt(
        character: character,
        messages: messages,
        settings: settings,
        memories: memoryContents,
        timeContext: DateTime.now(),
      );

      if (settings.streaming) {
        String fullText = '';
        await _llm.chatCompletionStream(
          settings: settings,
          messages: chatMessages,
          onChunk: (text) {
            fullText += text;
            if (mounted && mySeq == _requestSeq) {
              state = state.copyWith(currentStreamText: fullText);
            }
          },
          onDone: (finalText) async {
            if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
            final cleaned = _stripTimestampPrefix(finalText);
            if (cleaned.trim().isEmpty) {
              await _finishEmptyResponse(mySeq);
              return;
            }
            final messageActions = _ref.read(messageActionsProvider);
            await messageActions.insertAssistantMessage(
              conversationId: _conversationId,
              content: cleaned,
            );
            await _waitForMessagesUpdate();
            if (mySeq != _requestSeq) return;
            _releaseRequestLock(mySeq);
            if (mounted) {
              state = const ChatState(
                isGenerating: false,
                currentStreamText: '',
              );
            }
            _unextractedMessageCount += 1;
            await _postReplyProcessing(settings, conversation.characterId);
          },
          onError: (error) {
            _finishWithError(mySeq, error);
          },
          cancelToken: cancelToken,
        );
      } else {
        final result = await _llm.chatCompletion(
          settings: settings,
          messages: chatMessages,
          cancelToken: cancelToken,
        );
        if (mySeq != _requestSeq || cancelToken.isCancelled || !_claimFinalize()) return;
        final cleaned = _stripTimestampPrefix(result);
        if (cleaned.trim().isEmpty) {
          await _finishEmptyResponse(mySeq);
          return;
        }
        final messageActions = _ref.read(messageActionsProvider);
        await messageActions.insertAssistantMessage(
          conversationId: _conversationId,
          content: cleaned,
        );
        await _waitForMessagesUpdate();
        if (mySeq != _requestSeq) return;
        _releaseRequestLock(mySeq);
        if (mounted) {
          state = const ChatState(isGenerating: false, currentStreamText: '');
        }
        _unextractedMessageCount += 1;
        await _postReplyProcessing(settings, conversation.characterId);
      }
    } catch (e) {
      _finishWithError(mySeq, e.toString());
    }
  }

  /// 停止生成
  ///
  /// 每个 ChatController 实例拥有独立的 _cancelToken，
  /// 调用 stop() 仅取消本对话的请求，不影响其他对话的生成。
  ///
  /// 修复：若已有非空 partial 流式文本，先把它落库为 assistant 消息再清状态，
  /// 避免用户看到的内容直接消失。truncated 标记暂未持久化（MessageMetadata
  /// 模型当前无此字段，按精准修改原则不扩展）。
  ///
  /// 双写防护：stop() 与 onDone 共用 [_finalized] 互斥位。若 onDone 已经过
  /// 入口检查并 claim（即 `_finalized == true`），表示对方正在或已经把完整
  /// 文本落库，此处不再写 partial，避免同一轮对话出现两条 assistant 消息。
  // TODO(parity): MessageMetadata 增加 truncated 字段后，在此写入 metadata 中。
  Future<void> stop() async {
    // 1) 先快照 partial 文本，再自增序号 + 取消 cancelToken，
    //    阻止流式 onDone/onError 过期回调继续写入。
    final partial = state.currentStreamText;
    _requestSeq++;
    _requestInFlight = false;
    _cancelToken?.cancel();

    // 2) 若有 partial 内容且 onDone 尚未 claim finalize，落库为 assistant 消息，
    //    并等待 watcher 派发新行，再切换 state，避免出现"气泡消失 + 列表无新消息"的中间空白。
    final cleaned = _stripTimestampPrefix(partial);
    if (cleaned.trim().isNotEmpty && _claimFinalize()) {
      try {
        final messageActions = _ref.read(messageActionsProvider);
        await messageActions.insertAssistantMessage(
          conversationId: _conversationId,
          content: cleaned,
        );
        await _waitForMessagesUpdate();
      } catch (e) {
        // 落库失败不阻塞 stop 主流程，state 仍需被重置避免 UI 卡在生成中；
        // 但需要日志以便线上排查为何 partial 内容消失。
        debugPrint('ChatController.stop: insert partial failed: $e');
      }
    }

    if (mounted) {
      state = const ChatState(isGenerating: false, currentStreamText: '');
    }
  }

  /// 重新生成图片（带版本历史管理）
  ///
  /// 首次重新生成时将当前图片归档为版本 0，新图片追加为最新版本。
  /// 后续重新生成直接追加新版本。
  /// 失败时保持 versions 和 activeImageVersion 不变。
  ///
  /// R1.8：事务结束后对「事务前 metadata 中本地路径集合」与「事务后集合」
  /// 做差集，对消失的旧路径调用 [ImageGenService.deleteImage]。
  /// 常规归档路径下旧 path 会进入 `image_versions` / `versions`，差集为空、
  /// 零开销；仅在「覆盖而非归档」的边缘情况（如历史脏数据中 path 不在
  /// `generatedImages[].path` 也不在 `image_versions[]`）才会真正清理孤儿文件。
  /// 事务失败时直接 rethrow，差集计算与 deleteImage 调用都不会发生（沿用
  /// 既有事务回滚语义）。
  ///
  /// [imageGenServiceFactory] 仅供测试注入：传入非 null 的工厂时,
  /// 主生成路径与差集清理路径都改用 `imageGenServiceFactory()` 替代
  /// `ImageGenService()` 直接构造。`@visibleForTesting` 标记表示业务代码
  /// **不应**使用此参数(默认 null,行为与现有调用点完全一致)。
  Future<void> regenerateImage({
    required String messageId,
    required String currentImagePath,
    required AppSettings settings,
    String? prompt,
    @visibleForTesting ImageGenService Function()? imageGenServiceFactory,
  }) async {
    final db = _ref.read(databaseProvider);

    // 测试可注入的工厂；默认行为与原实现一致(每次新建一个 ImageGenService)
    final ImageGenService Function() factory =
        imageGenServiceFactory ?? () => ImageGenService();

    try {
      // 生成新图片
      final conversation = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingle();

      final character = await (db.select(
        db.characters,
      )..where((t) => t.id.equals(conversation.characterId))).getSingleOrNull();

      final msg = await (db.select(
        db.messages,
      )..where((t) => t.id.equals(messageId))).getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);

      GeneratedImage? targetImage;
      ImageVersion? targetVersion;
      for (final image in meta.generatedImages) {
        if (image.path == currentImagePath ||
            image.url == currentImagePath ||
            image.versions.any(
              (version) =>
                  version.path == currentImagePath ||
                  version.url == currentImagePath,
            ) ||
            (currentImagePath.isEmpty && image.status == 'failed')) {
          targetImage = image;
          final matchedVersions = image.versions.where(
            (version) =>
                version.path == currentImagePath ||
                version.url == currentImagePath,
          );
          if (matchedVersions.isNotEmpty) {
            targetVersion = matchedVersions.first;
          } else if (image.versions.isNotEmpty) {
            final activeIdx = image.activeVersion.clamp(
              0,
              image.versions.length - 1,
            );
            targetVersion = image.versions[activeIdx];
          }
          break;
        }
      }

      // 重试优先使用当前版本保存的 prompt，避免回退到旧顶层 prompt。
      final imageTags = character?.imageTags ?? '';
      final versionPrompt = targetVersion?.prompt?.trim();
      final imagePrompt = targetImage?.prompt?.trim();
      final explicitPrompt = prompt?.trim();
      final resolvedPrompt = versionPrompt?.isNotEmpty == true
          ? versionPrompt!
          : (explicitPrompt?.isNotEmpty == true
                ? explicitPrompt!
                : (imagePrompt?.isNotEmpty == true
                      ? imagePrompt!
                      : (imageTags.isNotEmpty
                            ? imageTags
                            : 'high quality illustration')));

      final imageService = factory();
      late final String newPath;
      try {
        newPath = await imageService.generate(
          prompt: resolvedPrompt,
          settings: settings.imageGen,
        );
      } finally {
        imageService.dispose();
      }

      final beforePaths = extractLocalPaths(meta.toJson());

      // 对照主项目：版本存储在 generatedImages[].versions 内（per-image-entry），
      // 不再使用 message-level 的 imageVersions 字段
      final now = DateTime.now().toIso8601String();
      var updatedImages = List<GeneratedImage>.from(meta.generatedImages);
      for (int i = 0; i < updatedImages.length; i++) {
        final img = updatedImages[i];
        final matchesCurrentImage =
            img.path == currentImagePath ||
            img.url == currentImagePath ||
            img.versions.any(
              (version) =>
                  version.path == currentImagePath ||
                  version.url == currentImagePath,
            ) ||
            (currentImagePath.isEmpty && img.status == 'failed');
        if (matchesCurrentImage) {
          // 归一化现有 versions
          var versions = List<ImageVersion>.from(img.versions);
          if (versions.isEmpty) {
            // 首次重新生成：把当前图片作为第一个版本
            versions.add(
              ImageVersion(
                id: img.id.isNotEmpty ? img.id : 'v0',
                url: currentImagePath,
                path: currentImagePath,
                prompt: img.prompt,
                createdAt: now,
              ),
            );
          }
          // 添加新版本
          final newVersionId = DateTime.now().millisecondsSinceEpoch
              .toRadixString(36);
          versions.add(
            ImageVersion(
              id: newVersionId,
              url: newPath,
              path: newPath,
              prompt: resolvedPrompt,
              createdAt: now,
            ),
          );

          updatedImages[i] = img.copyWith(
            url: newPath,
            path: newPath,
            prompt: resolvedPrompt,
            status: 'ready',
            versions: versions,
            activeVersion: versions.length - 1,
          );
          break;
        }
      }

      final newMeta = meta.copyWith(generatedImages: updatedImages);

      await (db.update(db.messages)..where((t) => t.id.equals(messageId)))
          .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));

      // R1.8：事务成功写库后做「旧本地路径差集」清理
      // 常规归档路径下旧 path 会被归档到 versions / image_versions,差集为空;
      // 仅在「覆盖而非归档」边缘情况下才会有 path 从 metadata 中真正消失,
      // 此时调用 ImageGenService.deleteImage 做安全删除(仍会做全库引用扫描)。
      // 注：当前 Flutter 端写入字段是 `path`,而 extractLocalPaths 只看 `url`,
      // 所以 `path` 字段在 before/after 都不会被扫到、差集仍为空,字段名差异
      // 不会导致误删;字段名迁移不在本任务范围内。
      // 事务(写库)失败时会跳到外层 catch rethrow,不会进入此分支,
      // 沿用既有事务回滚语义。
      try {
        final afterPaths = extractLocalPaths(newMeta.toJson());
        final removed = beforePaths.difference(afterPaths);
        if (removed.isNotEmpty) {
          final imagesActions = _ref.read(characterImagesActionsProvider);
          // deleteImage 用独立的轻量 ImageGenService 实例(只用其 deleteImage
          // 方法、不发起 HTTP),避免复用上面已 dispose 的 dio 句柄
          final cleanupService = factory();
          try {
            for (final p in removed) {
              await cleanupService.deleteImage(p, imagesActions: imagesActions);
            }
          } finally {
            cleanupService.dispose();
          }
        }
      } catch (_) {
        // 清理是 best-effort,失败不影响主流程
      }
    } catch (e) {
      // 失败时保持 versions 和 activeImageVersion 不变;
      // 事务（写库）失败 → 不进入差集清理分支,沿用既有回滚语义
      rethrow;
    }
  }

  /// 组装 prompt
  ///
  /// [timeContext] 用于注入时间上下文段落：
  /// - 普通发送时传入 `DateTime.now()`
  /// - 重新生成时传入消息的 `created_at`
  /// - 传入 null 则跳过时间注入
  List<ChatMessage> _assemblePrompt({
    required Character character,
    required List<Message> messages,
    required AppSettings settings,
    required List<String> memories,
    DateTime? timeContext,
  }) {
    final memoryText = settings.memoryInject && memories.isNotEmpty
        ? memories
              .asMap()
              .entries
              .map((e) => '${e.key + 1}. ${e.value}')
              .join('\n')
        : '';

    final systemPrompt = _buildSystemPrompt(character, memoryText, timeContext);
    final result = <ChatMessage>[
      ChatMessage(role: 'system', content: systemPrompt),
    ];

    // 示例对话
    if (settings.exampleDialogue && character.exampleDialogue.isNotEmpty) {
      result.addAll(_parseExampleDialogue(character.exampleDialogue));
    }

    // Token 预算
    int usedTokens = estimateTokens(systemPrompt);
    if (settings.exampleDialogue) {
      usedTokens += estimateTokens(character.exampleDialogue);
    }
    final availableBudget = (settings.contextWindow - settings.maxTokens).clamp(
      0,
      settings.contextWindow,
    );

    // 从最新往前填充
    final history = <ChatMessage>[];
    for (int i = messages.length - 1; i >= 0; i--) {
      final msg = messages[i];
      if (msg.content.isEmpty) continue;
      if (msg.role == 'system') {
        final meta = MessageMetadata.fromJsonString(msg.metadata);
        if (!meta.isSummary) continue;
      }

      final msgTokens = msg.tokenCount > 0
          ? msg.tokenCount
          : estimateTokens(msg.content);
      if (usedTokens + msgTokens > availableBudget) break;
      usedTokens += msgTokens;

      final meta = MessageMetadata.fromJsonString(msg.metadata);
      if (meta.isSummary) {
        history.insert(
          0,
          ChatMessage(role: 'assistant', content: '[对话总结]\n${msg.content}'),
        );
        continue;
      }

      String content = msg.content;
      if (settings.showTimestamps) {
        final ts = _formatTimestamp(msg.createdAt);
        content = '[$ts] $content';
      }

      history.insert(0, ChatMessage(role: msg.role, content: content));
    }

    // 对照主项目：合并相邻同角色消息（避免 API 报错）
    final merged = _mergeAdjacentSameRole(history);
    result.addAll(merged);
    return result;
  }

  /// 合并相邻同角色非 system 消息 — 对照主项目 mergeAdjacentSameRole
  List<ChatMessage> _mergeAdjacentSameRole(List<ChatMessage> messages) {
    if (messages.length <= 1) return messages;
    final result = <ChatMessage>[];
    for (final msg in messages) {
      if (result.isNotEmpty &&
          result.last.role == msg.role &&
          msg.role != 'system') {
        final merged = '${result.last.content}\n\n${msg.content}';
        result[result.length - 1] = ChatMessage(
          role: msg.role,
          content: merged,
        );
      } else {
        result.add(msg);
      }
    }
    return result;
  }

  /// 构建系统提示词
  ///
  /// [timeContext] 不为 null 时，在"行为要求"段落之前注入时间上下文段落。
  /// DateTime 无效时跳过注入，不阻塞系统提示词构建。
  String _buildSystemPrompt(
    Character character,
    String memoryText,
    DateTime? timeContext,
  ) {
    String? timeContextStr;
    if (timeContext != null) {
      try {
        timeContextStr = TimeContextBuilder.buildTimeContext(timeContext);
      } catch (_) {
        // DateTime 解析无效时跳过注入，不阻塞系统提示词构建
      }
    }

    return SystemPromptBuilder.build(
      characterName: character.name,
      systemPrompt: character.systemPrompt,
      basicInfo: character.basicInfo,
      personality: character.personality,
      scenario: character.scenario,
      otherInfo: character.otherInfo,
      memoryText: memoryText,
      timeContextStr: timeContextStr,
    );
  }

  /// 解析示例对话
  ///
  /// P3/R16：直接委托到 [chat_engine.dart] 的顶级 [parseExampleDialogueForTesting]，
  /// 与 [ChatEngine] 共享同一份正则与逻辑，避免双份实现因后续迭代失同步。
  List<ChatMessage> _parseExampleDialogue(String raw) {
    return parseExampleDialogueForTesting(raw);
  }

  /// 去除 AI 回复开头的时间戳前缀，委托给 TimeContextBuilder
  String _stripTimestampPrefix(String text) {
    return TimeContextBuilder.stripTimestampPrefix(text);
  }

  String _formatTimestamp(DateTime dt) {
    return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
        '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  // ═══════════════════════════════════════════════════════════════
  // 后处理：记忆触发 + 自动生图
  // ═══════════════════════════════════════════════════════════════

  /// 判定 `ignore_memory` 字段值是否应跳过自动记忆触发。
  ///
  /// 与 Node.js 端 `chat/route.ts` 在 `onDone` 中检查 `conversation.ignore_memory`
  /// 直接 `return` 的语义一致（参考 design.md「P1 / R5」）：
  /// - `ignoreMemory == 1` → 返回 true，跳过所有自动触发逻辑（消息数 / 时间间隔 / 关键词）
  /// - 其它值（含 0 / 异常值）→ 返回 false，由原有触发条件决定是否触发
  ///
  /// 抽出为 `@visibleForTesting` 公开静态方法，便于在不构造完整
  /// `ChatController` / `Ref` / `MemoryExtractionService` 依赖的前提下，
  /// 直接测试该判定纯函数（参考 tasks.md 7.4 推荐策略）。
  @visibleForTesting
  static bool shouldSkipAutoMemoryTrigger(int ignoreMemory) =>
      ignoreMemory == 1;

  /// AI 回复完成后的后处理流程
  ///
  /// 按顺序执行：记忆触发检查 → 自动生图检查。
  /// 单个功能失败不影响其他功能。
  ///
  /// 对话级 `ignore_memory == 1` 时，整个自动后处理流程（自动记忆触发 +
  /// 自动生图）一并跳过；该开关仅作用于自动触发流程，记忆管理页等
  /// 手动入口不受影响。与 design.md「P1 / R5」一节伪代码保持一致。
  Future<void> _postReplyProcessing(
    AppSettings settings,
    String characterId,
  ) async {
    // 入口先查询当前对话的 ignore_memory，等于 1 时直接跳过所有自动触发逻辑
    // （消息数 / 时间间隔 / 关键词）。读库失败时不阻塞后处理，保留原行为。
    try {
      final db = _ref.read(databaseProvider);
      final conv = await (db.select(
        db.conversations,
      )..where((t) => t.id.equals(_conversationId))).getSingleOrNull();
      if (conv != null && shouldSkipAutoMemoryTrigger(conv.ignoreMemory)) {
        return;
      }
    } catch (_) {
      // 查询失败时不阻塞，继续走原有自动后处理流程
    }

    // 记忆触发检查
    try {
      await _checkMemoryTrigger(settings, characterId);
    } catch (_) {
      // 记忆触发失败不阻塞后续流程
    }

    // 自动生图检查
    try {
      await _checkAutoImageGen(settings, characterId);
    } catch (_) {
      // 自动生图失败不阻塞
    }
  }

  /// 检查是否应触发记忆提取
  ///
  /// 三种触发条件（各受独立开关控制）：
  /// 1. 消息数达到 memoryInterval
  /// 2. 时间超过 memoryTriggerTimeHours
  /// 3. 用户消息包含 memoryTriggerKeywords 关键词
  Future<void> _checkMemoryTrigger(
    AppSettings settings,
    String characterId,
  ) async {
    bool shouldTrigger = false;

    // 条件 1：按消息数触发
    if (settings.memoryTriggerIntervalEnabled &&
        _unextractedMessageCount >= settings.memoryInterval) {
      shouldTrigger = true;
    }

    // 条件 2：按时间间隔触发
    if (!shouldTrigger && settings.memoryTriggerTimeEnabled) {
      final now = DateTime.now();
      if (_lastExtractionTime == null ||
          now.difference(_lastExtractionTime!).inHours >=
              settings.memoryTriggerTimeHours) {
        shouldTrigger = true;
      }
    }

    // 条件 3：按关键词触发
    if (!shouldTrigger && settings.memoryTriggerKeywordEnabled) {
      final keywords = settings.memoryTriggerKeywords
          .split(',')
          .map((k) => k.trim())
          .where((k) => k.isNotEmpty);
      for (final keyword in keywords) {
        if (_lastUserContent.contains(keyword)) {
          shouldTrigger = true;
          break;
        }
      }
    }

    if (!shouldTrigger) return;

    // 收集未提取用户消息及其紧随的 assistant 回复。
    final db = _ref.read(databaseProvider);
    final messages =
        await (db.select(db.messages)
              ..where((t) => t.conversationId.equals(_conversationId))
              ..orderBy([
                (t) => OrderingTerm.asc(t.createdAt),
                (t) => OrderingTerm.asc(t.seq),
              ]))
            .get();

    final extractionIds = MemoryExtractionService.selectExtractionMessageIds(
      messages,
    );

    if (extractionIds.isEmpty) return;

    // 入队记忆提取
    final memoryEngine = MemoryEngine(db, _llm);
    final extractionService = MemoryExtractionService(db, _llm, memoryEngine);
    await extractionService.enqueueExtraction(
      characterId: characterId,
      conversationId: _conversationId,
      messageIds: extractionIds,
    );

    // 重置计数和时间
    _unextractedMessageCount = 0;
    _lastExtractionTime = DateTime.now();
  }

  /// 检查是否应触发自动生图
  ///
  /// 检测用户消息是否包含 autoGenerateKeywords 中任一关键词。
  /// autoGenerate 为 false 时跳过。
  /// 提示词组装：角色 image_tags + 用户消息移除首个匹配关键词后的剩余文本。
  Future<void> _checkAutoImageGen(
    AppSettings settings,
    String characterId,
  ) async {
    final imageGen = settings.imageGen;
    if (!imageGen.enabled || !imageGen.autoGenerate) return;

    // 检测关键词
    final keywords = imageGen.autoGenerateKeywords
        .split(',')
        .map((k) => k.trim())
        .where((k) => k.isNotEmpty)
        .toList();

    String? matchedKeyword;
    for (final keyword in keywords) {
      if (_lastUserContent.contains(keyword)) {
        matchedKeyword = keyword;
        break;
      }
    }

    if (matchedKeyword == null) return;

    // 对照主项目：找到最后一条 assistant 消息，把图片附加到它上面
    // （而不是创建新的空消息）
    final db = _ref.read(databaseProvider);
    final lastAssistant =
        await (db.select(db.messages)
              ..where(
                (t) =>
                    t.conversationId.equals(_conversationId) &
                    t.role.equals('assistant'),
              )
              ..orderBy([(t) => OrderingTerm.desc(t.seq)])
              ..limit(1))
            .getSingleOrNull();

    if (lastAssistant == null) return;

    // 对照主项目：使用 handleGenerateImage 的完整流程（AI 生成 prompt）
    // 而不是简单拼接 imageTags + 用户文本
    try {
      final promptService = ImagePromptService();
      final p = await promptService.generateImagePrompt(
        settings,
        _conversationId,
        db,
        messageId: lastAssistant.id,
      );
      promptService.dispose();

      final imageService = ImageGenService();
      final imagePath = await imageService.generate(
        prompt: p.positive,
        negativePrompt: p.negative,
        settings: imageGen,
      );
      imageService.dispose();

      // 把图片附加到最后一条 assistant 消息的 metadata
      final msg = await (db.select(
        db.messages,
      )..where((t) => t.id.equals(lastAssistant.id))).getSingle();
      final meta = MessageMetadata.fromJsonString(msg.metadata);
      final imageId = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
      final newMeta = meta.copyWith(
        generatedImages: [
          ...meta.generatedImages,
          GeneratedImage(
            id: imageId,
            url: imagePath,
            path: imagePath,
            prompt: p.positive,
            status: 'ready',
          ),
        ],
      );
      await (db.update(db.messages)
            ..where((t) => t.id.equals(lastAssistant.id)))
          .write(MessagesCompanion(metadata: Value(newMeta.toJsonString())));
    } catch (_) {
      // 自动生图失败不中断对话流程
    }
  }

  @override
  void dispose() {
    // autoDispose 销毁时先取消正在进行的网络请求，避免回调进入已销毁的 state；
    // 配合 _requestSeq 防重入校验，过期回调不会写库或 setState。
    _requestSeq++;
    _cancelToken?.cancel();
    _llm.dispose();
    super.dispose();
  }
}
