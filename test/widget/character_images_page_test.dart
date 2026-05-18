// Feature: flutter-parity-completion, Task 12.8: Widget 测试 — CharacterImagesPage 多选删除流程
//
// **Validates: Requirements 11.7**
//
// 用 `testWidgets` 模拟整个角色图片管理页的多选删除链路：
//
//   1. 默认渲染：网格能加载并显示条目（用 `Icons.broken_image_outlined`
//      占位图标计数 — 由于 metadata 里写的是假路径，缩略图都会落在「图片不可用」
//      占位上，不影响多选与删除流程）。
//   2. 长按某条目进入多选态，顶部出现「已选 N / 总数」横幅；
//      在多选态下再点击其他条目切换选中。
//   3. 点击批量删除按钮 → 弹出确认对话框 → 点击「确认删除」→ 等待 SnackBar
//      文案「已删除 N 个图片版本」，并断言列表刷新后剩余条目数减少。
//
// 测试基础设施：
// - 内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）注入
//   `databaseProvider`，预先种入「角色 + 对话 + 一条 assistant 消息 + 3 个版本的
//   generatedImages」。
// - `characterProvider` 用一次性 StreamProvider 覆盖，避免 Drift StreamQueryStore
//   的清理 Timer 在 fakeAsync 区域里悬挂。
// - 不依赖 path_provider：删除文件路径全是假的，`_safeDeleteFile` 内部对不存在的
//   文件直接返回，不会抛错。

import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/features/characters/character_images_page.dart';

const _charId = 'char-page-test';
const _convId = 'conv-page-test';
const _msgId = 'amsg-page-test';

/// 创建用于测试的内存数据库 — 与同目录其它 PBT 测试保持一致
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 种入：1 角色 + 1 对话 + 1 条 assistant 消息（含一张图、三个版本）
///
/// 三版本展开后会得到 3 个网格条目（最新版本即数组末尾排在前）。
Future<void> _seedDatabase(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('图片管理页测试角色'),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('测试对话'),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: _msgId,
          conversationId: _convId,
          role: 'assistant',
          content: const Value('AI 回复'),
          seq: const Value(1),
          createdAt: Value(DateTime(2026, 1, 1, 10, 0, 0)),
          metadata: Value(jsonEncode({
            'generatedImages': [
              {
                'id': 'img-1',
                // 顶层 url 指向最新版本（与 listImages 行为一致）
                'url': '/fake/v-2.png',
                'prompt': 'p',
                'activeVersion': 2,
                'versions': [
                  {'id': 'v-0', 'url': '/fake/v-0.png', 'prompt': 'p0'},
                  {'id': 'v-1', 'url': '/fake/v-1.png', 'prompt': 'p1'},
                  {'id': 'v-2', 'url': '/fake/v-2.png', 'prompt': 'p2'},
                ],
              }
            ],
          })),
        ),
      );
}

/// 构造挂载了 `CharacterImagesPage` 的测试 App
///
/// 关键覆盖：把 `characterProvider`（基于 Drift `watchSingleOrNull` 的
/// StreamProvider.family）替换成一次性值流，避免 Drift StreamQueryStore
/// 的清理 Timer 在 widget 测试 fakeAsync 区域里悬挂导致 pending timers 报错。
/// listImages / deleteImages 走 `databaseProvider` 直查，不受此覆盖影响。
Widget _buildPageApp(AppDatabase db) {
  return ProviderScope(
    overrides: [
      databaseProvider.overrideWithValue(db),
      characterProvider.overrideWith((ref, id) async* {
        // 测试场景下 subtitle 仅用于头部显示，单值流即可满足
        yield Character(
          id: _charId,
          name: '图片管理页测试角色',
          avatarUrl: null,
          personality: '',
          scenario: '',
          greeting: '',
          exampleDialogue: '',
          systemPrompt: '',
          basicInfo: '',
          otherInfo: '',
          imageTags: '',
          sortOrder: 0,
          createdAt: DateTime(2026, 1, 1),
          updatedAt: DateTime(2026, 1, 1),
        );
      }),
    ],
    child: const MaterialApp(
      home: CharacterImagesPage(characterId: _charId),
    ),
  );
}

/// 计算当前网格中可见的条目数量 — 用「图片不可用」占位图标做代理
///
/// 由于 metadata 中的本地路径都是假的，每个 `_ImageGridTile` 都会落入
/// `_buildBrokenPlaceholder` 分支显示一个 `Icons.broken_image_outlined`，
/// 头部 / 选中横幅 / 对话框中均不使用此图标，因此计数等于网格条目数。
int _countTiles() {
  return find.byIcon(Icons.broken_image_outlined).evaluate().length;
}

void main() {
  group('Widget · CharacterImagesPage 多选删除流程', () {
    testWidgets(
      '渲染网格 → 长按进入多选 → 切换选中 → 批量删除 → SnackBar 与列表刷新',
      (tester) async {
        final db = _createTestDb();
        addTearDown(() => db.close());
        await _seedDatabase(db);

        await tester.pumpWidget(_buildPageApp(db));
        // listImages 是异步的，需要 settle 一次让 _loadImages 完成回填
        await tester.pumpAndSettle();

        // ── 1. 默认渲染：3 个版本各成一条网格条目 ───────────────────
        expect(_countTiles(), 3,
            reason: '初始渲染应包含三个图片版本对应的三个占位条目');
        // 默认态没有多选横幅
        expect(find.textContaining('已选 '), findsNothing,
            reason: '默认态不应出现「已选 N / 总数」横幅');

        // ── 2. 长按第一个条目 → 进入多选并选中该条 ────────────────
        await tester.longPress(find.byIcon(Icons.broken_image_outlined).first);
        await tester.pumpAndSettle();

        expect(find.text('已选 1 / 3'), findsOneWidget,
            reason: '长按后应进入多选态并显示「已选 1 / 3」');

        // ── 3. 多选态下点击第二个条目 → 切换为「已选 2 / 3」 ──────
        await tester.tap(find.byIcon(Icons.broken_image_outlined).at(1));
        await tester.pumpAndSettle();

        expect(find.text('已选 2 / 3'), findsOneWidget,
            reason: '在多选态再点一条应把选中数量切到 2');

        // ── 4. 点击头部「批量删除」按钮 → 弹出确认对话框 ──────────
        await tester.tap(find.byTooltip('批量删除'));
        await tester.pumpAndSettle();

        // 「确认删除」会同时出现在对话框标题与确认按钮文案上，两处都要存在
        expect(find.text('确认删除'), findsNWidgets(2),
            reason: '点击批量删除后应弹出确认对话框，标题与按钮文案都使用「确认删除」');
        expect(find.textContaining('将删除选中的 2 个图片版本'), findsOneWidget,
            reason: '对话框内容应反映待删条数');

        // ── 5. 点击「确认删除」→ 触发 deleteImages ───────────────
        //
        // Drift NativeDatabase.memory() 的事务在 widget 测试默认的 fakeAsync
        // 区域里走不动 — 事务内部用真实 Future / microtask 串联 ffi 调用，
        // FakeAsync 不推进真实事件循环就永远 pending。同时 `_handleBatchDelete`
        // 后续的 `setState` 与 `_loadImages` 也都依赖于这条 Future 链上恢复。
        //
        // 把「tap + 让异步链路完成 + pump 上屏」全部放进 `tester.runAsync`，
        // 让所有 await 与 setState 都在同一个真实 Zone 里发生；在 runAsync
        // 内部交替调用 `Future.delayed` 与 `tester.pump()`：前者借出真实事件
        // 循环让 Drift 事务、引用扫描、setState 推进，后者驱动 widget 重建
        // 把最新状态绘到屏幕上。
        //
        // 注意：不使用 pumpAndSettle，避免推进虚拟时钟把 SnackBar 的自动消失
        // 计时一并结算掉。
        await tester.runAsync(() async {
          await tester.tap(find.text('确认删除').last);
          for (var i = 0; i < 60; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 16));
            await tester.pump();
          }
        });

        // ── 6. SnackBar 文案断言 ────────────────────────────────────
        expect(
          find.text('已删除 2 个图片版本'),
          findsOneWidget,
          reason: '批量删除完成后应显示 SnackBar「已删除 N 个图片版本」',
        );

        // ── 7. _loadImages 刷新完成，断言列表减少到 1 条 ──────────
        expect(_countTiles(), 1,
            reason: '删除两个版本后，剩余条目应为 1');
        // 删除完成后多选态应自动退出
        expect(find.textContaining('已选 '), findsNothing,
            reason: '删除完成后应自动退出多选态，横幅不再展示');
      },
    );
  });
}
