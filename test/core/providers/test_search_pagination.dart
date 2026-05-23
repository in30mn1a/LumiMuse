// 搜索分页属性测试
// Feature: flutter-data-management, Task 8.8
// Property 7: 搜索分页 offset 正确性
// Property 8: hasMore 边界
// **Validates: Requirements 4.1, 4.2**

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/search_provider.dart';

/// 创建内存数据库用于测试
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 向测试数据库插入指定数量的消息
Future<void> _insertTestMessages(
  AppDatabase db, {
  required int count,
  required String keyword,
}) async {
  // 先创建角色
  await db.customInsert(
    "INSERT INTO characters (id, name) VALUES (?, ?)",
    variables: [
      Variable.withString('char_1'),
      Variable.withString('测试角色'),
    ],
  );

  // 创建对话
  await db.customInsert(
    "INSERT INTO conversations (id, character_id, title) VALUES (?, ?, ?)",
    variables: [
      Variable.withString('conv_1'),
      Variable.withString('char_1'),
      Variable.withString('测试对话'),
    ],
  );

  // 插入消息 — 每条消息包含关键词，created_at 递增
  for (int i = 0; i < count; i++) {
    final epoch = 1700000000 + i; // 递增时间戳（秒）
    await db.customInsert(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      variables: [
        Variable.withString('msg_$i'),
        Variable.withString('conv_1'),
        Variable.withString('user'),
        Variable.withString('消息 $i 包含 $keyword 关键词'),
        Variable.withInt(epoch),
      ],
    );
  }
}

void main() {
  group('Property 7: 搜索分页 offset 正确性', () {
    // 对于任何 results count > limit 的搜索，
    // offset=0 返回前 limit 条且 hasMore=true，
    // offset=limit 返回下一批，所有页的并集等于完整结果集（无重复无遗漏）
    Glados2<int, int>(
      any.intInRange(5, 15), // limit: 5~15
      any.intInRange(2, 4), // 页数: 2~4
    ).test(
      'offset=0 返回前 limit 条且 hasMore=true，后续页正确追加',
      (limit, pages) async {
        final totalCount = limit * pages + 3; // 确保总数 > limit
        final db = _createTestDb();
        addTearDown(() => db.close());

        await _insertTestMessages(db, count: totalCount, keyword: '搜索词');
        final searchActions = SearchActions(db);

        // 收集所有页的结果
        final allResults = <SearchResult>[];
        final allIds = <String>{};

        for (int page = 0; page < pages + 1; page++) {
          final offset = page * limit;
          final pageResult = await searchActions.searchMessages(
            '搜索词',
            limit: limit,
            offset: offset,
          );

          if (page == 0) {
            // 第一页：hasMore 应为 true（因为总数 > limit）
            expect(pageResult.hasMore, isTrue,
                reason: '总数 $totalCount > limit $limit，第一页 hasMore 应为 true');
            expect(pageResult.results.length, equals(limit),
                reason: '第一页应返回 limit=$limit 条');
          }

          allResults.addAll(pageResult.results);
          for (final r in pageResult.results) {
            allIds.add(r.messageId);
          }

          // 如果没有更多了，停止翻页
          if (!pageResult.hasMore) break;
        }

        // 验证无重复
        expect(allIds.length, equals(allResults.length),
            reason: '所有页的结果不应有重复 ID');

        // 验证覆盖完整（所有结果数 == 总数）
        expect(allResults.length, equals(totalCount),
            reason: '所有页的并集应等于完整结果集');
      },
    );

    test('offset=limit 返回第二批结果，与第一批无重叠', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const limit = 10;
      const totalCount = 25;
      await _insertTestMessages(db, count: totalCount, keyword: '测试');
      final searchActions = SearchActions(db);

      final page1 = await searchActions.searchMessages('测试', limit: limit, offset: 0);
      final page2 = await searchActions.searchMessages('测试', limit: limit, offset: limit);

      // 第一页和第二页的 ID 不应重叠
      final page1Ids = page1.results.map((r) => r.messageId).toSet();
      final page2Ids = page2.results.map((r) => r.messageId).toSet();
      expect(page1Ids.intersection(page2Ids), isEmpty,
          reason: '第一页和第二页不应有重叠的消息 ID');

      // 第一页应有 limit 条
      expect(page1.results.length, equals(limit));
      expect(page1.hasMore, isTrue);

      // 第二页也应有 limit 条（因为总数 25 > 20）
      expect(page2.results.length, equals(limit));
      expect(page2.hasMore, isTrue);
    });
  });

  group('Property 8: hasMore 边界', () {
    // hasMore 为 true 当且仅当 total results > offset + limit
    // 当返回结果数 < limit 时，hasMore 必为 false
    Glados2<int, int>(
      any.intInRange(3, 20), // limit
      any.intInRange(0, 50), // totalCount
    ).test(
      'hasMore 为 true 当且仅当 total > offset + limit',
      (limit, totalCount) async {
        final db = _createTestDb();
        addTearDown(() => db.close());

        await _insertTestMessages(db, count: totalCount, keyword: '关键词');
        final searchActions = SearchActions(db);

        final pageResult = await searchActions.searchMessages(
          '关键词',
          limit: limit,
          offset: 0,
        );

        if (totalCount > limit) {
          // 总数超过 limit，hasMore 应为 true
          expect(pageResult.hasMore, isTrue,
              reason: '总数 $totalCount > limit $limit，hasMore 应为 true');
          expect(pageResult.results.length, equals(limit),
              reason: '应返回恰好 limit=$limit 条');
        } else {
          // 总数 <= limit，hasMore 应为 false
          expect(pageResult.hasMore, isFalse,
              reason: '总数 $totalCount <= limit $limit，hasMore 应为 false');
          expect(pageResult.results.length, equals(totalCount),
              reason: '应返回全部 $totalCount 条');
        }
      },
    );

    Glados<int>(any.intInRange(5, 20)).test(
      '返回结果数 < limit 时 hasMore 必为 false',
      (limit) async {
        final db = _createTestDb();
        addTearDown(() => db.close());

        // 插入比 limit 少的消息
        final count = limit - 2;
        if (count <= 0) return; // 跳过无效情况
        await _insertTestMessages(db, count: count, keyword: '少量');
        final searchActions = SearchActions(db);

        final pageResult = await searchActions.searchMessages(
          '少量',
          limit: limit,
          offset: 0,
        );

        expect(pageResult.results.length, lessThan(limit));
        expect(pageResult.hasMore, isFalse,
            reason: '返回 ${pageResult.results.length} 条 < limit $limit，hasMore 必为 false');
      },
    );

    test('空查询返回空结果且 hasMore=false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      final searchActions = SearchActions(db);
      final pageResult = await searchActions.searchMessages('', limit: 30);

      expect(pageResult.results, isEmpty);
      expect(pageResult.hasMore, isFalse);
    });

    test('无匹配结果时 hasMore=false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      await _insertTestMessages(db, count: 50, keyword: '存在的词');
      final searchActions = SearchActions(db);

      final pageResult = await searchActions.searchMessages(
        '不存在的关键词xyz',
        limit: 30,
        offset: 0,
      );

      expect(pageResult.results, isEmpty);
      expect(pageResult.hasMore, isFalse);
    });

    test('恰好 limit 条结果时 hasMore=false', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const limit = 10;
      await _insertTestMessages(db, count: limit, keyword: '恰好');
      final searchActions = SearchActions(db);

      final pageResult = await searchActions.searchMessages(
        '恰好',
        limit: limit,
        offset: 0,
      );

      expect(pageResult.results.length, equals(limit));
      expect(pageResult.hasMore, isFalse,
          reason: '恰好 $limit 条结果，没有更多了');
    });

    test('limit+1 条结果时 hasMore=true', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const limit = 10;
      await _insertTestMessages(db, count: limit + 1, keyword: '多一条');
      final searchActions = SearchActions(db);

      final pageResult = await searchActions.searchMessages(
        '多一条',
        limit: limit,
        offset: 0,
      );

      expect(pageResult.results.length, equals(limit));
      expect(pageResult.hasMore, isTrue,
          reason: '${limit + 1} 条结果 > limit $limit，hasMore 应为 true');
    });
  });
}
