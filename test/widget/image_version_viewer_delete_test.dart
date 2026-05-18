// Feature: flutter-platform-polish, Task 2.2: ImageVersionViewer 删除按钮例测
// **Validates: Requirements 1.7（lightbox 删除入口）**
//
// 覆盖 ImageVersionViewer 在 lightbox 场景下的删除按钮交互：
//   - 例测 1：未传 onDeleteCurrent 时，右上角删除按钮不渲染（向前兼容）
//   - 例测 2：传入回调后，点击删除按钮会先弹二次确认对话框；
//             用户点「删除」后回调被触发，参数等于当前展示版本对应的本地路径
//   - 例测 3：用户点「取消」后回调不被触发
//
// 注意：测试中使用 '/tmp/a.png' 这种虚假路径不会触发任何 IO；ImageVersionViewer
// 已经用 `File(path).existsSync()` 兜底渲染错误占位图，因此不需要真实文件。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/chat/widgets/image_version_viewer.dart';

/// 构造一个挂载 ImageVersionViewer 的测试 App，统一处理 MaterialApp 包裹。
Widget _buildViewerApp({
  required List<String> imagePaths,
  int initialIndex = 0,
  void Function(String currentLocalPath)? onDeleteCurrent,
}) {
  // i18n 替换后 ImageVersionViewer 通过 ConsumerStatefulWidget 读 localeProvider，
  // 测试外壳必须提供 ProviderScope，其它行为保持不变。
  return ProviderScope(
    child: MaterialApp(
      home: ImageVersionViewer(
        imagePaths: imagePaths,
        initialIndex: initialIndex,
        onDeleteCurrent: onDeleteCurrent,
      ),
    ),
  );
}

void main() {
  group('ImageVersionViewer 删除按钮', () {
    testWidgets('未传 onDeleteCurrent 时不渲染删除按钮', (tester) async {
      // 准备：仅传入图片路径，不传删除回调
      await tester.pumpWidget(
        _buildViewerApp(
          imagePaths: const ['/tmp/a.png'],
        ),
      );
      await tester.pumpAndSettle();

      // 断言：右上角应只有关闭按钮，不应出现删除图标
      expect(find.byIcon(Icons.delete_outline), findsNothing);
      // 顺带确认关闭按钮仍正常渲染（保证测试搭建本身没问题）
      expect(find.byIcon(Icons.close), findsOneWidget);
    });

    testWidgets('点击删除按钮 → 弹二次确认 → 点「删除」触发回调，参数为当前展示版本路径',
        (tester) async {
      // 准备：捕获回调入参
      String? captured;
      void onDelete(String path) {
        captured = path;
      }

      await tester.pumpWidget(
        _buildViewerApp(
          imagePaths: const ['/tmp/a.png'],
          onDeleteCurrent: onDelete,
        ),
      );
      await tester.pumpAndSettle();

      // 删除按钮应出现
      expect(find.byIcon(Icons.delete_outline), findsOneWidget);

      // 点击删除按钮，等待对话框出现
      await tester.tap(find.byIcon(Icons.delete_outline));
      await tester.pumpAndSettle();

      // 断言二次确认对话框的文案与按钮均存在
      expect(find.text('删除当前图片'), findsOneWidget);
      expect(find.text('将从对话和本地存储中移除这张图片，确定继续？'), findsOneWidget);
      expect(find.text('取消'), findsOneWidget);
      expect(find.text('删除'), findsOneWidget);

      // 此时回调还不应被触发
      expect(captured, isNull);

      // 点击「删除」按钮
      await tester.tap(find.text('删除'));
      await tester.pumpAndSettle();

      // 回调应被触发，参数等于当前展示版本（initialIndex 默认 0 时为第一张）
      expect(captured, equals('/tmp/a.png'));
    });

    testWidgets('点击删除按钮 → 弹二次确认 → 点「取消」回调不被调用', (tester) async {
      // 准备：捕获回调入参
      String? captured;
      void onDelete(String path) {
        captured = path;
      }

      await tester.pumpWidget(
        _buildViewerApp(
          imagePaths: const ['/tmp/a.png'],
          onDeleteCurrent: onDelete,
        ),
      );
      await tester.pumpAndSettle();

      // 点击删除按钮触发对话框
      await tester.tap(find.byIcon(Icons.delete_outline));
      await tester.pumpAndSettle();

      // 点击「取消」
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();

      // 回调不应被触发
      expect(captured, isNull);

      // 对话框应已关闭
      expect(find.text('删除当前图片'), findsNothing);
    });
  });
}
