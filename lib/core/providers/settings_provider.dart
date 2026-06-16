import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import '../services/secret_storage_service.dart';
import 'database_provider.dart';

/// 主题模式 Provider
final themeModeProvider = StateProvider<ThemeMode>((ref) {
  return ThemeMode.light;
});

/// 顶层语言 Provider — 与 themeModeProvider 平级、同生命周期
///
/// 写入时机：
/// 1. 应用冷启动时由 SettingsNotifier.build 同步（任务 4.2 接线）
/// 2. 用户改语言时由 SettingsNotifier.updateSettings 同步（任务 4.2 接线）
///
/// 读取时机：MaterialApp.locale 顶层 watch（任务 4.4 接线）
final localeProvider = StateProvider<Locale>((ref) {
  return const Locale('zh');
});

/// 当前激活的供应商 ID Provider
final activeProviderIdProvider = StateProvider<String>((ref) => '');

/// 全局字体缩放倍率 Provider。
final fontScaleProvider = StateProvider<double>((ref) => 1.0);

/// 记录最近一次打开的对话，供下次启动恢复。
Future<void> rememberLastConversation(
  WidgetRef ref, {
  required String characterId,
  required String conversationId,
}) async {
  await ref
      .read(settingsProvider.notifier)
      .updateLastConversation(
        characterId: characterId,
        conversationId: conversationId,
      );
}

/// 把 AppSettings.language 字段（可空字符串）转换为 Flutter 内置 Locale。
///
/// - `'en'` → `Locale('en')`
/// - 其它任何值（含 `null` / `''` / `'xx'` 等非法语言码）回退为 `Locale('zh')`
///
/// 这是纯函数：相同输入恒得相同输出，无副作用。
/// 由 SettingsNotifier.build / updateSettings 调用，把数据库中的语言字段
/// 同步到顶层 [localeProvider]，进而驱动 MaterialApp.locale。
Locale _languageToLocale(String? language) {
  switch (language?.toLowerCase()) {
    case 'en':
      return const Locale('en');
    case 'zh':
    default:
      return const Locale('zh');
  }
}

/// 应用设置 Provider — 从数据库加载并缓存
final settingsProvider = AsyncNotifierProvider<SettingsNotifier, AppSettings>(
  SettingsNotifier.new,
);

class SettingsNotifier extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final db = ref.read(databaseProvider);
    final settings = await _loadFromDb(db);
    _syncDerivedProviders(settings);
    return settings;
  }

  void _syncDerivedProviders(AppSettings settings) {
    ref.read(themeModeProvider.notifier).state = settings.theme == 'dark'
        ? ThemeMode.dark
        : ThemeMode.light;
    ref.read(localeProvider.notifier).state = _languageToLocale(
      settings.language,
    );
    ref.read(activeProviderIdProvider.notifier).state =
        settings.activeProviderId;
    ref.read(fontScaleProvider.notifier).state = settings.fontScale;
  }

  /// 仅持久化最近对话指针，避免整包 [updateSettings]。
  Future<void> updateLastConversation({
    required String characterId,
    required String conversationId,
  }) async {
    final current = state.valueOrNull;
    if (current == null) return;
    if (current.lastConversationCharacterId == characterId &&
        current.lastConversationId == conversationId) {
      return;
    }

    final next = current.copyWith(
      lastConversationCharacterId: characterId,
      lastConversationId: conversationId,
    );
    final db = ref.read(databaseProvider);
    await db.batch((batch) {
      batch.insert(
        db.settings,
        SettingsCompanion.insert(
          key: 'last_conversation_character_id',
          value: jsonEncode(characterId),
        ),
        mode: InsertMode.insertOrReplace,
      );
      batch.insert(
        db.settings,
        SettingsCompanion.insert(
          key: 'last_conversation_id',
          value: jsonEncode(conversationId),
        ),
        mode: InsertMode.insertOrReplace,
      );
    });
    state = AsyncData(next);
  }

  /// 从数据库加载设置
  Future<AppSettings> _loadFromDb(AppDatabase db) async {
    final rows = await db.select(db.settings).get();
    final map = <String, dynamic>{};
    for (final row in rows) {
      try {
        map[row.key] = jsonDecode(row.value);
      } catch (_) {
        map[row.key] = row.value;
      }
    }
    final storedApiKey = map['api_key'] as String? ?? '';
    final secretStorage = ref.read(secretStorageServiceProvider);
    map['api_key'] = await secretStorage.resolveApiKey(storedApiKey);
    if (map['image_gen'] is Map<String, dynamic>) {
      final imageGen = ImageGenSettings.fromJson(
        map['image_gen'] as Map<String, dynamic>,
      );
      final resolvedImageGen = await _resolveImageGenSecrets(
        secretStorage,
        imageGen,
      );
      map['image_gen'] = resolvedImageGen.toJson();
    }
    return _mapToSettings(map);
  }

  /// 更新设置
  Future<void> updateSettings(AppSettings newSettings) async {
    final db = ref.read(databaseProvider);
    final activeProviderId = ref.read(activeProviderIdProvider);
    final nextSettings = newSettings.copyWith(
      activeProviderId: activeProviderId,
    );
    final secretStorage = ref.read(secretStorageServiceProvider);
    final storedApiKey = await secretStorage.storeApiKeyOrEmpty(
      SecretStorageService.settingsApiKeyRef,
      nextSettings.apiKey,
    );
    final storedImageGen = await _storeImageGenSecrets(
      secretStorage,
      nextSettings.imageGen,
    );
    final entries = _settingsToMap(
      nextSettings.copyWith(apiKey: storedApiKey, imageGen: storedImageGen),
    );

    await db.batch((batch) {
      for (final entry in entries.entries) {
        batch.insert(
          db.settings,
          SettingsCompanion.insert(
            key: entry.key,
            value: jsonEncode(entry.value),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });

    _syncDerivedProviders(nextSettings);

    state = AsyncData(nextSettings);
  }

  Future<ImageGenSettings> _resolveImageGenSecrets(
    SecretStorageService secretStorage,
    ImageGenSettings imageGen,
  ) async {
    return imageGen.copyWith(
      naiApiKey: await secretStorage.resolveApiKey(imageGen.naiApiKey),
      customApiKey: await secretStorage.resolveApiKey(imageGen.customApiKey),
    );
  }

  Future<ImageGenSettings> _storeImageGenSecrets(
    SecretStorageService secretStorage,
    ImageGenSettings imageGen,
  ) async {
    final naiApiKey = await secretStorage.resolveApiKey(imageGen.naiApiKey);
    final customApiKey = await secretStorage.resolveApiKey(
      imageGen.customApiKey,
    );
    return imageGen.copyWith(
      naiApiKey: await secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.imageGenNaiApiKeyRef,
        naiApiKey,
      ),
      customApiKey: await secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.imageGenCustomApiKeyRef,
        customApiKey,
      ),
    );
  }

  /// 更新单个设置项
  Future<void> updateSetting(String key, dynamic value) async {
    final db = ref.read(databaseProvider);
    var storedValue = value;
    final secretStorage = ref.read(secretStorageServiceProvider);
    if (key == 'api_key') {
      storedValue = await secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.settingsApiKeyRef,
        value is String ? value : '',
      );
    } else if (key == 'image_gen' && value is Map<String, dynamic>) {
      storedValue = (await _storeImageGenSecrets(
        secretStorage,
        ImageGenSettings.fromJson(value),
      )).toJson();
    }
    await db
        .into(db.settings)
        .insertOnConflictUpdate(
          SettingsCompanion.insert(key: key, value: jsonEncode(storedValue)),
        );
    // 重新加载
    final nextSettings = await _loadFromDb(db);
    _syncDerivedProviders(nextSettings);
    state = AsyncData(nextSettings);
  }

  AppSettings _mapToSettings(Map<String, dynamic> map) {
    // 解析图片生成设置（存储为嵌套 JSON 对象）
    ImageGenSettings imageGen = const ImageGenSettings();
    if (map['image_gen'] is Map<String, dynamic>) {
      imageGen = ImageGenSettings.fromJson(
        map['image_gen'] as Map<String, dynamic>,
      );
    }

    // 解析画师串管理预设（存储为 JSON 数组）
    List<ArtistString> artistStrings = const [];
    if (map['artist_strings'] is List) {
      artistStrings = (map['artist_strings'] as List)
          .whereType<Map<String, dynamic>>()
          .map((item) => ArtistString.fromJson(item))
          .toList();
    } else if (map['artist_strings'] is String) {
      try {
        final decoded = jsonDecode(map['artist_strings'] as String);
        if (decoded is List) {
          artistStrings = decoded
              .whereType<Map<String, dynamic>>()
              .map((item) => ArtistString.fromJson(item))
              .toList();
        }
      } catch (_) {}
    }

    return AppSettings(
      apiBase: map['api_base'] as String? ?? '',
      apiKey: map['api_key'] as String? ?? '',
      model: map['model'] as String? ?? '',
      jsonMode: map['json_mode'] as bool? ?? false,
      temperature: (map['temperature'] as num?)?.toDouble() ?? 1.0,
      maxTokens: map['max_tokens'] as int? ?? 4096,
      contextWindow: map['context_window'] as int? ?? 131072,
      streaming: map['streaming'] as bool? ?? true,
      exampleDialogue: map['example_dialogue'] as bool? ?? true,
      memoryInject: map['memory_inject'] as bool? ?? true,
      showTimestamps: map['show_timestamps'] as bool? ?? true,
      memoryTriggerIntervalEnabled:
          map['memory_trigger_interval_enabled'] as bool? ?? true,
      memoryInterval: map['memory_interval'] as int? ?? 3,
      memoryTriggerTimeEnabled:
          map['memory_trigger_time_enabled'] as bool? ?? false,
      memoryTriggerTimeHours: map['memory_trigger_time_hours'] as int? ?? 24,
      memoryTriggerKeywordEnabled:
          map['memory_trigger_keyword_enabled'] as bool? ?? true,
      memoryTriggerKeywords: map['memory_trigger_keywords'] as String? ?? '晚安',
      memoryMaxInject: map['memory_max_inject'] as int? ?? 30,
      limitInject: map['limit_inject'] as bool? ?? false,
      theme: map['theme'] as String? ?? 'light',
      language: map['language'] as String? ?? 'zh',
      fontStyle: map['font_style'] as String? ?? 'wenkai',
      fontScale: (map['font_scale'] as num?)?.toDouble() ?? 1.0,
      autoResumeLastConversation:
          map['auto_resume_last_conversation'] as bool? ?? false,
      lastConversationCharacterId:
          map['last_conversation_character_id'] as String? ?? '',
      lastConversationId: map['last_conversation_id'] as String? ?? '',
      activeProviderId: map['active_provider_id'] as String? ?? '',
      imageGen: imageGen,
      artistStrings: artistStrings,
    );
  }

  Map<String, dynamic> _settingsToMap(AppSettings s) {
    return {
      'api_base': s.apiBase,
      'api_key': s.apiKey,
      'model': s.model,
      'json_mode': s.jsonMode,
      'temperature': s.temperature,
      'max_tokens': s.maxTokens,
      'context_window': s.contextWindow,
      'streaming': s.streaming,
      'example_dialogue': s.exampleDialogue,
      'memory_inject': s.memoryInject,
      'show_timestamps': s.showTimestamps,
      'memory_trigger_interval_enabled': s.memoryTriggerIntervalEnabled,
      'memory_interval': s.memoryInterval,
      'memory_trigger_time_enabled': s.memoryTriggerTimeEnabled,
      'memory_trigger_time_hours': s.memoryTriggerTimeHours,
      'memory_trigger_keyword_enabled': s.memoryTriggerKeywordEnabled,
      'memory_trigger_keywords': s.memoryTriggerKeywords,
      'memory_max_inject': s.memoryMaxInject,
      'limit_inject': s.limitInject,
      'theme': s.theme,
      'language': s.language,
      'font_style': s.fontStyle,
      'font_scale': s.fontScale,
      'auto_resume_last_conversation': s.autoResumeLastConversation,
      'last_conversation_character_id': s.lastConversationCharacterId,
      'last_conversation_id': s.lastConversationId,
      'active_provider_id': s.activeProviderId,
      'image_gen': s.imageGen.toJson(),
      'artist_strings': s.artistStrings.map((a) => a.toJson()).toList(),
    };
  }
}
