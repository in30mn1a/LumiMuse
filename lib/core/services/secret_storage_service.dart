import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 安全存储底层接口，便于测试替换为内存实现。
abstract class SecretStorageBackend {
  Future<String?> read({required String key});
  Future<void> write({required String key, required String value});
  Future<void> delete({required String key});
}

class FlutterSecureStorageBackend implements SecretStorageBackend {
  final FlutterSecureStorage _storage;

  FlutterSecureStorageBackend({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  @override
  Future<void> delete({required String key}) {
    return _storage.delete(key: key);
  }

  @override
  Future<String?> read({required String key}) {
    return _storage.read(key: key);
  }

  @override
  Future<void> write({required String key, required String value}) {
    return _storage.write(key: key, value: value);
  }
}

/// API Key 安全存储适配层。
///
/// 数据库中的 `api_key` 字段只保留 `secret://api-key/...` 引用；旧版明文值
/// 通过 [resolveApiKey] 继续兼容读取，并在下一次保存时迁移成引用。
class SecretStorageService {
  static const _prefix = 'secret://api-key/';
  static const settingsApiKeyRef = '${_prefix}settings/main';
  static const imageGenNaiApiKeyRef = '${_prefix}settings/image-gen/nai';
  static const imageGenCustomApiKeyRef = '${_prefix}settings/image-gen/custom';
  static const memoryEngineEmbeddingApiKeyRef =
      '${_prefix}settings/memory-engine/embedding';
  static const memoryEngineRerankerApiKeyRef =
      '${_prefix}settings/memory-engine/reranker';

  /// API Key 脱敏掩码，对齐主项目 `API_KEY_MASK`（`src/lib/constants.ts`）。
  ///
  /// 语义契约（与主项目 `src/app/api/settings/route.ts` 一致）：
  /// - 展示侧：已保存的 key 在 UI 显示为本掩码而非明文；
  /// - 保存侧：字段值 == 本掩码视为「不修改」，保留 DB 旧值，不得用掩码覆盖真实 key；
  /// - 字段为空串视为显式清空；字段为其它非掩码值视为写入新值。
  static const String kApiKeyMask = '********';

  final SecretStorageBackend _backend;

  SecretStorageService({SecretStorageBackend? backend})
    : _backend = backend ?? FlutterSecureStorageBackend();

  static String apiProviderKeyRef(String providerId) {
    return '${_prefix}providers/$providerId';
  }

  static bool isSecretReference(String value) {
    return value.startsWith(_prefix);
  }

  Future<String?> readApiKey(String reference) {
    return _backend.read(key: reference);
  }

  Future<void> writeApiKey(String reference, String apiKey) async {
    if (apiKey.isEmpty) {
      await deleteApiKey(reference);
      return;
    }
    await _backend.write(key: reference, value: apiKey);
  }

  Future<void> deleteApiKey(String reference) {
    return _backend.delete(key: reference);
  }

  Future<String> resolveApiKey(String storedValue) async {
    if (storedValue.isEmpty) return '';
    if (!isSecretReference(storedValue)) return storedValue;
    return await readApiKey(storedValue) ?? '';
  }

  Future<String> storeApiKeyOrEmpty(String reference, String apiKey) async {
    if (apiKey.isEmpty) {
      await deleteApiKey(reference);
      return '';
    }
    await writeApiKey(reference, apiKey);
    return reference;
  }
}

/// 全局安全存储服务 Provider。
final secretStorageServiceProvider = Provider<SecretStorageService>((ref) {
  return SecretStorageService();
});
