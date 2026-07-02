import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart' show OrderingMode, OrderingTerm, Value;

import '../database/database.dart';
import 'llm_service.dart';

/// 记忆引擎 — 提取、合并、检索记忆
/// 对应 Next.js 版的 memory-engine.ts
class MemoryEngine {
  final AppDatabase _db;

  MemoryEngine(this._db, LlmService _);

  /// 六大记忆分类
  static const List<String> categories = [
    '关系动态',
    '话题历史',
    '基础信息',
    '偏好习惯',
    '人格特质',
    '重要事件',
  ];

  /// CJK 停用词（扩充至 60+，对齐主项目 memory-engine.ts:13-23 高频虚词/时间词/知觉行为词）
  static final Set<String> _cjkStopwords = {
    // 项目原有 — 角色陪伴场景高频词
    '用户', '喜欢', '觉得', '一起', '我们', '这个', '那个', '自己', '对话', '记忆',
    // 通用虚词 / 代词 / 时间词 / 知觉行为词（主项目 memory-engine.ts:13-23）
    '的', '了', '是', '就', '都', '也', '你', '我', '他', '她', '它', '这', '那',
    '有', '在', '不', '没', '很', '太', '要', '会', '能', '和', '与', '或', '但',
    '而', '则', '因', '所以', '因为', '但是', '如果', '虽然', '不过', '就是',
    '还是', '已经', '正在', '将要', '刚刚', '曾经', '今天', '明天', '昨天', '现在',
    '认为', '知道', '想要', '需要', '应该', '可能',
  };

  /// 检索相关记忆（基于 TF-IDF 余弦近似评分）
  Future<List<Memory>> retrieveRelevantMemories({
    required String queryText,
    required String characterId,
    int maxMemories = 30,
  }) async {
    // SQL 过滤 status='active'，按 pinned/importance/updatedAt 排序，限 500 条
    // 多个 where 链 Drift 自动以 AND 组合（Expression<bool> 未重载 & 操作符）
    final allMemories = await (_db.select(_db.memories)
          ..where((m) => m.characterId.equals(characterId))
          ..where((m) => m.status.equals('active'))
          ..orderBy([
            (m) => OrderingTerm(expression: m.pinned, mode: OrderingMode.desc),
            (m) => OrderingTerm(expression: m.importance, mode: OrderingMode.desc),
            (m) => OrderingTerm(expression: m.updatedAt, mode: OrderingMode.desc),
          ])
          ..limit(500))
        .get();

    if (allMemories.length <= maxMemories) return allMemories;

    final queryTokens = _tokenize(queryText);
    if (queryTokens.isEmpty) {
      return allMemories.sublist(0, maxMemories);
    }

    // 计算每条记忆与查询的 TF-IDF 余弦近似分数
    final scored = <MapEntry<double, Memory>>[];
    for (final memory in allMemories) {
      final memoryTokens = _tokenize(memory.content);
      // 加入标签
      final tags = _parseTags(memory.tags);
      for (final tag in tags) {
        memoryTokens.add(tag.toLowerCase());
      }
      memoryTokens.add(memory.category);

      final score = _tfidfScore(memoryTokens, queryTokens);
      if (score > 0) scored.add(MapEntry(score, memory));
    }

    if (scored.isEmpty) {
      return allMemories.sublist(0, maxMemories);
    }

    // 主排序为评分；评分相同时以 pinned/importance/updatedAt 作 tie-breaker，
    // 确保「短而精确」的记忆不被挤出，且 pinned 优先于 importance
    scored.sort((a, b) {
      final cmp = b.key.compareTo(a.key);
      if (cmp != 0) return cmp;
      if (a.value.pinned != b.value.pinned) return a.value.pinned ? -1 : 1;
      final impCmp = b.value.importance.compareTo(a.value.importance);
      if (impCmp != 0) return impCmp;
      return b.value.updatedAt.compareTo(a.value.updatedAt);
    });
    return scored.take(maxMemories).map((e) => e.value).toList();
  }

  /// TF-IDF 余弦近似评分：intersection / sqrt((|mem|+1) * (|query|+1))
  /// 短而精确的记忆（token 少但命中率高）评分高于冗长记忆，避免被挤出
  double _tfidfScore(Set<String> memoryTokens, Set<String> queryTokens) {
    final intersection = memoryTokens.intersection(queryTokens);
    return intersection.length /
        math.sqrt((memoryTokens.length + 1) * (queryTokens.length + 1));
  }

  /// 分词（CJK bigram + 英文单词）
  Set<String> _tokenize(String text) {
    final tokens = <String>{};

    // 英文单词
    for (final match in RegExp(r'[A-Za-z0-9]{2,}').allMatches(text)) {
      tokens.add(match.group(0)!.toLowerCase());
    }

    // CJK bigram（中文直写，与 AGENTS.md「编码防护」原则一致；受 RC-10
    // 扫描契约约束，禁止使用 \uXXXX 转义。一 = U+4E00，鿿 = U+9FFF。）
    final cjk = text.replaceAll(RegExp('[^一-鿿]'), '');
    for (int i = 0; i < cjk.length - 1; i++) {
      final bigram = cjk.substring(i, i + 2);
      if (!_cjkStopwords.contains(bigram)) {
        tokens.add(bigram);
      }
    }

    return tokens;
  }

  /// 解析 tags JSON 字符串
  List<String> _parseTags(String tagsJson) {
    try {
      final list = jsonDecode(tagsJson) as List;
      return list.cast<String>();
    } catch (_) {
      return [];
    }
  }

  /// 内容相似度（bigram Jaccard）— 公开方法供提取服务使用
  double contentSimilarity(String a, String b) {
    final left = a.replaceAll(RegExp(r'\s+'), '').toLowerCase();
    final right = b.replaceAll(RegExp(r'\s+'), '').toLowerCase();
    if (left.isEmpty || right.isEmpty) return 0;

    final bigramsA = <String>{};
    final bigramsB = <String>{};
    for (int i = 0; i < left.length - 1; i++) {
      bigramsA.add(left.substring(i, i + 2));
    }
    for (int i = 0; i < right.length - 1; i++) {
      bigramsB.add(right.substring(i, i + 2));
    }

    final intersection = bigramsA.intersection(bigramsB).length;
    final union = bigramsA.union(bigramsB).length;
    return union == 0 ? 0 : intersection / union;
  }

  /// containment 相似度：候选记忆 tokens 在现有记忆 tokens 中的覆盖比例
  /// 对齐主项目 memory-engine.ts:198-213 的 containment 思想
  double supersedeTextSimilarity(
      Set<String> candidateTokens, Set<String> existingTokens) {
    if (candidateTokens.isEmpty) return 0.0;
    final overlap = candidateTokens.intersection(existingTokens);
    return overlap.length / candidateTokens.length;
  }

  /// 查找与新候选记忆最相似的活跃记忆（用于 supersede 目标定位）
  /// 返回相似度最高的活跃记忆；若最高分 < [threshold] 则返回 null。
  /// 阈值判定使用 `>=`，对齐主项目 memory-engine.ts:303-316 的 `>=` 语义
  Future<Memory?> findSimilarExistingMemories(
    String characterId,
    String candidateContent, {
    double threshold = 0.6,
  }) async {
    // 取该角色所有 status='active' 的记忆（多个 where 链 Drift 自动以 AND 组合）
    final existing = await (_db.select(_db.memories)
          ..where((m) => m.characterId.equals(characterId))
          ..where((m) => m.status.equals('active')))
        .get();

    final candidateTokens = _tokenize(candidateContent);
    if (candidateTokens.isEmpty) return null;

    // 选取相似度最高的活跃记忆；同分时保留先出现者（稳定，对齐主项目 `>` 比较）
    Memory? best;
    double bestScore = 0.0;
    for (final memory in existing) {
      final existingTokens = _tokenize(memory.content);
      final score = supersedeTextSimilarity(candidateTokens, existingTokens);
      if (score > bestScore) {
        bestScore = score;
        best = memory;
      }
    }

    // 阈值判定（>= 对齐主项目语义：等于阈值亦视为命中）
    if (best == null || bestScore < threshold) return null;
    return best;
  }

  /// 失效源自某消息的活跃记忆（spec Task 10）
  ///
  /// 对齐主项目 src/lib/memory-source-tracking.ts:invalidateMemoriesForSourceMessage。
  /// 当消息被编辑 / 删除 / 重新生成时，把所有 source_msg_ids 数组包含 [messageId]
  /// 的 active 记忆标 status='superseded'，并在 metadata 写入：
  ///   {previousStatus, sourceInvalidation: {messageId, reason, at: <毫秒时间戳>}}
  ///
  /// 说明：
  /// - source_msg_ids 是 Memories 表的**独立列**（Drift 字段 sourceMsgIds，JSON 数组
  ///   字符串），不是 metadata 字段；与主项目表结构一致。
  /// - metadata 是 JSON 字符串，无法用 SQL 直接过滤 source_msg_ids 数组，需先 SQL
  ///   过滤 status='active'，再在 Dart 层逐条解析 source_msg_ids 判定包含关系。
  /// - 跨角色按 messageId 全表扫（对齐主项目语义）。
  /// - 主项目原版字段名为 invalidatedAt（ISO 字符串），此处按 spec Task 10 用 at +
  ///   毫秒级时间戳整数（对齐项目其他时间戳约定）。
  /// - 多条命中在单个 transaction 内原子更新，对齐主项目 db.transaction 语义。
  ///
  /// 返回失效记忆条数。
  Future<int> invalidateMemoriesForSourceMessage(
    String messageId, {
    required String reason,
  }) async {
    // 1. SQL 过滤 status='active'（跨角色，对齐主项目语义）
    final activeMemories = await (_db.select(_db.memories)
          ..where((m) => m.status.equals('active')))
        .get();

    // 2. Dart 层逐条解析 source_msg_ids，看是否含 messageId
    //    （JSON 数组字符串无法用 SQL 直接过滤）
    final hitMemories = <Memory>[];
    for (final memory in activeMemories) {
      final sourceIds = _parseSourceMsgIds(memory.sourceMsgIds);
      if (sourceIds.contains(messageId)) {
        hitMemories.add(memory);
      }
    }

    if (hitMemories.isEmpty) return 0;

    // 3. 命中的记忆：UPDATE status='superseded' + metadata.sourceInvalidation
    //    4. 单个 transaction 内原子更新，对齐主项目 db.transaction 语义
    final now = DateTime.now();
    final nowMs = now.millisecondsSinceEpoch;
    await _db.transaction(() async {
      for (final memory in hitMemories) {
        final metadata = _parseMetadata(memory.metadata);
        metadata['previousStatus'] = memory.status;
        metadata['sourceInvalidation'] = {
          'messageId': messageId,
          'reason': reason,
          'at': nowMs,
        };
        await (_db.update(_db.memories)
              ..where((m) => m.id.equals(memory.id)))
            .write(MemoriesCompanion(
          status: const Value('superseded'),
          metadata: Value(_encodeMetadata(metadata)),
          updatedAt: Value(now),
        ));
      }
    });

    return hitMemories.length;
  }

  /// 解析 source_msg_ids JSON 数组字符串为 `List<String>`
  /// 对齐主项目 memory-source-tracking.ts:parseSourceMessageIds
  List<String> _parseSourceMsgIds(String sourceMsgIdsJson) {
    try {
      final list = jsonDecode(sourceMsgIdsJson);
      if (list is List) {
        return list.whereType<String>().toList();
      }
    } catch (_) {
      // 解析失败按空数组处理，对齐主项目 parseSourceMessageIds 的 catch 兜底
    }
    return [];
  }

  /// 解析 metadata JSON 字符串为 Map（对齐 memory_extraction_service._readMetadata）
  Map<String, dynamic> _parseMetadata(String? metadataJson) {
    if (metadataJson == null || metadataJson.isEmpty) return {};
    try {
      final decoded = jsonDecode(metadataJson);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {
      // 解析失败返回空 Map，避免破坏后续写入
    }
    return {};
  }

  /// 序列化 Map 为 metadata JSON 字符串
  String _encodeMetadata(Map<String, dynamic> map) => jsonEncode(map);

  /// 校准原始记忆条目：检测承诺信号词并自动调整 category / memory_kind /
  /// importance / emotional_weight
  /// 对齐主项目 src/lib/memory-engine.ts:383-418 的 hasCharacterPromiseSignal +
  /// calibrateRawMemoryItem
  ///
  /// [raw] 是从 LLM 响应解析出的单条记忆 Map，含 content / memory_kind / category /
  /// importance / emotional_weight 等字段。返回校准后的 Map（不修改原 Map，返回新 Map）。
  ///
  /// 校准规则：
  /// - 命中承诺信号词（我会记得/我会记住/我答应/我承诺/以后我会/以后会/不会忘）
  ///   且 memory_kind 为 user_fact / user_preference 时，升级为 character_promise，
  ///   category 改为「关系动态」
  /// - character_promise：importance≥0.8, emotional_weight≥0.7
  /// - relationship_event / 重要事件 / 关系动态：emotional_weight≥0.6
  /// - 话题历史 / general：importance≤0.6
  /// - importance / emotional_weight 经 [0,1] 兜底（对齐主项目 toBoundedNumber）
  Map<String, dynamic> calibrateRawMemoryItem(Map<String, dynamic> raw) {
    final content = raw['content'] as String? ?? '';
    var category = raw['category'] as String? ?? '话题历史';
    var memoryKind = raw['memory_kind'] as String? ?? 'general';
    var importance = _toBoundedNumber(raw['importance'], 0.5);
    var emotionalWeight = _toBoundedNumber(raw['emotional_weight'], 0);

    // 承诺信号词检测（对齐主项目 memory-engine.ts:383-385）
    // 仅当 memory_kind 为 user_fact / user_preference 时才升级为 character_promise
    final promisePattern = RegExp(r'我会记得|我会记住|我答应|我承诺|以后我会|以后会|不会忘');
    if (promisePattern.hasMatch(content) &&
        (memoryKind == 'user_fact' || memoryKind == 'user_preference')) {
      category = '关系动态';
      memoryKind = 'character_promise';
    }

    // 分支校准（对齐主项目 memory-engine.ts:401-409）
    if (memoryKind == 'character_promise') {
      category = '关系动态';
      importance = math.max(importance, 0.8);
      emotionalWeight = math.max(emotionalWeight, 0.7);
    } else if (memoryKind == 'relationship_event' ||
        category == '重要事件' ||
        category == '关系动态') {
      emotionalWeight = math.max(emotionalWeight, 0.6);
    } else if (category == '话题历史' || memoryKind == 'general') {
      importance = math.min(importance, 0.6);
    }

    // 返回新 Map（不修改原 Map），importance / emotional_weight 经 [0,1] 兜底
    return {
      ...raw,
      'category': category,
      'memory_kind': memoryKind,
      'importance': _toBoundedNumber(importance, 0.5),
      'emotional_weight': _toBoundedNumber(emotionalWeight, 0),
    };
  }

  /// 将任意值转为 [0,1] 范围的 double，非有限值返回 [fallback]
  /// 对齐主项目 src/lib/memory-engine.ts:90-94 的 toBoundedNumber
  double _toBoundedNumber(Object? value, double fallback) {
    double? numValue;
    if (value is num) {
      numValue = value.toDouble();
    } else if (value is String) {
      numValue = double.tryParse(value);
    }
    if (numValue == null || !numValue.isFinite) return fallback;
    return numValue.clamp(0.0, 1.0).toDouble();
  }

  /// 从原始 LLM 响应中提取平衡的花括号 JSON 片段
  /// 对齐主项目 src/lib/memory-engine.ts:459-491 的 findBalancedJsonSnippet
  ///
  /// 主项目接受 startIdx 单候选参数；此处综合主项目 493-539 parseExtractionResponse
  /// 的多候选选择逻辑，扫描所有 `{` 起点配对 `}`，收集所有完整 JSON 候选块，
  /// 优先返回含 `"memories"` 字段的块；若无则返回第一个完整块；若无候选返回 null。
  ///
  /// 扫描考虑字符串字面量与反斜杠转义，避免越过字符串内的花括号（对齐主项目 459-491）。
  static String? findBalancedJsonSnippet(String raw) {
    final candidates = <String>[];
    var depth = 0;
    var start = -1;
    var inString = false;
    var escape = false;

    for (var i = 0; i < raw.length; i++) {
      final ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch == '\\') {
        escape = true;
        continue;
      }
      if (ch == '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch == '{') {
        if (depth == 0) start = i;
        depth++;
      } else if (ch == '}') {
        if (depth > 0) {
          depth--;
          if (depth == 0 && start >= 0) {
            candidates.add(raw.substring(start, i + 1));
            start = -1;
          }
        }
      }
    }

    if (candidates.isEmpty) return null;
    // 优先返回含 memories 字段的块（对齐主项目 parseExtractionResponse 候选优先级）
    for (final c in candidates) {
      if (c.contains('"memories"')) return c;
    }
    return candidates.first;
  }
}
