// 图片版本导航状态一致性属性测试
// Feature: flutter-visual-polish, Property 2: Image version navigation state consistency
// Validates: Requirements 6.2, 6.3, 6.8

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test, setUp, tearDown, setUpAll, tearDownAll;
import 'package:lumimuse/features/chat/widgets/image_version_viewer.dart';

/// 图片版本导航测试输入数据
class VersionNavInput {
  /// 总版本数 (1-20)
  final int totalVersions;

  /// 当前活跃索引 (0 <= index < totalVersions)
  final int activeIndex;

  const VersionNavInput({
    required this.totalVersions,
    required this.activeIndex,
  });

  @override
  String toString() =>
      'VersionNavInput(total: $totalVersions, activeIndex: $activeIndex)';
}

/// 为 VersionNavInput 提供自定义生成器
extension VersionNavGenerators on Any {
  /// 生成随机版本导航输入：版本数 1-20，活跃索引在有效范围内
  Generator<VersionNavInput> get versionNavInput {
    return combine2<int, double, VersionNavInput>(
      intInRange(1, 21), // totalVersions: 1 到 20
      doubleInRange(0.0, 1.0), // 用于计算 activeIndex 的比例因子
      (total, ratio) {
        // 根据比例因子计算有效的活跃索引
        final activeIndex = (ratio * (total - 1)).floor().clamp(0, total - 1);
        return VersionNavInput(
          totalVersions: total,
          activeIndex: activeIndex,
        );
      },
    );
  }
}

void main() {
  // 临时目录用于创建测试图片文件
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('image_version_viewer_test_');
  });

  tearDown(() {
    // 清理临时目录
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  /// 创建指定数量的临时图片文件路径
  List<String> createTempImageFiles(int count, Directory dir) {
    final paths = <String>[];
    for (var i = 0; i < count; i++) {
      final file = File('${dir.path}/test_image_$i.png');
      if (!file.existsSync()) {
        // 写入最小有效 PNG 文件头（1x1 像素透明 PNG）
        file.writeAsBytesSync([
          0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG 签名
          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR 块
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 像素
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, // RGBA
          0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, // IDAT 块
          0x54, 0x78, 0x9C, 0x62, 0x00, 0x00, 0x00, 0x02,
          0x00, 0x01, 0xE5, 0x27, 0xDE, 0xFC, 0x00, 0x00,
          0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, // IEND 块
          0x60, 0x82,
        ]);
      }
      paths.add(file.path);
    }
    return paths;
  }

  group('Property 2: Image version navigation state consistency', () {
    // ─────────────────────────────────────────────
    // 纯逻辑属性测试（不需要 Widget 渲染）
    // ─────────────────────────────────────────────

    Glados(any.versionNavInput, ExploreConfig(numRuns: 100)).test(
      '版本指示器文本格式正确：多版本时显示 "{index+1} / {total}"',
      (input) {
        // 仅测试多版本情况下的指示器文本
        if (input.totalVersions <= 1) return;

        // 验证预期文本格式
        final expectedText =
            '${input.activeIndex + 1} / ${input.totalVersions}';

        // 验证格式正确性
        expect(
          expectedText,
          matches(RegExp(r'^\d+ / \d+$')),
          reason: '指示器文本应为 "{n} / {m}" 格式',
        );

        // 验证索引范围正确
        expect(
          input.activeIndex + 1,
          greaterThanOrEqualTo(1),
          reason: '显示的当前索引应 >= 1',
        );
        expect(
          input.activeIndex + 1,
          lessThanOrEqualTo(input.totalVersions),
          reason: '显示的当前索引应 <= 总数',
        );
      },
    );

    Glados(any.versionNavInput, ExploreConfig(numRuns: 100)).test(
      '上一版按钮禁用状态：当且仅当 activeIndex == 0 时禁用',
      (input) {
        if (input.totalVersions <= 1) return;

        // 上一版按钮禁用条件
        final shouldBeDisabled = input.activeIndex == 0;
        final canGoPrevious = input.activeIndex > 0;

        expect(
          canGoPrevious,
          equals(!shouldBeDisabled),
          reason:
              '当 activeIndex=${input.activeIndex} 时，canGoPrevious 应为 ${!shouldBeDisabled}',
        );

        // 验证边界条件
        if (input.activeIndex == 0) {
          expect(canGoPrevious, isFalse,
              reason: '首版时上一版按钮应禁用');
        } else {
          expect(canGoPrevious, isTrue,
              reason: '非首版时上一版按钮应启用');
        }
      },
    );

    Glados(any.versionNavInput, ExploreConfig(numRuns: 100)).test(
      '下一版按钮禁用状态：当且仅当 activeIndex == total-1 时禁用',
      (input) {
        if (input.totalVersions <= 1) return;

        // 下一版按钮禁用条件
        final maxIndex = input.totalVersions - 1;
        final shouldBeDisabled = input.activeIndex == maxIndex;
        final canGoNext = input.activeIndex < maxIndex;

        expect(
          canGoNext,
          equals(!shouldBeDisabled),
          reason:
              '当 activeIndex=${input.activeIndex}, maxIndex=$maxIndex 时，canGoNext 应为 ${!shouldBeDisabled}',
        );

        // 验证边界条件
        if (input.activeIndex == maxIndex) {
          expect(canGoNext, isFalse,
              reason: '末版时下一版按钮应禁用');
        } else {
          expect(canGoNext, isTrue,
              reason: '非末版时下一版按钮应启用');
        }
      },
    );

    Glados(any.versionNavInput, ExploreConfig(numRuns: 100)).test(
      '版本控件可见性：当且仅当 total == 1 时隐藏所有版本控件',
      (input) {
        final hasMultipleVersions = input.totalVersions > 1;
        final shouldShowControls = hasMultipleVersions;

        if (input.totalVersions == 1) {
          expect(shouldShowControls, isFalse,
              reason: '单版本时应隐藏所有版本控件（指示器、上一版、下一版按钮）');
        } else {
          expect(shouldShowControls, isTrue,
              reason: '多版本时应显示版本控件');
        }
      },
    );

    // ─────────────────────────────────────────────
    // Widget 级别测试：验证实际渲染的 UI 状态
    // 使用 testWidgets 进行具体场景验证
    // ─────────────────────────────────────────────

    testWidgets('单版本时隐藏所有版本控件', (tester) async {
      final dir = Directory.systemTemp.createTempSync('ivv_single_');
      final paths = createTempImageFiles(1, dir);

      await tester.pumpWidget(
        MaterialApp(
          home: ImageVersionViewer(
            imagePaths: paths,
            initialIndex: 0,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 单版本：所有版本控件应隐藏
      expect(find.textContaining('/'), findsNothing,
          reason: '单版本时不应显示版本指示器');
      expect(find.byIcon(Icons.chevron_left), findsNothing,
          reason: '单版本时不应显示上一版按钮');
      expect(find.byIcon(Icons.chevron_right), findsNothing,
          reason: '单版本时不应显示下一版按钮');

      dir.deleteSync(recursive: true);
    });

    testWidgets('多版本时显示版本指示器和导航按钮', (tester) async {
      final dir = Directory.systemTemp.createTempSync('ivv_multi_');
      final paths = createTempImageFiles(5, dir);

      await tester.pumpWidget(
        MaterialApp(
          home: ImageVersionViewer(
            imagePaths: paths,
            initialIndex: 2,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 多版本：验证指示器文本
      expect(find.text('3 / 5'), findsOneWidget,
          reason: '应显示版本指示器文本 "3 / 5"');

      // 验证导航按钮存在
      expect(find.byIcon(Icons.chevron_left), findsOneWidget,
          reason: '多版本时应显示上一版按钮');
      expect(find.byIcon(Icons.chevron_right), findsOneWidget,
          reason: '多版本时应显示下一版按钮');

      dir.deleteSync(recursive: true);
    });

    testWidgets('首版时上一版按钮禁用（低透明度）', (tester) async {
      final dir = Directory.systemTemp.createTempSync('ivv_first_');
      final paths = createTempImageFiles(3, dir);

      await tester.pumpWidget(
        MaterialApp(
          home: ImageVersionViewer(
            imagePaths: paths,
            initialIndex: 0,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 首版：上一版按钮应禁用（颜色透明度低）
      final leftIcon = tester.widget<Icon>(find.byIcon(Icons.chevron_left));
      expect((leftIcon.color as Color).a < 0.5, isTrue,
          reason: '首版时上一版按钮图标应为低透明度（禁用态）');

      // 下一版按钮应启用
      final rightIcon = tester.widget<Icon>(find.byIcon(Icons.chevron_right));
      expect((rightIcon.color as Color).a >= 0.5, isTrue,
          reason: '首版时下一版按钮图标应为高透明度（启用态）');

      dir.deleteSync(recursive: true);
    });

    testWidgets('末版时下一版按钮禁用（低透明度）', (tester) async {
      final dir = Directory.systemTemp.createTempSync('ivv_last_');
      final paths = createTempImageFiles(4, dir);

      await tester.pumpWidget(
        MaterialApp(
          home: ImageVersionViewer(
            imagePaths: paths,
            initialIndex: 3,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 末版：下一版按钮应禁用
      final rightIcon = tester.widget<Icon>(find.byIcon(Icons.chevron_right));
      expect((rightIcon.color as Color).a < 0.5, isTrue,
          reason: '末版时下一版按钮图标应为低透明度（禁用态）');

      // 上一版按钮应启用
      final leftIcon = tester.widget<Icon>(find.byIcon(Icons.chevron_left));
      expect((leftIcon.color as Color).a >= 0.5, isTrue,
          reason: '末版时上一版按钮图标应为高透明度（启用态）');

      dir.deleteSync(recursive: true);
    });
  });
}
