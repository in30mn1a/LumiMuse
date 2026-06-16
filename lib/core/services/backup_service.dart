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

  const ExportOptions({
    this.includeCharacter = true,
    this.includeMemories = true,
    this.includeConversations = true,
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

  const ImportOptions({
    this.includeCharacter = true,
    this.includeMemories = true,
    this.includeConversations = true,
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

  const ImportResult({
    required this.addedCount,
    required this.skippedCount,
    required this.totalCount,
    this.memoriesImported = 0,
    this.conversationsImported = 0,
    this.messagesImported = 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// 备份服务
// ═══════════════════════════════════════════════════════════════

/// 最大导入文件大小：100MB
const int maxImportFileSize = 100 * 1024 * 1024;

/// 数据备份与恢复服务
class BackupService {
  static const int currentFullBackupVersion = 1;
  static const int currentCharacterBackupVersion = 2;
  static const int currentSchemaVersion = 6;

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

  DateTime _parseBackupDate(dynamic value) {
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
  Future<String> exportToJson({bool includeSecrets = false}) async {
    final result = await _db.transaction(() async {
      final characters = await _db.select(_db.characters).get();
      final conversations = await _db.select(_db.conversations).get();
      final messages = await _db.select(_db.messages).get();
      final memories = await _db.select(_db.memories).get();
      final settings = await _db.select(_db.settings).get();
      final apiProviders = await _db.select(_db.apiProviders).get();
      return (
        characters,
        conversations,
        messages,
        memories,
        settings,
        apiProviders,
      );
    });

    final (
      characters,
      conversations,
      messages,
      memories,
      settings,
      apiProviders,
    ) = result;

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

  /// 检查文件大小是否在允许范围内（≤100MB）
  /// 返回 null 表示通过，否则返回错误信息
  static String? checkFileSize(int fileSizeInBytes) {
    if (fileSizeInBytes > maxImportFileSize) {
      final sizeMB = (fileSizeInBytes / (1024 * 1024)).toStringAsFixed(1);
      // TODO(parity): 主项目缺失 'backup.fileTooLarge' 键，硬编码兜底
      return '文件大小 ${sizeMB}MB 超过限制（最大 100MB）';
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
  Future<ImportResult> importFromJson(String jsonStr) async {
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

    // 使用事务确保原子性
    await _db.transaction(() async {
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
        final existing = await (_db.select(
          _db.characters,
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
        await _db.batch((batch) {
          for (final companion in characterCompanions) {
            batch.insert(_db.characters, companion);
          }
        });
      }

      // 导入对话
      final conversations = data['conversations'] as List? ?? [];
      final conversationCompanions = <ConversationsCompanion>[];
      for (final c in conversations) {
        final map = c as Map<String, dynamic>;
        final id = map['id'] as String;

        final existing = await (_db.select(
          _db.conversations,
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
      }
      if (conversationCompanions.isNotEmpty) {
        await _db.batch((batch) {
          for (final companion in conversationCompanions) {
            batch.insert(_db.conversations, companion);
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

        final existing = await (_db.select(
          _db.messages,
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
      }
      if (messageCompanions.isNotEmpty) {
        await _db.batch((batch) {
          for (final companion in messageCompanions) {
            batch.insert(_db.messages, companion);
          }
        });
      }

      // 导入记忆
      final memories = data['memories'] as List? ?? [];
      final memoryCompanions = <MemoriesCompanion>[];
      for (final m in memories) {
        final map = m as Map<String, dynamic>;
        final id = map['id'] as String;

        final existing = await (_db.select(
          _db.memories,
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
      }
      if (memoryCompanions.isNotEmpty) {
        await _db.batch((batch) {
          for (final companion in memoryCompanions) {
            batch.insert(_db.memories, companion);
          }
        });
      }

      // 导入设置（设置使用 key 作为主键，重复则跳过）
      final settings = data['settings'] as Map<String, dynamic>? ?? {};
      for (final entry in settings.entries) {
        // 跳过密码相关设置，避免导入备份时覆盖当前的登录密码
        if (entry.key.startsWith('launch_password_')) {
          continue;
        }

        final existing = await (_db.select(
          _db.settings,
        )..where((t) => t.key.equals(entry.key))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        await _db
            .into(_db.settings)
            .insert(
              SettingsCompanion.insert(
                key: entry.key,
                value: await _prepareImportedSettingValue(
                  entry.key,
                  entry.value,
                ),
              ),
            );
        addedCount++;
      }

      // 导入 API Provider。旧备份没有该字段时保持兼容；包含凭据时转入安全存储。
      final apiProviders = data['api_providers'] as List? ?? [];
      for (final item in apiProviders) {
        final map = item as Map<String, dynamic>;
        final id = map['id'] as String? ?? '';
        if (id.isEmpty) continue;

        final existing = await (_db.select(
          _db.apiProviders,
        )..where((t) => t.id.equals(id))).getSingleOrNull();

        if (existing != null) {
          skippedCount++;
          continue;
        }

        await _db
            .into(_db.apiProviders)
            .insert(
              ApiProvidersCompanion.insert(
                id: id,
                name: map['name'] as String? ?? '',
                apiBase: Value(map['api_base'] as String? ?? ''),
                apiKey: Value(
                  await _prepareImportedProviderApiKey(
                    id,
                    map['api_key'] ?? '',
                  ),
                ),
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
                createdAt: Value(_parseBackupDate(map['created_at'])),
              ),
            );
        addedCount++;
      }
    });

    return ImportResult(
      addedCount: addedCount,
      skippedCount: skippedCount,
      totalCount: addedCount + skippedCount,
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

    return exportData;
  }

  // ═══════════════════════════════════════════════════════════════
  // 导入增强 — 名称去重与 ID 重建
  // ═══════════════════════════════════════════════════════════════

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

    // ID 映射表：原始 ID → 新/已有 ID
    final Map<String, String> idMap = {};

    await _db.transaction(() async {
      // ─── 导入角色（按名称去重）───
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

        final characterCompanions = <CharactersCompanion>[];
        for (final map in characterList) {
          final originalId = map['id'] as String;
          final name = map['name'] as String? ?? '';

          // 按名称去重：查询是否已存在同名角色
          final existing = await (_db.select(
            _db.characters,
          )..where((t) => t.name.equals(name))).getSingleOrNull();

          if (existing != null) {
            // 同名角色已存在，跳过并记录 ID 映射
            idMap[originalId] = existing.id;
            skippedCount++;
          } else {
            // 不存在同名角色，生成新 UUID 并插入
            final newId = uuid.v4();
            idMap[originalId] = newId;

            characterCompanions.add(
              CharactersCompanion.insert(
                id: newId,
                name: Value(name),
                avatarUrl: Value(map['avatar_url'] as String?),
                personality: Value(map['personality'] as String? ?? ''),
                scenario: Value(map['scenario'] as String? ?? ''),
                greeting: Value(map['greeting'] as String? ?? ''),
                exampleDialogue: Value(
                  map['example_dialogue'] as String? ?? '',
                ),
                systemPrompt: Value(map['system_prompt'] as String? ?? ''),
                imageTags: Value(map['image_tags'] as String? ?? ''),
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
        }
        if (characterCompanions.isNotEmpty) {
          await _db.batch((batch) {
            for (final companion in characterCompanions) {
              batch.insert(_db.characters, companion);
            }
          });
        }
      }

      // ─── 导入记忆（使用 idMap 映射 character_id，生成新 UUID）───
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
              sourceMsgIds: Value(
                map['source_msg_ids'] is String
                    ? map['source_msg_ids'] as String
                    : jsonEncode(map['source_msg_ids'] ?? []),
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
          await _db.batch((batch) {
            for (final companion in memoryCompanions) {
              batch.insert(_db.memories, companion);
            }
          });
        }
      }

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
          await _db.batch((batch) {
            for (final companion in conversationCompanions) {
              batch.insert(_db.conversations, companion);
            }
          });
        }
        if (messageCompanions.isNotEmpty) {
          await _db.batch((batch) {
            for (final companion in messageCompanions) {
              batch.insert(_db.messages, companion);
            }
          });
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
    );
  }
}
