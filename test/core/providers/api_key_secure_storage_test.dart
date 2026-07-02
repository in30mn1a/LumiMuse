import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/api_provider_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';
import 'package:lumimuse/core/services/secret_storage_service.dart';

class _MemorySecretStorageBackend implements SecretStorageBackend {
  final Map<String, String> values = {};

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }

  @override
  Future<String?> read({required String key}) async {
    return values[key];
  }

  @override
  Future<void> write({required String key, required String value}) async {
    values[key] = value;
  }
}

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

ProviderContainer _createContainer(
  AppDatabase db,
  SecretStorageService secrets,
) {
  return ProviderContainer(
    overrides: [
      databaseProvider.overrideWithValue(db),
      secretStorageServiceProvider.overrideWithValue(secrets),
    ],
  );
}

void _expectSameSecret(String? actual, String expected) {
  expect(actual == expected, isTrue, reason: '应读回同一个测试密钥值');
}

Future<String> _settingValue(AppDatabase db, String key) async {
  final row = await (db.select(db.settings)..where((t) => t.key.equals(key)))
      .getSingle();
  return row.value;
}

void main() {
  group('SettingsNotifier API Key 安全存储', () {
    test('updateSettings 新保存主 API Key 时 settings 表只保留安全存储引用', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      await container.read(settingsProvider.future);
      await container.read(settingsProvider.notifier).updateSettings(
            const AppSettings(
              apiBase: 'https://api.example.test/v1',
              apiKey: 'main-test-secret',
              model: 'model-a',
            ),
          );

      final rawValue = await _settingValue(db, 'api_key');
      final storedRef = jsonDecode(rawValue) as String;
      expect(storedRef != 'main-test-secret', isTrue);
      expect(SecretStorageService.isSecretReference(storedRef), isTrue);
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.settingsApiKeyRef),
        'main-test-secret',
      );
      _expectSameSecret(
        container.read(settingsProvider).valueOrNull?.apiKey,
        'main-test-secret',
      );
    });

    test('旧 settings 明文 API Key 能读取，并在更新时迁移为安全存储引用', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      await db.into(db.settings).insert(
            SettingsCompanion.insert(
              key: 'api_key',
              value: jsonEncode('legacy-main-test-secret'),
            ),
          );

      final loaded = await container.read(settingsProvider.future);
      _expectSameSecret(loaded.apiKey, 'legacy-main-test-secret');

      await container.read(settingsProvider.notifier).updateSettings(
            loaded.copyWith(model: 'new-model'),
          );

      final rawValue = await _settingValue(db, 'api_key');
      final storedRef = jsonDecode(rawValue) as String;
      expect(storedRef != 'legacy-main-test-secret', isTrue);
      expect(SecretStorageService.isSecretReference(storedRef), isTrue);
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.settingsApiKeyRef),
        'legacy-main-test-secret',
      );
    });
  });

  group('ApiProviderListNotifier API Key 安全存储', () {
    test('saveCurrentAsProvider 新增 provider 时 api_providers.api_key 不写明文', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      await container.read(settingsProvider.future);
      await container.read(settingsProvider.notifier).updateSettings(
            const AppSettings(
              apiBase: 'https://provider.example.test/v1',
              apiKey: 'provider-test-secret',
              model: 'provider-model',
            ),
          );
      await container.read(apiProviderListProvider.future);

      final id = await container
          .read(apiProviderListProvider.notifier)
          .saveCurrentAsProvider('Provider A');

      final row = await (db.select(db.apiProviders)
            ..where((t) => t.id.equals(id)))
          .getSingle();
      expect(row.apiKey != 'provider-test-secret', isTrue);
      expect(SecretStorageService.isSecretReference(row.apiKey), isTrue);
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.apiProviderKeyRef(id)),
        'provider-test-secret',
      );

      final providers = container.read(apiProviderListProvider).valueOrNull!;
      // UI 脱敏后 ApiProviderData.apiKey 展示为掩码（对齐主项目 providers/route.ts
      // 的 rowToProvider）；真实 key 的读回由上面 secrets.readApiKey 断言覆盖。
      expect(providers.single.apiKey, SecretStorageService.kApiKeyMask);
    });

    test('旧 provider 明文能读取；掩码=不修改时保留 DB 旧值不迁移', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      await db.into(db.apiProviders).insert(
            ApiProvidersCompanion.insert(
              id: 'legacy-provider',
              name: 'Legacy',
              apiBase: const Value('https://legacy.example.test/v1'),
              apiKey: const Value('legacy-provider-test-secret'),
              model: const Value('legacy-model'),
            ),
          );

      final providers = await container.read(apiProviderListProvider.future);
      // UI 脱敏后展示为掩码；真实 key 的读回由下方 updateProvider 后的
      // secrets.readApiKey 断言覆盖。
      expect(providers.single.apiKey, SecretStorageService.kApiKeyMask);

      await container.read(settingsProvider.future);
      await container
          .read(apiProviderListProvider.notifier)
          .updateProvider(
            providers.single.copyWith(model: 'updated-model'),
          );

      final row = await (db.select(db.apiProviders)
            ..where((t) => t.id.equals('legacy-provider')))
          .getSingle();
      // 掩码=不修改：updateProvider 收到掩码时保留 DB 旧 apiKey 值不覆盖
      // （对齐主项目 providers/route.ts 的 resolveProviderKey）。旧明文因此
      // 不会被本次更新迁移成引用——迁移发生在用户主动输入新 key 时。
      expect(row.apiKey, 'legacy-provider-test-secret');
    });

    test('activateProvider 用安全存储中的 API Key 写入 settings 状态', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      final reference = SecretStorageService.apiProviderKeyRef('provider-ref');
      await secrets.writeApiKey(reference, 'activate-test-secret');
      await db.into(db.apiProviders).insert(
            ApiProvidersCompanion.insert(
              id: 'provider-ref',
              name: 'Stored Provider',
              apiBase: const Value('https://stored.example.test/v1'),
              apiKey: Value(reference),
              model: const Value('stored-model'),
            ),
          );

      await container.read(settingsProvider.future);
      await container.read(apiProviderListProvider.future);
      await container
          .read(apiProviderListProvider.notifier)
          .activateProvider('provider-ref');

      _expectSameSecret(
        container.read(settingsProvider).valueOrNull?.apiKey,
        'activate-test-secret',
      );
      final rawValue = await _settingValue(db, 'api_key');
      final storedRef = jsonDecode(rawValue) as String;
      expect(storedRef != 'activate-test-secret', isTrue);
      expect(SecretStorageService.isSecretReference(storedRef), isTrue);
    });
  });
}

extension on ApiProviderData {
  ApiProviderData copyWith({
    String? name,
    String? apiBase,
    String? apiKey,
    String? model,
    double? temperature,
    int? maxTokens,
    int? contextWindow,
    bool? jsonMode,
  }) {
    return ApiProviderData(
      id: id,
      name: name ?? this.name,
      apiBase: apiBase ?? this.apiBase,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      temperature: temperature ?? this.temperature,
      maxTokens: maxTokens ?? this.maxTokens,
      contextWindow: contextWindow ?? this.contextWindow,
      jsonMode: jsonMode ?? this.jsonMode,
      createdAt: createdAt,
    );
  }
}
