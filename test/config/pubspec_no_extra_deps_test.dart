// 文件作用：pubspec 依赖增量 smoke 测试
//
// 来源任务：flutter-parity-gaps-fill / 4.6 编写 pubspec 依赖增量 smoke 测试；
// 后续 flutter-audit-remediation-2026-06-07 允许安全存储依赖。
// 落实需求：R6.2 + 审计整改需求 1 —— 依赖增量必须显式登记在白名单。
//
// 测试思路：
//   1. 硬编码「本 spec 实施前」的依赖基线（pre-spec baseline），分别记录在
//      [_baselineDependencies] 与 [_baselineDevDependencies]；
//   2. 用最小的行级扫描解析 pubspec.yaml 顶层 `dependencies:` 与
//      `dev_dependencies:` 两段，提取 2 空格缩进下的依赖键（不引入 `yaml` 包，
//      避免本测试自身额外引入依赖，绕过 R6.2 约束）；
//   3. 计算增量 = 当前 − 基线，断言 ⊆ {flutter_localizations}；
//   4. 失败时打印新增依赖列表（区分 dependencies / dev_dependencies），便于定位。
//
// 注意：本测试不校验依赖版本号，只校验「键集合」；版本升级不应触发本测试失败。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 本 spec 实施前 `dependencies:` 段已有的依赖键集合。
///
/// FIX: M5 同步删除 riverpod_annotation / json_annotation —— 这两个包此前
/// 在 pubspec 但项目代码从未使用，移除后基线必须随之收缩，否则 difference
/// 计算会错误地把「白名单内允许的新增项」与「被删除项」混在一起。
const Set<String> _baselineDependencies = <String>{
  'flutter',
  'flutter_riverpod',
  'drift',
  'sqlite3_flutter_libs',
  'go_router',
  'dio',
  'uuid',
  'path_provider',
  'path',
  'intl',
  'characters',
  'shared_preferences',
  'image_picker',
  'file_picker',
  'share_plus',
  'url_launcher',
  'flutter_markdown',
  'cached_network_image',
  'google_fonts',
  'flutter_animate',
  'reorderable_grid_view',
  'image_cropper',
  'archive',
  'cryptography',
};

/// 本 spec 实施前 `dev_dependencies:` 段已有的依赖键集合。
///
/// FIX: M5 同步删除 json_serializable / riverpod_generator —— 同上理由。
const Set<String> _baselineDevDependencies = <String>{
  'flutter_test',
  'integration_test',
  'flutter_lints',
  'build_runner',
  'drift_dev',
  'glados',
};

/// 已审查并允许新增的依赖键集合（白名单）。
///
/// - `flutter_localizations`：i18n 中文/英文双语支持
/// - `flutter_secure_storage`：API Key 安全存储（feat(security): migrate API keys）
/// - `crypto`：记忆向量嵌入文本哈希（SHA-256）— 对齐主项目
///   `src/lib/memory-embeddings.ts:210-212`，Wave 8 引入但漏登记，此处补登
const Set<String> _allowedNewDependencies = <String>{
  'flutter_localizations',
  'flutter_secure_storage',
  'crypto',
};

void main() {
  group('pubspec 依赖增量 smoke', () {
    final File pubspecFile = File('pubspec.yaml');
    if (!pubspecFile.existsSync()) {
      // group body 中不能直接调用 expect，把缺失检查延迟到 test 内 fail。
      test('找不到 pubspec.yaml', () {
        fail('找不到 pubspec.yaml，请确认测试在 lumimuse_flutter/ 目录下执行');
      });
      return;
    }

    final String pubspecText = pubspecFile.readAsStringSync();
    final _PubspecSections sections = _parsePubspecSections(pubspecText);

    test('dependencies 增量 ⊆ 已审查白名单', () {
      final Set<String> increment =
          sections.dependencies.difference(_baselineDependencies);
      final Set<String> illegal =
          increment.difference(_allowedNewDependencies);

      expect(
        illegal,
        isEmpty,
        reason: _formatFailureReason(
          section: 'dependencies',
          increment: increment,
          illegal: illegal,
        ),
      );
    });

    test('dev_dependencies 增量 ⊆ 已审查白名单', () {
      final Set<String> increment =
          sections.devDependencies.difference(_baselineDevDependencies);
      final Set<String> illegal =
          increment.difference(_allowedNewDependencies);

      expect(
        illegal,
        isEmpty,
        reason: _formatFailureReason(
          section: 'dev_dependencies',
          increment: increment,
          illegal: illegal,
        ),
      );
    });

    test('依赖键集合非空（pubspec 解析正常）', () {
      // 防止解析逻辑误把整个文件解析空之后,误以为「没有任何新增」从而通过测试。
      expect(
        sections.dependencies,
        isNotEmpty,
        reason: 'pubspec.yaml 的 dependencies 段被解析为空,可能是格式异常',
      );
      expect(
        sections.devDependencies,
        isNotEmpty,
        reason: 'pubspec.yaml 的 dev_dependencies 段被解析为空,可能是格式异常',
      );
      // 基线中的关键依赖必须能被解析出来,验证解析逻辑覆盖正确。
      expect(sections.dependencies, contains('flutter_riverpod'));
      expect(sections.devDependencies, contains('flutter_test'));
    });
  });
}

/// 解析后的 pubspec 顶层依赖段。
class _PubspecSections {
  _PubspecSections({
    required this.dependencies,
    required this.devDependencies,
  });

  final Set<String> dependencies;
  final Set<String> devDependencies;
}

/// 简易行级解析 pubspec.yaml 的顶层 `dependencies:` 与 `dev_dependencies:` 段。
///
/// 仅识别 2 空格缩进的依赖键(形如 `  package_name:` 或 `  package_name: ^x.y.z`),
/// 跳过空行、注释行和更深缩进的子字段(如 `    sdk: flutter`)。
/// 一旦遇到新的零缩进顶层键(如 `flutter:`、`environment:`),即结束当前段。
_PubspecSections _parsePubspecSections(String source) {
  final List<String> lines = source.split('\n');

  // 顶层 section 标识(零缩进 + key + 冒号)。
  final RegExp topLevelKey = RegExp(r'^([A-Za-z_][A-Za-z0-9_]*):\s*$');
  // 2 空格缩进下的依赖键(允许冒号后跟版本号或为空)。
  final RegExp depKey = RegExp(r'^  ([A-Za-z_][A-Za-z0-9_]*):');

  final Set<String> deps = <String>{};
  final Set<String> devDeps = <String>{};

  String? currentSection; // 'dependencies' / 'dev_dependencies' / null

  for (final String rawLine in lines) {
    // 去掉行尾 \r(Windows 换行)。
    final String line =
        rawLine.endsWith('\r') ? rawLine.substring(0, rawLine.length - 1) : rawLine;

    // 跳过空行与整行注释。
    if (line.trim().isEmpty) continue;
    if (line.trimLeft().startsWith('#')) continue;

    // 顶层键:切换 section。
    final Match? topMatch = topLevelKey.firstMatch(line);
    if (topMatch != null) {
      final String key = topMatch.group(1)!;
      if (key == 'dependencies' || key == 'dev_dependencies') {
        currentSection = key;
      } else {
        currentSection = null;
      }
      continue;
    }

    // 当前不在依赖段,跳过。
    if (currentSection == null) continue;

    // 2 空格缩进的依赖键。
    final Match? depMatch = depKey.firstMatch(line);
    if (depMatch != null) {
      final String name = depMatch.group(1)!;
      if (currentSection == 'dependencies') {
        deps.add(name);
      } else if (currentSection == 'dev_dependencies') {
        devDeps.add(name);
      }
    }
    // 更深缩进(如 4 空格的 `    sdk: flutter`)或 `dependency_overrides` 等其它顶层键不在此处理。
  }

  return _PubspecSections(dependencies: deps, devDependencies: devDeps);
}

/// 构造失败原因文本,清晰列出新增依赖,便于主人定位。
String _formatFailureReason({
  required String section,
  required Set<String> increment,
  required Set<String> illegal,
}) {
  final List<String> illegalSorted = illegal.toList()..sort();
  final List<String> incrementSorted = increment.toList()..sort();
  final List<String> allowedSorted = _allowedNewDependencies.toList()..sort();
  final StringBuffer buf = StringBuffer();
  buf.writeln('flutter-parity-gaps-fill 不允许超出白名单的新增依赖');
  buf.writeln('  段:           $section');
  buf.writeln('  白名单:        $allowedSorted');
  buf.writeln('  本次新增:      $incrementSorted');
  buf.writeln('  超出白名单的:  $illegalSorted');
  buf.writeln('  处理建议:     ① 若依赖确属必要,请先在 design.md 中显式登记理由;');
  buf.writeln('               ② 否则请回退该依赖,并改用现有依赖或 Flutter SDK 自带能力。');
  return buf.toString();
}
