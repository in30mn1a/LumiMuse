import 'dart:convert';
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

  /// CJK 停用词
  static final Set<String> _cjkStopwords = {
    '用户', '喜欢', '觉得', '一起', '我们', '这个', '那个', '自己', '对话', '记忆',
  };

  /// 检索相关记忆（基于 token 匹配）
  Future<List<Memory>> retrieveRelevantMemories({
    required String queryText,
    required String characterId,
    int maxMemories = 30,
  }) async {
    final allMemories = await (_db.select(_db.memories)
          ..where((m) => m.characterId.equals(characterId)))
        .get();

    if (allMemories.length <= maxMemories) return allMemories;

    final queryTokens = _tokenize(queryText);
    if (queryTokens.isEmpty) {
      return allMemories.sublist(allMemories.length - maxMemories);
    }

    // 计算每条记忆与查询的相关性分数
    final scored = <MapEntry<double, Memory>>[];
    for (final memory in allMemories) {
      final memoryTokens = _tokenize(memory.content);
      // 加入标签
      final tags = _parseTags(memory.tags);
      for (final tag in tags) {
        memoryTokens.add(tag.toLowerCase());
      }
      memoryTokens.add(memory.category);

      final score = queryTokens.where((t) => memoryTokens.contains(t)).length.toDouble();
      if (score > 0) scored.add(MapEntry(score, memory));
    }

    if (scored.isEmpty) {
      return allMemories.sublist(allMemories.length - maxMemories);
    }

    scored.sort((a, b) => b.key.compareTo(a.key));
    return scored.take(maxMemories).map((e) => e.value).toList();
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
}
