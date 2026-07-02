// RC-1：本文件涉及 SSE 转发/多订阅分支时必须能 grep 到 SafeStreamSink（预留）。
// RC-9：不得出现 unawaited(...chatCompletion...) 这类把 LLM 流式请求丢进 fire-and-forget 的写法。
// RC-10：注释一律中文直写，禁止 \uXXXX Unicode 转义。

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../database/database.dart';
import '../models/app_settings.dart';
import 'llm_service.dart';

/// 画像版本保留上限 — 对齐主项目 memory-profile.ts:130 `MAX_MEMORY_PROFILE_VERSIONS`。
const int maxMemoryProfileVersions = 100;

/// 推理模型安全 max_tokens 下限 — 对齐主项目 api-client.ts:8 `REASONING_SAFE_MAX_TOKENS`。
/// 后台画像 patch LLM 调用强制至少给到这个量，避免思考链吃光 token 后无内容输出。
const int reasoningSafeMaxTokens = 16384;

/// 画像内容字段（不含 profile_name）。对齐主项目 memory-profile.ts:117-124。
const List<String> _profileContentFields = [
  'relationship_state',
  'recent_story_state',
  'emotional_baseline',
  'open_threads',
  'user_profile_summary',
  'pinned_summary',
];

/// patch 可写字段（含 profile_name）。对齐主项目 memory-profile.ts:125-128。
const List<String> _patchFields = [
  'profile_name',
  ..._profileContentFields,
];

// ═══════════════════════════════════════════════════════════════
// 业务领域类
// ═══════════════════════════════════════════════════════════════
// 说明：Drift 已为三张画像表生成 CharacterMemoryProfile /
// CharacterMemoryProfileUpdateTask / CharacterMemoryProfileVersion 行类
// （openThreads 字段为 String，存 JSON 序列化结果）。这里另起业务领域类
// （去掉 Character 前缀），将 openThreads parse 为 List<String>，与主项目
// `CharacterMemoryProfile` 接口语义对齐，避免与 Drift 行类同名冲突。

/// 角色记忆画像当前状态。对齐主项目 memory-profile.ts:7-17。
class MemoryProfile {
  final String characterId;
  final String profileName;
  final String relationshipState;
  final String recentStoryState;
  final String emotionalBaseline;
  final List<String> openThreads;
  final String userProfileSummary;
  final String pinnedSummary;
  final DateTime updatedAt;

  const MemoryProfile({
    required this.characterId,
    this.profileName = '',
    this.relationshipState = '',
    this.recentStoryState = '',
    this.emotionalBaseline = '',
    this.openThreads = const [],
    this.userProfileSummary = '',
    this.pinnedSummary = '',
    required this.updatedAt,
  });

  /// 序列化为可被 normalizeRow 回读的 JSON。对齐主项目 JSON.stringify(profile)。
  Map<String, dynamic> toJson() => {
        'character_id': characterId,
        'profile_name': profileName,
        'relationship_state': relationshipState,
        'recent_story_state': recentStoryState,
        'emotional_baseline': emotionalBaseline,
        'open_threads': openThreads,
        'user_profile_summary': userProfileSummary,
        'pinned_summary': pinnedSummary,
        'updated_at': updatedAt.toIso8601String(),
      };

  factory MemoryProfile.fromJson(Map<String, dynamic> json) {
    return MemoryProfile(
      characterId: json['character_id'] as String? ?? '',
      profileName: json['profile_name'] as String? ?? '',
      relationshipState: json['relationship_state'] as String? ?? '',
      recentStoryState: json['recent_story_state'] as String? ?? '',
      emotionalBaseline: json['emotional_baseline'] as String? ?? '',
      openThreads: parseOpenThreads(json['open_threads']),
      userProfileSummary: json['user_profile_summary'] as String? ?? '',
      pinnedSummary: json['pinned_summary'] as String? ?? '',
      updatedAt: json['updated_at'] is String
          ? DateTime.tryParse(json['updated_at'] as String) ??
              DateTime.fromMillisecondsSinceEpoch(0)
          : DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// 画像 patch（部分字段更新）。对齐主项目 memory-profile.ts:19-28。
/// 字段非 null 表示需要更新；null 表示不更新。
class MemoryProfilePatch {
  String? profileName;
  String? relationshipState;
  String? recentStoryState;
  String? emotionalBaseline;
  List<String>? openThreads;
  String? userProfileSummary;
  String? pinnedSummary;

  MemoryProfilePatch({
    this.profileName,
    this.relationshipState,
    this.recentStoryState,
    this.emotionalBaseline,
    this.openThreads,
    this.userProfileSummary,
    this.pinnedSummary,
  });

  /// 序列化为 JSON Map（只输出已设置字段）。对齐主项目 JSON.stringify(patch) 行为。
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (profileName != null) m['profile_name'] = profileName;
    if (relationshipState != null) m['relationship_state'] = relationshipState;
    if (recentStoryState != null) m['recent_story_state'] = recentStoryState;
    if (emotionalBaseline != null) m['emotional_baseline'] = emotionalBaseline;
    if (openThreads != null) m['open_threads'] = openThreads;
    if (userProfileSummary != null) {
      m['user_profile_summary'] = userProfileSummary;
    }
    if (pinnedSummary != null) m['pinned_summary'] = pinnedSummary;
    return m;
  }
}

/// 画像版本快照。对齐主项目 memory-profile.ts:57-65。
class MemoryProfileVersion {
  final int id;
  final String characterId;
  final int versionNumber;
  final MemoryProfile snapshot;
  final String reason;
  final int? taskId;
  final DateTime createdAt;

  const MemoryProfileVersion({
    required this.id,
    required this.characterId,
    required this.versionNumber,
    required this.snapshot,
    required this.reason,
    this.taskId,
    required this.createdAt,
  });
}

/// 画像更新任务（已解析 patch 与 source_text）。对齐主项目 memory-profile.ts:30-43。
class MemoryProfileUpdateTask {
  final int id;
  final String characterId;
  final String reason;
  final MemoryProfilePatch patch;
  final String sourceText;
  final String status;
  final String? claimToken;
  final int? leaseExpiresAt;
  final int retryCount;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;

  const MemoryProfileUpdateTask({
    required this.id,
    required this.characterId,
    required this.reason,
    required this.patch,
    required this.sourceText,
    required this.status,
    required this.claimToken,
    required this.leaseExpiresAt,
    required this.retryCount,
    required this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });
}

/// 任务摘要（不含 patch_json / claim_token / lease）。对齐主项目 memory-profile.ts:45-55。
class MemoryProfileTaskSummary {
  final int id;
  final String characterId;
  final String reason;
  final String status;
  final int retryCount;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;

  const MemoryProfileTaskSummary({
    required this.id,
    required this.characterId,
    required this.reason,
    required this.status,
    required this.retryCount,
    required this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });
}

/// 处理一批画像更新任务的结果。对齐主项目 memory-profile.ts:67-77。
class ProcessMemoryProfileUpdateResult {
  final int processed;
  final int skipped;
  final int failed;
  final int remaining;
  final int claimed;
  final bool hasPendingTasks;
  final bool noPendingTasks;
  final String message;
  final List<MemoryProfile> profiles;

  const ProcessMemoryProfileUpdateResult({
    required this.processed,
    required this.skipped,
    required this.failed,
    required this.remaining,
    required this.claimed,
    required this.hasPendingTasks,
    required this.noPendingTasks,
    required this.message,
    required this.profiles,
  });
}

/// 画像 patch LLM 调用的后台 provider/model 配置。
/// 类比 Wave 8 `EmbeddingAdapterConfig`：参数注入，不直接读 AppSettings.memoryEngine
/// （Wave 13 才加）。生产侧由调用方解析 settings 后传入。
class MemoryProfilePatchConfig {
  final String apiBase;
  final String apiKey;
  final String model;
  final int maxTokens;

  const MemoryProfilePatchConfig({
    required this.apiBase,
    required this.apiKey,
    required this.model,
    required this.maxTokens,
  });
}

/// 自定义 patch 生成器签名 — 用于测试注入（不走真实 LLM）。
typedef MemoryProfilePatchGenerator = Future<MemoryProfilePatch> Function(
  MemoryProfileUpdateTask task,
  MemoryProfile currentProfile,
);

// ═══════════════════════════════════════════════════════════════
// 纯辅助函数
// ═══════════════════════════════════════════════════════════════

/// 解析 open_threads 字段（可为 JSON 字符串或已解析数组）。
/// 对齐主项目 memory-profile.ts:160-168 `parseOpenThreads`。
List<String> parseOpenThreads(dynamic value) {
  if (value is List) {
    return value.whereType<String>().toList();
  }
  if (value is String) {
    try {
      final parsed = jsonDecode(value);
      if (parsed is List) return parsed.whereType<String>().toList();
    } catch (_) {
      return [];
    }
  }
  return [];
}

/// 规整 open_threads 数组：trim + 去空 + 去重保持顺序。
/// 对齐主项目 memory-profile.ts:170-174 `normalizeOpenThreads`（注意主项目这里不去重，
/// 去重在 normalizePatchPayload 里做；这里只 trim + filter）。
List<String> normalizeOpenThreads(List<String> value) {
  return value.map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
}

/// 解析任务 patch_json 为 JSON 对象，失败返回空 Map。
/// 对齐主项目 memory-profile.ts:176-182 `parseTaskPayload`。
Object? _parseTaskPayload(String value) {
  try {
    return jsonDecode(value);
  } catch (_) {
    return <String, dynamic>{};
  }
}

/// 判断 payload 是否为 extraction（含 source_text）形式。
/// 对齐主项目 memory-profile.ts:153-158 `isExtractionPayload`。
bool _isExtractionPayload(Object? value) {
  if (value is! Map) return false;
  return value['source_text'] is String;
}

/// 归一化 patch payload。对齐主项目 memory-profile.ts:227-257 `normalizePatchPayload`。
/// [preserveEmpty]：true 保留空字符串与空数组（用于已存储 patch 回读）；
/// false 跳过空值（用于 LLM 生成 patch）。
/// [fields]：参与归一化的字段列表。
MemoryProfilePatch _normalizePatchPayload(
  Object? value, {
  required bool preserveEmpty,
  required List<String> fields,
}) {
  if (value is! Map) return MemoryProfilePatch();
  final patch = MemoryProfilePatch();
  for (final field in fields) {
    if (!value.containsKey(field)) continue;
    final raw = value[field];
    if (field == 'open_threads') {
      final threads = <String>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is String) {
            final trimmed = item.trim();
            if (trimmed.isNotEmpty) threads.add(trimmed);
          }
        }
      }
      if (threads.isNotEmpty || (preserveEmpty && raw is List)) {
        // 去重保持顺序（对齐主项目 `[...new Set(threads)]`）
        final seen = <String>{};
        final unique = <String>[];
        for (final t in threads) {
          if (seen.add(t)) unique.add(t);
        }
        patch.openThreads = unique;
      }
      continue;
    }
    if (raw is! String) continue;
    final text = raw.trim();
    if (text.isNotEmpty || preserveEmpty) {
      switch (field) {
        case 'profile_name':
          patch.profileName = text;
          break;
        case 'relationship_state':
          patch.relationshipState = text;
          break;
        case 'recent_story_state':
          patch.recentStoryState = text;
          break;
        case 'emotional_baseline':
          patch.emotionalBaseline = text;
          break;
        case 'user_profile_summary':
          patch.userProfileSummary = text;
          break;
        case 'pinned_summary':
          patch.pinnedSummary = text;
          break;
      }
    }
  }
  return patch;
}

/// 已存储 patch 回读（preserveEmpty=true，含 profile_name）。
/// 对齐主项目 memory-profile.ts:259-261 `normalizeStoredPatch`。
MemoryProfilePatch normalizeStoredPatch(Object? value) {
  return _normalizePatchPayload(value,
      preserveEmpty: true, fields: _patchFields);
}

/// LLM 生成 patch 归一化（preserveEmpty=false，不含 profile_name）。
/// 对齐主项目 memory-profile.ts:263-265 `normalizeGeneratedPatch`。
MemoryProfilePatch normalizeGeneratedPatch(Object? value) {
  return _normalizePatchPayload(value,
      preserveEmpty: false, fields: _profileContentFields);
}

/// patch 是否含任何可写字段。对齐主项目 memory-profile.ts:267-269 `hasPatchChanges`。
bool hasPatchChanges(MemoryProfilePatch patch) {
  return patch.profileName != null ||
      patch.relationshipState != null ||
      patch.recentStoryState != null ||
      patch.emotionalBaseline != null ||
      patch.openThreads != null ||
      patch.userProfileSummary != null ||
      patch.pinnedSummary != null;
}

/// 画像是否含任何非空内容字段。对齐主项目 memory-profile.ts:271-277 `hasProfileContent`。
bool hasProfileContent(MemoryProfile profile) {
  if (profile.relationshipState.trim().isNotEmpty) return true;
  if (profile.recentStoryState.trim().isNotEmpty) return true;
  if (profile.emotionalBaseline.trim().isNotEmpty) return true;
  if (profile.openThreads.isNotEmpty) return true;
  if (profile.userProfileSummary.trim().isNotEmpty) return true;
  if (profile.pinnedSummary.trim().isNotEmpty) return true;
  return false;
}

/// 从文本中提取首个平衡 JSON 对象片段。对齐主项目 memory-profile.ts:279-311。
String? _findBalancedJsonSnippet(String text, int startIdx) {
  if (startIdx >= text.length || text[startIdx] != '{') return null;
  var depth = 0;
  var inString = false;
  var escape = false;
  for (var i = startIdx; i < text.length; i++) {
    final ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch == r'\') {
      escape = true;
      continue;
    }
    if (ch == '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch == '{') depth++;
    if (ch == '}') {
      depth--;
      if (depth == 0) return text.substring(startIdx, i + 1);
    }
  }
  return null;
}

/// 解析 LLM 返回的画像 patch 响应。对齐主项目 memory-profile.ts:313-348。
///
/// 三段处理：trim → 剥 ``` 代码块 → JSON.parse → 失败回退到 `_findBalancedJsonSnippet`
/// 提取首个平衡 JSON 对象 → 仍失败抛 "memory profile patch parsing failed: ..."。
MemoryProfilePatch parseMemoryProfilePatchResponse(String response) {
  var text = response.trim();
  if (text.startsWith('```')) {
    text = text.split('\n').skip(1).join('\n');
  }
  if (text.endsWith('```')) {
    text = text.substring(0, text.lastIndexOf('```'));
  }

  Exception parseError(String detail, [Object? cause]) {
    final causeMessage = cause is FormatException && cause.message.isNotEmpty
        ? ': ${cause.message}'
        : (cause != null ? ': $cause' : '');
    return Exception(
        'memory profile patch parsing failed: $detail$causeMessage');
  }

  MemoryProfilePatch normalizeParsedObject(Object? parsed) {
    if (parsed is! Map) {
      throw parseError('response JSON must be an object');
    }
    final root = parsed.containsKey('patch') ? parsed['patch'] : parsed;
    if (root is! Map) {
      throw parseError('profile patch must be a JSON object');
    }
    return normalizeGeneratedPatch(root);
  }

  try {
    return normalizeParsedObject(jsonDecode(text));
  } on FormatException catch (e) {
    final objectIdx = text.indexOf('{');
    if (objectIdx == -1) {
      throw parseError('response did not contain a JSON object', e);
    }
    final snippet = _findBalancedJsonSnippet(text, objectIdx);
    if (snippet == null) {
      throw parseError('response did not contain a balanced JSON object', e);
    }
    try {
      return normalizeParsedObject(jsonDecode(snippet));
    } on FormatException catch (snippetError) {
      throw parseError('JSON object snippet could not be parsed', snippetError);
    }
  }
}

/// 构造画像 patch LLM prompt。逐字对齐主项目 memory-profile.ts:350-371。
String buildMemoryProfilePatchPrompt(
  MemoryProfileUpdateTask task,
  MemoryProfile currentProfile,
  String sourceText,
  String characterInfo,
) {
  return [
    '你是 LumiMuse 的记忆画像维护器。请根据新的长期记忆信号，生成一个只包含必要字段的 JSON patch。',
    '只能输出 JSON 对象，不要解释。',
    '允许字段：relationship_state, recent_story_state, emotional_baseline, open_threads, user_profile_summary, pinned_summary。',
    '字段含义：recent_story_state 是最近正在发生的故事/阶段状态；open_threads 是仍需继续跟进的近期话题或未完成事项。',
    '如果没有值得进入长期角色画像的信息，输出 {"patch":{}}。',
    '不要编造用户没有表达过的事实。旧画像与新信号冲突时，只更新能被新信号支持的字段。',
    '',
    characterInfo,
    '任务原因：${task.reason}',
    '当前画像：${jsonEncode(currentProfile.toJson())}',
    '新信号：$sourceText',
    '',
    '输出格式：{"patch":{"relationship_state":"...","recent_story_state":"...","emotional_baseline":"...","open_threads":["..."],"user_profile_summary":"...","pinned_summary":"..."}}',
  ].join('\n');
}

/// 渲染画像为注入聊天上下文的文本。逐字对齐主项目 memory-profile.ts:889-901。
String renderMemoryProfile(MemoryProfile profile) {
  final lines = <String>[
    if (profile.relationshipState.trim().isNotEmpty)
      '关系状态：${profile.relationshipState.trim()}',
    if (profile.recentStoryState.trim().isNotEmpty)
      '近期故事状态：${profile.recentStoryState.trim()}',
    if (profile.emotionalBaseline.trim().isNotEmpty)
      '情绪基线：${profile.emotionalBaseline.trim()}',
    if (profile.openThreads.isNotEmpty)
      '进行中的话题：${profile.openThreads.join('；')}',
    if (profile.userProfileSummary.trim().isNotEmpty)
      '主人画像：${profile.userProfileSummary.trim()}',
    if (profile.pinnedSummary.trim().isNotEmpty)
      '置顶摘要：${profile.pinnedSummary.trim()}',
  ];
  if (lines.isEmpty) return '';
  return ['记忆画像：', ...lines].join('\n');
}

int _boundedLimit(int? value, int fallback, int maxVal) {
  if (value == null || value <= 0) return fallback;
  return math.max(1, math.min(value, maxVal));
}

int _boundedOffset(int? value) {
  if (value == null || value < 0) return 0;
  return value;
}

// ═══════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════

/// 角色记忆画像服务 — 对齐主项目 src/lib/memory-profile.ts。
///
/// 纯 Drift 操作 + LLM 调用（经 [LlmService]）。三张表：
/// CharacterMemoryProfiles / CharacterMemoryProfileUpdateTasks /
/// CharacterMemoryProfileVersions（schema v8 已建）。
class MemoryProfileService {
  final AppDatabase _db;
  final LlmService _llm;
  static const _uuid = Uuid();

  /// 队列处理防重入 flag — 对齐主项目 module-level `profileQueueProcessing`。
  bool _profileQueueProcessing = false;

  MemoryProfileService(this._db, this._llm);

  // ─────────────────────────────────────────────────────────────
  // 行类 → 业务类 normalize
  // ─────────────────────────────────────────────────────────────

  MemoryProfile _normalizeProfileRow(CharacterMemoryProfile row) {
    return MemoryProfile(
      characterId: row.characterId,
      profileName: row.profileName,
      relationshipState: row.relationshipState,
      recentStoryState: row.recentStoryState,
      emotionalBaseline: row.emotionalBaseline,
      openThreads: parseOpenThreads(row.openThreads),
      userProfileSummary: row.userProfileSummary,
      pinnedSummary: row.pinnedSummary,
      updatedAt: row.updatedAt,
    );
  }

  MemoryProfileVersion _normalizeVersionRow(CharacterMemoryProfileVersion row) {
    final snapshotMap = jsonDecode(row.snapshotJson) as Map<String, dynamic>;
    return MemoryProfileVersion(
      id: row.id,
      characterId: row.characterId,
      versionNumber: row.versionNumber,
      snapshot: MemoryProfile.fromJson(snapshotMap),
      reason: row.reason,
      taskId: row.taskId,
      createdAt: row.createdAt,
    );
  }

  MemoryProfileUpdateTask _normalizeTaskRow(CharacterMemoryProfileUpdateTask row) {
    final payload = _parseTaskPayload(row.patchJson);
    // _isExtractionPayload 是独立函数，Dart 不会跨函数把 Object? promote 为 Map，
    // 因此显式 cast 后再取 source_text。
    final sourceText = _isExtractionPayload(payload)
        ? ((payload as Map)['source_text'] as String).trim()
        : '';
    // 对齐主项目 normalizeTaskRow（memory-profile.ts:184-192）：
    //   sourceText 非空（extraction 任务）→ patch 留空，待 LLM 生成；
    //   sourceText 为空（已含 patch 的任务）→ 从 patch_json 回读已存储 patch。
    return MemoryProfileUpdateTask(
      id: row.id,
      characterId: row.characterId,
      reason: row.reason,
      patch: sourceText.isNotEmpty ? MemoryProfilePatch() : normalizeStoredPatch(payload),
      sourceText: sourceText,
      status: row.status,
      claimToken: row.claimToken,
      leaseExpiresAt: row.leaseExpiresAt,
      retryCount: row.retryCount,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  MemoryProfileTaskSummary _normalizeTaskSummaryRow(
      CharacterMemoryProfileUpdateTask row) {
    return MemoryProfileTaskSummary(
      id: row.id,
      characterId: row.characterId,
      reason: row.reason,
      status: row.status,
      retryCount: row.retryCount,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  Future<MemoryProfile?> _readRow(String characterId) async {
    final row = await (_db.select(_db.characterMemoryProfiles)
          ..where((t) => t.characterId.equals(characterId)))
        .getSingleOrNull();
    return row == null ? null : _normalizeProfileRow(row);
  }

  Future<MemoryProfileUpdateTask?> _getTaskById(int id) async {
    final row = await (_db.select(_db.characterMemoryProfileUpdateTasks)
          ..where((t) => t.id.equals(id)))
        .getSingleOrNull();
    return row == null ? null : _normalizeTaskRow(row);
  }

  // ─────────────────────────────────────────────────────────────
  // 9.1 画像 CRUD + 版本快照
  // ─────────────────────────────────────────────────────────────

  /// 获取或创建画像行。对齐主项目 memory-profile.ts:429-448 `getOrCreateMemoryProfile`。
  Future<MemoryProfile> getOrCreateMemoryProfile(String characterId) async {
    final existing = await _readRow(characterId);
    if (existing != null) return existing;

    await _db.into(_db.characterMemoryProfiles).insert(
          CharacterMemoryProfilesCompanion.insert(
            characterId: characterId,
            updatedAt: Value(DateTime.now()),
          ),
        );
    final created = await _readRow(characterId);
    if (created == null) {
      throw Exception(
          'failed to initialize memory profile for character $characterId');
    }
    return created;
  }

  /// 读取画像（不存在返回 null）。对齐主项目 memory-profile.ts:450-456。
  Future<MemoryProfile?> readMemoryProfile(String characterId) async {
    return _readRow(characterId);
  }

  /// 应用 patch 到画像。对齐主项目 memory-profile.ts:458-488。
  /// open_threads 序列化为 JSON 字符串存库；其他字段直接 String 化。
  Future<MemoryProfile> patchMemoryProfile(
      String characterId, MemoryProfilePatch patch) async {
    await getOrCreateMemoryProfile(characterId);

    final companion = CharacterMemoryProfilesCompanion(
      profileName:
          patch.profileName != null ? Value(patch.profileName!) : const Value.absent(),
      relationshipState: patch.relationshipState != null
          ? Value(patch.relationshipState!)
          : const Value.absent(),
      recentStoryState: patch.recentStoryState != null
          ? Value(patch.recentStoryState!)
          : const Value.absent(),
      emotionalBaseline: patch.emotionalBaseline != null
          ? Value(patch.emotionalBaseline!)
          : const Value.absent(),
      openThreads: patch.openThreads != null
          ? Value(jsonEncode(normalizeOpenThreads(patch.openThreads!)))
          : const Value.absent(),
      userProfileSummary: patch.userProfileSummary != null
          ? Value(patch.userProfileSummary!)
          : const Value.absent(),
      pinnedSummary: patch.pinnedSummary != null
          ? Value(patch.pinnedSummary!)
          : const Value.absent(),
      updatedAt: Value(DateTime.now()),
    );

    // 仅在 patch 含字段时才 UPDATE（对齐主项目 assignments.length > 0 判断）
    final hasField = patch.profileName != null ||
        patch.relationshipState != null ||
        patch.recentStoryState != null ||
        patch.emotionalBaseline != null ||
        patch.openThreads != null ||
        patch.userProfileSummary != null ||
        patch.pinnedSummary != null;
    if (hasField) {
      await (_db.update(_db.characterMemoryProfiles)
            ..where((t) => t.characterId.equals(characterId)))
          .write(companion);
    }

    return (await _readRow(characterId))!;
  }

  /// 创建画像版本快照 + trim 到 MAX_MEMORY_PROFILE_VERSIONS。
  /// 对齐主项目 memory-profile.ts:490-526 `createMemoryProfileVersion`。
  Future<MemoryProfileVersion> createMemoryProfileVersion(
    String characterId, {
    String reason = 'profile_update',
    int? taskId,
  }) async {
    final profile = await getOrCreateMemoryProfile(characterId);

    final maxExpr = _db.characterMemoryProfileVersions.versionNumber.max();
    final maxRow = await (_db.selectOnly(_db.characterMemoryProfileVersions)
          ..addColumns([maxExpr])
          ..where(_db.characterMemoryProfileVersions.characterId.equals(characterId)))
        .getSingle();
    final nextVersion = (maxRow.read(maxExpr) ?? 0) + 1;

    final insertedId = await _db.into(_db.characterMemoryProfileVersions).insert(
          CharacterMemoryProfileVersionsCompanion.insert(
            characterId: characterId,
            versionNumber: nextVersion,
            snapshotJson: jsonEncode(profile.toJson()),
            reason: reason,
            taskId: taskId != null ? Value(taskId) : const Value.absent(),
            createdAt: Value(DateTime.now()),
          ),
        );

    final row = await (_db.select(_db.characterMemoryProfileVersions)
          ..where((t) => t.id.equals(insertedId)))
        .getSingle();
    final version = _normalizeVersionRow(row);

    await _trimVersions(characterId);
    return version;
  }

  /// trim 画像版本到 MAX_MEMORY_PROFILE_VERSIONS（保留 version_number DESC 前 N）。
  /// 对齐主项目 memory-profile.ts:515-524 的 DELETE ... NOT IN 子句。
  Future<void> _trimVersions(String characterId) async {
    final keepRows = await (_db.select(_db.characterMemoryProfileVersions)
          ..where((t) => t.characterId.equals(characterId))
          ..orderBy([(t) => OrderingTerm.desc(t.versionNumber)])
          ..limit(maxMemoryProfileVersions))
        .map((t) => t.id)
        .get();
    if (keepRows.length < maxMemoryProfileVersions) return; // 未超限
    final keepSet = keepRows.toSet();
    await (_db.delete(_db.characterMemoryProfileVersions)
          ..where((t) =>
              t.characterId.equals(characterId) & t.id.isNotIn(keepSet)))
        .go();
  }

  /// 分页查询画像版本。对齐主项目 memory-profile.ts:528-542。
  /// 默认 limit=50，上限 100。
  Future<List<MemoryProfileVersion>> getMemoryProfileVersions(
    String characterId, {
    int? limit,
    int? offset,
  }) async {
    final l = _boundedLimit(limit, 50, maxMemoryProfileVersions);
    final o = _boundedOffset(offset);
    final rows = await (_db.select(_db.characterMemoryProfileVersions)
          ..where((t) => t.characterId.equals(characterId))
          ..orderBy([(t) => OrderingTerm.desc(t.versionNumber)])
          ..limit(l, offset: o))
        .get();
    return rows.map(_normalizeVersionRow).toList();
  }

  /// 删除指定画像版本。对齐主项目 memory-profile.ts:544-555。
  Future<bool> deleteMemoryProfileVersion(
      String characterId, int versionId) async {
    final changed = await (_db.delete(_db.characterMemoryProfileVersions)
          ..where((t) =>
              t.id.equals(versionId) & t.characterId.equals(characterId)))
        .go();
    return changed > 0;
  }

  /// 回滚画像到指定版本。对齐主项目 memory-profile.ts:860-887。
  /// snapshot 空内容时直接返回 getOrCreate 结果；否则 patchMemoryProfile 全字段覆盖。
  Future<MemoryProfile> rollbackMemoryProfile(
      String characterId, int versionId) async {
    final row = await (_db.select(_db.characterMemoryProfileVersions)
          ..where((t) =>
              t.id.equals(versionId) & t.characterId.equals(characterId)))
        .getSingleOrNull();
    if (row == null) {
      throw Exception(
          'memory profile version $versionId not found for character $characterId');
    }
    final version = _normalizeVersionRow(row);
    if (!hasProfileContent(version.snapshot)) {
      return await getOrCreateMemoryProfile(characterId);
    }
    return await patchMemoryProfile(
      characterId,
      MemoryProfilePatch(
        profileName: version.snapshot.profileName,
        relationshipState: version.snapshot.relationshipState,
        recentStoryState: version.snapshot.recentStoryState,
        emotionalBaseline: version.snapshot.emotionalBaseline,
        openThreads: version.snapshot.openThreads,
        userProfileSummary: version.snapshot.userProfileSummary,
        pinnedSummary: version.snapshot.pinnedSummary,
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 9.2 patch LLM 生成 + 更新队列 + render
  // ─────────────────────────────────────────────────────────────

  /// 入队一条 patch 更新任务。对齐主项目 memory-profile.ts:557-576。
  Future<MemoryProfileUpdateTask> enqueueMemoryProfileUpdate(
    String characterId,
    MemoryProfilePatch patch, {
    String reason = 'memory_extraction',
  }) async {
    final now = DateTime.now();
    final id = await _db.into(_db.characterMemoryProfileUpdateTasks).insert(
          CharacterMemoryProfileUpdateTasksCompanion.insert(
            characterId: characterId,
            reason: reason,
            patchJson: jsonEncode(patch.toJson()),
            status: const Value('pending'),
            retryCount: const Value(0),
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
    return (await _getTaskById(id))!;
  }

  /// 入队一条 patch 提取任务（含 source_text，待 LLM 生成 patch）。
  /// 对齐主项目 memory-profile.ts:578-597。
  Future<MemoryProfileUpdateTask> enqueueMemoryProfilePatchExtraction(
    String characterId,
    String sourceText, {
    String reason = 'memory_extraction',
  }) async {
    final now = DateTime.now();
    final id = await _db.into(_db.characterMemoryProfileUpdateTasks).insert(
          CharacterMemoryProfileUpdateTasksCompanion.insert(
            characterId: characterId,
            reason: reason,
            patchJson: jsonEncode({'source_text': sourceText}),
            status: const Value('pending'),
            retryCount: const Value(0),
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
    return (await _getTaskById(id))!;
  }

  /// 获取某角色的全部画像更新任务（含解析后的 patch + source_text）。
  /// 对齐主项目 memory-profile.ts:599-609。
  Future<List<MemoryProfileUpdateTask>> getMemoryProfileUpdateTasks(
      String characterId) async {
    final rows = await (_db.select(_db.characterMemoryProfileUpdateTasks)
          ..where((t) => t.characterId.equals(characterId))
          ..orderBy([(t) => OrderingTerm.asc(t.id)]))
        .get();
    return rows.map(_normalizeTaskRow).toList();
  }

  /// 获取某角色的任务摘要（不含 patch_json / claim_token / lease）。
  /// 对齐主项目 memory-profile.ts:611-622。
  Future<List<MemoryProfileTaskSummary>> getMemoryProfileTaskSummaries(
      String characterId) async {
    final rows = await (_db.select(_db.characterMemoryProfileUpdateTasks)
          ..where((t) => t.characterId.equals(characterId))
          ..orderBy([(t) => OrderingTerm.asc(t.id)]))
        .get();
    return rows.map(_normalizeTaskSummaryRow).toList();
  }

  /// 抢占一批可领取任务（pending 或 processing+lease 过期）。
  /// 对齐主项目 memory-profile.ts:624-689 `claimMemoryProfileUpdateTasks`。
  ///
  /// 事务内 SELECT 候选 → UPDATE 翻 processing + 写 claim_token + lease_expires_at。
  /// Drift 的 update().write() 不支持 LIMIT，因此先 SELECT 取 id 再逐条 update。
  Future<List<MemoryProfileUpdateTask>> claimMemoryProfileUpdateTasks(
    int limit,
    int leaseSeconds, {
    int? taskId,
    int? throughTaskId,
    String? characterId,
  }) async {
    final claimToken = _uuid.v4();
    final now = DateTime.now();
    final nowMs = now.millisecondsSinceEpoch;
    final leaseExpiresAtMs =
        now.add(Duration(seconds: leaseSeconds)).millisecondsSinceEpoch;

    await _db.transaction(() async {
      final query = _db.select(_db.characterMemoryProfileUpdateTasks)
        ..where((t) =>
            t.status.equals('pending') |
            (t.status.equals('processing') &
                t.leaseExpiresAt.isNotNull() &
                t.leaseExpiresAt.isSmallerThanValue(nowMs)));
      if (characterId != null) {
        query.where((t) => t.characterId.equals(characterId));
      }
      if (taskId != null) {
        query.where((t) => t.id.equals(taskId));
      } else if (throughTaskId != null) {
        query.where((t) => t.id.isSmallerOrEqualValue(throughTaskId));
      }
      query.orderBy([(t) => OrderingTerm.asc(t.id)]);
      if (throughTaskId == null) {
        query.limit(limit);
      }
      final rows = await query.get();
      for (final row in rows) {
        await (_db.update(_db.characterMemoryProfileUpdateTasks)
              ..where((t) =>
                  t.id.equals(row.id) &
                  (t.status.equals('pending') |
                      (t.status.equals('processing') &
                          t.leaseExpiresAt.isNotNull() &
                          t.leaseExpiresAt.isSmallerThanValue(nowMs)))))
            .write(CharacterMemoryProfileUpdateTasksCompanion(
          status: const Value('processing'),
          claimToken: Value(claimToken),
          leaseExpiresAt: Value(leaseExpiresAtMs),
          errorMessage: const Value(null),
          updatedAt: Value(now),
        ));
      }
    });

    final claimed = await (_db.select(_db.characterMemoryProfileUpdateTasks)
          ..where((t) => t.claimToken.equals(claimToken))
          ..orderBy([(t) => OrderingTerm.asc(t.id)]))
        .get();
    return claimed.map(_normalizeTaskRow).toList();
  }

  /// 确认 claim 仍然有效（用于事务内写操作前的乐观锁校验）。
  /// 对齐主项目 memory-profile.ts:707-714 `confirmTaskClaimForWrite`。
  /// no-op 写回 lease_expires_at 触发 changes 计数。
  Future<bool> _confirmTaskClaimForWrite(MemoryProfileUpdateTask task) async {
    final changed = await (_db.update(_db.characterMemoryProfileUpdateTasks)
          ..where((t) =>
              t.id.equals(task.id) &
              t.claimToken.equals(task.claimToken!) &
              t.status.equals('processing')))
        .write(CharacterMemoryProfileUpdateTasksCompanion(
      leaseExpiresAt: Value(task.leaseExpiresAt),
    ));
    return changed > 0;
  }

  /// 统计可领取任务数。对齐主项目 memory-profile.ts:691-705 `countClaimableMemoryProfileUpdateTasks`。
  Future<int> _countClaimableMemoryProfileUpdateTasks([String? characterId]) async {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final countExpr = _db.characterMemoryProfileUpdateTasks.id.count();
    final query = _db.selectOnly(_db.characterMemoryProfileUpdateTasks)
      ..addColumns([countExpr])
      ..where(_db.characterMemoryProfileUpdateTasks.status.equals('pending') |
          (_db.characterMemoryProfileUpdateTasks.status.equals('processing') &
              _db.characterMemoryProfileUpdateTasks.leaseExpiresAt.isNotNull() &
              _db.characterMemoryProfileUpdateTasks.leaseExpiresAt
                  .isSmallerThanValue(nowMs)));
    if (characterId != null) {
      query.where(
          _db.characterMemoryProfileUpdateTasks.characterId.equals(characterId));
    }
    final row = await query.getSingle();
    return row.read(countExpr) ?? 0;
  }

  /// 主处理循环。对齐主项目 memory-profile.ts:716-822 `processMemoryProfileUpdateTasks`。
  ///
  /// 流程：
  /// 1. claim 一批任务
  /// 2. 逐 task：读 current profile → 若 source_text 非空则 generatePatch
  ///    → 无 patch 变更 → 翻 done + 'empty profile patch skipped'
  ///    → 有变更 → 事务内 confirmTaskClaimForWrite + patchMemoryProfile
  ///      + createMemoryProfileVersion + 翻 done
  ///    → 异常 → 翻 failed + retry_count++ + error_message
  Future<ProcessMemoryProfileUpdateResult> processMemoryProfileUpdateTasks({
    int limit = 10,
    int leaseSeconds = 300,
    MemoryProfilePatchGenerator? generatePatch,
    MemoryProfilePatchConfig? config,
    int? taskId,
    int? throughTaskId,
    String? characterId,
  }) async {
    if (generatePatch == null && config == null) {
      throw Exception(
          'LLM provider is not configured for memory profile patch generation');
    }
    final clampedLimit = math.max(1, limit);
    final clampedLease = math.max(1, leaseSeconds);

    final tasks = await claimMemoryProfileUpdateTasks(
      clampedLimit,
      clampedLease,
      taskId: taskId,
      throughTaskId: throughTaskId,
      characterId: characterId,
    );

    var processed = 0;
    var skipped = 0;
    var failed = 0;
    final profiles = <MemoryProfile>[];

    for (final task in tasks) {
      try {
        final currentProfile = await getOrCreateMemoryProfile(task.characterId);
        final gen = generatePatch ??
            ((t, p) =>
                _generateMemoryProfilePatchWithLlm(t, p, config!));
        final patch = task.sourceText.isNotEmpty
            ? normalizeGeneratedPatch((await gen(task, currentProfile)).toJson())
            : task.patch;

        if (!hasPatchChanges(patch)) {
          // 无 patch 变更 → skipped 路径
          final result = await _db.transaction(() async {
            if (!await _confirmTaskClaimForWrite(task)) {
              return (applied: false, profile: await getOrCreateMemoryProfile(task.characterId));
            }
            await (_db.update(_db.characterMemoryProfileUpdateTasks)
                  ..where((t) =>
                      t.id.equals(task.id) &
                      t.claimToken.equals(task.claimToken!)))
                .write(CharacterMemoryProfileUpdateTasksCompanion(
              status: const Value('done'),
              claimToken: const Value(null),
              leaseExpiresAt: const Value(null),
              errorMessage: const Value('empty profile patch skipped'),
              updatedAt: Value(DateTime.now()),
            ));
            return (applied: true, profile: await getOrCreateMemoryProfile(task.characterId));
          });
          skipped += 1;
          profiles.add(result.profile);
          continue;
        }

        // 有变更 → 应用 patch + 创建版本
        final result = await _db.transaction(() async {
          if (!await _confirmTaskClaimForWrite(task)) {
            return (applied: false, profile: await getOrCreateMemoryProfile(task.characterId));
          }
          final updated = await patchMemoryProfile(task.characterId, patch);
          await createMemoryProfileVersion(task.characterId,
              reason: task.reason, taskId: task.id);
          await (_db.update(_db.characterMemoryProfileUpdateTasks)
                ..where((t) =>
                    t.id.equals(task.id) &
                    t.claimToken.equals(task.claimToken!)))
              .write(CharacterMemoryProfileUpdateTasksCompanion(
            status: const Value('done'),
            claimToken: const Value(null),
            leaseExpiresAt: const Value(null),
            errorMessage: const Value(null),
            updatedAt: Value(DateTime.now()),
          ));
          return (applied: true, profile: updated);
        });
        if (result.applied) {
          processed += 1;
        } else {
          skipped += 1;
        }
        profiles.add(result.profile);
      } catch (e) {
        failed += 1;
        final message = e.toString();
        await (_db.update(_db.characterMemoryProfileUpdateTasks)
              ..where((t) =>
                  t.id.equals(task.id) &
                  t.claimToken.equals(task.claimToken!)))
            .write(CharacterMemoryProfileUpdateTasksCompanion(
          status: const Value('failed'),
          claimToken: const Value(null),
          leaseExpiresAt: const Value(null),
          retryCount: Value(task.retryCount + 1),
          errorMessage: Value(message),
          updatedAt: Value(DateTime.now()),
        ));
      }
    }

    final remaining = await _countClaimableMemoryProfileUpdateTasks(characterId);
    return ProcessMemoryProfileUpdateResult(
      processed: processed,
      skipped: skipped,
      failed: failed,
      remaining: remaining,
      claimed: tasks.length,
      hasPendingTasks: remaining > 0,
      noPendingTasks: tasks.isEmpty,
      message: tasks.isEmpty ? 'no pending tasks' : 'processed memory profile tasks',
      profiles: profiles,
    );
  }

  /// 启动恢复：把残留 processing 翻回 pending（claim_token / lease 清空）。
  /// 对齐主项目 memory-profile.ts:851-858 `recoverStaleMemoryProfileTasks`。
  Future<int> recoverStaleMemoryProfileTasks() async {
    final now = DateTime.now();
    final changed = await (_db.update(_db.characterMemoryProfileUpdateTasks)
          ..where((t) => t.status.equals('processing')))
        .write(CharacterMemoryProfileUpdateTasksCompanion(
      status: const Value('pending'),
      claimToken: const Value(null),
      leaseExpiresAt: const Value(null),
      updatedAt: Value(now),
    ));
    return changed;
  }

  /// 触发画像更新队列处理：异步循环排空队列，不阻塞调用方。
  /// 对齐主项目 memory-profile.ts:832-848 `triggerMemoryProfileQueue`。
  ///
  /// RC-9：循环内 LLM 调用必须 await（在 [processMemoryProfileUpdateTasks]
  /// 内部 await `_llm.chatCompletion`），不得 fire-and-forget。
  void triggerMemoryProfileQueue({
    MemoryProfilePatchConfig? config,
    MemoryProfilePatchGenerator? generatePatch,
  }) {
    if (_profileQueueProcessing) return;
    _profileQueueProcessing = true;
    unawaited(_drainProfileQueue(config: config, generatePatch: generatePatch));
  }

  Future<void> _drainProfileQueue({
    MemoryProfilePatchConfig? config,
    MemoryProfilePatchGenerator? generatePatch,
  }) async {
    try {
      // 持续处理直到无可领取任务；上限保护避免异常情况下死循环
      for (var i = 0; i < 1000; i++) {
        final result = await processMemoryProfileUpdateTasks(
          limit: 5,
          config: config,
          generatePatch: generatePatch,
        );
        if (result.claimed == 0) break;
      }
    } catch (_) {
      // 排空失败兜底（对齐主项目 console.error 静默）
    } finally {
      _profileQueueProcessing = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 默认 patch 生成器（私有）
  // ─────────────────────────────────────────────────────────────

  /// 默认 LLM patch 生成器。对齐主项目 memory-profile.ts:373-420 `generateMemoryProfilePatchWithLlm`。
  ///
  /// 流程：
  /// 1. source_text 为空 → 返回 task.patch
  /// 2. 读 characters 表 name/basic_info/personality/scenario/other_info 拼 characterInfo
  /// 3. 构造 AppSettings（json_mode=true, streaming=false, max_tokens≥REASONING_SAFE_MAX_TOKENS）
  /// 4. buildMemoryProfilePatchPrompt → chatCompletion → parseMemoryProfilePatchResponse
  Future<MemoryProfilePatch> _generateMemoryProfilePatchWithLlm(
    MemoryProfileUpdateTask task,
    MemoryProfile currentProfile,
    MemoryProfilePatchConfig config,
  ) async {
    final rawSourceText = task.sourceText.trim();
    if (rawSourceText.isEmpty) return task.patch;

    // 读取角色信息，让画像 patch LLM 知道角色是谁（读失败不阻塞）
    var characterInfo = '';
    try {
      final charRow = await (_db.select(_db.characters)
            ..where((c) => c.id.equals(task.characterId))
            ..limit(1))
          .getSingleOrNull();
      if (charRow != null) {
        final parts = <String>['角色名称：${charRow.name}'];
        if (charRow.basicInfo.isNotEmpty) parts.add('基本信息：${charRow.basicInfo}');
        if (charRow.personality.isNotEmpty) parts.add('性格：${charRow.personality}');
        if (charRow.scenario.isNotEmpty) parts.add('场景设定：${charRow.scenario}');
        if (charRow.otherInfo.isNotEmpty) parts.add('其他补充：${charRow.otherInfo}');
        characterInfo = parts.join('\n');
      }
    } catch (_) {
      // 角色信息读取失败不阻塞画像更新
    }

    // TODO(Wave13): 接入 MemoryEngineSettings 解析后台 provider/model
    if (config.apiBase.trim().isEmpty || config.model.trim().isEmpty) {
      throw Exception(
          'LLM provider is not configured for memory profile patch generation');
    }

    final settings = AppSettings(
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      model: config.model,
      jsonMode: true,
      streaming: false,
      maxTokens: math.max(config.maxTokens, reasoningSafeMaxTokens),
      temperature: 1.0,
    );

    final prompt =
        buildMemoryProfilePatchPrompt(task, currentProfile, rawSourceText, characterInfo);
    // TODO(Wave13): Flutter LlmService 暂不支持 extraBody，待 Wave 13 接入
    // buildBackgroundChatExtraBody(loaded, settings.model)
    final response = await _llm.chatCompletion(
      settings: settings,
      messages: [ChatMessage(role: 'user', content: prompt)],
    );
    return parseMemoryProfilePatchResponse(response);
  }
}
