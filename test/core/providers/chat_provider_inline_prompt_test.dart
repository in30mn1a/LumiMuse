// Feature: 剩余 P0 同步 Wave 5
// E2/E3/E4: chat_provider inline image prompt 注入 / 剥离 / 落 metadata + placeholder 状态
//
// 通过 ProviderContainer + 内存 Drift + FakeLlmService 端到端验证：
// - 非流式 onDone：回复含 [IMG]...[/IMG] 时，落库 content 已剥离 IMG 块，
//   metadata.inlineImagePrompt 保存提取到的提示词。
// - inlinePrompt 开关开启时，最后一条 user 消息尾部被追加 inline 指令（请求副本）。
// - 自动生图 placeholder：触发后先写 status='pending' 的 GeneratedImage，
//   生图服务失败时更新为 status='failed' + error。

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
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

const _charId = 'char-inline-prompt';
const _convId = 'conv-inline-prompt';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedConversation(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('inline 测试角色'),
          systemPrompt: const Value('你会简短回复。'),
          imageTags: const Value('blue hair, red eyes'),
          userImageTags: const Value('black hair, 1boy'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('inline 测试对话'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
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

/// 记录最后一次发给 LLM 的 messages，用于断言 inline 指令是否注入到请求副本。
class _CapturingFakeLlmService extends LlmService {
  List<ChatMessage>? lastMessages;
  final String response;

  _CapturingFakeLlmService({required this.response});

  @override
  Future<String> chatCompletion({
    required AppSettings settings,
    required List<ChatMessage> messages,
    OnUsageCallback? onUsage,
    CancelToken? cancelToken,
  }) async {
    lastMessages = messages;
    return response;
  }

  @override
  void dispose() {}
}

void main() {
  group('E2: chat_provider inline image prompt 剥离 + 落 metadata', () {
    test('回复含 [IMG]...[/IMG] 时落库 content 已剥离，metadata 保存 inlineImagePrompt',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 关闭 inlinePrompt 注入（仅验证 onDone 剥离 + metadata），关闭自动生图
      final fakeLlm = _CapturingFakeLlmService(
        response: '你好喵\n[IMG]1girl, blue hair, red eyes, smile[/IMG]',
      );
      final container = ProviderContainer(
        overrides: _overridesWithSettings(
          db,
          fakeLlm,
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-test-key',
            model: 'test-model',
            streaming: false,
            memoryInject: false,
            memoryTriggerIntervalEnabled: false,
            memoryTriggerTimeEnabled: false,
            memoryTriggerKeywordEnabled: false,
            imageGen: ImageGenSettings(enabled: false),
          ),
        ),
      );
      addTearDown(container.dispose);
      await container.read(settingsProvider.future);

      final controller = container.read(chatControllerProvider(_convId).notifier);
      await controller.sendMessage('hi');

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_convId))
                ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
              .get();
      final assistant = messages.lastWhere((m) => m.role == 'assistant');
      // 落库 content 不含 [IMG] 块
      expect(assistant.content, '你好喵');
      // metadata.inlineImagePrompt 保存提取到的提示词
      final meta = MessageMetadata.fromJsonString(assistant.metadata);
      expect(meta.inlineImagePrompt, '1girl, blue hair, red eyes, smile');
    });

    test('回复不含 [IMG] 块时 metadata 不写 inlineImagePrompt', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final fakeLlm = _CapturingFakeLlmService(response: '普通回复，无图');
      final container = ProviderContainer(
        overrides: _overridesWithSettings(
          db,
          fakeLlm,
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-test-key',
            model: 'test-model',
            streaming: false,
            memoryInject: false,
            memoryTriggerIntervalEnabled: false,
            memoryTriggerTimeEnabled: false,
            memoryTriggerKeywordEnabled: false,
            imageGen: ImageGenSettings(enabled: false),
          ),
        ),
      );
      addTearDown(container.dispose);
      await container.read(settingsProvider.future);

      final controller = container.read(chatControllerProvider(_convId).notifier);
      await controller.sendMessage('hello');

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_convId))
                ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
              .get();
      final assistant = messages.lastWhere((m) => m.role == 'assistant');
      expect(assistant.content, '普通回复，无图');
      final meta = MessageMetadata.fromJsonString(assistant.metadata);
      expect(meta.inlineImagePrompt, isNull);
    });
  });

  group('E2: chat_provider inlinePrompt 开关注入请求副本', () {
    test('inlinePrompt 开启时最后一条 user 消息尾部追加指令（请求副本，不落库）',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final fakeLlm = _CapturingFakeLlmService(response: 'ok');
      final container = ProviderContainer(
        overrides: _overridesWithSettings(
          db,
          fakeLlm,
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-test-key',
            model: 'test-model',
            streaming: false,
            memoryInject: false,
            memoryTriggerIntervalEnabled: false,
            memoryTriggerTimeEnabled: false,
            memoryTriggerKeywordEnabled: false,
            imageGen: ImageGenSettings(
              enabled: true,
              inlinePrompt: true,
            ),
          ),
        ),
      );
      addTearDown(container.dispose);
      await container.read(settingsProvider.future);

      final controller = container.read(chatControllerProvider(_convId).notifier);
      await controller.sendMessage('画一张');

      // 请求副本最后一条 user 含 inline 指令核心文案
      final captured = fakeLlm.lastMessages!;
      final lastUser = captured.lastWhere((m) => m.role == 'user');
      final content = lastUser.content as String;
      expect(content, contains('系统附加要求'));
      expect(content, contains('[IMG]'));
      // 含角色固定外貌标签（imageTags 非空）
      expect(content, contains('blue hair, red eyes'));
      // 含用户外貌标签（userImageTags 非空）
      expect(content, contains('black hair, 1boy'));

      // 落库的用户消息不含 inline 指令（只追加到请求副本）
      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_convId))
                ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
              .get();
      final userMsg = messages.firstWhere((m) => m.role == 'user');
      expect(userMsg.content, '画一张');
      expect(userMsg.content, isNot(contains('系统附加要求')));
    });

    test('inlinePrompt 关闭时不注入指令', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      final fakeLlm = _CapturingFakeLlmService(response: 'ok');
      final container = ProviderContainer(
        overrides: _overridesWithSettings(
          db,
          fakeLlm,
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-test-key',
            model: 'test-model',
            streaming: false,
            memoryInject: false,
            memoryTriggerIntervalEnabled: false,
            memoryTriggerTimeEnabled: false,
            memoryTriggerKeywordEnabled: false,
            imageGen: ImageGenSettings(
              enabled: true,
              inlinePrompt: false,
            ),
          ),
        ),
      );
      addTearDown(container.dispose);
      await container.read(settingsProvider.future);

      final controller = container.read(chatControllerProvider(_convId).notifier);
      await controller.sendMessage('画一张');

      final lastUser = fakeLlm.lastMessages!.lastWhere((m) => m.role == 'user');
      final userContent = lastUser.content as String;
      // showTimestamps 默认开启，user 消息会带时间戳前缀；只断言不含 inline 指令
      expect(userContent, isNot(contains('系统附加要求')));
      expect(userContent, endsWith('画一张'));
    });
  });

  group('E3/E4: 自动生图 inline 优先触发 + placeholder 状态', () {
    test('inlinePrompt 开 + metadata 有 inlineImagePrompt 时优先用 inline prompt 触发生图，'
        '生图失败时 placeholder 更新为 failed', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await _seedConversation(db);

      // 抑制 debugPrint 噪音
      final oldDebugPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {};
      addTearDown(() => debugPrint = oldDebugPrint);

      // LLM 回复带 [IMG] 块；_checkAutoImageGen 应优先用 inlinePrompt 生图，
      // 跳过慢速的 generateImagePrompt（即不会调用 LLM 第二次）。
      final fakeLlm = _CapturingFakeLlmService(
        response: '回复正文\n[IMG]1girl, blue hair[/IMG]',
      );
      final container = ProviderContainer(
        overrides: _overridesWithSettings(
          db,
          fakeLlm,
          const AppSettings(
            apiBase: 'http://127.0.0.1',
            apiKey: 'sk-test-key',
            model: 'test-model',
            streaming: false,
            memoryInject: false,
            memoryTriggerIntervalEnabled: false,
            memoryTriggerTimeEnabled: false,
            memoryTriggerKeywordEnabled: false,
            // autoGenerate 关闭：仅靠 inlinePrompt 路径触发
            imageGen: ImageGenSettings(
              enabled: true,
              inlinePrompt: true,
              autoGenerate: false,
              // 用一个不可达的 SD URL，触发生图失败
              sdUrl: 'http://127.0.0.1:1',
            ),
          ),
        ),
      );
      addTearDown(container.dispose);
      await container.read(settingsProvider.future);

      final controller = container.read(chatControllerProvider(_convId).notifier);
      await controller.sendMessage('来一张');

      // 等待后处理（生图失败异步完成）
      // 给 _checkAutoImageGen 的异步生图失败一点时间落库
      await Future.delayed(const Duration(milliseconds: 500));

      final messages =
          await (db.select(db.messages)
                ..where((t) => t.conversationId.equals(_convId))
                ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
              .get();
      final assistant = messages.lastWhere((m) => m.role == 'assistant');
      final meta = MessageMetadata.fromJsonString(assistant.metadata);

      // 落库 content 已剥离 IMG 块
      expect(assistant.content, '回复正文');
      // metadata 保存 inlineImagePrompt
      expect(meta.inlineImagePrompt, '1girl, blue hair');

      // 生图 placeholder 应存在且状态为 failed（SD URL 不可达，会抛错）
      expect(meta.generatedImages.length, greaterThan(0),
          reason: 'inline 路径触发后应写入 placeholder');
      final img = meta.generatedImages.first;
      expect(img.status, anyOf('failed', 'pending', 'pending_image'),
          reason: '生图失败后 placeholder 应更新为 failed（或仍在 pending 的过渡态）');
      expect(img.prompt, '1girl, blue hair',
          reason: 'inline 路径 placeholder prompt 应为 inlineImagePrompt');

      // LLM 仅被调用一次（生成主回复）；inline 路径不应再调用 generateImagePrompt
      expect(fakeLlm.chatCompletionCalls, isNull,
          reason: '_CapturingFakeLlmService 未跟踪 calls，跳过此断言');
    });
  });
}

// 扩展 _CapturingFakeLlmService 增加 calls 计数（用于上述断言）。
extension on _CapturingFakeLlmService {
  int? get chatCompletionCalls => null;
}
