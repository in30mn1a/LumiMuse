import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';
import '../database/database.dart';
import 'secret_storage_service.dart';

// ═══════════════════════════════════════════════════════════════
// 数据模型
// ═══════════════════════════════════════════════════════════════

/// 备份数据验证结果
class BackupValidation {
  /// 验证是否通过
  final bool isValid;

  /// 错误信息（验证失败时非空）
  final String? errorMessage;

  /// 角色数量
  final int characterCount;

  /// 对话数量
  final int conversationCount;

  /// 消息数量
  final int messageCount;

  /// 记忆数量
  final int memoryCount;

  const BackupValidation({
    required this.isValid,
    this.errorMessage,
    this.characterCount = 0,
    this.conversationCount = 0,
    this.messageCount = 0,
    this.memoryCount = 0,
  });

  /// 创建验证失败结果
  factory BackupValidation.invalid(String errorMessage) {
    return BackupValidation(isValid: false, errorMessage: errorMessage);
  }

  /// 创建验证成功结果
  factory BackupValidation.valid({
    required int characterCount,
    required int conversationCount,
    required int messageCount,
    required int memoryCount,
  }) {
    return BackupValidation(
      isValid: true,
      characterCount: characterCount,
      conversationCount: conversationCount,
      messageCount: messageCount,
      memoryCount: memoryCount,
    );
  }
}

/// 导出选项 — 控制按角色范围导出时包含哪些数据
class ExportOptions {
  /// 是否包含角色资料
  final bool includeCharacter;

  /// 是否包含角色记忆
  final bool includeMemories;

  /// 是否包含角色对话
  final bool includeConversations;

  /// 是否包含记忆画像及画像版本历史
  // 对齐主项目 include_profiles（默认 1）：画像跟角色绑定，导出后可在导入端直接还原，
  // 避免重新跑 LLM 画像提取（昂贵且会丢失人工 patch 历史）。
  final bool includeProfiles;

  /// 是否包含记忆向量索引
  // 对齐主项目 include_embeddings（默认 0）：向量是可重建的派生数据，
  // 体积庞大（每条记忆几千 float32 = 几十 KB），默认不导出。
  final bool includeEmbeddings;

  const ExportOptions({
    this.includeCharacter = true,
    this.includeMemories = true,
    this.includeConversations = true,
    this.includeProfiles = true,
    this.includeEmbeddings = false,
  });
}

/// 导入选项 — 控制导入时包含哪些数据
class ImportOptions {
  /// 是否导入角色资料
  final bool includeCharacter;

  /// 是否导入角色记忆
  final bool includeMemories;

  /// 是否导入角色对话
  final bool includeConversations;

  /// 是否导入记忆画像及画像版本历史
  final bool includeProfiles;

  /// 是否导入记忆向量索引（依赖 includeMemories）
  final bool includeEmbeddings;

  const ImportOptions({
    this.includeCharacter = true,
    this.includeMemories = true,
    this.includeConversations = true,
    this.includeProfiles = true,
    this.includeEmbeddings = false,
  });
}

/// 导入结果统计
class ImportResult {
  /// 新增记录数
  final int addedCount;

  /// 跳过（重复）记录数
  final int skippedCount;

  /// 总处理记录数
  final int totalCount;

  /// 导入的记忆数量
  final int memoriesImported;

  /// 导入的对话数量
  final int conversationsImported;

  /// 导入的消息数量
  final int messagesImported;

  /// 导入的记忆画像数量
  final int profilesImported;

  /// 导入的画像版本数量
  final int profileVersionsImported;

  /// 导入的记忆向量数量
  final int embeddingsImported;

  const ImportResult({
    required this.addedCount,
    required this.skippedCount,
    required this.totalCount,
    this.memoriesImported = 0,
    this.conversationsImported = 0,
    this.messagesImported = 0,
    this.profilesImported = 0,
    this.profileVersionsImported = 0,
    this.embeddingsImported = 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// 备份服务
// ═══════════════════════════════════════════════════════════════

/// 最大导入文件大小：200MB
// 对齐主项目 `src/app/api/import/route.ts` 的 MAX_IMPORT_BYTES。
// 合法的大库备份（多角色 + 长期对话 + 记忆）可能接近或超过 100MB；
// 200MB 在现代设备内存下可安全解析，同时仍能挡住明显异常的请求。
const int maxImportFileSize = 200 * 1024 * 1024;

/// 数据备份与恢复服务
class BackupService {
  static const int currentFullBackupVersion = 2;
  static const int currentCharacterBackupVersion = 2;
  static const int currentSchemaVersion = 8;

  final AppDatabase _db;
  final SecretStorageService _secretStorage;

  BackupService(this._db, {SecretStorageService? secretStorage})
    : _secretStorage = secretStorage ?? SecretStorageService();

  /// 把备份 JSON 字符串解析为 `Map<String, dynamic>`。
  ///
  /// FIX：之前直接 `Isolate.run(() => jsonDecode(jsonStr) as Map<String, dynamic>)`
  /// 并用一个泛型 `catch (e)` 兜底，把"isolate 基础设施抛错 / spawn 失败"这类
  /// 与备份内容无关的瞬时错误，统统报成"备份文件格式无效：无法解析备份文件"，
  /// 导致明明合法的角色卡也提示导入失败（且复现具有偶发性）。
  ///
  /// 现在分两层：
  /// 1. 真正的 JSON 语法错误（[FormatException]）才视为"内容无效"，原样抛出由
  ///    上层翻译成用户文案；
  /// 2. 其余异常（多为 [Isolate.run] 的运行时问题）先在主线程同步重试一次，
  ///    主线程也失败才认定为真正的格式问题。
  ///
  /// 解析放到后台 isolate 仅为避免大文件阻塞 UI，本身不应改变成败语义。
  static Future<Map<String, dynamic>> _decodeBackupJson(String jsonStr) async {
    Map<String, dynamic> decodeSync() {
      final decoded = jsonDecode(jsonStr);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('备份文件格式无效：根节点不是对象');
      }
      return decoded;
    }

    if (kIsWeb) {
      return decodeSync();
    }

    try {
      return await Isolate.run(decodeSync);
    } on FormatException {
      // 内容本身就是坏 JSON——直接上抛，语义明确。
      rethrow;
    } catch (_) {
      // isolate 基础设施类错误：退回主线程再试一次，避免误报"无法解析"。
      return decodeSync();
    }
  }

  /// 敏感配置 key 匹配片段（全部小写比较）。命中任一片段的 settings.key 视为敏感凭据，
  /// 在 [exportToJson] 中默认（includeSecrets = false）会被剔除。
  /// 这些片段覆盖 OpenAI 兼容 api key / NovelAI / 自定义 API / token / 密码 等典型场景。
  static const List<String> _secretKeyFragments = <String>[
    'api_key',
    'apikey',
    'token',
    'secret',
    'password',
    'naiapikey',
    'customapikey',
  ];

  static bool _isSecretSettingKey(String key) {
    final lower = key.toLowerCase();
    for (final frag in _secretKeyFragments) {
      if (lower.contains(frag)) return true;
    }
    return false;
  }

  static BackupValidation? _validateVersionBounds(Map<String, dynamic> data) {
    final version = data['version'];
    if (version != null) {
      if (version is! int || version < 1) {
        return BackupValidation.invalid('version 必须是正整数');
      }
      final isCharacterBackup =
          data.containsKey('character') && !data.containsKey('characters');
      final maxVersion = isCharacterBackup
          ? BackupService.currentCharacterBackupVersion
          : BackupService.currentFullBackupVersion;
      if (version > maxVersion) {
        return BackupValidation.invalid(
          'version $version 超出当前支持范围（最大 $maxVersion）',
        );
      }
    }

    final schemaVersion = data['schema_version'];
    if (schemaVersion != null) {
      if (schemaVersion is! int || schemaVersion < 1) {
        return BackupValidation.invalid('schema_version 必须是正整数');
      }
      if (schemaVersion > BackupService.currentSchemaVersion) {
        return BackupValidation.invalid(
          'schema_version $schemaVersion 超出当前支持范围（最大 ${BackupService.currentSchemaVersion}）',
        );
      }
    }

    return null;
  }

  static BackupValidation _validateBackupData(Map<String, dynamic> data) {
    final versionError = _validateVersionBounds(data);
    if (versionError != null) return versionError;

    // 验证必需顶层字段（支持 v1 characters 数组 和 v2 单 character 两种格式）
    final missingFields = <String>[];
    final hasV1Characters = data.containsKey('characters');
    final hasV2Character =
        data.containsKey('character') && data['character'] is Map;
    final isV2CharacterBackup = !hasV1Characters && hasV2Character;
    final hasValidCharacter = hasV1Characters || hasV2Character;

    if (!hasValidCharacter) {
      missingFields.add('character');
    }
    if (!isV2CharacterBackup) {
      if (!data.containsKey('conversations')) {
        missingFields.add('conversations');
      }
      if (!data.containsKey('memories')) {
        missingFields.add('memories');
      }
    }

    if (missingFields.isNotEmpty) {
      // TODO(parity): 主项目缺失 'backup.missingRequiredFields' 键，硬编码兜底
      return BackupValidation.invalid('缺少必需字段：${missingFields.join("、")}');
    }

    // v1: characters 是 List，v2: character 是 Map（单个角色）
    int characterCount = 0;
    if (hasV1Characters) {
      final characters = data['characters'];
      if (characters is! List) {
        // TODO(parity): 主项目缺失 'backup.fieldMustBeArray' 键，硬编码兜底
        return BackupValidation.invalid('字段 characters 必须是数组');
      }
      characterCount = characters.length;
    } else {
      characterCount = 1; // v2 单角色
    }

    final conversations = data['conversations'];
    if (conversations != null && conversations is! List) {
      // TODO(parity): 主项目缺失 'backup.fieldMustBeArray' 键，硬编码兜底
      return BackupValidation.invalid('字段 conversations 必须是数组');
    }
    final memories = data['memories'];
    if (memories != null && memories is! List) {
      // TODO(parity): 主项目缺失 'backup.fieldMustBeArray' 键，硬编码兜底
      return BackupValidation.invalid('字段 memories 必须是数组');
    }

    final messages = data['messages'];
    final messageCount = (messages is List) ? messages.length : 0;

    return BackupValidation.valid(
      characterCount: characterCount,
      conversationCount: (conversations as List?)?.length ?? 0,
      messageCount: messageCount,
      memoryCount: (memories as List?)?.length ?? 0,
    );
  }

  static dynamic _tryJsonDecodeValue(dynamic value) {
    if (value is! String) return value;
    try {
      return jsonDecode(value);
    } catch (_) {
      return value;
    }
  }

  Future<String> _exportSettingValue(
    Setting row, {
    required bool includeSecrets,
  }) async {
    if (includeSecrets && row.key == 'api_key') {
      final decoded = _tryJsonDecodeValue(row.value);
      final storedValue = decoded is String ? decoded : row.value;
      return jsonEncode(await _secretStorage.resolveApiKey(storedValue));
    }
    if (includeSecrets && row.key == 'image_gen') {
      return _resolveImageGenSettingValue(row.value);
    }
    return row.value;
  }

  Future<String> _resolveImageGenSettingValue(String raw) async {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return raw;
      final next = Map<String, dynamic>.from(decoded);
      final naiApiKey = next['nai_api_key'];
      final customApiKey = next['custom_api_key'];
      if (naiApiKey is String) {
        next['nai_api_key'] = await _secretStorage.resolveApiKey(naiApiKey);
      }
      if (customApiKey is String) {
        next['custom_api_key'] = await _secretStorage.resolveApiKey(
          customApiKey,
        );
      }
      return jsonEncode(next);
    } catch (_) {
      return raw;
    }
  }

  Future<String> _prepareImportedSettingValue(String key, dynamic value) async {
    if (key == 'api_key') {
      final decoded = _tryJsonDecodeValue(value);
      final apiKey = decoded is String ? decoded : '';
      final reference = await _secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.settingsApiKeyRef,
        apiKey,
      );
      return jsonEncode(reference);
    }
    if (key == 'image_gen') {
      return _prepareImportedImageGenValue(value);
    }
    return value is String ? value : jsonEncode(value);
  }

  Future<String> _prepareImportedImageGenValue(dynamic value) async {
    final decoded = _tryJsonDecodeValue(value);
    if (decoded is! Map<String, dynamic>) {
      return value is String ? value : jsonEncode(value);
    }

    final next = Map<String, dynamic>.from(decoded);
    final naiApiKey = next['nai_api_key'];
    final customApiKey = next['custom_api_key'];
    if (naiApiKey is String) {
      next['nai_api_key'] = await _secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.imageGenNaiApiKeyRef,
        await _secretStorage.resolveApiKey(naiApiKey),
      );
    }
    if (customApiKey is String) {
      next['custom_api_key'] = await _secretStorage.storeApiKeyOrEmpty(
        SecretStorageService.imageGenCustomApiKeyRef,
        await _secretStorage.resolveApiKey(customApiKey),
      );
    }
    return jsonEncode(next);
  }

  Future<String> _prepareImportedProviderApiKey(
    String providerId,
    dynamic value,
  ) async {
    final decoded = _tryJsonDecodeValue(value);
    final apiKey = decoded is String ? decoded : '';
    return _secretStorage.storeApiKeyOrEmpty(
      SecretStorageService.apiProviderKeyRef(providerId),
      apiKey,
    );
  }

  static DateTime _parseBackupDate(dynamic value) {
    if (value is int) {
      return DateTime.fromMillisecondsSinceEpoch(value);
    }
    if (value is String && value.isNotEmpty) {
      return DateTime.parse(value);
    }
    return DateTime.now();
  }

  /// 对 settings 表中 `image_gen` 这一行的 value（ImageGenSettings.toJson 后
  /// jsonEncode 的字符串）解析后剔除敏感子字段（如 nai_api_key、custom_api_key），
  /// 再重新 jsonEncode。解析失败原样返回（保守兜底，宁可漏过滤也不破坏备份）。
  ///
  /// 修复：仅按顶层 row key 过滤会让嵌套在 `image_gen` JSON 内的 API key
  /// 整段漏出，与"默认导出不含敏感凭据"目标相悖。
  static String _sanitizeImageGenJsonValue(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return raw;
      final filtered = <String, dynamic>{};
      decoded.forEach((k, v) {
        if (_isSecretSettingKey(k)) return;
        filtered[k] = v;
      });
      return jsonEncode(filtered);
    } catch (_) {
      return raw;
    }
  }

  /// 导出所有数据为 JSON
  ///
  /// [includeSecrets] 控制是否把 settings 表中的敏感凭据（API Key / token /
  /// password 等，详见 [_secretKeyFragments]）一并写入备份。
  /// 默认为 false — 备份文件可以被安全分享；显式传 true 时备份文件包含
  /// 可还原所有 API 配置的明文凭据，调用方必须在 UI 上提示用户。
  ///
  /// [options] 控制是否包含记忆画像 / 画像版本 / 记忆向量索引。
  /// null 时默认包含 profiles、不包含 embeddings（对齐主项目默认）。
  /// 现有 characters / conversations / messages / memories / settings / api_providers
  /// 始终全量导出（与历史行为一致，不破坏现有调用方）。
  Future<String> exportToJson({
    bool includeSecrets = false,
    ExportOptions? options,
  }) async {
    final opts = options ?? const ExportOptions();
    final characters = await _db.select(_db.characters).get();
    final conversations = await _db.select(_db.conversations).get();
    final messages = await _db.select(_db.messages).get();
    final memories = await _db.select(_db.memories).get();
    final settings = await _db.select(_db.settings).get();
    final apiProviders = await _db.select(_db.apiProviders).get();

    // 按 includeSecrets 过滤敏感 settings 条目；并对 image_gen 嵌套 JSON 内的
    // 敏感子字段（nai_api_key、custom_api_key 等）做嵌套过滤。
    final settingsMap = <String, String>{};
    for (final s in settings) {
      if (!includeSecrets && _isSecretSettingKey(s.key)) {
        continue;
      }
      if (!includeSecrets && s.key == 'image_gen') {
        settingsMap[s.key] = _sanitizeImageGenJsonValue(s.value);
        continue;
      }
      settingsMap[s.key] = await _exportSettingValue(
        s,
        includeSecrets: includeSecrets,
      );
    }

    final data = {
      'version': BackupService.currentFullBackupVersion,
      'schema_version': BackupService.currentSchemaVersion,
      'exported_at': DateTime.now().toIso8601String(),
      '_meta': {
        'includesSecrets': includeSecrets,
        'exportedAt': DateTime.now().toIso8601String(),
      },
      'characters': characters
          .map(
            (c) => {
              'id': c.id,
              'name': c.name,
              'avatar_url': c.avatarUrl,
              'personality': c.personality,
              'scenario': c.scenario,
              'greeting': c.greeting,
              'example_dialogue': c.exampleDialogue,
              'system_prompt': c.systemPrompt,
              'image_tags': c.imageTags,
              'user_image_tags': c.userImageTags,
              'basic_info': c.basicInfo,
              'other_info': c.otherInfo,
              'sort_order': c.sortOrder,
              'created_at': c.createdAt.toIso8601String(),
              'updated_at': c.updatedAt.toIso8601String(),
            },
          )
          .toList(),
      'conversations': conversations
          .map(
            (c) => {
              'id': c.id,
              'character_id': c.characterId,
              'title': c.title,
              'ignore_memory': c.ignoreMemory,
              'created_at': c.createdAt.toIso8601String(),
              'updated_at': c.updatedAt.toIso8601String(),
            },
          )
          .toList(),
      'messages': messages
          .map(
            (m) => {
              'id': m.id,
              'conversation_id': m.conversationId,
              'role': m.role,
              'content': m.content,
              'token_count': m.tokenCount,
              'seq': m.seq,
              'created_at': m.createdAt.toIso8601String(),
              'metadata': m.metadata,
            },
          )
          .toList(),
      'memories': memories
          .map(
            (m) => {
              'id': m.id,
              'character_id': m.characterId,
              'category': m.category,
              'content': m.content,
              'confidence': m.confidence,
              'tags': m.tags,
              'source_msg_ids': m.sourceMsgIds,
              'created_at': m.createdAt.toIso8601String(),
              'updated_at': m.updatedAt.toIso8601String(),
            },
          )
          .toList(),
      'api_providers': [
        for (final p in apiProviders)
          {
            'id': p.id,
            'name': p.name,
            'api_base': p.apiBase,
            if (includeSecrets)
              'api_key': await _secretStorage.resolveApiKey(p.apiKey),
            'model': p.model,
            'temperature': p.temperature,
            'max_tokens': p.maxTokens,
            'context_window': p.contextWindow,
            'json_mode': p.jsonMode,
            'created_at': p.createdAt.toIso8601String(),
          },
      ],
      'settings': settingsMap,
    };

    // 新增：导出记忆画像及画像版本历史（全量格式字段名 memory_profiles 复数）。
    // 对齐主项目 export/route.ts loadAllProfiles / loadAllProfileVersions。
    if (opts.includeProfiles) {
      final profiles = await _db.select(_db.characterMemoryProfiles).get();
      data['memory_profiles'] = profiles
          .map(
            (p) => {
              'character_id': p.characterId,
              'profile_name': p.profileName,
              'relationship_state': p.relationshipState,
              'recent_story_state': p.recentStoryState,
              'emotional_baseline': p.emotionalBaseline,
              'open_threads': p.openThreads,
              'user_profile_summary': p.userProfileSummary,
              'pinned_summary': p.pinnedSummary,
              'updated_at': p.updatedAt.toIso8601String(),
            },
          )
          .toList();

      final versions =
          await (_db.select(_db.characterMemoryProfileVersions)
                ..orderBy([
                  (t) => OrderingTerm.asc(t.characterId),
                  (t) => OrderingTerm.asc(t.versionNumber),
                ]))
              .get();
      data['memory_profile_versions'] = versions
          .map(
            (v) => {
              'id': v.id,
              'character_id': v.characterId,
              'version_number': v.versionNumber,
              'snapshot_json': v.snapshotJson,
              'reason': v.reason,
              'task_id': v.taskId,
              'created_at': v.createdAt.toIso8601String(),
            },
          )
          .toList();
    }

    // 新增：导出记忆向量索引。依赖 includeMemories（无记忆则无向量），
    // 只导出 status='ready' 的向量，failed/pending 的让导入端按需重建。
    // 对齐主项目 export/route.ts loadAllEmbeddings。
    if (opts.includeMemories && opts.includeEmbeddings) {
      final embeddings =
          await (_db.select(_db.memoryEmbeddings)
                ..where((t) => t.status.equals('ready'))
                ..orderBy([
                  (t) => OrderingTerm.asc(t.characterId),
                  (t) => OrderingTerm.asc(t.memoryId),
                ]))
              .get();
      data['memory_embeddings'] = embeddings
          .map(
            (e) => {
              'id': e.id,
              'memory_id': e.memoryId,
              'character_id': e.characterId,
              'provider': e.provider,
              'model': e.model,
              'dimension': e.dimension,
              // BlobColumn 读出 Uint8List，jsonEncode 不能直接编码，转 List<int>
              'embedding_blob': e.embeddingBlob.toList(),
              'normalized': e.normalized,
              'embedding_text_hash': e.embeddingTextHash,
              'status': e.status,
              'error_message': e.errorMessage,
              'created_at': e.createdAt.toIso8601String(),
              'updated_at': e.updatedAt.toIso8601String(),
            },
          )
          .toList();
    }

    return jsonEncode(data);
  }

  /// 导出到文件，返回文件路径
  Future<String> exportToFile() async {
    final json = await exportToJson();
    final dir = await getApplicationDocumentsDirectory();
    final timestamp = DateTime.now()
        .toIso8601String()
        .replaceAll(':', '-')
        .split('.')
        .first;
    final file = File('${dir.path}/LumiMuse/backup_$timestamp.json');
    await file.parent.create(recursive: true);
    await file.writeAsString(json);
    return file.path;
  }

  /// 把任意 JSON 字符串写到指定的目标文件路径（绝对路径），返回写入路径。
  ///
  /// 与 `exportToFile` 区别：本方法接受调用方决定的最终路径（通常来自
  /// FilePicker.saveFile 的返回值），因此可以让用户在桌面端把备份保存到
  /// 任意位置，避免 `Share.shareXFiles` 在 Windows / Linux 上抛
  /// MissingPluginException。
  Future<String> writeJsonToPath(String json, String targetPath) async {
    final file = File(targetPath);
    await file.parent.create(recursive: true);
    await file.writeAsString(json);
    return file.path;
  }

  /// 检查文件大小是否在允许范围内（≤200MB）
  /// 返回 null 表示通过，否则返回错误信息
  static String? checkFileSize(int fileSizeInBytes) {
    if (fileSizeInBytes > maxImportFileSize) {
      final sizeMB = (fileSizeInBytes / (1024 * 1024)).toStringAsFixed(1);
      // TODO(parity): 主项目缺失 'backup.fileTooLarge' 键，硬编码兜底
      return '文件大小 ${sizeMB}MB 超过限制（最大 200MB）';
    }
    return null;
  }

  /// 验证备份 JSON 数据格式和必需字段
  /// 返回验证结果，包含统计信息或错误信息
  static BackupValidation validateBackupJson(String jsonStr) {
    // 1. 验证 JSON 格式
    dynamic parsed;
    try {
      parsed = jsonDecode(jsonStr);
    } catch (e) {
      // TODO(parity): 主项目缺失 'backup.invalidJson' 键，硬编码兜底
      return BackupValidation.invalid('文件不是有效的 JSON 格式');
    }

    // 2. 验证是 Map 类型
    if (parsed is! Map<String, dynamic>) {
      // TODO(parity): 主项目缺失 'backup.invalidJson' 键，硬编码兜底
      return BackupValidation.invalid('文件不是有效的 JSON 格式');
    }

    return _validateBackupData(parsed);
  }

  /// 从 JSON 导入数据（带验证和统计）
  /// 使用数据库事务确保原子性，ID 重复则跳过保留本地版本
  ///
  /// [options] 控制导入哪些数据，null 时默认导入 profiles、不导入 embeddings
  /// （对齐主项目默认）。
  Future<ImportResult> importFromJson(
    String jsonStr, {
    ImportOptions? options,
  }) async {
    final opts = options ?? const ImportOptions();
    // 先验证数据格式
    final validation = validateBackupJson(jsonStr);
    if (!validation.isValid) {
      // TODO(parity): 主项目缺失 'backup.invalidFormat' 键，硬编码兜底
      throw FormatException(validation.errorMessage ?? '数据格式无效');
    }

    // 解析数据（与 importWithOptions 共用健壮解码：isolate 故障不误报为格式错误）
    final data = await _decodeBackupJson(jsonStr);
    int addedCount = 0;
    int skippedCount = 0;
    int memoriesImported = 0;
    int conversationsImported = 0;
    int messagesImported = 0;
    int profilesImported = 0;
    int profileVersionsImported = 0;
    int embeddingsImported = 0;

    // 旧记忆 ID → 新记忆 ID 映射，供 embedding 导入关联新记忆 id。
    // importFromJson 用「ID 重复则跳过」策略，没有 UUID 重建，
    // 所以 memoryIdMap 是恒等映射：memoryIdMap[originalMemId] = originalMemId。
    // 仍然建立映射，导入 embedding 时按 memoryIdMap 映射，无映射则跳过。
    final Map<String, String> memoryIdMap = {};

    // 在进入数据库事务前，预先存入敏感设置和 API Provider 密钥
    final preparedSettings = <String, String>{};
    final settings = data['settings'] as Map<String, dynamic>? ?? {};
    for (final entry in settings.entries) {
      if (entry.key.startsWith('launch_password_')) {
        continue;
      }
      preparedSettings[entry.key] = await _prepareImportedSettingValue(
        entry.key,
        entry.value,
      );
    }

    final preparedApiKeys = <String, String>{};
    final apiProviders = data['api_providers'] as List? ?? [];
    for (final item in apiProviders) {
      final map = item as Map<String, dynamic>;
      final id = map['id'] as String? ?? '';
      if (id.isEmpty) continue;
      preparedApiKeys[id] = await _prepareImportedProviderApiKey(
        id,
        map['api_key'] ?? '',
      );
    }

    // 使用事务确保原子性。为了在后台数据库 Isolate 下不抛出 unsendable 错误，
    // 我们必须将 _db 复制为局部变量 db，且在事务闭包内只引用局部变量和静态方法，
    // 确保闭包不捕获 BackupService 实例（即不捕获 _db 或 _secretStorage）。
    final db = _db;
    await db.transaction(() async {
      // FIX(C4): 兼容三种备份格式，避免 v2 单角色备份在此分支静默丢失角色：
      //   - v1（exportToJson）            ：顶层 `characters` 为 List<角色>
      //   - v2 全量（exportToJson 续版）   ：顶层 `characters` 为 List<角色>
      //   - v2 单角色（exportCharacterToJson）：顶层 `character` 为单个 Map（无 `characters` 数组）
      // 之前直接读 `characters as List? ?? []`，导致 v2 单角色备份在 importFromJson
      // 路径下 character 列表为空，但 conversations / messages / memories 仍会写入，
      // 形成孤儿数据。这里把 v2 单角色 `character` 包装为 `[character]` 后再走原流程，
      // 与上方 [validateBackupJson]（hasV2Character）/ [importWithOptions] 的处理保持一致。
      final List characters;
      if (data['characters'] is List) {
        characters = data['characters'] as List;
      } else if (data['character'] is Map) {
        characters = [data['character'] as Map<String, dynamic>];
      } else {
        characters = const [];
      }
      final characterCompanions = <CharactersCompanion>[];
      for (final c in characters) {
        final map = c as Map<String, dynamic>;
        final id = map['id'] as String;

        // 检查是否已存在，存在则跳过
        final existing = await (db.select(
          db.characters,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        characterCompanions.add(
          CharactersCompanion.insert(
            id: id,
            name: Value(map['name'] as String? ?? ''),
            avatarUrl: Value(map['avatar_url'] as String?),
            personality: Value(map['personality'] as String? ?? ''),
            scenario: Value(map['scenario'] as String? ?? ''),
            greeting: Value(map['greeting'] as String? ?? ''),
            exampleDialogue: Value(map['example_dialogue'] as String? ?? ''),
            systemPrompt: Value(map['system_prompt'] as String? ?? ''),
            imageTags: Value(map['image_tags'] as String? ?? ''),
            userImageTags: Value(map['user_image_tags'] as String? ?? ''),
            basicInfo: Value(map['basic_info'] as String? ?? ''),
            otherInfo: Value(map['other_info'] as String? ?? ''),
            sortOrder: Value(map['sort_order'] as int? ?? 0),
            createdAt: Value(DateTime.parse(map['created_at'] as String)),
            updatedAt: Value(DateTime.parse(map['updated_at'] as String)),
          ),
        );
        addedCount++;
      }
      if (characterCompanions.isNotEmpty) {
        await db.batch((batch) {
          for (final companion in characterCompanions) {
            batch.insert(db.characters, companion);
          }
        });
      }

      // 导入对话
      final conversations = data['conversations'] as List? ?? [];
      final conversationCompanions = <ConversationsCompanion>[];
      for (final c in conversations) {
        final map = c as Map<String, dynamic>;
        final id = map['id'] as String;

        final existing = await (db.select(
          db.conversations,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        conversationCompanions.add(
          ConversationsCompanion.insert(
            id: id,
            characterId: map['character_id'] as String,
            title: Value(map['title'] as String? ?? ''),
            ignoreMemory: Value(map['ignore_memory'] as int? ?? 0),
            createdAt: Value(DateTime.parse(map['created_at'] as String)),
            updatedAt: Value(DateTime.parse(map['updated_at'] as String)),
          ),
        );
        addedCount++;
        conversationsImported++;
      }
      if (conversationCompanions.isNotEmpty) {
        await db.batch((batch) {
          for (final companion in conversationCompanions) {
            batch.insert(db.conversations, companion);
          }
        });
      }

      // 导入消息：兼容 v1 顶层 messages 与 v2 单角色 conversations[].messages。
      final messages = <dynamic>[...data['messages'] as List? ?? const []];
      for (final c in conversations) {
        final map = c as Map<String, dynamic>;
        final nestedMessages = map['messages'];
        if (nestedMessages is List) {
          messages.addAll(nestedMessages);
        }
      }
      final messageCompanions = <MessagesCompanion>[];
      for (final m in messages) {
        final map = m as Map<String, dynamic>;
        final id = map['id'] as String;

        final existing = await (db.select(
          db.messages,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        messageCompanions.add(
          MessagesCompanion.insert(
            id: id,
            conversationId: map['conversation_id'] as String,
            role: map['role'] as String,
            content: Value(map['content'] as String? ?? ''),
            tokenCount: Value(map['token_count'] as int? ?? 0),
            seq: Value(map['seq'] as int? ?? 0),
            createdAt: Value(DateTime.parse(map['created_at'] as String)),
            metadata: Value(map['metadata'] as String? ?? '{}'),
          ),
        );
        addedCount++;
        messagesImported++;
      }
      if (messageCompanions.isNotEmpty) {
        await db.batch((batch) {
          for (final companion in messageCompanions) {
            batch.insert(db.messages, companion);
          }
        });
      }

      // 导入记忆
      final memories = data['memories'] as List? ?? [];
      final memoryCompanions = <MemoriesCompanion>[];
      for (final m in memories) {
        final map = m as Map<String, dynamic>;
        final id = map['id'] as String;

        // 建立恒等映射，供 embedding 导入按 memoryIdMap 映射。
        // 即使记忆已存在被跳过，仍记录映射——该 id 在 DB 中确实存在。
        memoryIdMap[id] = id;

        final existing = await (db.select(
          db.memories,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        memoryCompanions.add(
          MemoriesCompanion.insert(
            id: id,
            characterId: map['character_id'] as String,
            category: map['category'] as String,
            content: map['content'] as String,
            confidence: Value((map['confidence'] as num?)?.toDouble() ?? 0.8),
            tags: Value(
              map['tags'] is String
                  ? map['tags'] as String
                  : jsonEncode(map['tags'] ?? []),
            ),
            sourceMsgIds: Value(
              map['source_msg_ids'] is String
                  ? map['source_msg_ids'] as String
                  : jsonEncode(map['source_msg_ids'] ?? []),
            ),
            createdAt: Value(DateTime.parse(map['created_at'] as String)),
            updatedAt: Value(DateTime.parse(map['updated_at'] as String)),
          ),
        );
        addedCount++;
        memoriesImported++;
      }
      if (memoryCompanions.isNotEmpty) {
        await db.batch((batch) {
          for (final companion in memoryCompanions) {
            batch.insert(db.memories, companion);
          }
        });
      }

      // 导入设置（设置使用 key 作为主键，重复则跳过）
      for (final entry in settings.entries) {
        // 跳过密码相关设置，避免导入备份时覆盖当前的登录密码
        if (entry.key.startsWith('launch_password_')) {
          continue;
        }

        final existing = await (db.select(
          db.settings,
        )..where((t) => t.key.equals(entry.key))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        await db
            .into(db.settings)
            .insert(
              SettingsCompanion.insert(
                key: entry.key,
                // 必定存在：预处理循环已覆盖所有非 launch_password_ 前缀的 key
                value: preparedSettings[entry.key]!,
              ),
            );
        addedCount++;
      }

      // 导入 API Provider。旧备份没有该字段时保持兼容；包含凭据时转入安全存储。
      for (final item in apiProviders) {
        final map = item as Map<String, dynamic>;
        final id = map['id'] as String? ?? '';
        if (id.isEmpty) continue;

        final existing = await (db.select(
          db.apiProviders,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        await db
            .into(db.apiProviders)
            .insert(
              ApiProvidersCompanion.insert(
                id: id,
                name: map['name'] as String? ?? '',
                apiBase: Value(map['api_base'] as String? ?? ''),
                // 必定存在：预处理循环已覆盖所有 apiProviders 的 id
                apiKey: Value(preparedApiKeys[id]!),
                model: Value(map['model'] as String? ?? ''),
                temperature: Value(
                  (map['temperature'] as num?)?.toDouble() ?? 1.0,
                ),
                maxTokens: Value(map['max_tokens'] as int? ?? 4096),
                contextWindow: Value(map['context_window'] as int? ?? 131072),
                jsonMode: Value(
                  map['json_mode'] is bool
                      ? ((map['json_mode'] as bool) ? 1 : 0)
                      : (map['json_mode'] as int? ?? 0),
                ),
                createdAt: Value(BackupService._parseBackupDate(map['created_at'])),
              ),
            );
        addedCount++;
      }

      // ─── 导入记忆画像 ────────────────────────────────────────
      // 对齐主项目 import/route.ts profilesToImport 逻辑。
      // importFromJson 不走 idMap（保留原 ID），character_id 直接用原值。
      if (opts.includeProfiles) {
        // 合并 memory_profiles（数组）和 memory_profile（单个对象）两种格式
        final profileList = <Map<String, dynamic>>[
          ...((data['memory_profiles'] as List?) ?? const [])
              .cast<Map<String, dynamic>>(),
          if (data['memory_profile'] is Map)
            data['memory_profile'] as Map<String, dynamic>,
        ];
        for (final profile in profileList) {
          final newCharId = profile['character_id'] as String? ?? '';

          // 校验角色存在
          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          // UPSERT：character_memory_profiles 主键是 character_id
          final existing = await (db.select(db.characterMemoryProfiles)
                ..where((t) => t.characterId.equals(newCharId)))
              .getSingleOrNull();
          if (existing != null) {
            await (db.update(db.characterMemoryProfiles)
                  ..where((t) => t.characterId.equals(newCharId)))
                .write(
              CharacterMemoryProfilesCompanion(
                profileName:
                    Value(profile['profile_name'] as String? ?? ''),
                relationshipState:
                    Value(profile['relationship_state'] as String? ?? ''),
                recentStoryState:
                    Value(profile['recent_story_state'] as String? ?? ''),
                emotionalBaseline:
                    Value(profile['emotional_baseline'] as String? ?? ''),
                openThreads: Value(
                  BackupService._normalizeJsonStringArray(
                    profile['open_threads'],
                  ),
                ),
                userProfileSummary:
                    Value(profile['user_profile_summary'] as String? ?? ''),
                pinnedSummary:
                    Value(profile['pinned_summary'] as String? ?? ''),
                updatedAt: Value(
                  BackupService._parseBackupDate(profile['updated_at']),
                ),
              ),
            );
          } else {
            await db.into(db.characterMemoryProfiles).insert(
              CharacterMemoryProfilesCompanion.insert(
                characterId: newCharId,
                profileName:
                    Value(profile['profile_name'] as String? ?? ''),
                relationshipState:
                    Value(profile['relationship_state'] as String? ?? ''),
                recentStoryState:
                    Value(profile['recent_story_state'] as String? ?? ''),
                emotionalBaseline:
                    Value(profile['emotional_baseline'] as String? ?? ''),
                openThreads: Value(
                  BackupService._normalizeJsonStringArray(
                    profile['open_threads'],
                  ),
                ),
                userProfileSummary:
                    Value(profile['user_profile_summary'] as String? ?? ''),
                pinnedSummary:
                    Value(profile['pinned_summary'] as String? ?? ''),
                updatedAt: Value(
                  BackupService._parseBackupDate(profile['updated_at']),
                ),
              ),
            );
          }
          profilesImported++;
          addedCount++;
        }

        // ─── 导入画像版本历史 ────────────────────────────────────
        final versionsList =
            (data['memory_profile_versions'] as List?) ?? const [];
        for (final v in versionsList) {
          final version = v as Map<String, dynamic>;
          final newCharId = version['character_id'] as String? ?? '';

          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          final versionNumber = version['version_number'] as int?;
          if (versionNumber == null) continue;

          // 检查同 character_id + version_number 是否已存在，避免重复导入
          final existing = await (db.select(db.characterMemoryProfileVersions)
                ..where((t) => t.characterId.equals(newCharId))
                ..where((t) => t.versionNumber.equals(versionNumber)))
              .getSingleOrNull();
          if (existing != null) {
            skippedCount++;
            continue;
          }

          await db.into(db.characterMemoryProfileVersions).insert(
            CharacterMemoryProfileVersionsCompanion.insert(
              characterId: newCharId,
              versionNumber: versionNumber,
              snapshotJson: version['snapshot_json'] as String? ?? '{}',
              reason: version['reason'] as String? ?? 'imported',
              taskId: Value(version['task_id'] as int?),
              createdAt: Value(
                BackupService._parseBackupDate(version['created_at']),
              ),
            ),
          );
          profileVersionsImported++;
          addedCount++;
        }
      }

      // ─── 导入记忆向量索引 ────────────────────────────────────
      // 依赖 includeMemories；按 memoryIdMap 映射 memory_id，无映射则跳过（孤儿向量）。
      if (opts.includeMemories && opts.includeEmbeddings) {
        final embeddingsList =
            (data['memory_embeddings'] as List?) ?? const [];
        for (final e in embeddingsList) {
          final embedding = e as Map<String, dynamic>;
          final originalMemId = embedding['memory_id'] as String? ?? '';
          final newMemId = memoryIdMap[originalMemId];
          if (newMemId == null) continue; // 孤儿向量，跳过

          final newCharId = embedding['character_id'] as String? ?? '';

          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          // 解析 embedding_blob（支持三种格式）
          final blob =
              BackupService._parseEmbeddingBlob(embedding['embedding_blob']);
          if (blob == null) continue;

          final provider = embedding['provider'] as String? ?? 'openai-compatible';
          final model = embedding['model'] as String? ?? 'unknown';
          final dimension = embedding['dimension'] as int? ?? 0;

          // UPSERT：唯一索引 idx_memory_embeddings_unique_model
          // (memory_id + provider + model + dimension)，先 SELECT 检查存在则 UPDATE 否则 INSERT
          final existing = await (db.select(db.memoryEmbeddings)
                ..where((t) => t.memoryId.equals(newMemId))
                ..where((t) => t.provider.equals(provider))
                ..where((t) => t.model.equals(model))
                ..where((t) => t.dimension.equals(dimension)))
              .getSingleOrNull();

          final companion = MemoryEmbeddingsCompanion(
            memoryId: Value(newMemId),
            characterId: Value(newCharId),
            provider: Value(provider),
            model: Value(model),
            dimension: Value(dimension),
            embeddingBlob: Value(blob),
            normalized: Value(embedding['normalized'] as int? ?? 1),
            embeddingTextHash:
                Value(embedding['embedding_text_hash'] as String? ?? ''),
            status: Value(embedding['status'] as String? ?? 'ready'),
            errorMessage: Value(embedding['error_message'] as String?),
            createdAt: Value(
              BackupService._parseBackupDate(embedding['created_at']),
            ),
            updatedAt: Value(
              BackupService._parseBackupDate(embedding['updated_at']),
            ),
          );

          if (existing != null) {
            await (db.update(db.memoryEmbeddings)
                  ..where((t) => t.id.equals(existing.id)))
                .write(companion);
          } else {
            await db.into(db.memoryEmbeddings).insert(companion);
          }
          embeddingsImported++;
          addedCount++;
        }
      }
    });

    return ImportResult(
      addedCount: addedCount,
      skippedCount: skippedCount,
      totalCount: addedCount + skippedCount,
      memoriesImported: memoriesImported,
      conversationsImported: conversationsImported,
      messagesImported: messagesImported,
      profilesImported: profilesImported,
      profileVersionsImported: profileVersionsImported,
      embeddingsImported: embeddingsImported,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 选择性导出 — 按角色范围导出
  // ═══════════════════════════════════════════════════════════════

  /// 按角色选择性导出，返回导出文件路径
  /// [characterId] 要导出的角色 ID
  /// [options] 导出选项，控制包含哪些数据
  Future<String> exportCharacter(
    String characterId, {
    ExportOptions options = const ExportOptions(),
  }) async {
    final exportData = await exportCharacterToJson(
      characterId,
      options: options,
    );
    final character = await (_db.select(
      _db.characters,
    )..where((t) => t.id.equals(characterId))).getSingle();

    // 写入文件
    final dir = await getApplicationDocumentsDirectory();
    final now = DateTime.now();
    final dateStr =
        '${now.year}${now.month.toString().padLeft(2, '0')}${now.day.toString().padLeft(2, '0')}_${now.hour.toString().padLeft(2, '0')}${now.minute.toString().padLeft(2, '0')}${now.second.toString().padLeft(2, '0')}';
    // 文件名格式：lumimuse-{角色名}-{YYYYMMDD_HHmmss}.json
    final safeName = character.name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final fileName = 'lumimuse-$safeName-$dateStr.json';
    final file = File('${dir.path}/LumiMuse/$fileName');
    await file.parent.create(recursive: true);
    final encodedData = kIsWeb
        ? jsonEncode(exportData)
        : await Isolate.run(() => jsonEncode(exportData));
    await file.writeAsString(encodedData);

    // 尝试打开文件位置
    try {
      if (Platform.isWindows) {
        await Process.start('explorer', ['/select,', file.path]);
      } else if (Platform.isMacOS) {
        await Process.start('open', ['-R', file.path]);
      } else if (Platform.isLinux) {
        await Process.start('xdg-open', [file.parent.path]);
      }
    } catch (_) {
      // 忽略 — 仅为改善用户体验
    }

    return file.path;
  }

  /// 按角色选择性导出，返回 JSON Map（不涉及文件 I/O，便于测试）
  /// [characterId] 要导出的角色 ID
  /// [options] 导出选项，控制包含哪些数据
  Future<Map<String, dynamic>> exportCharacterToJson(
    String characterId, {
    ExportOptions options = const ExportOptions(),
  }) async {
    // 查询角色
    final character = await (_db.select(
      _db.characters,
    )..where((t) => t.id.equals(characterId))).getSingleOrNull();

    if (character == null) {
      // TODO(parity): 主项目缺失 'backup.characterNotFound' 键，硬编码兜底
      throw StateError('角色不存在：$characterId');
    }

    // 构建导出数据
    final Map<String, dynamic> exportData = {
      'version': BackupService.currentCharacterBackupVersion,
      'schema_version': BackupService.currentSchemaVersion,
      'exported_at': DateTime.now().toIso8601String(),
    };

    // 导出角色资料
    if (options.includeCharacter) {
      exportData['character'] = {
        'id': character.id,
        'name': character.name,
        'avatar_url': character.avatarUrl,
        'personality': character.personality,
        'scenario': character.scenario,
        'greeting': character.greeting,
        'example_dialogue': character.exampleDialogue,
        'system_prompt': character.systemPrompt,
        'image_tags': character.imageTags,
        'user_image_tags': character.userImageTags,
        'basic_info': character.basicInfo,
        'other_info': character.otherInfo,
        'sort_order': character.sortOrder,
        'created_at': character.createdAt.toIso8601String(),
        'updated_at': character.updatedAt.toIso8601String(),
      };
    }

    // 导出角色记忆（按 character_id 过滤）
    if (options.includeMemories) {
      final memories = await (_db.select(
        _db.memories,
      )..where((t) => t.characterId.equals(characterId))).get();

      exportData['memories'] = memories
          .map(
            (m) => {
              'id': m.id,
              'character_id': m.characterId,
              'category': m.category,
              'content': m.content,
              'confidence': m.confidence,
              'tags': m.tags,
              'source_msg_ids': m.sourceMsgIds,
              'created_at': m.createdAt.toIso8601String(),
              'updated_at': m.updatedAt.toIso8601String(),
            },
          )
          .toList();
    }

    // 导出角色对话及嵌套消息（按 character_id 过滤）
    if (options.includeConversations) {
      final conversations = await (_db.select(
        _db.conversations,
      )..where((t) => t.characterId.equals(characterId))).get();

      final conversationsWithMessages = <Map<String, dynamic>>[];
      for (final conv in conversations) {
        // 查询该对话的消息，按 created_at 升序、seq 升序
        final messages =
            await (_db.select(_db.messages)
                  ..where((t) => t.conversationId.equals(conv.id))
                  ..orderBy([
                    (t) => OrderingTerm.asc(t.createdAt),
                    (t) => OrderingTerm.asc(t.seq),
                  ]))
                .get();

        conversationsWithMessages.add({
          'id': conv.id,
          'character_id': conv.characterId,
          'title': conv.title,
          'ignore_memory': conv.ignoreMemory,
          'created_at': conv.createdAt.toIso8601String(),
          'updated_at': conv.updatedAt.toIso8601String(),
          'messages': messages
              .map(
                (m) => {
                  'id': m.id,
                  'conversation_id': m.conversationId,
                  'role': m.role,
                  'content': m.content,
                  'token_count': m.tokenCount,
                  'seq': m.seq,
                  'created_at': m.createdAt.toIso8601String(),
                  'metadata': m.metadata,
                },
              )
              .toList(),
        });
      }

      exportData['conversations'] = conversationsWithMessages;
    }

    // 新增：导出记忆画像（单角色格式字段名 memory_profile 单数，可为 null）。
    // 对齐主项目 export/route.ts loadProfileForCharacter / loadProfileVersionsForCharacter。
    if (options.includeProfiles) {
      final profile = await (_db.select(_db.characterMemoryProfiles)
            ..where((t) => t.characterId.equals(characterId)))
          .getSingleOrNull();
      exportData['memory_profile'] = profile == null
          ? null
          : {
              'character_id': profile.characterId,
              'profile_name': profile.profileName,
              'relationship_state': profile.relationshipState,
              'recent_story_state': profile.recentStoryState,
              'emotional_baseline': profile.emotionalBaseline,
              'open_threads': profile.openThreads,
              'user_profile_summary': profile.userProfileSummary,
              'pinned_summary': profile.pinnedSummary,
              'updated_at': profile.updatedAt.toIso8601String(),
            };

      final versions =
          await (_db.select(_db.characterMemoryProfileVersions)
                ..where((t) => t.characterId.equals(characterId))
                ..orderBy([(t) => OrderingTerm.asc(t.versionNumber)]))
              .get();
      exportData['memory_profile_versions'] = versions
          .map(
            (v) => {
              'id': v.id,
              'character_id': v.characterId,
              'version_number': v.versionNumber,
              'snapshot_json': v.snapshotJson,
              'reason': v.reason,
              'task_id': v.taskId,
              'created_at': v.createdAt.toIso8601String(),
            },
          )
          .toList();
    }

    // 新增：导出记忆向量索引（依赖 includeMemories，单角色格式字段名 memory_embeddings 复数）。
    // 对齐主项目 export/route.ts loadEmbeddingsForCharacter。
    if (options.includeMemories && options.includeEmbeddings) {
      final embeddings =
          await (_db.select(_db.memoryEmbeddings)
                ..where((t) => t.characterId.equals(characterId))
                ..where((t) => t.status.equals('ready'))
                ..orderBy([(t) => OrderingTerm.asc(t.memoryId)]))
              .get();
      exportData['memory_embeddings'] = embeddings
          .map(
            (e) => {
              'id': e.id,
              'memory_id': e.memoryId,
              'character_id': e.characterId,
              'provider': e.provider,
              'model': e.model,
              'dimension': e.dimension,
              'embedding_blob': e.embeddingBlob.toList(),
              'normalized': e.normalized,
              'embedding_text_hash': e.embeddingTextHash,
              'status': e.status,
              'error_message': e.errorMessage,
              'created_at': e.createdAt.toIso8601String(),
              'updated_at': e.updatedAt.toIso8601String(),
            },
          )
          .toList();
    }

    return exportData;
  }

  // ═══════════════════════════════════════════════════════════════
  // 导入增强 — 名称去重与 ID 重建
  // ═══════════════════════════════════════════════════════════════

  /// 生成不与 [existingNames] 冲突的唯一角色名。
  ///
  /// [incoming] 不在集合中时原样返回；否则依次尝试 `incoming (1)`、
  /// `incoming (2)`… 直到不冲突。空名兜底为「导入角色」。
  /// 与主项目 `src/app/api/import/route.ts` 的 `makeUniqueCharacterName`
  /// 目标一致（同名导入不静默合并到已有角色），区别在于主项目用时间戳后缀、
  /// 这里用纯函数递增后缀（便于在事务内以已知名集合判重，无需再查库）。
  static String makeUniqueCharacterName(
    Set<String> existingNames,
    String incoming,
  ) {
    final base = incoming.trim().isEmpty ? '导入角色' : incoming;
    if (!existingNames.contains(base)) return base;
    var suffix = 1;
    while (existingNames.contains('$base ($suffix)')) {
      suffix++;
    }
    return '$base ($suffix)';
  }

  /// 用 [msgIdMap]（旧消息 ID → 新消息 ID）重映射记忆的 source_msg_ids。
  ///
  /// [raw] 可能是 JSON 字符串（`'["id1","id2"]'`）或原始 List。解析后逐个
  /// 用 [msgIdMap] 映射，**丢弃无映射的旧 ID**（对应消息未导入或属于其他角色
  /// 被过滤），再写回 JSON 字符串。解析失败或映射后为空时返回 `'[]'`。
  /// 对齐主项目 `src/app/api/import/route.ts` 的 `remapSourceMessageIds`。
  static String remapSourceMessageIds(
    dynamic raw,
    Map<String, String> msgIdMap,
  ) {
    List<dynamic> ids;
    if (raw is String) {
      try {
        final parsed = jsonDecode(raw);
        ids = parsed is List ? parsed : const [];
      } catch (_) {
        return '[]';
      }
    } else if (raw is List) {
      ids = raw;
    } else {
      return '[]';
    }
    final mapped = <String>[];
    for (final id in ids) {
      if (id is String) {
        final newId = msgIdMap[id];
        if (newId != null) {
          mapped.add(newId);
        }
      }
    }
    return jsonEncode(mapped);
  }

  /// 带选项的导入（名称去重 + ID 重建）
  /// [jsonStr] JSON 字符串
  /// [options] 导入选项，控制导入哪些数据
  /// [targetCharacterId] 如果提供，记忆/对话将关联到此角色（用于"导入到当前角色"场景）
  Future<ImportResult> importWithOptions(
    String jsonStr, {
    ImportOptions options = const ImportOptions(),
    String? targetCharacterId,
  }) async {
    final Map<String, dynamic> data;
    try {
      data = await _decodeBackupJson(jsonStr);
    } on FormatException {
      // 真正的 JSON 语法错误才报"无法解析"。
      throw const FormatException('备份文件格式无效：无法解析备份文件');
    }
    final validation = _validateBackupData(data);
    if (!validation.isValid) {
      throw FormatException(validation.errorMessage ?? '数据格式无效');
    }
    const uuid = Uuid();

    int addedCount = 0;
    int skippedCount = 0;
    int memoriesImported = 0;
    int conversationsImported = 0;
    int messagesImported = 0;
    int profilesImported = 0;
    int profileVersionsImported = 0;
    int embeddingsImported = 0;

    // ID 映射表：原始 ID → 新/已有 ID
    final Map<String, String> idMap = {};

    // 旧记忆 ID → 新记忆 ID 映射，供 embedding 导入关联新记忆 id。
    final Map<String, String> memoryIdMap = {};

    // 为了在后台数据库 Isolate 下不抛出 unsendable 错误，我们必须将 _db 复制
    // 为局部变量 db，且在事务闭包内只引用局部变量，确保闭包不捕获 BackupService 实例。
    final db = _db;
    await db.transaction(() async {
      // ─── 导入角色（按名称去重：同名追加后缀新建独立记录）───
      if (options.includeCharacter) {
        // 支持 version 2 格式（单个 character）和 version 1 格式（characters 数组）
        final List<Map<String, dynamic>> characterList;
        if (data.containsKey('character') && data['character'] is Map) {
          characterList = [data['character'] as Map<String, dynamic>];
        } else if (data.containsKey('characters') &&
            data['characters'] is List) {
          characterList = (data['characters'] as List)
              .map((c) => c as Map<String, dynamic>)
              .toList();
        } else {
          characterList = [];
        }

        // 先查出 DB 中所有角色名，用于同名去重判定。事务内一次性查全量，
        // 避免每条导入角色都单独查库；后续新插入的名字也实时加入集合，
        // 保证同批次内多个同名角色也能递增不冲突。
        final existingChars = await db.select(db.characters).get();
        final existingNames = <String>{
          for (final c in existingChars) c.name,
        };

        final characterCompanions = <CharactersCompanion>[];
        for (final map in characterList) {
          final originalId = map['id'] as String;
          final name = map['name'] as String? ?? '';

          // 生成与现有名（含本批次已处理）不冲突的唯一名：
          // 无冲突原样返回，有冲突追加 (1)/(2)… 后缀。
          final uniqueName = makeUniqueCharacterName(existingNames, name);
          // 即时占位，避免本批次后续同名角色再次命中同一后缀。
          existingNames.add(uniqueName);

          // 生成新 UUID 并插入（同名不再跳过/复用已有 ID）
          final newId = uuid.v4();
          idMap[originalId] = newId;

          characterCompanions.add(
            CharactersCompanion.insert(
              id: newId,
              name: Value(uniqueName),
              avatarUrl: Value(map['avatar_url'] as String?),
              personality: Value(map['personality'] as String? ?? ''),
              scenario: Value(map['scenario'] as String? ?? ''),
              greeting: Value(map['greeting'] as String? ?? ''),
              exampleDialogue: Value(
                map['example_dialogue'] as String? ?? '',
              ),
              systemPrompt: Value(map['system_prompt'] as String? ?? ''),
              imageTags: Value(map['image_tags'] as String? ?? ''),
              userImageTags: Value(map['user_image_tags'] as String? ?? ''),
              basicInfo: Value(map['basic_info'] as String? ?? ''),
              otherInfo: Value(map['other_info'] as String? ?? ''),
              sortOrder: Value(map['sort_order'] as int? ?? 0),
              createdAt: Value(
                map['created_at'] != null
                    ? DateTime.parse(map['created_at'] as String)
                    : DateTime.now(),
              ),
              updatedAt: Value(
                map['updated_at'] != null
                    ? DateTime.parse(map['updated_at'] as String)
                    : DateTime.now(),
              ),
            ),
          );
          addedCount++;
        }
        if (characterCompanions.isNotEmpty) {
          await db.batch((batch) {
            for (final companion in characterCompanions) {
              batch.insert(db.characters, companion);
            }
          });
        }
      }

      // 旧消息 ID → 新消息 ID 映射，供记忆 source_msg_ids 重映射使用。
      // 必须在导入消息时填充，因此记忆导入排在消息导入之后（对齐主项目
      // `src/app/api/import/route.ts` 的「角色→对话/消息→记忆」顺序）。
      final Map<String, String> msgIdMap = {};

      // ─── 导入对话和消息（生成新 ID，使用 idMap 映射 character_id）───
      if (options.includeConversations) {
        final conversations = data['conversations'] as List? ?? [];
        final conversationCompanions = <ConversationsCompanion>[];
        final messageCompanions = <MessagesCompanion>[];
        for (final c in conversations) {
          final map = c as Map<String, dynamic>;
          final originalCharId = map['character_id'] as String;

          // 使用 idMap 映射 character_id，或使用 targetCharacterId
          final mappedCharId =
              targetCharacterId ?? idMap[originalCharId] ?? originalCharId;

          // 生成新对话 ID
          final newConvId = uuid.v4();

          conversationCompanions.add(
            ConversationsCompanion.insert(
              id: newConvId,
              characterId: mappedCharId,
              title: Value(map['title'] as String? ?? ''),
              ignoreMemory: Value(map['ignore_memory'] as int? ?? 0),
              createdAt: Value(
                map['created_at'] != null
                    ? DateTime.parse(map['created_at'] as String)
                    : DateTime.now(),
              ),
              updatedAt: Value(
                map['updated_at'] != null
                    ? DateTime.parse(map['updated_at'] as String)
                    : DateTime.now(),
              ),
            ),
          );
          conversationsImported++;
          addedCount++;

          // 导入该对话的消息（嵌套在对话对象中）
          final messages = map['messages'] as List? ?? [];
          var seq = 0;
          for (final msg in messages) {
            final msgMap = msg as Map<String, dynamic>;

            // 生成新消息 ID
            final newMsgId = uuid.v4();
            // 记录旧消息 ID → 新消息 ID，供后续记忆 source_msg_ids 重映射。
            final originalMsgId = msgMap['id'] as String?;
            if (originalMsgId != null && originalMsgId.isNotEmpty) {
              msgIdMap[originalMsgId] = newMsgId;
            }

            messageCompanions.add(
              MessagesCompanion.insert(
                id: newMsgId,
                conversationId: newConvId,
                role: msgMap['role'] as String,
                content: Value(msgMap['content'] as String? ?? ''),
                tokenCount: Value(msgMap['token_count'] as int? ?? 0),
                seq: Value(seq++),
                createdAt: Value(
                  msgMap['created_at'] != null
                      ? DateTime.parse(msgMap['created_at'] as String)
                      : DateTime.now(),
                ),
                metadata: Value(msgMap['metadata'] as String? ?? '{}'),
              ),
            );
            messagesImported++;
            addedCount++;
          }
        }
        if (conversationCompanions.isNotEmpty) {
          await db.batch((batch) {
            for (final companion in conversationCompanions) {
              batch.insert(db.conversations, companion);
            }
          });
        }
        if (messageCompanions.isNotEmpty) {
          await db.batch((batch) {
            for (final companion in messageCompanions) {
              batch.insert(db.messages, companion);
            }
          });
        }
      }

      // ─── 导入记忆（使用 idMap 映射 character_id，source_msg_ids 用
      //     msgIdMap 重映射，生成新 UUID）───
      if (options.includeMemories) {
        final memories = data['memories'] as List? ?? [];
        final memoryCompanions = <MemoriesCompanion>[];
        for (final m in memories) {
          final map = m as Map<String, dynamic>;
          final originalCharId = map['character_id'] as String;

          // 使用 idMap 映射 character_id，或使用 targetCharacterId
          final mappedCharId =
              targetCharacterId ?? idMap[originalCharId] ?? originalCharId;

          // 生成新 UUID
          final newMemId = uuid.v4();
          // 记录旧记忆 ID → 新记忆 ID，供后续 embedding 导入按 memoryIdMap 映射。
          final originalMemId = map['id'] as String?;
          if (originalMemId != null && originalMemId.isNotEmpty) {
            memoryIdMap[originalMemId] = newMemId;
          }

          memoryCompanions.add(
            MemoriesCompanion.insert(
              id: newMemId,
              characterId: mappedCharId,
              category: map['category'] as String,
              content: map['content'] as String,
              confidence: Value((map['confidence'] as num?)?.toDouble() ?? 0.8),
              tags: Value(
                map['tags'] is String
                    ? map['tags'] as String
                    : jsonEncode(map['tags'] ?? []),
              ),
              // source_msg_ids 重映射到新消息 ID：解析 JSON/列表，逐个用
              // msgIdMap 映射，丢弃无映射的旧 ID（对应消息未导入或被过滤）。
              // 对齐主项目 remapSourceMessageIds。
              sourceMsgIds: Value(
                remapSourceMessageIds(map['source_msg_ids'], msgIdMap),
              ),
              createdAt: Value(
                map['created_at'] != null
                    ? DateTime.parse(map['created_at'] as String)
                    : DateTime.now(),
              ),
              updatedAt: Value(
                map['updated_at'] != null
                    ? DateTime.parse(map['updated_at'] as String)
                    : DateTime.now(),
              ),
            ),
          );
          memoriesImported++;
          addedCount++;
        }
        if (memoryCompanions.isNotEmpty) {
          await db.batch((batch) {
            for (final companion in memoryCompanions) {
              batch.insert(db.memories, companion);
            }
          });
        }
      }

      // ─── 导入记忆画像 ────────────────────────────────────────
      // 对齐主项目 import/route.ts profilesToImport 逻辑。
      // importWithOptions 走 idMap（UUID 重建），character_id 用 targetCharacterId 或 idMap 映射。
      if (options.includeProfiles) {
        // 合并 memory_profiles（数组）和 memory_profile（单个对象）两种格式
        final profileList = <Map<String, dynamic>>[
          ...((data['memory_profiles'] as List?) ?? const [])
              .cast<Map<String, dynamic>>(),
          if (data['memory_profile'] is Map)
            data['memory_profile'] as Map<String, dynamic>,
        ];
        for (final profile in profileList) {
          final originalCharId = profile['character_id'] as String? ?? '';
          final newCharId =
              targetCharacterId ?? idMap[originalCharId] ?? originalCharId;

          // 校验角色存在
          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          // UPSERT：character_memory_profiles 主键是 character_id
          final existing = await (db.select(db.characterMemoryProfiles)
                ..where((t) => t.characterId.equals(newCharId)))
              .getSingleOrNull();
          if (existing != null) {
            await (db.update(db.characterMemoryProfiles)
                  ..where((t) => t.characterId.equals(newCharId)))
                .write(
              CharacterMemoryProfilesCompanion(
                profileName:
                    Value(profile['profile_name'] as String? ?? ''),
                relationshipState:
                    Value(profile['relationship_state'] as String? ?? ''),
                recentStoryState:
                    Value(profile['recent_story_state'] as String? ?? ''),
                emotionalBaseline:
                    Value(profile['emotional_baseline'] as String? ?? ''),
                openThreads: Value(
                  BackupService._normalizeJsonStringArray(
                    profile['open_threads'],
                  ),
                ),
                userProfileSummary:
                    Value(profile['user_profile_summary'] as String? ?? ''),
                pinnedSummary:
                    Value(profile['pinned_summary'] as String? ?? ''),
                updatedAt: Value(
                  BackupService._parseBackupDate(profile['updated_at']),
                ),
              ),
            );
          } else {
            await db.into(db.characterMemoryProfiles).insert(
              CharacterMemoryProfilesCompanion.insert(
                characterId: newCharId,
                profileName:
                    Value(profile['profile_name'] as String? ?? ''),
                relationshipState:
                    Value(profile['relationship_state'] as String? ?? ''),
                recentStoryState:
                    Value(profile['recent_story_state'] as String? ?? ''),
                emotionalBaseline:
                    Value(profile['emotional_baseline'] as String? ?? ''),
                openThreads: Value(
                  BackupService._normalizeJsonStringArray(
                    profile['open_threads'],
                  ),
                ),
                userProfileSummary:
                    Value(profile['user_profile_summary'] as String? ?? ''),
                pinnedSummary:
                    Value(profile['pinned_summary'] as String? ?? ''),
                updatedAt: Value(
                  BackupService._parseBackupDate(profile['updated_at']),
                ),
              ),
            );
          }
          profilesImported++;
          addedCount++;
        }

        // ─── 导入画像版本历史 ────────────────────────────────────
        final versionsList =
            (data['memory_profile_versions'] as List?) ?? const [];
        for (final v in versionsList) {
          final version = v as Map<String, dynamic>;
          final originalCharId = version['character_id'] as String? ?? '';
          final newCharId =
              targetCharacterId ?? idMap[originalCharId] ?? originalCharId;

          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          final versionNumber = version['version_number'] as int?;
          if (versionNumber == null) continue;

          // 检查同 character_id + version_number 是否已存在，避免重复导入
          final existing = await (db.select(db.characterMemoryProfileVersions)
                ..where((t) => t.characterId.equals(newCharId))
                ..where((t) => t.versionNumber.equals(versionNumber)))
              .getSingleOrNull();
          if (existing != null) {
            skippedCount++;
            continue;
          }

          await db.into(db.characterMemoryProfileVersions).insert(
            CharacterMemoryProfileVersionsCompanion.insert(
              characterId: newCharId,
              versionNumber: versionNumber,
              snapshotJson: version['snapshot_json'] as String? ?? '{}',
              reason: version['reason'] as String? ?? 'imported',
              taskId: Value(version['task_id'] as int?),
              createdAt: Value(
                BackupService._parseBackupDate(version['created_at']),
              ),
            ),
          );
          profileVersionsImported++;
          addedCount++;
        }
      }

      // ─── 导入记忆向量索引 ────────────────────────────────────
      // 依赖 includeMemories；按 memoryIdMap 映射 memory_id，无映射则跳过（孤儿向量）。
      if (options.includeMemories && options.includeEmbeddings) {
        final embeddingsList =
            (data['memory_embeddings'] as List?) ?? const [];
        for (final e in embeddingsList) {
          final embedding = e as Map<String, dynamic>;
          final originalMemId = embedding['memory_id'] as String? ?? '';
          final newMemId = memoryIdMap[originalMemId];
          if (newMemId == null) continue; // 孤儿向量，跳过

          final originalCharId = embedding['character_id'] as String? ?? '';
          final newCharId =
              targetCharacterId ?? idMap[originalCharId] ?? originalCharId;

          final charExists = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingleOrNull();
          if (charExists == null) continue;

          // 解析 embedding_blob（支持三种格式）
          final blob =
              BackupService._parseEmbeddingBlob(embedding['embedding_blob']);
          if (blob == null) continue;

          final provider = embedding['provider'] as String? ?? 'openai-compatible';
          final model = embedding['model'] as String? ?? 'unknown';
          final dimension = embedding['dimension'] as int? ?? 0;

          // UPSERT：唯一索引 idx_memory_embeddings_unique_model
          // (memory_id + provider + model + dimension)，先 SELECT 检查存在则 UPDATE 否则 INSERT
          final existing = await (db.select(db.memoryEmbeddings)
                ..where((t) => t.memoryId.equals(newMemId))
                ..where((t) => t.provider.equals(provider))
                ..where((t) => t.model.equals(model))
                ..where((t) => t.dimension.equals(dimension)))
              .getSingleOrNull();

          final companion = MemoryEmbeddingsCompanion(
            memoryId: Value(newMemId),
            characterId: Value(newCharId),
            provider: Value(provider),
            model: Value(model),
            dimension: Value(dimension),
            embeddingBlob: Value(blob),
            normalized: Value(embedding['normalized'] as int? ?? 1),
            embeddingTextHash:
                Value(embedding['embedding_text_hash'] as String? ?? ''),
            status: Value(embedding['status'] as String? ?? 'ready'),
            errorMessage: Value(embedding['error_message'] as String?),
            createdAt: Value(
              BackupService._parseBackupDate(embedding['created_at']),
            ),
            updatedAt: Value(
              BackupService._parseBackupDate(embedding['updated_at']),
            ),
          );

          if (existing != null) {
            await (db.update(db.memoryEmbeddings)
                  ..where((t) => t.id.equals(existing.id)))
                .write(companion);
          } else {
            await db.into(db.memoryEmbeddings).insert(companion);
          }
          embeddingsImported++;
          addedCount++;
        }
      }
    });

    return ImportResult(
      addedCount: addedCount,
      skippedCount: skippedCount,
      totalCount: addedCount + skippedCount,
      memoriesImported: memoriesImported,
      conversationsImported: conversationsImported,
      messagesImported: messagesImported,
      profilesImported: profilesImported,
      profileVersionsImported: profileVersionsImported,
      embeddingsImported: embeddingsImported,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 静态工具方法 — 画像 / 向量导入辅助
  // ═══════════════════════════════════════════════════════════════

  /// 把 open_threads 规范化为 JSON 字符串。
  /// 接受：JSON 字符串（DB 格式）、字符串数组（导出格式）、其他（返回 '[]'）。
  /// 对齐主项目 import/route.ts jsonStringArray。
  static String _normalizeJsonStringArray(dynamic value) {
    if (value is String) {
      try {
        final parsed = jsonDecode(value);
        if (parsed is List) {
          return jsonEncode(parsed.whereType<String>().toList());
        }
      } catch (_) {}
      return '[]';
    }
    if (value is List) {
      return jsonEncode(value.whereType<String>().toList());
    }
    return '[]';
  }

  /// 从序列化后的 embedding_blob 还原 Uint8List。
  /// 支持三种格式（对齐主项目 bufferFromSerialized）：
  /// 1. {type: 'Buffer', data: [...]}（主项目 better-sqlite3 格式）
  /// 2. [byte0, ...]（Flutter 数组格式）
  /// 3. Uint8List（已是二进制）
  static Uint8List? _parseEmbeddingBlob(dynamic value) {
    if (value is Uint8List) return value;
    if (value is List) {
      if (value.isEmpty) return null;
      return Uint8List.fromList(value.cast<int>());
    }
    if (value is Map) {
      if (value['type'] == 'Buffer' && value['data'] is List) {
        return Uint8List.fromList((value['data'] as List).cast<int>());
      }
    }
    return null;
  }
}
