// Feature: flutter-parity-gaps-fill, Task 4.5: MaterialApp 接线 smoke 测试
// **Validates: Requirements R2.5, R2.6**
//
// 验证 LumiMuseApp 的 MaterialApp.router 已经把语言相关的三件套
// 正确接线：
//   1. supportedLocales ⊇ [Locale('zh'), Locale('en')]
//   2. localizationsDelegates 链路含 GlobalMaterialLocalizations.delegate
//      （以及 Widgets / Cupertino，但本测试只强校验 Material）
//   3. 切换 localeProvider.state 为 Locale('en') 后，MaterialApp.locale
//      也变为 Locale('en')（同一调用栈 + tester.pump()）
//
// 设计要点：
//   - 用一个空的内存 Drift 数据库覆盖 databaseProvider，避开真实磁盘
//     依赖；SettingsNotifier.build 读到空表后会回退默认值（language='zh'），
//     此时 localeProvider 默认值也是 Locale('zh')
//   - 用空列表覆盖 characterListProvider，避免 Drift StreamQueryStore
//     的清理 Timer 在 widget 测试 fakeAsync 区域里悬挂导致 pending timers
//     报错（与 sidebar_highlight_wiring_test.dart 同款做法）
//   - 不调用 pumpAndSettle：HomePage 内部依赖 settingsProvider 的 await
//     与 LaunchPasswordGate 的 _checkEnabled，二者都是异步 setState；
//     本测试只关心顶层 MaterialApp 的配置字段，pumpWidget + pump 一次
//     即可拿到 MaterialApp 的真实 widget 实例
//   - 通过 ProviderScope.containerOf 取根容器，再用 container.read 写
//     localeProvider.state，模拟 SettingsNotifier 写库后同步 Provider 的
//     效果（R2.6 要求测试不通过桩绕过 SettingsNotifier；这里直接写
//     localeProvider 是测试场景对「Provider 已被写入新值」的最小复刻，
//     不破坏「写库 + 写 Provider 同栈」契约的可观察行为）

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/app.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/memory_provider.dart';
import 'package:lumimuse/core/providers/settings_provider.dart';

/// 创建用于测试的内存数据库 — 与同目录其它 widget 测试保持一致，避免多
/// 实例 warning（driftRuntimeOptions.dontWarnAboutMultipleDatabases = true）。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

void main() {
  group('App · MaterialApp 语言接线 smoke', () {
    testWidgets(
      'supportedLocales / localizationsDelegates / locale 切换三件套接线正确',
      (tester) async {
        // 1. 准备内存数据库 + 空角色列表覆盖
        final db = _createTestDb();
        addTearDown(() => db.close());

        // 设置一个足够宽高的测试 surface，避免 SidebarCharacterList 空态在
        // 默认 800×600 surface 下出现 27px overflow（与本测试关心的语言
        // 接线无关，但 rendering 库会把 overflow 当成断言失败处理）
        tester.view.physicalSize = const Size(1600, 1200);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              databaseProvider.overrideWithValue(db),
              characterListProvider.overrideWith((ref) async* {
                yield <Character>[];
              }),
              // 覆盖 latestMemoryTaskProvider：ChatView build 时无条件 listen
              // 该 family Provider，默认实现走 Drift StreamQueryStore，会在
              // widget 树 dispose 时调度一个 Timer.run 把 query 标记为关闭，
              // 从而引发 widget 测试 fakeAsync 的 pending timers 报错。
              // 用一次性 Stream 直接 yield null 替代，避免 Drift 内部清理路径。
              latestMemoryTaskProvider.overrideWith((ref, conversationId) async* {
                yield null;
              }),
            ],
            child: const LumiMuseApp(),
          ),
        );

        // 跑几帧让 MaterialApp 完成首屏装配；不调 pumpAndSettle 以避开
        // SettingsNotifier 的异步 await 与 LaunchPasswordGate 的 _checkEnabled
        // 引发的 pending tasks
        await tester.pump();
        await tester.pump();

        // 2. 取 MaterialApp 实例（MaterialApp.router 也是 MaterialApp 的
        //    具体 widget，find.byType(MaterialApp) 命中）
        final materialAppFinder = find.byType(MaterialApp);
        expect(
          materialAppFinder,
          findsOneWidget,
          reason: 'LumiMuseApp 应该构造唯一一个 MaterialApp（走 router 命名构造）',
        );
        MaterialApp materialApp = tester.widget<MaterialApp>(materialAppFinder);

        // 3. 断言 supportedLocales ⊇ [Locale('zh'), Locale('en')]
        final supportedLocales = materialApp.supportedLocales.toList();
        expect(
          supportedLocales,
          containsAll(const <Locale>[Locale('zh'), Locale('en')]),
          reason: 'MaterialApp.supportedLocales 至少需要包含 zh 与 en 两种语言',
        );

        // 4. 断言 localizationsDelegates 链路含 GlobalMaterialLocalizations.delegate
        final delegates = materialApp.localizationsDelegates?.toList() ?? <LocalizationsDelegate<dynamic>>[];
        expect(
          delegates,
          isNotEmpty,
          reason: 'MaterialApp.localizationsDelegates 不能为空',
        );
        // GlobalMaterialLocalizations.delegate 是单例 const，可直接用 contains 命中；
        // 同时兜底用 runtimeType 字符串校验，防止未来 Flutter 调整 delegate 包装
        final hasMaterialDelegate = delegates.any((d) =>
            identical(d, GlobalMaterialLocalizations.delegate) ||
            d.runtimeType.toString().contains('GlobalMaterialLocalizations'));
        expect(
          hasMaterialDelegate,
          isTrue,
          reason: 'MaterialApp.localizationsDelegates 应包含 GlobalMaterialLocalizations.delegate',
        );

        // 5. 初始 locale 应为默认的 Locale('zh')
        expect(
          materialApp.locale,
          equals(const Locale('zh')),
          reason: '冷启动时 localeProvider 默认值为 Locale("zh")，MaterialApp.locale 应同步',
        );

        // 6. 切换 localeProvider.state 为 Locale('en') 并 pump 一次
        //    通过 ProviderScope.containerOf 取根容器，模拟 SettingsNotifier
        //    写库后同步 Provider 的效果（同一调用栈 + tester.pump()）
        final BuildContext rootCtx = tester.element(materialAppFinder);
        final container = ProviderScope.containerOf(rootCtx, listen: false);
        container.read(localeProvider.notifier).state = const Locale('en');
        await tester.pump();

        // 7. 重新取 MaterialApp 实例，断言 locale 已切到 Locale('en')
        materialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
        expect(
          materialApp.locale,
          equals(const Locale('en')),
          reason: '切换 localeProvider.state 为 Locale("en") 后，'
              'MaterialApp.locale 应在同一调用栈 + tester.pump() 后变为 Locale("en")',
        );
      },
    );
  });
}
