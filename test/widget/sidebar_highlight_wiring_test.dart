// Feature: flutter-platform-polish, Task 8.4: Sidebar 接线例测
// **Validates: Requirements 2.10**
//
// 验证 Sidebar 已经把搜索结果 snippet 的渲染从原来的纯文本 TextSpan 切换为
// 共享 [HighlightedText] widget，并且 widget 的 `query` 参数与已 debounce 的
// `_lastQuery` 完全一致（即「调用方真的把已稳定的搜索关键字透传给了
// HighlightedText」）。
//
// 设计要点（与 8.3 GlobalSearch 接线测试相似）：
//   - 用 `_FakeSearchActions` 覆盖 `searchActionsProvider`，让
//     `searchMessages` 直接返回固定的 SearchResult 列表，避免依赖真实数据库；
//   - 用一个空的内存 Drift 数据库覆盖 `databaseProvider`，让 Sidebar 内部的
//     `SidebarCharacterList` 拿到一个空角色列表，进入「还没有角色」空态，
//     不影响搜索浮层的渲染；
//   - 在 Sidebar 的搜索框内输入 'keyword'，跨过 250ms debounce 后触发渲染；
//   - 断言 `find.byType(HighlightedText)` 至少匹配一个；
//   - 取出第一个 HighlightedText 实例，断言其 `query` 字段等于 `_lastQuery`，
//     而 `_lastQuery` 在 debounce 后被赋值为搜索框当前文本，因此与
//     `'keyword'` 一致。
//
// 不验证 navigation / selection 行为：本任务只关心 HighlightedText 接线。

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/search_provider.dart';
import 'package:lumimuse/features/home/widgets/sidebar.dart';
import 'package:lumimuse/features/search/widgets/highlighted_text.dart';

/// 假的 SearchActions：直接返回构造时给定的固定结果，不走数据库。
///
/// `SearchActions` 是个具体类（持有 private `_db: AppDatabase`），但 Dart 中
/// `implements`/`Fake` 仅要求实现公开 API，所以可以借助 `Fake` 跳过 private
/// 成员，仅复写我们需要的 [searchMessages]。
class _FakeSearchActions extends Fake implements SearchActions {
  final List<SearchResult> results;
  _FakeSearchActions(this.results);

  @override
  Future<SearchPageResult> searchMessages(
    String query, {
    int limit = 30,
    int offset = 0,
  }) async {
    // 一律返回构造时塞进来的固定结果，hasMore 设为 false 让 UI 不再走加载
    // 更多分支。
    return SearchPageResult(results: results, hasMore: false);
  }
}

/// 创建用于测试的内存数据库 — 与同目录其它测试保持一致，避免多实例 warning。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 构造若干 SearchResult，snippet 都包含关键字 'keyword'，方便
/// HighlightedText 计算出至少一段高亮区间（不过本测试只关心 widget 实例本身
/// 是否存在 + query 是否对齐，不强行断言区间内容）。
List<SearchResult> _fakeResults() {
  final now = DateTime(2026, 5, 14, 12, 30);
  return [
    SearchResult(
      messageId: 'm1',
      conversationId: 'c1',
      characterId: 'ch1',
      characterName: '小猫',
      conversationTitle: '测试对话 A',
      role: 'user',
      snippet: '主人，你说的 keyword 是什么意思呀',
      createdAt: now,
    ),
    SearchResult(
      messageId: 'm2',
      conversationId: 'c1',
      characterId: 'ch1',
      characterName: '小猫',
      conversationTitle: '测试对话 A',
      role: 'assistant',
      snippet: 'keyword 是关键字喵～',
      createdAt: now,
    ),
  ];
}

void main() {
  group('Widget · Sidebar HighlightedText 接线', () {
    testWidgets(
      '触发 debounce 后渲染 HighlightedText，且其 query 等于已 debounce 的 _lastQuery',
      (tester) async {
        // 1. 准备假数据 + 内存数据库（角色列表为空，进入空态）
        final fake = _FakeSearchActions(_fakeResults());
        final db = _createTestDb();
        addTearDown(() => db.close());

        // Sidebar 宽度固定 336px；保证测试视图足够宽，避免横向溢出干扰
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              databaseProvider.overrideWithValue(db),
              searchActionsProvider.overrideWithValue(fake),
              // 把 `characterListProvider` 替换成一次性值流，避免 Drift
              // StreamQueryStore 的清理 Timer 在 widget 测试 fakeAsync 区域里
              // 悬挂导致 pending timers 报错（与同目录其它 widget 测试一致的
              // 处理方式）。
              characterListProvider.overrideWith((ref) async* {
                yield <Character>[];
              }),
            ],
            child: const MaterialApp(
              home: Scaffold(
                body: SizedBox(
                  width: 336,
                  height: 800,
                  child: Sidebar(),
                ),
              ),
            ),
          ),
        );
        // 等首屏初始化完成（StreamProvider 首帧、布局等）
        await tester.pumpAndSettle();

        // 初始状态：尚未输入 query，浮层未显示，不应有 HighlightedText
        expect(find.byType(HighlightedText), findsNothing);

        // 2. 在搜索框内输入 'keyword'
        //    `enterText` 会自动 focus 该 TextField，从而把
        //    `_searchFocused` 切到 true（与真实交互一致）。
        const kQuery = 'keyword';
        final searchField = find.byType(TextField);
        expect(searchField, findsOneWidget,
            reason: 'Sidebar 顶部应只有一个搜索 TextField');
        await tester.enterText(searchField, kQuery);

        // 3. 跨过 Sidebar 内部的 250ms debounce
        //    pump 300ms 让 Timer 触发 `_runSearch`。
        await tester.pump(const Duration(milliseconds: 300));
        // 让 await searchMessages 的微任务完成 + setState 渲染浮层
        await tester.pumpAndSettle();

        // 4. 断言至少出现一个 HighlightedText 实例
        final highlightFinder = find.byType(HighlightedText);
        expect(
          highlightFinder,
          findsAtLeastNWidgets(1),
          reason: 'Sidebar 应把每条搜索结果的 snippet 渲染为 HighlightedText',
        );

        // 5. 取第一个 HighlightedText 实例，断言其 query 字段等于
        //    搜索框当前文本（debounce 已结束，_lastQuery == 'keyword'）
        final firstWidget =
            tester.widget<HighlightedText>(highlightFinder.first);
        expect(
          firstWidget.query,
          equals(kQuery),
          reason: 'Sidebar 应把已 debounce 的 _lastQuery 透传给 HighlightedText',
        );

        // 进一步：所有 HighlightedText 的 query 都应该等于当前 _lastQuery
        // （列表里每张结果卡都用同一份 _lastQuery）
        final allHighlights =
            tester.widgetList<HighlightedText>(highlightFinder).toList();
        for (final w in allHighlights) {
          expect(w.query, equals(kQuery));
        }
      },
    );
  });
}
