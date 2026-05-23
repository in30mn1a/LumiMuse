// AppIcons 25 键 widget smoke 测试
//
// 覆盖范围：
//   1. 维护一份与 `AppIcons` 同步的 25 个字段列表（lowerCamelCase + 主项目
//      PascalCase 导出名），逐个用 `tester.pumpWidget(MaterialApp(home:
//      Icon(field, size: 24)))` 渲染并断言 `find.byIcon(field)` 命中 1 个
//      widget；
//   2. 断言所有字段为非占位 IconData（codePoint != 0），落实 GAP-D7；
//   3. 断言列表长度为 25 且字段名集合无重复，作为「列表与契约同步」兜底。
//
// 来源任务：flutter-parity-gaps-fill / 任务 2.2
// Validates: Requirements R4.3, R4.4

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/theme/app_icons.dart';

/// 主项目导出名（PascalCase）+ Flutter 端字段（[IconData]）的二元组。
///
/// 列表必须与 `lib/theme/app_icons.dart` 内 `class AppIcons` 字段保持同步：
/// 修改图标契约时，请同步在主项目 `src/components/ui/icons.tsx` 与本列表
/// 中登记。
class _IconEntry {
  const _IconEntry(this.exportName, this.icon);
  final String exportName;
  final IconData icon;
}

const List<_IconEntry> _entries = <_IconEntry>[
  // ── 导航与操作 ──
  _IconEntry('MenuIcon', AppIcons.menuIcon),
  _IconEntry('MoreVerticalIcon', AppIcons.moreVerticalIcon),
  _IconEntry('PlusIcon', AppIcons.plusIcon),
  _IconEntry('ChevronDownIcon', AppIcons.chevronDownIcon),
  _IconEntry('ArrowLeftIcon', AppIcons.arrowLeftIcon),

  // ── 主功能区 ──
  _IconEntry('ChatIcon', AppIcons.chatIcon),
  _IconEntry('MemoryIcon', AppIcons.memoryIcon),
  _IconEntry('SettingsIcon', AppIcons.settingsIcon),
  _IconEntry('SearchIcon', AppIcons.searchIcon),

  // ── 编辑与状态 ──
  _IconEntry('PencilIcon', AppIcons.pencilIcon),
  _IconEntry('TrashIcon', AppIcons.trashIcon),
  _IconEntry('ClockIcon', AppIcons.clockIcon),
  _IconEntry('CheckIcon', AppIcons.checkIcon),
  _IconEntry('StopIcon', AppIcons.stopIcon),
  _IconEntry('RefreshIcon', AppIcons.refreshIcon),

  // ── 内容与多媒体 ──
  _IconEntry('CameraIcon', AppIcons.cameraIcon),
  _IconEntry('LinkIcon', AppIcons.linkIcon),
  _IconEntry('CopyIcon', AppIcons.copyIcon),
  _IconEntry('DuplicateIcon', AppIcons.duplicateIcon),
  _IconEntry('ReplyIcon', AppIcons.replyIcon),
  _IconEntry('SummaryIcon', AppIcons.summaryIcon),
  _IconEntry('ListIcon', AppIcons.listIcon),
  _IconEntry('ImageIcon', AppIcons.imageIcon),

  // ── 装饰与魔法 ──
  _IconEntry('SparkIcon', AppIcons.sparkIcon),
  _IconEntry('WandIcon', AppIcons.wandIcon),
];

void main() {
  group('AppIcons · 25 键契约（需求 R4.3 / R4.4）', () {
    test('字段列表长度为 25 且导出名无重复', () {
      expect(
        _entries.length,
        25,
        reason: 'AppIcons 应包含 25 个图标字段，与主项目 src/components/ui/icons.tsx '
            '导出符号数量严格一致',
      );
      final Set<String> uniqueNames =
          _entries.map((e) => e.exportName).toSet();
      expect(
        uniqueNames.length,
        25,
        reason: '导出名集合不应有重复（Set 长度应等于列表长度）',
      );
    });

    test('所有字段为非占位 IconData（codePoint != 0，落实 GAP-D7）', () {
      for (final _IconEntry entry in _entries) {
        expect(
          entry.icon.codePoint,
          isNot(0),
          reason: 'AppIcons.${entry.exportName} 不应为 IconData(0) 占位',
        );
      }
    });

    for (final _IconEntry entry in _entries) {
      testWidgets('AppIcons.${entry.exportName} 可渲染并被 find.byIcon 命中',
          (WidgetTester tester) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Icon(entry.icon, size: 24),
          ),
        );
        expect(
          find.byIcon(entry.icon),
          findsOneWidget,
          reason: 'AppIcons.${entry.exportName} 应在 widget 树中渲染为唯一 Icon',
        );
      });
    }
  });
}
