import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/chat_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/llm_service_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/llm_service.dart';

const _charId = 'char-llm-provider';
const _convId = 'conv-llm-provider';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedConversation(AppDatabase db) async {
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('provider 测试角色'),
          systemPrompt: const Value('你会简短回复。'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db
      .into(db.conversations)
      .insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('provider 测试对话'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

List<Override> _baseOverrides(AppDatabase db, LlmService llm) {
  return _overridesWithSettings(
    db,
    llm,
    const AppSettings(
      apiBase: 'http://127.0.0.1',
      apiKey: 'sk-test-key',
      model: 'test-model',
      streaming: false,
      memoryInject: false,
      memoryTriggerIntervalEnabled: false,
      memoryTriggerTimeEnabled: false,
      memoryTriggerKeywordEnabled: false,
    ),
  );
}

List<Override> _overridesWithSettings(
  AppDatabase db,
  LlmService llm,
  AppSettings settings,
) {
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

class _FakeLlmService extends LlmService {
  int chatCompletionCalls = 0;
  final String? response;
  final Object? error;

  _FakeLlmService({this.response, this.error});

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    chatCompletionCalls += 1;
    if (error != null) throw error!;
    return response ?? 'fake assistant reply';
  }

  @override
  void dispose() {}
}

void main() {
  test('ChatController 通过 llmServiceProvider 复用并允许测试 override', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    final fakeLlm = _FakeLlmService(response: 'provider reply');
    final container = ProviderContainer(overrides: _baseOverrides(db, fakeLlm));
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.sendMessage('你好');

    expect(fakeLlm.chatCompletionCalls, 1);
    final messages =
        await (db.select(db.messages)
              ..where((t) => t.conversationId.equals(_convId))
              ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
            .get();
    expect(messages.map((m) => '${m.role}:${m.content}'), [
      'user:你好',
      'assistant:provider reply',
    ]);
    expect(container.read(chatControllerProvider(_convId)).error, isNull);
  });

  test('非流式取消不会被误报为模型返回了空响应', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    final fakeLlm = _FakeLlmService(
      error: const LlmRequestCancelledException(),
    );
    final container = ProviderContainer(overrides: _baseOverrides(db, fakeLlm));
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.sendMessage('取消我');

    final state = container.read(chatControllerProvider(_convId));
    expect(state.isGenerating, isFalse);
    expect(state.error, isNull);
    final messages = await (db.select(
      db.messages,
    )..where((t) => t.conversationId.equals(_convId))).get();
    expect(messages.where((m) => m.role == 'assistant'), isEmpty);
  });

  test('自动生图后处理失败时记录日志且不阻塞主回复落库', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedConversation(db);

    final logs = <String>[];
    final oldDebugPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) logs.add(message);
    };
    addTearDown(() => debugPrint = oldDebugPrint);

    final fakeLlm = _FakeLlmService(response: 'main reply');
    final container = ProviderContainer(
      overrides: _overridesWithSettings(
        db,
        fakeLlm,
        const AppSettings(
          apiBase: 'http://127.0.0.1:1',
          apiKey: 'sk-secret-key-abcdefghijklmnopqrstuvwxyz',
          model: 'test-model',
          streaming: false,
          memoryInject: false,
          memoryTriggerIntervalEnabled: false,
          memoryTriggerTimeEnabled: false,
          memoryTriggerKeywordEnabled: false,
          imageGen: ImageGenSettings(
            enabled: true,
            autoGenerate: true,
            autoGenerateKeywords: '画',
          ),
        ),
      ),
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final controller = container.read(chatControllerProvider(_convId).notifier);
    await controller.sendMessage('请画一张图');

    final messages =
        await (db.select(db.messages)
              ..where((t) => t.conversationId.equals(_convId))
              ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
            .get();
    expect(messages.map((m) => '${m.role}:${m.content}'), [
      'user:请画一张图',
      'assistant:main reply',
    ]);
    expect(container.read(chatControllerProvider(_convId)).error, isNull);
    expect(
      logs,
      contains(
        allOf(
          contains('ChatController._checkAutoImageGen'),
          isNot(contains('sk-secret-key-abcdefghijklmnopqrstuvwxyz')),
        ),
      ),
    );
  });
}
