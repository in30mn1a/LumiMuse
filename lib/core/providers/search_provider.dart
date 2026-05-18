import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../database/database.dart';
import 'database_provider.dart';

/// 搜索结果模型
class SearchResult {
  final String messageId;
  final String conversationId;
  final String characterId;
  final String characterName;
  final String conversationTitle;
  final String role;
  final String snippet;
  final DateTime createdAt;

  const SearchResult({
    required this.messageId,
    required this.conversationId,
    required this.characterId,
    required this.characterName,
    required this.conversationTitle,
    required this.role,
    required this.snippet,
    required this.createdAt,
  });
}

/// 搜索分页结果（含 results 和 hasMore 标志）
class SearchPageResult {
  final List<SearchResult> results;
  final bool hasMore;
  const SearchPageResult({required this.results, required this.hasMore});
}

/// 搜索操作 Provider
final searchActionsProvider = Provider<SearchActions>((ref) {
  return SearchActions(ref.read(databaseProvider));
});

class SearchActions {
  final AppDatabase _db;

  SearchActions(this._db);

  /// 搜索消息 — 支持关键词和日期搜索，返回分页结果
  ///
  /// 通过多查询 1 条记录来判断 hasMore：
  /// 查询 limit+1 条，返回 limit 条，多出 1 条则 hasMore=true
  Future<SearchPageResult> searchMessages(
    String query, {
    int limit = 30,
    int offset = 0,
  }) async {
    if (query.trim().isEmpty) {
      return const SearchPageResult(results: [], hasMore: false);
    }

    // 尝试解析日期
    final dateRange = _parseDateQuery(query);

    if (dateRange != null) {
      return _searchByDate(dateRange.$1, dateRange.$2, limit: limit, offset: offset);
    }

    // 关键词搜索 — 使用 LIKE（CJK 兼容）
    // 查询 limit+1 条用于判断 hasMore
    final keyword = '%${query.trim()}%';

    final results = await _db.customSelect(
      '''
      SELECT m.id as msg_id, m.conversation_id, m.role, m.content, m.created_at,
             c.id as char_id, c.name as char_name, conv.title as conv_title
      FROM messages m
      JOIN conversations conv ON m.conversation_id = conv.id
      JOIN characters c ON conv.character_id = c.id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
      ''',
      variables: [
        Variable.withString(keyword),
        Variable.withInt(limit + 1),
        Variable.withInt(offset),
      ],
      readsFrom: {_db.messages, _db.conversations, _db.characters},
    ).get();

    // 判断是否还有更多：查询到 limit+1 条说明还有下一页
    final hasMore = results.length > limit;
    final actualResults = hasMore ? results.sublist(0, limit) : results;

    return SearchPageResult(
      results: actualResults.map((row) {
        final content = row.read<String>('content');
        return SearchResult(
          messageId: row.read<String>('msg_id'),
          conversationId: row.read<String>('conversation_id'),
          characterId: row.read<String>('char_id'),
          characterName: row.read<String>('char_name'),
          conversationTitle: row.read<String>('conv_title'),
          role: row.read<String>('role'),
          snippet: _buildSnippet(content, query),
          createdAt: DateTime.fromMillisecondsSinceEpoch(
              row.read<int>('created_at') * 1000),
        );
      }).toList(),
      hasMore: hasMore,
    );
  }

  /// 按日期范围搜索 — 返回分页结果
  Future<SearchPageResult> _searchByDate(
    DateTime start,
    DateTime end, {
    int limit = 30,
    int offset = 0,
  }) async {
    final startEpoch = start.millisecondsSinceEpoch ~/ 1000;
    final endEpoch = end.millisecondsSinceEpoch ~/ 1000;

    final results = await _db.customSelect(
      '''
      SELECT m.id as msg_id, m.conversation_id, m.role, m.content, m.created_at,
             c.id as char_id, c.name as char_name, conv.title as conv_title
      FROM messages m
      JOIN conversations conv ON m.conversation_id = conv.id
      JOIN characters c ON conv.character_id = c.id
      WHERE m.created_at >= ? AND m.created_at <= ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
      ''',
      variables: [
        Variable.withInt(startEpoch),
        Variable.withInt(endEpoch),
        Variable.withInt(limit + 1),
        Variable.withInt(offset),
      ],
      readsFrom: {_db.messages, _db.conversations, _db.characters},
    ).get();

    // 判断是否还有更多
    final hasMore = results.length > limit;
    final actualResults = hasMore ? results.sublist(0, limit) : results;

    return SearchPageResult(
      results: actualResults.map((row) {
        final content = row.read<String>('content');
        return SearchResult(
          messageId: row.read<String>('msg_id'),
          conversationId: row.read<String>('conversation_id'),
          characterId: row.read<String>('char_id'),
          characterName: row.read<String>('char_name'),
          conversationTitle: row.read<String>('conv_title'),
          role: row.read<String>('role'),
          snippet: content.length > 80 ? '${content.substring(0, 80)}...' : content,
          createdAt: DateTime.fromMillisecondsSinceEpoch(
              row.read<int>('created_at') * 1000),
        );
      }).toList(),
      hasMore: hasMore,
    );
  }

  /// 构建搜索结果摘要 — 高亮关键词附近的文本
  String _buildSnippet(String content, String query) {
    final idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) {
      return content.length > 80 ? '${content.substring(0, 80)}...' : content;
    }

    final start = (idx - 20).clamp(0, content.length);
    final end = (idx + query.length + 40).clamp(0, content.length);
    final snippet = content.substring(start, end);

    return '${start > 0 ? '...' : ''}$snippet${end < content.length ? '...' : ''}';
  }

  /// 解析日期查询 — 支持多种中文日期格式
  /// 返回 (startOfDay, endOfDay) 或 null
  (DateTime, DateTime)? _parseDateQuery(String query) {
    final trimmed = query.trim();

    // 格式: 2026/3/30 或 2026-3-30 或 2026.3.30
    final slashMatch = RegExp(r'^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$').firstMatch(trimmed);
    if (slashMatch != null) {
      return _buildDateRange(
        int.parse(slashMatch.group(1)!),
        int.parse(slashMatch.group(2)!),
        int.parse(slashMatch.group(3)!),
      );
    }

    // 格式: 3月30日 或 3月30（中文直写，与 AGENTS.md「编码防护」原则一致；
    // 受 RC-10 扫描契约约束，禁止使用 \uXXXX 转义）
    final monthDayMatch = RegExp(r'^(\d{1,2})月(\d{1,2})日?$').firstMatch(trimmed);
    if (monthDayMatch != null) {
      final now = DateTime.now();
      return _buildDateRange(
        now.year,
        int.parse(monthDayMatch.group(1)!),
        int.parse(monthDayMatch.group(2)!),
      );
    }

    // 格式: 2026年3月30日（中文直写，禁止 \uXXXX 转义）
    final fullCnMatch = RegExp(r'^(\d{4})年(\d{1,2})月(\d{1,2})日?$').firstMatch(trimmed);
    if (fullCnMatch != null) {
      return _buildDateRange(
        int.parse(fullCnMatch.group(1)!),
        int.parse(fullCnMatch.group(2)!),
        int.parse(fullCnMatch.group(3)!),
      );
    }

    // 格式: 3/30 或 03-30（月/日，无年份，假设当前年）— 对照主项目
    final shortDateMatch = RegExp(r'^(\d{1,2})[/\-](\d{1,2})$').firstMatch(trimmed);
    if (shortDateMatch != null) {
      final now = DateTime.now();
      return _buildDateRange(
        now.year,
        int.parse(shortDateMatch.group(1)!),
        int.parse(shortDateMatch.group(2)!),
      );
    }

    return null;
  }

  (DateTime, DateTime)? _buildDateRange(int year, int month, int day) {
    try {
      final start = DateTime(year, month, day);
      final end = DateTime(year, month, day, 23, 59, 59);
      return (start, end);
    } catch (_) {
      return null;
    }
  }
}
