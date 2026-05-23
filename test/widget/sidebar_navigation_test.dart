import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/providers/selection_provider.dart';
import 'package:lumimuse/features/home/widgets/sidebar.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

void main() {
  group('Widget · Sidebar 底部导航', () {
    testWidgets('移动端抽屉内点击设置时，先关抽屉等动画完成再导航', (tester) async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      final closeEvents = <String>[];
      late final GoRouter router;
      router = GoRouter(
        initialLocation: '/',
        routes: [
          GoRoute(
            path: '/',
            builder: (context, state) => ProviderScope(
              overrides: [
                databaseProvider.overrideWithValue(db),
                characterListProvider.overrideWith((ref) async* {
                  yield <Character>[];
                }),
                selectionProvider.overrideWith((ref) => SelectionNotifier()),
              ],
              child: Material(
                child: SizedBox(
                  width: 336,
                  height: 800,
                  child: Sidebar(
                    onCloseDrawer: () async {
                      closeEvents.add(
                        router.routeInformationProvider.value.uri.toString(),
                      );
                    },
                  ),
                ),
              ),
            ),
          ),
          GoRoute(
            path: '/settings',
            builder: (context, state) =>
                const Material(child: Center(child: Text('设置页'))),
          ),
        ],
      );

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      await tester.tap(find.text('设置'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      expect(closeEvents, equals(['/']));
      expect(find.text('设置页'), findsOneWidget);
    });
  });
}
