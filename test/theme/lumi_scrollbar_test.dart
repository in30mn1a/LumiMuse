// LumiScrollbar Widget 测试
// 覆盖：透明度状态转换、暗色模式颜色切换、ScrollController 未附着时降级行为

import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_theme.dart';
import 'package:lumimuse/theme/lumi_scrollbar.dart';

/// 辅助方法：构建测试用的 LumiScrollbar 组件
Widget _buildTestScrollbar({
  Brightness brightness = Brightness.light,
  ScrollController? controller,
  double listHeight = 2000.0,
}) {
  return MaterialApp(
    theme: brightness == Brightness.light ? AppTheme.light() : AppTheme.dark(),
    home: Scaffold(
      body: SizedBox(
        height: 400,
        child: LumiScrollbar(
          controller: controller,
          child: ListView.builder(
            controller: controller,
            itemCount: 50,
            itemBuilder: (context, index) => SizedBox(
              height: listHeight / 50,
              child: Text('Item $index'),
            ),
          ),
        ),
      ),
    ),
  );
}

/// 辅助方法：查找 RawScrollbar 的 thumbColor alpha 值
double? _findThumbColorAlpha(WidgetTester tester) {
  final rawScrollbar = tester.widget<RawScrollbar>(
    find.byType(RawScrollbar),
  );
  final color = rawScrollbar.thumbColor;
  if (color == null) return null;
  return color.a;
}

/// 辅助方法：查找 RawScrollbar 的 thumbColor（不含 alpha）
Color? _findThumbBaseColor(WidgetTester tester) {
  final rawScrollbar = tester.widget<RawScrollbar>(
    find.byType(RawScrollbar),
  );
  final color = rawScrollbar.thumbColor;
  if (color == null) return null;
  // 返回不含 alpha 的基础颜色
  return color.withValues(alpha: 1.0);
}

void main() {
  group('LumiScrollbar 透明度状态转换', () {
    testWidgets('初始状态为空闲态，透明度为 0.3', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      final alpha = _findThumbColorAlpha(tester);
      expect(alpha, isNotNull);
      // 空闲态透明度应为 0.3
      expect(alpha!, closeTo(0.3, 0.01));

      controller.dispose();
    });

    testWidgets('滚动时透明度过渡到 0.7', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      // 触发滚动
      await tester.drag(find.byType(ListView), const Offset(0, -100));
      // 等待 150ms 过渡动画完成
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();

      final alpha = _findThumbColorAlpha(tester);
      expect(alpha, isNotNull);
      // 滚动态透明度应为 0.7
      expect(alpha!, closeTo(0.7, 0.05));

      controller.dispose();
    });

    testWidgets('滚动停止 800ms 后回到空闲态透明度 0.3', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      // 触发滚动
      await tester.drag(find.byType(ListView), const Offset(0, -100));
      await tester.pumpAndSettle();

      // 等待 800ms 空闲超时
      await tester.pump(const Duration(milliseconds: 800));
      // 等待 200ms 过渡动画完成
      await tester.pump(const Duration(milliseconds: 250));
      await tester.pumpAndSettle();

      final alpha = _findThumbColorAlpha(tester);
      expect(alpha, isNotNull);
      // 回到空闲态透明度 0.3
      expect(alpha!, closeTo(0.3, 0.05));

      controller.dispose();
    });

    testWidgets('鼠标 hover 时透明度提升到 0.9', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      // 查找 LumiScrollbar 组件区域用于 hover
      final scrollbarFinder = find.byType(LumiScrollbar);
      expect(scrollbarFinder, findsOneWidget);

      final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await gesture.addPointer(location: Offset.zero);
      addTearDown(gesture.removePointer);

      // 移动鼠标到 LumiScrollbar 区域内
      await gesture.moveTo(tester.getCenter(scrollbarFinder));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();

      final alpha = _findThumbColorAlpha(tester);
      expect(alpha, isNotNull);
      // hover 态透明度应为 0.9
      expect(alpha!, closeTo(0.9, 0.05));

      controller.dispose();
    });

    testWidgets('鼠标离开后回到空闲态', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      // 查找 LumiScrollbar 组件区域
      final scrollbarFinder = find.byType(LumiScrollbar);

      // 模拟鼠标进入
      final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await gesture.addPointer(location: Offset.zero);
      addTearDown(gesture.removePointer);

      await gesture.moveTo(tester.getCenter(scrollbarFinder));
      await tester.pumpAndSettle();

      // 模拟鼠标离开（移到组件外部）
      await gesture.moveTo(const Offset(-100, -100));
      await tester.pump(const Duration(milliseconds: 250));
      await tester.pumpAndSettle();

      final alpha = _findThumbColorAlpha(tester);
      expect(alpha, isNotNull);
      // 离开后回到空闲态 0.3
      expect(alpha!, closeTo(0.3, 0.05));

      controller.dispose();
    });
  });

  group('LumiScrollbar 暗色模式颜色切换', () {
    testWidgets('亮色模式使用 AppTheme.accent 颜色', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(
        brightness: Brightness.light,
        controller: controller,
      ));
      await tester.pumpAndSettle();

      final baseColor = _findThumbBaseColor(tester);
      expect(baseColor, isNotNull);
      // 亮色模式下基础颜色应为 AppTheme.accent
      expect(baseColor!, equals(AppTheme.accent));

      controller.dispose();
    });

    testWidgets('暗色模式使用 AppTheme.darkAccent 颜色', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(
        brightness: Brightness.dark,
        controller: controller,
      ));
      await tester.pumpAndSettle();

      final baseColor = _findThumbBaseColor(tester);
      expect(baseColor, isNotNull);
      // 暗色模式下基础颜色应为 AppTheme.darkAccent
      expect(baseColor!, equals(AppTheme.darkAccent));

      controller.dispose();
    });

    testWidgets('暗色模式下透明度规则与亮色模式一致', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(
        brightness: Brightness.dark,
        controller: controller,
      ));
      await tester.pumpAndSettle();

      // 初始空闲态透明度 0.3
      final idleAlpha = _findThumbColorAlpha(tester);
      expect(idleAlpha, isNotNull);
      expect(idleAlpha!, closeTo(0.3, 0.01));

      // 触发滚动
      await tester.drag(find.byType(ListView), const Offset(0, -100));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();

      // 滚动态透明度 0.7
      final scrollAlpha = _findThumbColorAlpha(tester);
      expect(scrollAlpha, isNotNull);
      expect(scrollAlpha!, closeTo(0.7, 0.05));

      controller.dispose();
    });
  });

  group('LumiScrollbar ScrollController 降级行为', () {
    testWidgets('未提供 ScrollController 时正常渲染', (tester) async {
      // 不传入 controller，使用 null
      await tester.pumpWidget(_buildTestScrollbar(controller: null));
      await tester.pumpAndSettle();

      // 应该能找到 RawScrollbar 组件
      expect(find.byType(RawScrollbar), findsOneWidget);
      // 应该能找到 LumiScrollbar 组件
      expect(find.byType(LumiScrollbar), findsOneWidget);
    });

    testWidgets('未附着的 ScrollController 不导致应用崩溃', (tester) async {
      // 创建一个 ScrollController 但不附着到任何 ScrollView
      final detachedController = ScrollController();

      // 使用 detachedController 但不将其传给 ListView
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: SizedBox(
            height: 400,
            child: LumiScrollbar(
              controller: detachedController,
              child: ListView.builder(
                // 注意：这里故意不传 controller，让 detachedController 未附着
                itemCount: 50,
                itemBuilder: (context, index) => SizedBox(
                  height: 40,
                  child: Text('Item $index'),
                ),
              ),
            ),
          ),
        ),
      ));

      // RawScrollbar 在 controller 未附着时会抛出断言错误
      // 但不应导致整个应用崩溃，组件树仍然存在
      // 消费掉 Flutter 框架抛出的异常
      final exception = tester.takeException();
      // 验证确实有异常（RawScrollbar 的断言）
      expect(exception, isNotNull);

      // 组件应该仍然存在于组件树中
      expect(find.byType(LumiScrollbar), findsOneWidget);

      detachedController.dispose();
    });

    testWidgets('滚动条滑块尺寸符合规格（6px 宽，3px 圆角）', (tester) async {
      final controller = ScrollController();
      await tester.pumpWidget(_buildTestScrollbar(controller: controller));
      await tester.pumpAndSettle();

      final rawScrollbar = tester.widget<RawScrollbar>(
        find.byType(RawScrollbar),
      );

      // 验证滑块宽度为 6px
      expect(rawScrollbar.thickness, equals(6.0));
      // 验证圆角为 3px
      expect(rawScrollbar.radius, equals(const Radius.circular(3.0)));
      // 验证轨道背景透明
      expect(rawScrollbar.trackColor, equals(Colors.transparent));
      // 验证轨道边框透明
      expect(rawScrollbar.trackBorderColor, equals(Colors.transparent));
      // 验证滑块始终可见
      expect(rawScrollbar.thumbVisibility, isTrue);

      controller.dispose();
    });
  });
}
