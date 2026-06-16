import 'package:flutter_test/flutter_test.dart';
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

void _expectSameSecret(String? actual, String expected) {
  expect(actual == expected, isTrue, reason: '应读回同一个测试密钥值');
}

void main() {
  group('SecretStorageService', () {
    test('writeApiKey/readApiKey/deleteApiKey 读写同一个引用', () async {
      final backend = _MemorySecretStorageBackend();
      final service = SecretStorageService(backend: backend);
      final reference = SecretStorageService.apiProviderKeyRef('provider-1');
      const secret = 'main-test-secret';

      await service.writeApiKey(reference, secret);

      _expectSameSecret(await service.readApiKey(reference), secret);

      await service.deleteApiKey(reference);
      expect(await service.readApiKey(reference), isNull);
    });

    test('readApiKey 缺失值返回 null', () async {
      final service = SecretStorageService(
        backend: _MemorySecretStorageBackend(),
      );

      expect(
        await service.readApiKey(
          SecretStorageService.settingsApiKeyRef,
        ),
        isNull,
      );
    });

    test('resolveApiKey 兼容旧明文字段并解析新引用', () async {
      final backend = _MemorySecretStorageBackend();
      final service = SecretStorageService(backend: backend);
      final reference = SecretStorageService.apiProviderKeyRef('provider-2');
      const legacySecret = 'legacy-test-secret';
      const storedSecret = 'stored-test-secret';
      await service.writeApiKey(reference, storedSecret);

      _expectSameSecret(
        await service.resolveApiKey(legacySecret),
        legacySecret,
      );
      _expectSameSecret(await service.resolveApiKey(reference), storedSecret);
      expect(await service.resolveApiKey(''), '');
    });
  });
}
