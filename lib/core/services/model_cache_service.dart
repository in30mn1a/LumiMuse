import 'dart:convert';

import 'package:drift/drift.dart' as drift;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../database/database.dart';
import '../providers/database_provider.dart';
import 'llm_service.dart';

/// 基于 Drift `ModelCache` 表的缓存后端实现。
///
/// `LlmService` 通过 `ModelCacheBackend` 抽象隔离数据库依赖，本类是生产实现：
/// - `read`：按 `api_base` 主键查询单行，反序列化 `models` JSON，返回 `(models, cachedAt)`；
/// - `write`：`insertOnConflictUpdate` upsert（对齐主项目 `INSERT ... ON CONFLICT
///   (api_base) DO UPDATE`）。`cachedAt` 由调用方传入（`LlmService` 用 `DateTime.now()`）。
class DriftModelCacheBackend implements ModelCacheBackend {
  final AppDatabase _db;

  DriftModelCacheBackend(this._db);

  @override
  Future<({List<String> models, DateTime cachedAt})?> read(
    String apiBase,
  ) async {
    final row = await (_db.select(_db.modelCache)
          ..where((t) => t.apiBase.equals(apiBase)))
        .getSingleOrNull();
    if (row == null) return null;
    final decoded = jsonDecode(row.models);
    final models = decoded is List
        ? decoded.map((e) => e.toString()).toList()
        : const <String>[];
    return (models: models, cachedAt: row.cachedAt);
  }

  @override
  Future<void> write(
    String apiBase,
    List<String> models,
    DateTime cachedAt,
  ) async {
    await _db.into(_db.modelCache).insertOnConflictUpdate(
          ModelCacheCompanion.insert(
            apiBase: apiBase,
            models: drift.Value(jsonEncode(models)),
            // Drift 的 DateTimeColumn 以毫秒时间戳存储；这里显式传入写入时间，
            // 避免依赖 DB 默认值导致回退判定时拿不到真实缓存时刻。
            cachedAt: drift.Value(cachedAt),
          ),
        );
  }
}

/// 缓存后端 Provider — 让 `LlmService` 默认带上 Drift 缓存。
final modelCacheBackendProvider = Provider<ModelCacheBackend>((ref) {
  return DriftModelCacheBackend(ref.read(databaseProvider));
});
