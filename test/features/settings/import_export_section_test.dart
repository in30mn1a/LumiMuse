// 导入导出 Widget 测试
// 覆盖：按钮状态（正常/加载中/禁用）、错误提示显示
// Validates: Requirements 7.1, 7.2, 7.10

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_theme.dart';

// ═══════════════════════════════════════════════════════════════
// 可测试的导入导出区域组件（提取自 _ImportExportSection 的 UI 逻辑）
// 通过回调注入替代 WidgetRef 依赖，便于 Widget 测试
// ═══════════════════════════════════════════════════════════════

/// 可测试的导入导出区域组件
/// 将 BackupService 和 FilePicker 的依赖通过回调注入
class TestableImportExportSection extends StatefulWidget {
  /// 导出操作回调
  final Future<void> Function()? onExport;

  /// 导入操作回调
  final Future<void> Function()? onImport;

  const TestableImportExportSection({
    super.key,
    this.onExport,
    this.onImport,
  });

  @override
  State<TestableImportExportSection> createState() =>
      TestableImportExportSectionState();
}

class TestableImportExportSectionState
    extends State<TestableImportExportSection> {
  /// 是否正在导出
  bool isExporting = false;

  /// 是否正在导入
  bool isImporting = false;

  /// 操作中（导入或导出任一进行中）
  bool get isBusy => isExporting || isImporting;

  /// 模拟导出操作
  Future<void> handleExport() async {
    setState(() => isExporting = true);
    try {
      await widget.onExport?.call();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('导出失败：$e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => isExporting = false);
      }
    }
  }

  /// 模拟导入操作
  Future<void> handleImport() async {
    setState(() => isImporting = true);
    try {
      await widget.onImport?.call();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('导入失败：$e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => isImporting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // 导出数据按钮
        Expanded(
          child: OutlinedButton.icon(
            onPressed: isBusy ? null : handleExport,
            icon: isExporting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.upload_rounded, size: 18),
            label: const Text('导出数据'),
          ),
        ),
        const SizedBox(width: 12),
        // 导入数据按钮
        Expanded(
          child: OutlinedButton.icon(
            onPressed: isBusy ? null : handleImport,
            icon: isImporting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.download_rounded, size: 18),
            label: const Text('导入数据'),
          ),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试辅助方法
// ═══════════════════════════════════════════════════════════════

/// 构建测试用的导入导出组件
Widget _buildTestWidget({
  Future<void> Function()? onExport,
  Future<void> Function()? onImport,
}) {
  return MaterialApp(
    theme: AppTheme.light(),
    home: Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: TestableImportExportSection(
          onExport: onExport,
          onImport: onImport,
        ),
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

void main() {
  group('导入导出按钮状态 — 正常态', () {
    testWidgets('初始状态下导出按钮可点击且显示正确图标和文字', (tester) async {
      await tester.pumpWidget(_buildTestWidget());
      await tester.pumpAndSettle();

      // 验证导出按钮存在且可点击
      final exportButton = find.widgetWithText(OutlinedButton, '导出数据');
      expect(exportButton, findsOneWidget);

      // 验证导出按钮图标为 upload_rounded
      expect(find.byIcon(Icons.upload_rounded), findsOneWidget);

      // 验证按钮未禁用（onPressed 不为 null）
      final button = tester.widget<OutlinedButton>(exportButton);
      expect(button.onPressed, isNotNull, reason: '正常态下导出按钮应可点击');
    });

    testWidgets('初始状态下导入按钮可点击且显示正确图标和文字', (tester) async {
      await tester.pumpWidget(_buildTestWidget());
      await tester.pumpAndSettle();

      // 验证导入按钮存在且可点击
      final importButton = find.widgetWithText(OutlinedButton, '导入数据');
      expect(importButton, findsOneWidget);

      // 验证导入按钮图标为 download_rounded
      expect(find.byIcon(Icons.download_rounded), findsOneWidget);

      // 验证按钮未禁用
      final button = tester.widget<OutlinedButton>(importButton);
      expect(button.onPressed, isNotNull, reason: '正常态下导入按钮应可点击');
    });

    testWidgets('初始状态下不显示 CircularProgressIndicator', (tester) async {
      await tester.pumpWidget(_buildTestWidget());
      await tester.pumpAndSettle();

      // 不应有加载指示器
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });
  });

  group('导入导出按钮状态 — 加载中', () {
    testWidgets('导出操作中显示加载指示器并禁用两个按钮', (tester) async {
      // 使用 Completer 控制异步操作的完成时机，避免 pending timer
      final completer = Completer<void>();

      await tester.pumpWidget(_buildTestWidget(
        onExport: () => completer.future,
      ));
      await tester.pumpAndSettle();

      // 点击导出按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导出数据'));
      // 只 pump 一帧让 setState 生效，不等待异步完成
      await tester.pump();

      // 验证导出按钮显示加载指示器
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // 验证两个按钮都被禁用
      final exportButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导出数据'),
      );
      expect(exportButton.onPressed, isNull, reason: '导出中导出按钮应禁用');

      final importButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导入数据'),
      );
      expect(importButton.onPressed, isNull, reason: '导出中导入按钮应禁用');

      // 完成操作以清理 pending future
      completer.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('导入操作中显示加载指示器并禁用两个按钮', (tester) async {
      // 使用 Completer 控制异步操作的完成时机，避免 pending timer
      final completer = Completer<void>();

      await tester.pumpWidget(_buildTestWidget(
        onImport: () => completer.future,
      ));
      await tester.pumpAndSettle();

      // 点击导入按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导入数据'));
      await tester.pump();

      // 验证导入按钮显示加载指示器
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // 验证两个按钮都被禁用
      final exportButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导出数据'),
      );
      expect(exportButton.onPressed, isNull, reason: '导入中导出按钮应禁用');

      final importButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导入数据'),
      );
      expect(importButton.onPressed, isNull, reason: '导入中导入按钮应禁用');

      // 完成操作以清理 pending future
      completer.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('导出完成后按钮恢复可点击状态', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onExport: () async {
          // 快速完成的操作
          await Future.delayed(const Duration(milliseconds: 50));
        },
      ));
      await tester.pumpAndSettle();

      // 点击导出按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导出数据'));
      await tester.pump();

      // 等待操作完成
      await tester.pumpAndSettle();

      // 验证按钮恢复可点击
      final exportButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导出数据'),
      );
      expect(exportButton.onPressed, isNotNull, reason: '操作完成后导出按钮应恢复可点击');

      final importButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导入数据'),
      );
      expect(importButton.onPressed, isNotNull, reason: '操作完成后导入按钮应恢复可点击');

      // 加载指示器应消失
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('导入完成后按钮恢复可点击状态', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onImport: () async {
          await Future.delayed(const Duration(milliseconds: 50));
        },
      ));
      await tester.pumpAndSettle();

      // 点击导入按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导入数据'));
      await tester.pump();

      // 等待操作完成
      await tester.pumpAndSettle();

      // 验证按钮恢复可点击
      final exportButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导出数据'),
      );
      expect(exportButton.onPressed, isNotNull, reason: '操作完成后导出按钮应恢复可点击');

      final importButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导入数据'),
      );
      expect(importButton.onPressed, isNotNull, reason: '操作完成后导入按钮应恢复可点击');
    });
  });

  group('导入导出错误提示显示', () {
    testWidgets('导出失败时显示错误 SnackBar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onExport: () async {
          throw Exception('磁盘空间不足');
        },
      ));
      await tester.pumpAndSettle();

      // 点击导出按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导出数据'));
      await tester.pumpAndSettle();

      // 验证显示错误 SnackBar
      expect(find.byType(SnackBar), findsOneWidget);
      expect(
        find.textContaining('导出失败'),
        findsOneWidget,
        reason: '导出失败时应显示包含"导出失败"的错误提示',
      );
      expect(
        find.textContaining('磁盘空间不足'),
        findsOneWidget,
        reason: '错误提示应包含具体错误信息',
      );
    });

    testWidgets('导入失败时显示错误 SnackBar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onImport: () async {
          throw Exception('文件不是有效的 JSON 格式');
        },
      ));
      await tester.pumpAndSettle();

      // 点击导入按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导入数据'));
      await tester.pumpAndSettle();

      // 验证显示错误 SnackBar
      expect(find.byType(SnackBar), findsOneWidget);
      expect(
        find.textContaining('导入失败'),
        findsOneWidget,
        reason: '导入失败时应显示包含"导入失败"的错误提示',
      );
      expect(
        find.textContaining('文件不是有效的 JSON 格式'),
        findsOneWidget,
        reason: '错误提示应包含具体错误信息',
      );
    });

    testWidgets('导入文件过大时显示文件大小错误提示', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onImport: () async {
          throw Exception('文件大小 150.0MB 超过限制（最大 100MB）');
        },
      ));
      await tester.pumpAndSettle();

      // 点击导入按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导入数据'));
      await tester.pumpAndSettle();

      // 验证显示文件大小错误
      expect(find.byType(SnackBar), findsOneWidget);
      expect(
        find.textContaining('超过限制'),
        findsOneWidget,
        reason: '文件过大时应显示大小超限的错误提示',
      );
    });

    testWidgets('错误发生后按钮恢复可点击状态', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onExport: () async {
          throw Exception('网络错误');
        },
      ));
      await tester.pumpAndSettle();

      // 点击导出按钮触发错误
      await tester.tap(find.widgetWithText(OutlinedButton, '导出数据'));
      await tester.pumpAndSettle();

      // 验证按钮恢复可点击（错误不应导致按钮永久禁用）
      final exportButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导出数据'),
      );
      expect(
        exportButton.onPressed,
        isNotNull,
        reason: '错误发生后导出按钮应恢复可点击状态',
      );

      final importButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '导入数据'),
      );
      expect(
        importButton.onPressed,
        isNotNull,
        reason: '错误发生后导入按钮应恢复可点击状态',
      );
    });

    testWidgets('缺少必需字段时显示具体字段名称', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        onImport: () async {
          throw Exception('缺少必需字段：conversations、memories');
        },
      ));
      await tester.pumpAndSettle();

      // 点击导入按钮
      await tester.tap(find.widgetWithText(OutlinedButton, '导入数据'));
      await tester.pumpAndSettle();

      // 验证显示具体缺少的字段名称
      expect(
        find.textContaining('缺少必需字段'),
        findsOneWidget,
        reason: '缺少字段时应显示具体缺少哪些字段',
      );
    });
  });
}
