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

Character _character({String id = 'char-1', String name = '测试角色'}) {
  final now = DateTime(2026, 5, 29);
  return Character(
    id: id,
    name: name,
    avatarUrl: null,
    personality: '',
    scenario: '',
    greeting: '',
    exampleDialogue: '',
    systemPrompt: '',
    basicInfo: '',
    otherInfo: '',
    imageTags: '',
    userImageTags: '',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  );
}

class _FakeCharacterActions extends Fake implements CharacterActions {
  final String createdId;

  _FakeCharacterActions({required this.createdId});

  @override
  Future<String> create({
    String name = '新角色',
    String personality = '',
    String scenario = '',
    String greeting = '',
    String exampleDialogue = '',
    String systemPrompt = '',
    String imageTags = '',
    String userImageTags = '',
  }) async {
    return createdId;
  }
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

    testWidgets('移动端抽屉内选择角色时关闭抽屉', (tester) async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final closeEvents = <String>[];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            databaseProvider.overrideWithValue(db),
            characterListProvider.overrideWith((ref) async* {
              yield [_character()];
            }),
            selectionProvider.overrideWith((ref) => SelectionNotifier()),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 336,
                height: 800,
                child: Sidebar(
                  onCloseDrawer: () async {
                    closeEvents.add('close');
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('测试角色'));
      await tester.pumpAndSettle();

      expect(closeEvents, equals(['close']));
    });

    testWidgets('移动端抽屉内新建角色时，先关抽屉再导航到编辑页', (tester) async {
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
                characterActionsProvider.overrideWithValue(
                  _FakeCharacterActions(createdId: 'new-char'),
                ),
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
            path: '/characters/:id/edit',
            builder: (context, state) =>
                const Material(child: Center(child: Text('角色编辑页'))),
          ),
        ],
      );

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      await tester.tap(find.text('新建角色'));
      await tester.pumpAndSettle();

      expect(closeEvents, equals(['/']));
      expect(find.text('角色编辑页'), findsOneWidget);
    });

    testWidgets('移动端抽屉内编辑角色时，先关抽屉再导航到编辑页', (tester) async {
      tester.view.physicalSize = const Size(390, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final db = _createTestDb();
      addTearDown(() => db.close());
      final character = _character();

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
                  yield [character];
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
            path: '/characters/:id/edit',
            builder: (context, state) =>
                const Material(child: Center(child: Text('角色编辑页'))),
          ),
        ],
      );

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.edit_outlined));
      await tester.pumpAndSettle();

      expect(closeEvents, equals(['/']));
      expect(find.text('角色编辑页'), findsOneWidget);
    });
  });
}
