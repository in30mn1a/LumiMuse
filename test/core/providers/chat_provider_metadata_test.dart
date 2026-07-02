// D1/D2/D3 测试：ChatController 落库时把 usage / memoryInjection /
// generationStopped 写入 assistant 消息的 metadata。
//
// 覆盖：
// - sendMessage 流式 onDone → metadata.lastUsage + lastMemoryInjection；
// - sendMessage 非流式 → 同上；
// - stop() 落 partial → metadata.generationStopped = true, reason = 'abort'；
// - regenerate → updateAssistantRegenerate 写入 usage + memoryInjection（D4 版本归档）。
//
// 注入策略：用 Fake LlmService 覆盖 chatCompletionStream / chatCompletion，
// 通过 onUsage 回调上报固定 usage；流式 onDone 直接同步触发，避免真实网络。

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/models/message_metadata.dart';
import 'package:lumimuse/core/providers/chat_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/llm_service_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/llm_service.dart';

const _convId = 'conv-meta';
const _charId = 'char-meta';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedScenario(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('meta 测试角色'),
          systemPrompt: const Value('你会简短回复。'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('meta 测试对话'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

List<Override> _overrides(AppDatabase db, LlmService llm, AppSettings settings) {
  return [
    databaseProvider.overrideWithValue(db),
    llmServiceProvider.overrideWithValue(llm),
    settingsProvider.overrideWith(() => _StaticSettingsNotifier(settings)),
  ];
}

class _StaticSettingsNotifier extends SettingsNotifier {
  final AppSettings _settings;

  _StaticSettingsNotifier(this._settings);

  @override
  Future<AppSettings> build() async => _settings;
}

/// Fake LlmService：覆写流式 / 非流式两条路径，按测试需要触发回调。
class _FakeLlmService extends LlmService {
  final String reply;
  final LlmUsage? usage;

  _FakeLlmService({required this.reply, this.usage});

  @override
  Future<void> chatCompletionStream({
    required AppSettings settings,
    required List<ChatMessage> messages,
    required OnChunkCallback onChunk,
    required OnDoneCallback onDone,
    required OnErrorCallback onError,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    if (usage != null && onUsage != null) {
      onUsage(usage!);
    }
    onChunk(reply);
    await onDone(reply);
  }

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    if (usage != null && onUsage != null) {
      onUsage(usage!);
    }
    return reply;
  }

  @override
  void dispose() {}
}

const _baseSettings = AppSettings(
  apiBase: 'http://127.0.0.1',
  apiKey: 'sk-test-key',
  model: 'test-model',
  streaming: true,
  memoryInject: false,
  memoryTriggerIntervalEnabled: false,
  memoryTriggerTimeEnabled: false,
  memoryTriggerKeywordEnabled: false,
);

void main() {
  test('sendMessage 流式 onDone 写入 lastUsage + lastMemoryInjection', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedScenario(db);

    final fakeLlm = _FakeLlmService(
      reply: 'hello world',
      usage: const LlmUsage(
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
      ),
    );

    final container = ProviderContainer(
      overrides: _overrides(db, fakeLlm, _baseSettings),
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.sendMessage('用户输入');

    final rows = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(_convId))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .get();
    final assistant = rows.lastWhere((m) => m.role == 'assistant');
    final meta = MessageMetadata.fromJsonString(assistant.metadata);

    expect(meta.lastUsage, isNotNull);
    expect(meta.lastUsage!['prompt_tokens'], 12);
    expect(meta.lastUsage!['total_tokens'], 16);
    expect(meta.lastMemoryInjection, isNotNull);
    // 未开启 memoryInject → count=0
    expect(meta.lastMemoryInjection!.count, 0);
    expect(meta.lastMemoryInjection!.mode, 'local');
    // 正常完成 → generationStopped = false
    expect(meta.generationStopped, isFalse);
  });

  test('sendMessage 非流式写入 lastUsage + lastMemoryInjection', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedScenario(db);

    final fakeLlm = _FakeLlmService(
      reply: 'non-stream reply',
      usage: const LlmUsage(
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      ),
    );

    const settings = AppSettings(
      apiBase: 'http://127.0.0.1',
      apiKey: 'sk-test-key',
      model: 'test-model',
      streaming: false,
      memoryInject: false,
      memoryTriggerIntervalEnabled: false,
      memoryTriggerTimeEnabled: false,
      memoryTriggerKeywordEnabled: false,
    );

    final container = ProviderContainer(
      overrides: _overrides(db, fakeLlm, settings),
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.sendMessage('用户输入');

    final rows = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(_convId))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .get();
    final assistant = rows.lastWhere((m) => m.role == 'assistant');
    final meta = MessageMetadata.fromJsonString(assistant.metadata);
    expect(meta.lastUsage?['total_tokens'], 30);
    expect(meta.lastMemoryInjection?.count, 0);
  });

  test('stop() 落 partial 写入 generationStopped=true, reason=abort', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedScenario(db);

    // 用一个不主动触发 onDone 的 fake，模拟正在流式输出
    final fakeLlm = _StopBlockingLlmService();
    final container = ProviderContainer(
      overrides: _overrides(db, fakeLlm, _baseSettings),
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);

    // 启动 sendMessage（流式），不等完成
    final sendFuture = controller.sendMessage('用户输入');
    // 等 chunk 写入 state.currentStreamText
    await fakeLlm.chunkedCompleter.future;
    // 此时主动 stop
    await controller.stop();
    await sendFuture;

    final rows = await (db.select(db.messages)
          ..where((t) => t.conversationId.equals(_convId))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .get();
    final assistant = rows.lastWhere((m) => m.role == 'assistant');
    final meta = MessageMetadata.fromJsonString(assistant.metadata);
    expect(meta.generationStopped, isTrue);
    expect(meta.generationStopReason, 'abort');
  });

  test('regenerate 写入 lastUsage + lastMemoryInjection（版本归档 D4）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedScenario(db);

    // 先插入一条 assistant 消息供 regenerate
    const msgId = 'msg-regen';
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: msgId,
            conversationId: _convId,
            role: 'assistant',
            content: const Value('旧回复'),
            seq: const Value(1),
            createdAt: Value(DateTime(2026, 1, 1, 10, 0, 0)),
            metadata: Value(
              const MessageMetadata(
                versions: [MessageVersion(content: '旧回复', tokenCount: 5)],
                activeVersion: 0,
              ).toJsonString(),
            ),
          ),
        );
    // 还需要一条 user 消息在前面，否则 contextMessages 可能为空
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: 'msg-user',
            conversationId: _convId,
            role: 'user',
            content: const Value('用户问'),
            seq: const Value(0),
            createdAt: Value(DateTime(2026, 1, 1, 9, 59, 0)),
            metadata: const Value('{}'),
          ),
        );

    final fakeLlm = _FakeLlmService(
      reply: '新回复内容',
      usage: const LlmUsage(
        promptTokens: 8,
        completionTokens: 2,
        totalTokens: 10,
      ),
    );

    final container = ProviderContainer(
      overrides: _overrides(db, fakeLlm, _baseSettings),
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.regenerate(msgId);

    final row = await (db.select(db.messages)
          ..where((t) => t.id.equals(msgId)))
        .getSingle();
    final meta = MessageMetadata.fromJsonString(row.metadata);

    // D4 版本归档：旧版本保留、新版本追加
    expect(meta.versions.length, 2);
    expect(meta.versions[0].content, '旧回复');
    expect(meta.versions[1].content, '新回复内容');
    expect(meta.activeVersion, 1);

    // D1/D2：usage + memoryInjection 写入最新 metadata
    expect(meta.lastUsage?['total_tokens'], 10);
    expect(meta.lastMemoryInjection?.count, 0);
  });
}

/// 流式调用时只触发一次 onChunk 把文本写入 state，然后阻塞等测试主动 stop。
class _StopBlockingLlmService extends LlmService {
  final Completer<void> chunkedCompleter = Completer<void>();

  @override
  Future<void> chatCompletionStream({
    required AppSettings settings,
    required List<ChatMessage> messages,
    required OnChunkCallback onChunk,
    required OnDoneCallback onDone,
    required OnErrorCallback onError,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    onChunk('partial content');
    if (!chunkedCompleter.isCompleted) {
      chunkedCompleter.complete();
    }
    // 等待 cancelToken 被取消（stop() 会调用 cancel）
    while (!(cancelToken?.isCancelled ?? false)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    // 被取消时不调 onDone（对齐 DioExceptionType.cancel 语义）
  }

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    throw StateError('非流式分支不应被此 fake 触发');
  }

  @override
  void dispose() {}
}
