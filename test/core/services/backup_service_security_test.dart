import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/backup_service.dart';
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

Future<void> _seedCharacter(AppDatabase db, String id) async {
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(
          id: id,
          name: const Value('备份测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

Future<void> _seedCharacterScopedData(
  AppDatabase db,
  String characterId,
) async {
  await db
      .into(db.memories)
      .insert(
        MemoriesCompanion.insert(
          id: 'memory-for-$characterId',
          characterId: characterId,
          category: '关系动态',
          content: '这条记忆用于确认可选段不会被导入',
          createdAt: Value(DateTime(2026, 1, 2)),
          updatedAt: Value(DateTime(2026, 1, 2)),
        ),
      );
  await db
      .into(db.conversations)
      .insert(
        ConversationsCompanion.insert(
          id: 'conversation-for-$characterId',
          characterId: characterId,
          title: const Value('可选对话'),
          createdAt: Value(DateTime(2026, 1, 3)),
          updatedAt: Value(DateTime(2026, 1, 3)),
        ),
      );
  await db
      .into(db.messages)
      .insert(
        MessagesCompanion.insert(
          id: 'message-for-$characterId',
          conversationId: 'conversation-for-$characterId',
          role: 'user',
          content: const Value('这条消息用于确认对话段未导入'),
          createdAt: Value(DateTime(2026, 1, 3, 0, 1)),
        ),
      );
}

void _expectSameSecret(String? actual, String expected) {
  expect(actual == expected, isTrue, reason: '应读回同一个测试密钥值');
}

Map<String, dynamic> _minimalV1Backup({
  Object? version = 1,
  Object? schemaVersion,
  Map<String, dynamic>? settings,
  List<Map<String, dynamic>> apiProviders = const [],
}) {
  return {
    if (version != null) 'version': version,
    if (schemaVersion != null) 'schema_version': schemaVersion,
    'exported_at': '2026-01-01T00:00:00.000Z',
    'characters': [
      {
        'id': 'char-import',
        'name': '导入角色',
        'created_at': '2026-01-01T00:00:00.000Z',
        'updated_at': '2026-01-01T00:00:00.000Z',
      },
    ],
    'conversations': <Map<String, dynamic>>[],
    'messages': <Map<String, dynamic>>[],
    'memories': <Map<String, dynamic>>[],
    if (settings != null) 'settings': settings,
    if (apiProviders.isNotEmpty) 'api_providers': apiProviders,
  };
}

Map<String, dynamic> _minimalV2Backup({Object? version = 2}) {
  return {
    if (version != null) 'version': version,
    'schema_version': BackupService.currentSchemaVersion,
    'exported_at': '2026-01-01T00:00:00.000Z',
    'character': {
      'id': 'char-v2',
      'name': '单角色',
      'created_at': '2026-01-01T00:00:00.000Z',
      'updated_at': '2026-01-01T00:00:00.000Z',
    },
    'conversations': <Map<String, dynamic>>[],
    'memories': <Map<String, dynamic>>[],
  };
}

void main() {
  group('BackupService 敏感凭据导出语义', () {
    test('默认导出不包含 settings/API Provider 中的 API Key', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      addTearDown(db.close);

      const mainSecret = 'main-export-test-secret';
      const providerSecret = 'provider-export-test-secret';
      const mainRef = SecretStorageService.settingsApiKeyRef;
      final providerRef = SecretStorageService.apiProviderKeyRef('provider-1');
      await secrets.writeApiKey(mainRef, mainSecret);
      await secrets.writeApiKey(providerRef, providerSecret);
      await db
          .into(db.settings)
          .insert(
            SettingsCompanion.insert(
              key: 'api_key',
              value: jsonEncode(mainRef),
            ),
          );
      await db
          .into(db.apiProviders)
          .insert(
            ApiProvidersCompanion.insert(
              id: 'provider-1',
              name: 'Provider 1',
              apiBase: const Value('https://api.example.test/v1'),
              apiKey: Value(providerRef),
              model: const Value('model-a'),
            ),
          );

      final jsonStr = await BackupService(
        db,
        secretStorage: secrets,
      ).exportToJson();
      final exported = jsonDecode(jsonStr) as Map<String, dynamic>;

      expect(jsonStr.contains(mainSecret), isFalse);
      expect(jsonStr.contains(providerSecret), isFalse);
      expect((exported['settings'] as Map).containsKey('api_key'), isFalse);
      final apiProviders = exported['api_providers'] as List;
      expect((apiProviders.single as Map).containsKey('api_key'), isFalse);
      expect((exported['_meta'] as Map)['includesSecrets'], isFalse);
    });

    test('includeSecrets=true 从安全存储解析 settings/API Provider API Key', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      addTearDown(db.close);

      const mainSecret = 'main-include-test-secret';
      const providerSecret = 'provider-include-test-secret';
      const mainRef = SecretStorageService.settingsApiKeyRef;
      final providerRef = SecretStorageService.apiProviderKeyRef('provider-2');
      await secrets.writeApiKey(mainRef, mainSecret);
      await secrets.writeApiKey(providerRef, providerSecret);
      await db
          .into(db.settings)
          .insert(
            SettingsCompanion.insert(
              key: 'api_key',
              value: jsonEncode(mainRef),
            ),
          );
      await db
          .into(db.apiProviders)
          .insert(
            ApiProvidersCompanion.insert(
              id: 'provider-2',
              name: 'Provider 2',
              apiBase: const Value('https://api.example.test/v1'),
              apiKey: Value(providerRef),
              model: const Value('model-b'),
            ),
          );

      final jsonStr = await BackupService(
        db,
        secretStorage: secrets,
      ).exportToJson(includeSecrets: true);
      final exported = jsonDecode(jsonStr) as Map<String, dynamic>;

      final settings = exported['settings'] as Map<String, dynamic>;
      expect(settings['api_key'] == jsonEncode(mainSecret), isTrue);
      final apiProviders = exported['api_providers'] as List;
      expect(
        (apiProviders.single as Map<String, dynamic>)['api_key'] ==
            providerSecret,
        isTrue,
      );
      expect((exported['_meta'] as Map)['includesSecrets'], isTrue);
    });

    test('includeSecrets=true 从安全存储解析 image_gen API Key', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      addTearDown(db.close);

      const naiSecret = 'nai-image-include-test-secret';
      const customSecret = 'custom-image-include-test-secret';
      const naiRef = 'secret://api-key/settings/image-gen/nai';
      const customRef = 'secret://api-key/settings/image-gen/custom';
      await secrets.writeApiKey(naiRef, naiSecret);
      await secrets.writeApiKey(customRef, customSecret);
      await db
          .into(db.settings)
          .insert(
            SettingsCompanion.insert(
              key: 'image_gen',
              value: jsonEncode({
                'enabled': true,
                'engine': 'custom',
                'nai_api_key': naiRef,
                'custom_api_key': customRef,
              }),
            ),
          );

      final jsonStr = await BackupService(
        db,
        secretStorage: secrets,
      ).exportToJson(includeSecrets: true);
      final exported = jsonDecode(jsonStr) as Map<String, dynamic>;
      final settings = exported['settings'] as Map<String, dynamic>;
      final imageGen = jsonDecode(settings['image_gen'] as String) as Map;

      expect(imageGen['nai_api_key'] == naiSecret, isTrue);
      expect(imageGen['custom_api_key'] == customSecret, isTrue);
      expect(jsonStr.contains(naiRef), isFalse);
      expect(jsonStr.contains(customRef), isFalse);
    });

    test('导入含凭据备份时写入安全存储引用而不是明文', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      addTearDown(db.close);

      const mainSecret = 'main-import-test-secret';
      const providerSecret = 'provider-import-test-secret';
      final importJson = jsonEncode(
        _minimalV1Backup(
          settings: {'api_key': jsonEncode(mainSecret)},
          apiProviders: [
            {
              'id': 'import-provider',
              'name': 'Imported',
              'api_base': 'https://import.example.test/v1',
              'api_key': providerSecret,
              'model': 'import-model',
              'temperature': 0.8,
              'max_tokens': 2048,
              'context_window': 8192,
              'json_mode': 1,
              'created_at': '2026-01-01T00:00:00.000Z',
            },
          ],
        ),
      );

      await BackupService(
        db,
        secretStorage: secrets,
      ).importFromJson(importJson);

      final setting = await (db.select(
        db.settings,
      )..where((t) => t.key.equals('api_key'))).getSingle();
      final settingRef = jsonDecode(setting.value) as String;
      expect(settingRef != mainSecret, isTrue);
      expect(SecretStorageService.isSecretReference(settingRef), isTrue);
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.settingsApiKeyRef),
        mainSecret,
      );

      final provider = await (db.select(
        db.apiProviders,
      )..where((t) => t.id.equals('import-provider'))).getSingle();
      expect(provider.apiKey != providerSecret, isTrue);
      expect(SecretStorageService.isSecretReference(provider.apiKey), isTrue);
      _expectSameSecret(
        await secrets.readApiKey(
          SecretStorageService.apiProviderKeyRef('import-provider'),
        ),
        providerSecret,
      );
    });

    test('导入含 image_gen 凭据备份时写入安全存储引用而不是明文', () async {
      final db = _createTestDb();
      final backend = _MemorySecretStorageBackend();
      final secrets = SecretStorageService(backend: backend);
      addTearDown(db.close);

      const naiSecret = 'nai-image-import-test-secret';
      const customSecret = 'custom-image-import-test-secret';
      final importJson = jsonEncode(
        _minimalV1Backup(
          settings: {
            'image_gen': jsonEncode({
              'enabled': true,
              'engine': 'custom',
              'nai_api_key': naiSecret,
              'custom_api_key': customSecret,
            }),
          },
        ),
      );

      await BackupService(
        db,
        secretStorage: secrets,
      ).importFromJson(importJson);

      final setting = await (db.select(
        db.settings,
      )..where((t) => t.key.equals('image_gen'))).getSingle();
      final imageGen = jsonDecode(setting.value) as Map;

      expect(imageGen['nai_api_key'] != naiSecret, isTrue);
      expect(imageGen['custom_api_key'] != customSecret, isTrue);
      expect(
        SecretStorageService.isSecretReference(
          imageGen['nai_api_key'] as String,
        ),
        isTrue,
      );
      expect(
        SecretStorageService.isSecretReference(
          imageGen['custom_api_key'] as String,
        ),
        isTrue,
      );
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.imageGenNaiApiKeyRef),
        naiSecret,
      );
      _expectSameSecret(
        await secrets.readApiKey(SecretStorageService.imageGenCustomApiKeyRef),
        customSecret,
      );
    });
  });

  group('BackupService 版本上限校验', () {
    test('全量和单角色导出都包含 version/schema_version', () async {
      final db = _createTestDb();
      addTearDown(db.close);
      await _seedCharacter(db, 'char-export-version');

      final service = BackupService(db);
      final full = jsonDecode(await service.exportToJson()) as Map;
      final character = await service.exportCharacterToJson(
        'char-export-version',
      );

      expect(BackupService.currentSchemaVersion, db.schemaVersion);
      expect(full['version'], BackupService.currentFullBackupVersion);
      expect(full['schema_version'], BackupService.currentSchemaVersion);
      expect(character['version'], BackupService.currentCharacterBackupVersion);
      expect(character['schema_version'], BackupService.currentSchemaVersion);
    });

    test('validateBackupJson 拒绝未来 version/schema_version 和非法 version 类型', () {
      final futureVersion = BackupService.validateBackupJson(
        jsonEncode(
          _minimalV1Backup(version: BackupService.currentFullBackupVersion + 1),
        ),
      );
      expect(futureVersion.isValid, isFalse);
      expect(futureVersion.errorMessage, contains('version'));

      final futureSchema = BackupService.validateBackupJson(
        jsonEncode(
          _minimalV1Backup(
            schemaVersion: BackupService.currentSchemaVersion + 1,
          ),
        ),
      );
      expect(futureSchema.isValid, isFalse);
      expect(futureSchema.errorMessage, contains('schema_version'));

      final invalidVersion = BackupService.validateBackupJson(
        jsonEncode(_minimalV1Backup(version: '1')),
      );
      expect(invalidVersion.isValid, isFalse);
      expect(invalidVersion.errorMessage, contains('version'));
    });

    test('validateBackupJson 兼容 v1 全量、v2 单角色和缺 version 旧格式', () {
      final v1 = BackupService.validateBackupJson(
        jsonEncode(_minimalV1Backup()),
      );
      expect(v1.isValid, isTrue);

      final v2 = BackupService.validateBackupJson(
        jsonEncode(_minimalV2Backup()),
      );
      expect(v2.isValid, isTrue);

      final legacyWithoutVersion = BackupService.validateBackupJson(
        jsonEncode(_minimalV1Backup(version: null)),
      );
      expect(legacyWithoutVersion.isValid, isTrue);
    });

    test('importWithOptions 拒绝未来 version', () async {
      final db = _createTestDb();
      addTearDown(db.close);

      await expectLater(
        BackupService(db).importWithOptions(
          jsonEncode(
            _minimalV2Backup(
              version: BackupService.currentCharacterBackupVersion + 1,
            ),
          ),
        ),
        throwsFormatException,
      );
    });
  });

  group('BackupService 单角色可选段导入', () {
    test('validateBackupJson 仍拒绝类型错误的单角色可选段', () {
      final invalidConversations = BackupService.validateBackupJson(
        jsonEncode({..._minimalV2Backup(), 'conversations': 'not_an_array'}),
      );
      final invalidMemories = BackupService.validateBackupJson(
        jsonEncode({..._minimalV2Backup(), 'memories': 'not_an_array'}),
      );

      expect(invalidConversations.isValid, isFalse);
      expect(invalidConversations.errorMessage, contains('conversations'));
      expect(invalidMemories.isValid, isFalse);
      expect(invalidMemories.errorMessage, contains('memories'));
    });

    test('importWithOptions 接受省略记忆和对话的单角色备份', () async {
      final sourceDb = _createTestDb();
      final targetDb = _createTestDb();
      addTearDown(sourceDb.close);
      addTearDown(targetDb.close);

      const characterId = 'char-optional-import';
      await _seedCharacter(sourceDb, characterId);
      await _seedCharacterScopedData(sourceDb, characterId);

      final exported = await BackupService(sourceDb).exportCharacterToJson(
        characterId,
        options: const ExportOptions(
          includeMemories: false,
          includeConversations: false,
        ),
      );

      expect(exported.containsKey('character'), isTrue);
      expect(exported.containsKey('memories'), isFalse);
      expect(exported.containsKey('conversations'), isFalse);

      final result = await BackupService(
        targetDb,
      ).importWithOptions(jsonEncode(exported));

      final importedCharacters = await targetDb
          .select(targetDb.characters)
          .get();
      final importedMemories = await targetDb.select(targetDb.memories).get();
      final importedConversations = await targetDb
          .select(targetDb.conversations)
          .get();
      final importedMessages = await targetDb.select(targetDb.messages).get();

      expect(result.addedCount, 1);
      expect(result.memoriesImported, 0);
      expect(result.conversationsImported, 0);
      expect(result.messagesImported, 0);
      expect(importedCharacters, hasLength(1));
      expect(importedCharacters.single.name, '备份测试角色');
      expect(importedMemories, isEmpty);
      expect(importedConversations, isEmpty);
      expect(importedMessages, isEmpty);
    });
  });
}
