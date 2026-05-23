import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
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
    // 冷启动时同步 locale，确保首屏渲染前 MaterialApp.locale 已就位
    ref.read(localeProvider.notifier).state =
        _languageToLocale(settings.language);
    // 同步 activeProviderId
    ref.read(activeProviderIdProvider.notifier).state =
        settings.activeProviderId;
    return settings;
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
    return _mapToSettings(map);
  }

  /// 更新设置
  Future<void> updateSettings(AppSettings newSettings) async {
    final db = ref.read(databaseProvider);
    final entries = _settingsToMap(newSettings);

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

    ref.read(themeModeProvider.notifier).state =
        newSettings.theme == 'dark' ? ThemeMode.dark : ThemeMode.light;

    // 同步 locale：保证「写库 + 写 Provider」在同一调用栈内完成，
    // MaterialApp 顶层 watch 后立即重建为新语言。
    ref.read(localeProvider.notifier).state =
        _languageToLocale(newSettings.language);

    state = AsyncData(newSettings);
  }

  /// 更新单个设置项
  Future<void> updateSetting(String key, dynamic value) async {
    final db = ref.read(databaseProvider);
    await db.into(db.settings).insertOnConflictUpdate(
      SettingsCompanion.insert(key: key, value: jsonEncode(value)),
    );
    // 重新加载
    state = AsyncData(await _loadFromDb(db));
  }

  AppSettings _mapToSettings(Map<String, dynamic> map) {
    // 解析图片生成设置（存储为嵌套 JSON 对象）
    ImageGenSettings imageGen = const ImageGenSettings();
    if (map['image_gen'] is Map<String, dynamic>) {
      imageGen = ImageGenSettings.fromJson(map['image_gen'] as Map<String, dynamic>);
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
      memoryTriggerIntervalEnabled: map['memory_trigger_interval_enabled'] as bool? ?? true,
      memoryInterval: map['memory_interval'] as int? ?? 3,
      memoryTriggerTimeEnabled: map['memory_trigger_time_enabled'] as bool? ?? false,
      memoryTriggerTimeHours: map['memory_trigger_time_hours'] as int? ?? 24,
      memoryTriggerKeywordEnabled: map['memory_trigger_keyword_enabled'] as bool? ?? true,
      memoryTriggerKeywords: map['memory_trigger_keywords'] as String? ?? '晚安',
      memoryMaxInject: map['memory_max_inject'] as int? ?? 30,
      limitInject: map['limit_inject'] as bool? ?? false,
      theme: map['theme'] as String? ?? 'light',
      language: map['language'] as String? ?? 'zh',
      fontStyle: map['font_style'] as String? ?? 'wenkai',
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
      'active_provider_id': s.activeProviderId,
      'image_gen': s.imageGen.toJson(),
      'artist_strings': s.artistStrings.map((a) => a.toJson()).toList(),
    };
  }
}
