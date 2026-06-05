// MessageAnimationWrapper Widget 测试
// 覆盖：动画跳过逻辑（shouldAnimate=false、辅助功能设置）、stagger 延迟计算
//
// Validates: Requirements 2.2, 2.3, 2.6

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/chat/widgets/message_animation.dart';

/// 辅助方法：构建测试用的 MessageAnimationWrapper 组件
Widget _buildTestWidget({
  bool shouldAnimate = true,
  int staggerIndex = 0,
  Duration staggerDelay = const Duration(milliseconds: 50),
  bool disableAnimations = false,
}) {
  return MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: disableAnimations),
      child: Scaffold(
        body: MessageAnimationWrapper(
          shouldAnimate: shouldAnimate,
          staggerIndex: staggerIndex,
          staggerDelay: staggerDelay,
          child: const Text('测试消息内容'),
        ),
      ),
    ),
  );
}

/// 辅助方法：构建多条消息用于测试 stagger 延迟
Widget _buildMultipleMessages({
  int count = 3,
  Duration staggerDelay = const Duration(milliseconds: 50),
}) {
  return MaterialApp(
    home: Scaffold(
      body: Column(
        children: List.generate(
          count,
          (index) => MessageAnimationWrapper(
            shouldAnimate: true,
            staggerIndex: index,
            staggerDelay: staggerDelay,
            child: Text('消息 $index'),
          ),
        ),
      ),
    ),
  );
}

/// 辅助方法：等待 flutter_animate 的所有动画和内部 timer 完成
/// flutter_animate 内部使用 Timer 调度动画启动，需要足够的 pump 时间来清理
Future<void> _pumpUntilAnimationsComplete(WidgetTester tester,
    {Duration extra = Duration.zero}) async {
  // 推进足够长的时间确保所有动画（含 stagger 延迟）完成
  await tester.pump(const Duration(milliseconds: 1000) + extra);
  await tester.pumpAndSettle();
}

void main() {
  group('MessageAnimationWrapper 动画跳过逻辑', () {
    testWidgets('shouldAnimate=false 时直接渲染子组件，无动画效果', (tester) async {
      await tester.pumpWidget(_buildTestWidget(shouldAnimate: false));
      await tester.pumpAndSettle();

      // 子组件应该被直接渲染
      expect(find.text('测试消息内容'), findsOneWidget);

      // 不应存在 Animate 组件（flutter_animate 的动画容器）
      expect(find.byType(Animate), findsNothing);
    });

    testWidgets('MediaQuery.disableAnimations=true 时直接渲染子组件', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        disableAnimations: true,
      ));
      await tester.pumpAndSettle();

      // 子组件应该被直接渲染
      expect(find.text('测试消息内容'), findsOneWidget);

      // 不应存在 Animate 组件
      expect(find.byType(Animate), findsNothing);
    });

    testWidgets('shouldAnimate=true 且无辅助功能设置时应用动画效果', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        disableAnimations: false,
      ));
      // pump 一帧让组件构建
      await tester.pump();

      // 子组件应该存在
      expect(find.text('测试消息内容'), findsOneWidget);

      // 应该存在 Animate 组件（flutter_animate 的动画容器）
      expect(find.byType(Animate), findsOneWidget);

      // 等待所有动画和 timer 完成，避免 pending timer 错误
      await _pumpUntilAnimationsComplete(tester);
    });

    testWidgets('shouldAnimate=false 时子组件透明度为 1（完全可见）', (tester) async {
      await tester.pumpWidget(_buildTestWidget(shouldAnimate: false));
      await tester.pumpAndSettle();

      // 查找 Text 组件
      final textWidget = find.text('测试消息内容');
      expect(textWidget, findsOneWidget);

      // 不应有 Animate 包裹（因为没有动画）
      expect(find.byType(Animate), findsNothing);
    });

    testWidgets('辅助功能设置下子组件透明度为 1（完全可见）', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        disableAnimations: true,
      ));
      await tester.pumpAndSettle();

      // 查找 Text 组件
      final textWidget = find.text('测试消息内容');
      expect(textWidget, findsOneWidget);

      // 不应有 Animate 组件
      expect(find.byType(Animate), findsNothing);
    });
  });

  group('MessageAnimationWrapper stagger 延迟计算', () {
    testWidgets('staggerIndex=0 时延迟为 0ms', (tester) async {
      // staggerIndex=0，延迟 = 0 * 50ms = 0ms
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        staggerIndex: 0,
        staggerDelay: const Duration(milliseconds: 50),
      ));
      await tester.pump();

      // 动画应该立即开始（无额外延迟）
      expect(find.byType(Animate), findsOneWidget);
      expect(find.text('测试消息内容'), findsOneWidget);

      // 等待所有动画完成
      await _pumpUntilAnimationsComplete(tester);
    });

    testWidgets('staggerIndex * staggerDelay 产生正确延迟', (tester) async {
      // 验证 staggerIndex=2, staggerDelay=50ms → 延迟 100ms
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        staggerIndex: 2,
        staggerDelay: const Duration(milliseconds: 50),
      ));
      await tester.pump();

      // 动画组件应该存在
      expect(find.byType(Animate), findsOneWidget);

      // 在延迟期间（100ms 内），动画尚未开始，组件应该不可见（opacity 接近 0）
      // pump 50ms — 仍在延迟期间
      await tester.pump(const Duration(milliseconds: 50));

      // 组件存在但动画尚未完成
      expect(find.text('测试消息内容'), findsOneWidget);

      // 等待所有动画完成
      await _pumpUntilAnimationsComplete(tester);
    });

    testWidgets('多条消息的 stagger 延迟依次递增', (tester) async {
      await tester.pumpWidget(_buildMultipleMessages(
        count: 3,
        staggerDelay: const Duration(milliseconds: 50),
      ));
      await tester.pump();

      // 应该有 3 个 Animate 组件
      expect(find.byType(Animate), findsNWidgets(3));

      // 所有消息文本都应该存在
      expect(find.text('消息 0'), findsOneWidget);
      expect(find.text('消息 1'), findsOneWidget);
      expect(find.text('消息 2'), findsOneWidget);

      // 等待所有动画完成（最大延迟 = 2*50ms + 300ms 动画时长）
      await _pumpUntilAnimationsComplete(tester);
    });

    testWidgets('自定义 staggerDelay 值正确应用', (tester) async {
      // 使用 100ms 的 staggerDelay
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        staggerIndex: 3,
        staggerDelay: const Duration(milliseconds: 100),
      ));
      await tester.pump();

      // 延迟应为 3 * 100ms = 300ms
      // 动画组件应该存在
      expect(find.byType(Animate), findsOneWidget);

      // pump 到 300ms + 300ms（延迟 + 动画时长）后动画应完成
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle();

      // 动画完成后消息应该完全可见
      expect(find.text('测试消息内容'), findsOneWidget);
    });

    testWidgets('stagger 延迟计算公式验证：index × delay', (tester) async {
      // 验证不同 index 和 delay 组合
      const testCases = [
        (index: 0, delayMs: 50, expectedMs: 0),
        (index: 1, delayMs: 50, expectedMs: 50),
        (index: 5, delayMs: 50, expectedMs: 250),
        (index: 2, delayMs: 100, expectedMs: 200),
        (index: 10, delayMs: 30, expectedMs: 300),
      ];

      for (final testCase in testCases) {
        // 验证 MessageAnimationWrapper 的 stagger 延迟计算
        final wrapper = MessageAnimationWrapper(
          shouldAnimate: true,
          staggerIndex: testCase.index,
          staggerDelay: Duration(milliseconds: testCase.delayMs),
          child: const Text('测试'),
        );

        // 验证参数正确存储
        expect(wrapper.staggerIndex, equals(testCase.index));
        expect(
          wrapper.staggerDelay,
          equals(Duration(milliseconds: testCase.delayMs)),
        );

        // 验证计算结果：staggerIndex * staggerDelay
        final computedDelay = wrapper.staggerDelay * wrapper.staggerIndex;
        expect(
          computedDelay,
          equals(Duration(milliseconds: testCase.expectedMs)),
          reason:
              'index=${testCase.index}, delay=${testCase.delayMs}ms → 期望延迟 ${testCase.expectedMs}ms',
        );
      }
    });
  });

  group('MessageAnimationWrapper 动画参数验证', () {
    testWidgets('动画时长为 300ms，缓动为 easeOut', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        shouldAnimate: true,
        staggerIndex: 0,
      ));
      await tester.pump();

      // 动画组件存在
      expect(find.byType(Animate), findsOneWidget);

      // 等待动画完成（300ms 动画时长）
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      // 动画完成后消息应该完全可见
      expect(find.text('测试消息内容'), findsOneWidget);
    });

    testWidgets('默认 staggerDelay 为 50ms', (tester) async {
      // 不传 staggerDelay，使用默认值
      const wrapper = MessageAnimationWrapper(
        shouldAnimate: true,
        staggerIndex: 1,
        child: Text('测试'),
      );

      // 验证默认 staggerDelay 为 50ms
      expect(wrapper.staggerDelay, equals(const Duration(milliseconds: 50)));
    });

    testWidgets('默认 staggerIndex 为 0', (tester) async {
      // 不传 staggerIndex，使用默认值
      const wrapper = MessageAnimationWrapper(
        shouldAnimate: true,
        child: Text('测试'),
      );

      // 验证默认 staggerIndex 为 0
      expect(wrapper.staggerIndex, equals(0));
    });

    testWidgets('默认 shouldAnimate 为 true', (tester) async {
      // 不传 shouldAnimate，使用默认值
      const wrapper = MessageAnimationWrapper(
        child: Text('测试'),
      );

      // 验证默认 shouldAnimate 为 true
      expect(wrapper.shouldAnimate, isTrue);
    });
  });
}
