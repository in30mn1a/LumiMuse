import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import '../models/app_settings.dart';
import 'database_provider.dart';
import 'settings_provider.dart';

/// API 供应商数据模型
class ApiProviderData {
  final String id;
  final String name;
  final String apiBase;
  final String apiKey;
  final String model;
  final double temperature;
  final int maxTokens;
  final int contextWindow;
  final bool jsonMode;
  final DateTime createdAt;

  const ApiProviderData({
    required this.id,
    required this.name,
    required this.apiBase,
    required this.apiKey,
    required this.model,
    required this.temperature,
    required this.maxTokens,
    required this.contextWindow,
    required this.jsonMode,
    required this.createdAt,
  });
}

/// 供应商列表 Provider
final apiProviderListProvider =
    AsyncNotifierProvider<ApiProviderListNotifier, List<ApiProviderData>>(
  ApiProviderListNotifier.new,
);

class ApiProviderListNotifier extends AsyncNotifier<List<ApiProviderData>> {
  static const _uuid = Uuid();

  @override
  Future<List<ApiProviderData>> build() async {
    final db = ref.read(databaseProvider);
    try {
      return await _loadProviders(db);
    } catch (e) {
      // 仅在明确判定为 schema 不兼容（缺表/缺列）时才尝试重建表，
      // 其他异常（IO、约束、解析等）必须抛出，避免误删数据
      final msg = e.toString().toLowerCase();
      final isSchemaMissing = msg.contains('no such table') ||
          msg.contains('no such column');
      if (!isSchemaMissing) {
        rethrow;
      }
      try {
        // 仅当表/列缺失才重建。注意：这里没有 DROP，因为「表不存在」就不需要 DROP；
        // 「列缺失」的情况交给迁移层处理，而不是从数据层暴力 DROP 重建造成数据丢失
        await db.customStatement('''
          CREATE TABLE IF NOT EXISTS api_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            api_base TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            temperature REAL NOT NULL DEFAULT 1.0,
            max_tokens INTEGER NOT NULL DEFAULT 4096,
            context_window INTEGER NOT NULL DEFAULT 131072,
            json_mode INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
          )
        ''');
        return await _loadProviders(db);
      } catch (_) {
        return [];
      }
    }
  }

  Future<List<ApiProviderData>> _loadProviders(AppDatabase db) async {
    final rows = await (db.select(db.apiProviders)
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
    return rows
        .map((r) => ApiProviderData(
              id: r.id,
              name: r.name,
              apiBase: r.apiBase,
              apiKey: r.apiKey,
              model: r.model,
              temperature: r.temperature,
              maxTokens: r.maxTokens,
              contextWindow: r.contextWindow,
              jsonMode: r.jsonMode != 0,
              createdAt: r.createdAt,
            ))
        .toList();
  }

  /// 保存当前设置为新供应商
  Future<String> saveCurrentAsProvider(String name) async {
    final db = ref.read(databaseProvider);
    final settings = ref.read(settingsProvider).valueOrNull ?? const AppSettings();
    final id = _generateId();

    await db.into(db.apiProviders).insert(ApiProvidersCompanion.insert(
      id: id,
      name: name,
      apiBase: Value(settings.apiBase),
      apiKey: Value(settings.apiKey),
      model: Value(settings.model),
      temperature: Value(settings.temperature),
      maxTokens: Value(settings.maxTokens),
      contextWindow: Value(settings.contextWindow),
      jsonMode: Value(settings.jsonMode ? 1 : 0),
    ));

    // 设置当前激活供应商
    await _setActiveProviderId(db, id);
    ref.read(activeProviderIdProvider.notifier).state = id;

    state = AsyncData(await _loadProviders(db));
    return id;
  }

  /// 更新当前激活供应商的配置（从当前设置同步）
  Future<void> updateCurrentProvider() async {
    final db = ref.read(databaseProvider);
    final activeId = ref.read(activeProviderIdProvider);
    if (activeId.isEmpty) return;

    final settings = ref.read(settingsProvider).valueOrNull ?? const AppSettings();

    await (db.update(db.apiProviders)..where((t) => t.id.equals(activeId)))
        .write(ApiProvidersCompanion(
      apiBase: Value(settings.apiBase),
      apiKey: Value(settings.apiKey),
      model: Value(settings.model),
      temperature: Value(settings.temperature),
      maxTokens: Value(settings.maxTokens),
      contextWindow: Value(settings.contextWindow),
      jsonMode: Value(settings.jsonMode ? 1 : 0),
    ));

    state = AsyncData(await _loadProviders(db));
  }

  /// 切换激活供应商 — 把供应商配置写入 settings
  Future<void> activateProvider(String id) async {
    final db = ref.read(databaseProvider);
    final row = await (db.select(db.apiProviders)
          ..where((t) => t.id.equals(id)))
        .getSingleOrNull();
    if (row == null) return;

    // 把供应商配置写入 settings
    final settingsNotifier = ref.read(settingsProvider.notifier);
    final current = ref.read(settingsProvider).valueOrNull ?? const AppSettings();
    await settingsNotifier.updateSettings(current.copyWith(
      apiBase: row.apiBase,
      apiKey: row.apiKey,
      model: row.model,
      temperature: row.temperature,
      maxTokens: row.maxTokens,
      contextWindow: row.contextWindow,
      jsonMode: row.jsonMode != 0,
    ));

    await _setActiveProviderId(db, id);
    ref.read(activeProviderIdProvider.notifier).state = id;
  }

  /// 删除供应商
  Future<void> deleteProvider(String id) async {
    final db = ref.read(databaseProvider);
    await (db.delete(db.apiProviders)..where((t) => t.id.equals(id))).go();

    // 如果删除的是当前激活的，清空激活 ID
    final activeId = ref.read(activeProviderIdProvider);
    if (activeId == id) {
      await _setActiveProviderId(db, '');
      ref.read(activeProviderIdProvider.notifier).state = '';
    }

    state = AsyncData(await _loadProviders(db));
  }

  /// 编辑供应商
  Future<void> updateProvider(ApiProviderData provider) async {
    final db = ref.read(databaseProvider);
    await (db.update(db.apiProviders)..where((t) => t.id.equals(provider.id)))
        .write(ApiProvidersCompanion(
      name: Value(provider.name),
      apiBase: Value(provider.apiBase),
      apiKey: Value(provider.apiKey),
      model: Value(provider.model),
      temperature: Value(provider.temperature),
      maxTokens: Value(provider.maxTokens),
      contextWindow: Value(provider.contextWindow),
      jsonMode: Value(provider.jsonMode ? 1 : 0),
    ));

    // 如果编辑的是当前激活的，同步到 settings
    final activeId = ref.read(activeProviderIdProvider);
    if (activeId == provider.id) {
      await activateProvider(provider.id);
    }

    state = AsyncData(await _loadProviders(db));
  }

  Future<void> _setActiveProviderId(AppDatabase db, String id) async {
    await db.into(db.settings).insertOnConflictUpdate(
      SettingsCompanion.insert(
        key: 'active_provider_id',
        // 用 jsonEncode 安全转义 id，避免引号/反斜杠造成的 JSON 注入
        value: jsonEncode(id),
      ),
    );
  }

  String _generateId() => _uuid.v4();
}
