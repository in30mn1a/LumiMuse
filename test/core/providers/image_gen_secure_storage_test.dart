import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
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

Future<Map<String, dynamic>> _imageGenValue(AppDatabase db) async {
  final row = await (db.select(
    db.settings,
  )..where((t) => t.key.equals('image_gen'))).getSingle();
  return jsonDecode(row.value) as Map<String, dynamic>;
}

void _expectSameSecret(String? actual, String expected) {
  expect(actual == expected, isTrue, reason: '应读回同一个测试密钥值');
}

void main() {
  group('图片生成 API Key 安全存储', () {
    test(
      'updateSettings 新保存 image_gen 时 settings 表不写入 NAI/自定义 API Key 明文',
      () async {
        final db = _createTestDb();
        final backend = _MemorySecretStorageBackend();
        final secrets = SecretStorageService(backend: backend);
        final container = _createContainer(db, secrets);
        addTearDown(container.dispose);
        addTearDown(db.close);

        await container.read(settingsProvider.future);
        await container
            .read(settingsProvider.notifier)
            .updateSettings(
              const AppSettings(
                imageGen: ImageGenSettings(
                  enabled: true,
                  engine: 'custom',
                  naiApiKey: 'nai-image-secret',
                  customApiKey: 'custom-image-secret',
                ),
              ),
            );

        final storedImageGen = await _imageGenValue(db);
        expect(storedImageGen['nai_api_key'] != 'nai-image-secret', isTrue);
        expect(
          storedImageGen['custom_api_key'] != 'custom-image-secret',
          isTrue,
        );
        expect(
          SecretStorageService.isSecretReference(
            storedImageGen['nai_api_key'] as String,
          ),
          isTrue,
        );
        expect(
          SecretStorageService.isSecretReference(
            storedImageGen['custom_api_key'] as String,
          ),
          isTrue,
        );
        expect(backend.values.containsValue('nai-image-secret'), isTrue);
        expect(backend.values.containsValue('custom-image-secret'), isTrue);
        _expectSameSecret(
          container.read(settingsProvider).valueOrNull?.imageGen.naiApiKey,
          'nai-image-secret',
        );
        _expectSameSecret(
          container.read(settingsProvider).valueOrNull?.imageGen.customApiKey,
          'custom-image-secret',
        );
      },
    );

    test('旧 image_gen 明文 API Key 能读取，并在更新时迁移为安全存储引用', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      final container = _createContainer(db, secrets);
      addTearDown(container.dispose);
      addTearDown(db.close);

      await db
          .into(db.settings)
          .insert(
            SettingsCompanion.insert(
              key: 'image_gen',
              value: jsonEncode({
                'enabled': true,
                'engine': 'custom',
                'nai_api_key': 'legacy-nai-image-secret',
                'custom_api_key': 'legacy-custom-image-secret',
              }),
            ),
          );

      final loaded = await container.read(settingsProvider.future);
      _expectSameSecret(loaded.imageGen.naiApiKey, 'legacy-nai-image-secret');
      _expectSameSecret(
        loaded.imageGen.customApiKey,
        'legacy-custom-image-secret',
      );

      await container
          .read(settingsProvider.notifier)
          .updateSettings(loaded.copyWith(model: 'updated-model'));

      final storedImageGen = await _imageGenValue(db);
      expect(
        storedImageGen['nai_api_key'] != 'legacy-nai-image-secret',
        isTrue,
      );
      expect(
        storedImageGen['custom_api_key'] != 'legacy-custom-image-secret',
        isTrue,
      );
      expect(
        SecretStorageService.isSecretReference(
          storedImageGen['nai_api_key'] as String,
        ),
        isTrue,
      );
      expect(
        SecretStorageService.isSecretReference(
          storedImageGen['custom_api_key'] as String,
        ),
        isTrue,
      );
      expect(backend.values.containsValue('legacy-nai-image-secret'), isTrue);
      expect(
        backend.values.containsValue('legacy-custom-image-secret'),
        isTrue,
      );
    });
  });
}
