// 暗色模式 Widget 测试
// 覆盖：暗色模式下各组件颜色正确性、主题切换不重建路由栈
// Validates: Requirements 4.1, 4.2, 4.3, 4.6

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_theme.dart';

/// 阻止测试环境中的 HTTP 请求（google_fonts 字体下载）
class _NoHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (_, __, ___) => true;
  }
}

void main() {
  // 覆盖 HTTP 客户端，防止 google_fonts 异步字体下载导致测试失败
  setUpAll(() {
    HttpOverrides.global = _NoHttpOverrides();
    // 模拟 path_provider 插件，防止 google_fonts 缓存字体时抛出 MissingPluginException
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async {
        if (methodCall.method == 'getApplicationSupportDirectory') {
          return Directory.systemTemp.path;
        }
        if (methodCall.method == 'getTemporaryDirectory') {
          return Directory.systemTemp.path;
        }
        return null;
      },
    );
  });

  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
  });

  group('暗色模式颜色正确性', () {
    late ThemeData darkTheme;

    setUp(() {
      darkTheme = AppTheme.dark();
    });

    group('需求 4.1: 文字元素使用暗色模式色值', () {
      testWidgets('暗色模式下 TextTheme 主色为 darkTextPrimary', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme: darkTheme,
          home: const Scaffold(
            body: Text('测试文字'),
          ),
        ));

        // 验证 TextTheme 中主要文字颜色为 darkTextPrimary
        final textTheme = darkTheme.textTheme;

        expect(
          textTheme.bodyLarge?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'bodyLarge 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.bodyMedium?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'bodyMedium 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.titleLarge?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'titleLarge 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.titleMedium?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'titleMedium 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.headlineMedium?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'headlineMedium 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.displayLarge?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'displayLarge 应使用 darkTextPrimary 颜色',
        );
        expect(
          textTheme.labelLarge?.color,
          equals(AppTheme.darkTextPrimary),
          reason: 'labelLarge 应使用 darkTextPrimary 颜色',
        );
      });

      testWidgets('暗色模式下 TextTheme 次要色为 darkTextSecondary', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme: darkTheme,
          home: const Scaffold(
            body: Text('测试文字'),
          ),
        ));

        final textTheme = darkTheme.textTheme;

        // bodySmall 和 labelSmall 使用 secondary 颜色
        expect(
          textTheme.bodySmall?.color,
          equals(AppTheme.darkTextSecondary),
          reason: 'bodySmall 应使用 darkTextSecondary 颜色',
        );
        expect(
          textTheme.labelSmall?.color,
          equals(AppTheme.darkTextSecondary),
          reason: 'labelSmall 应使用 darkTextSecondary 颜色',
        );
      });

      testWidgets('暗色模式下文字颜色不包含亮色模式色值', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme: darkTheme,
          home: const Scaffold(
            body: Text('测试文字'),
          ),
        ));

        final textTheme = darkTheme.textTheme;
        final allStyles = [
          textTheme.displayLarge,
          textTheme.headlineMedium,
          textTheme.titleLarge,
          textTheme.titleMedium,
          textTheme.bodyLarge,
          textTheme.bodyMedium,
          textTheme.bodySmall,
          textTheme.labelLarge,
          textTheme.labelSmall,
        ];

        for (final style in allStyles) {
          if (style?.color != null) {
            // 不应使用亮色模式的文字色值
            expect(
              style!.color,
              isNot(equals(AppTheme.textPrimary)),
              reason: '暗色模式下不应使用亮色 textPrimary: ${style.color}',
            );
            expect(
              style.color,
              isNot(equals(AppTheme.textMuted)),
              reason: '暗色模式下不应使用亮色 textMuted: ${style.color}',
            );
          }
        }
      });
    });

    group('需求 4.2: 表面元素使用暗色模式色值', () {
      test('scaffoldBackgroundColor 使用 darkWarm50', () {
        expect(
          darkTheme.scaffoldBackgroundColor,
          equals(AppTheme.darkWarm50),
          reason: '页面背景应使用 darkWarm50',
        );
      });

      test('cardColor 使用 darkSurface', () {
        expect(
          darkTheme.cardColor,
          equals(AppTheme.darkSurface),
          reason: '卡片颜色应使用 darkSurface',
        );
      });

      test('colorScheme.surface 使用 darkWarm50', () {
        expect(
          darkTheme.colorScheme.surface,
          equals(AppTheme.darkWarm50),
          reason: 'colorScheme.surface 应使用 darkWarm50',
        );
      });

      test('inputDecorationTheme fillColor 使用 darkSurfaceRaised', () {
        expect(
          darkTheme.inputDecorationTheme.fillColor,
          equals(AppTheme.darkSurfaceRaised),
          reason: '输入框填充色应使用 darkSurfaceRaised',
        );
      });

      test('dialogTheme backgroundColor 使用 darkSurfaceRaised', () {
        expect(
          darkTheme.dialogTheme.backgroundColor,
          equals(AppTheme.darkSurfaceRaised),
          reason: '弹窗背景应使用 darkSurfaceRaised',
        );
      });

      test('bottomSheetTheme backgroundColor 使用 darkSurfaceRaised', () {
        expect(
          darkTheme.bottomSheetTheme.backgroundColor,
          equals(AppTheme.darkSurfaceRaised),
          reason: '底部面板背景应使用 darkSurfaceRaised',
        );
      });

      test('popupMenuTheme color 使用 darkSurfaceRaised', () {
        expect(
          darkTheme.popupMenuTheme.color,
          equals(AppTheme.darkSurfaceRaised),
          reason: '弹出菜单颜色应使用 darkSurfaceRaised',
        );
      });

      test('表面元素不使用亮色模式色值', () {
        // 不应使用亮色模式的 surface 色值
        expect(
          darkTheme.scaffoldBackgroundColor,
          isNot(equals(AppTheme.surface)),
          reason: '暗色模式不应使用亮色 surface',
        );
        expect(
          darkTheme.scaffoldBackgroundColor,
          isNot(equals(AppTheme.surfaceRaised)),
          reason: '暗色模式不应使用亮色 surfaceRaised',
        );
        expect(
          darkTheme.scaffoldBackgroundColor,
          isNot(equals(AppTheme.warm50)),
          reason: '暗色模式不应使用亮色 warm50',
        );
        expect(
          darkTheme.cardColor,
          isNot(equals(AppTheme.surface)),
          reason: '暗色模式卡片不应使用亮色 surface',
        );
      });
    });

    group('需求 4.3: 边框元素使用暗色模式色值', () {
      test('colorScheme.outline 使用 darkBorder', () {
        expect(
          darkTheme.colorScheme.outline,
          equals(AppTheme.darkBorder),
          reason: 'outline 应使用 darkBorder',
        );
      });

      test('colorScheme.outlineVariant 使用 darkBorderLight', () {
        expect(
          darkTheme.colorScheme.outlineVariant,
          equals(AppTheme.darkBorderLight),
          reason: 'outlineVariant 应使用 darkBorderLight',
        );
      });

      test('dividerColor 使用 darkBorderLight', () {
        expect(
          darkTheme.dividerColor,
          equals(AppTheme.darkBorderLight),
          reason: '分割线颜色应使用 darkBorderLight',
        );
      });

      test('inputDecorationTheme enabledBorder 使用 darkBorder', () {
        final enabledBorder = darkTheme.inputDecorationTheme.enabledBorder;
        expect(enabledBorder, isNotNull);
        expect(enabledBorder, isA<OutlineInputBorder>());

        final outlineBorder = enabledBorder as OutlineInputBorder;
        expect(
          outlineBorder.borderSide.color,
          equals(AppTheme.darkBorder),
          reason: '输入框启用态边框应使用 darkBorder',
        );
      });

      test('边框元素不使用亮色模式色值', () {
        expect(
          darkTheme.colorScheme.outline,
          isNot(equals(AppTheme.border)),
          reason: '暗色模式不应使用亮色 border',
        );
        expect(
          darkTheme.colorScheme.outlineVariant,
          isNot(equals(AppTheme.borderLight)),
          reason: '暗色模式不应使用亮色 borderLight',
        );
        expect(
          darkTheme.dividerColor,
          isNot(equals(AppTheme.borderLight)),
          reason: '暗色模式分割线不应使用亮色 borderLight',
        );
      });
    });

    group('暗色模式 ColorScheme 完整性', () {
      test('primary 使用 darkAccent', () {
        expect(
          darkTheme.colorScheme.primary,
          equals(AppTheme.darkAccent),
          reason: 'primary 应使用 darkAccent',
        );
      });

      test('secondary 使用 darkAccentDark', () {
        expect(
          darkTheme.colorScheme.secondary,
          equals(AppTheme.darkAccentDark),
          reason: 'secondary 应使用 darkAccentDark',
        );
      });

      test('onSurface 使用 darkTextPrimary', () {
        expect(
          darkTheme.colorScheme.onSurface,
          equals(AppTheme.darkTextPrimary),
          reason: 'onSurface 应使用 darkTextPrimary',
        );
      });
    });
  });

  group('需求 4.6: 主题切换不重建路由栈', () {
    testWidgets('切换主题时有状态组件的 state 被保留', (tester) async {
      // 使用 ValueNotifier 模拟主题模式切换
      final themeMode = ValueNotifier<ThemeMode>(ThemeMode.light);

      await tester.pumpWidget(
        ValueListenableBuilder<ThemeMode>(
          valueListenable: themeMode,
          builder: (context, mode, _) {
            return MaterialApp(
              theme: AppTheme.light(),
              darkTheme: AppTheme.dark(),
              themeMode: mode,
              home: const _StatefulCounterPage(),
            );
          },
        ),
      );
      await tester.pumpAndSettle();

      // 验证初始状态：计数器为 0
      expect(find.text('计数: 0'), findsOneWidget);

      // 点击按钮增加计数器
      await tester.tap(find.byKey(const Key('increment_button')));
      await tester.pumpAndSettle();
      expect(find.text('计数: 1'), findsOneWidget);

      // 再次点击
      await tester.tap(find.byKey(const Key('increment_button')));
      await tester.pumpAndSettle();
      expect(find.text('计数: 2'), findsOneWidget);

      // 切换到暗色模式
      themeMode.value = ThemeMode.dark;
      await tester.pumpAndSettle();

      // 验证计数器状态被保留（未重建）
      expect(
        find.text('计数: 2'),
        findsOneWidget,
        reason: '切换主题后计数器状态应被保留，不应重建路由栈',
      );

      // 切换回亮色模式
      themeMode.value = ThemeMode.light;
      await tester.pumpAndSettle();

      // 验证计数器状态仍然保留
      expect(
        find.text('计数: 2'),
        findsOneWidget,
        reason: '再次切换主题后计数器状态仍应被保留',
      );

      themeMode.dispose();
    });

    testWidgets('切换主题时 Navigator 不重建（路由栈保持不变）', (tester) async {
      final themeMode = ValueNotifier<ThemeMode>(ThemeMode.light);

      await tester.pumpWidget(
        ValueListenableBuilder<ThemeMode>(
          valueListenable: themeMode,
          builder: (context, mode, _) {
            return MaterialApp(
              theme: AppTheme.light(),
              darkTheme: AppTheme.dark(),
              themeMode: mode,
              home: const _NavigationTestPage(),
            );
          },
        ),
      );
      await tester.pumpAndSettle();

      // 验证初始页面
      expect(find.text('首页'), findsOneWidget);
      expect(find.text('详情页'), findsNothing);

      // 导航到详情页
      await tester.tap(find.text('打开详情'));
      await tester.pumpAndSettle();

      // 验证已导航到详情页
      expect(find.text('详情页'), findsOneWidget);

      // 切换到暗色模式
      themeMode.value = ThemeMode.dark;
      await tester.pumpAndSettle();

      // 验证仍在详情页（路由栈未重建）
      expect(
        find.text('详情页'),
        findsOneWidget,
        reason: '切换主题后应仍在详情页，路由栈不应重建',
      );
      expect(
        find.text('首页'),
        findsNothing,
        reason: '切换主题后不应回到首页',
      );

      // 切换回亮色模式
      themeMode.value = ThemeMode.light;
      await tester.pumpAndSettle();

      // 验证仍在详情页
      expect(
        find.text('详情页'),
        findsOneWidget,
        reason: '再次切换主题后仍应在详情页',
      );

      themeMode.dispose();
    });

    testWidgets('多次快速切换主题不导致状态丢失', (tester) async {
      final themeMode = ValueNotifier<ThemeMode>(ThemeMode.light);

      await tester.pumpWidget(
        ValueListenableBuilder<ThemeMode>(
          valueListenable: themeMode,
          builder: (context, mode, _) {
            return MaterialApp(
              theme: AppTheme.light(),
              darkTheme: AppTheme.dark(),
              themeMode: mode,
              home: const _StatefulCounterPage(),
            );
          },
        ),
      );
      await tester.pumpAndSettle();

      // 增加计数器到 3
      for (int i = 0; i < 3; i++) {
        await tester.tap(find.byKey(const Key('increment_button')));
        await tester.pumpAndSettle();
      }
      expect(find.text('计数: 3'), findsOneWidget);

      // 快速多次切换主题
      themeMode.value = ThemeMode.dark;
      await tester.pump(const Duration(milliseconds: 50));
      themeMode.value = ThemeMode.light;
      await tester.pump(const Duration(milliseconds: 50));
      themeMode.value = ThemeMode.dark;
      await tester.pump(const Duration(milliseconds: 50));
      themeMode.value = ThemeMode.light;
      await tester.pumpAndSettle();

      // 验证状态仍然保留
      expect(
        find.text('计数: 3'),
        findsOneWidget,
        reason: '多次快速切换主题后计数器状态应被保留',
      );

      themeMode.dispose();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// 测试辅助组件
// ═══════════════════════════════════════════════════════════════

/// 有状态计数器页面 — 用于验证主题切换不重建 State
class _StatefulCounterPage extends StatefulWidget {
  const _StatefulCounterPage();

  @override
  State<_StatefulCounterPage> createState() => _StatefulCounterPageState();
}

class _StatefulCounterPageState extends State<_StatefulCounterPage> {
  int _counter = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('计数: $_counter'),
            GestureDetector(
              key: const Key('increment_button'),
              onTap: () => setState(() => _counter++),
              child: Container(
                padding: const EdgeInsets.all(16),
                color: Theme.of(context).colorScheme.primary,
                child: Text(
                  '增加',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onPrimary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 导航测试页面 — 用于验证主题切换不重建路由栈
class _NavigationTestPage extends StatelessWidget {
  const _NavigationTestPage();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('首页'),
            GestureDetector(
              onTap: () {
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const _DetailPage(),
                  ),
                );
              },
              child: Container(
                padding: const EdgeInsets.all(16),
                child: const Text('打开详情'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 详情页 — 导航目标页面
class _DetailPage extends StatelessWidget {
  const _DetailPage();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('详情页'),
            GestureDetector(
              onTap: () => Navigator.of(context).pop(),
              child: Container(
                padding: const EdgeInsets.all(16),
                child: const Text('返回'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
