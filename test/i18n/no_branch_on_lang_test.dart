// 文件作用：扫描 lib/ 目录禁止 `lang == 'en'` 之类语言分支
//
// 来源任务：flutter-parity-gaps-fill / 6.8 编写 `lang == 'en'` 分支扫描测试
// 落实需求：R2.2 —— 禁止子组件级 `if (lang == 'en')` 分支字体或文案，
//          所有语言切换 SHALL 经由 `MaterialApp.locale` + `I18n.t / tArgs`
//          统一注入，避免子组件级覆盖造成 UI 不一致。
//
// 测试思路：
//   1. 递归扫描 `lib/` 目录所有 `.dart` 文件；
//   2. 用正则 `lang\s*==\s*['"]en['"]` 匹配每一行；
//   3. 命中 0 处通过；命中 ≥ 1 处失败并打印「文件路径: 行号: 行内容」清单。
//
// 工作目录约定：`flutter test` 默认在 `lumimuse_flutter/` 下运行,
// 因此 `lib/` 直接用相对路径解析即可。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 命中 `lang == 'en'` / `lang == "en"` 的正则。
///
/// - `lang` 为完整变量名(用 `\b` 防止误伤 `language`、`my_lang2` 等);
/// - `\s*==\s*` 允许两侧任意空白;
/// - `['"]en['"]` 同时覆盖单引号与双引号字面量。
final RegExp _langEqEnPattern = RegExp(r'''\blang\s*==\s*['"]en['"]''');

void main() {
  group('lib/ 目录禁止 `lang == \'en\'` 语言分支扫描', () {
    final Directory libDir = Directory('lib');

    if (!libDir.existsSync()) {
      test('找不到 lib/ 目录', () {
        fail('找不到 lib/ 目录,请确认测试在 lumimuse_flutter/ 目录下执行');
      });
      return;
    }

    test('lib/ 下所有 .dart 文件均不包含 `lang == \'en\'` 形态的硬分支', () {
      final List<_BranchHit> hits = _scanLibForLangBranches(libDir);

      expect(
        hits,
        isEmpty,
        reason: _formatFailureReason(hits),
      );
    });

    test('扫描到的 .dart 文件数 > 0(防止扫描逻辑误把目录扫空)', () {
      // 这一条小型 sanity check 落实 RC-11 思路:
      // 如果未来重构把 `lib/` 重组成空目录,我们要让这条测试先失败,
      // 而不是第一条测试看似「0 命中通过」实际什么都没扫。
      final int dartFileCount = libDir
          .listSync(recursive: true, followLinks: false)
          .whereType<File>()
          .where((File f) => f.path.endsWith('.dart'))
          .length;
      expect(
        dartFileCount,
        greaterThan(0),
        reason: 'lib/ 下没有任何 .dart 文件,扫描逻辑形同虚设,请检查测试执行目录',
      );
    });
  });
}

/// 单次命中记录。
class _BranchHit {
  _BranchHit({
    required this.path,
    required this.lineNumber,
    required this.lineContent,
  });

  final String path;
  final int lineNumber;
  final String lineContent;

  @override
  String toString() => '$path:$lineNumber: ${lineContent.trim()}';
}

/// 递归扫描 [libDir] 下所有 `.dart` 文件,返回所有命中。
List<_BranchHit> _scanLibForLangBranches(Directory libDir) {
  final List<_BranchHit> hits = <_BranchHit>[];

  final Iterable<File> dartFiles = libDir
      .listSync(recursive: true, followLinks: false)
      .whereType<File>()
      .where((File f) => f.path.endsWith('.dart'));

  for (final File file in dartFiles) {
    final List<String> lines = file.readAsLinesSync();
    for (int i = 0; i < lines.length; i++) {
      final String line = lines[i];
      if (_langEqEnPattern.hasMatch(line)) {
        hits.add(
          _BranchHit(
            // 使用 POSIX 风格分隔符,Windows 上更易读。
            path: file.path.replaceAll(r'\', '/'),
            lineNumber: i + 1,
            lineContent: line,
          ),
        );
      }
    }
  }

  return hits;
}

/// 构造失败原因文本,逐条列出命中位置,便于主人快速定位。
String _formatFailureReason(List<_BranchHit> hits) {
  final StringBuffer buf = StringBuffer();
  buf.writeln(
    'R2.2 违例:lib/ 下检测到 ${hits.length} 处 `lang == \'en\'` 形态的硬分支',
  );
  buf.writeln('禁止子组件级 `if (lang == \'en\')` 分支字体或文案,');
  buf.writeln('所有语言相关行为应通过 `MaterialApp.locale` + `I18n.t / tArgs` 统一处理。');
  buf.writeln('命中清单:');
  for (final _BranchHit hit in hits) {
    buf.writeln('  - $hit');
  }
  buf.writeln('修复建议:');
  buf.writeln('  ① 把分支替换为 `I18n.t(\'xxx.yyy\')` / `I18n.tArgs(\'xxx.yyy\', {...})`;');
  buf.writeln('  ② 若必须按语言区分行为,改为读取 `ref.watch(localeProvider)` 后');
  buf.writeln('     在顶层 widget 一次性切换,而非子组件内分支。');
  return buf.toString();
}
