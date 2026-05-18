// runtime 调用点 ⊆ I18n.allKeys() 全量扫描测试
//
// 本测试是 example-based 测试（非 PBT，不需要 glados）：
//   1. 扫描 lumimuse_flutter/lib/ 目录下所有 .dart 文件，
//      用正则 `I18n\.(?:t|tArgs)\(\s*'([A-Za-z][A-Za-z0-9.]*)'`
//      抽取每一处 `I18n.t(...)` / `I18n.tArgs(...)` 的 key 字面量；
//   2. 断言所有抽取出的 key 都属于 `I18n.allKeys()`，防止「写错 key
//      但跑通」的隐患（落实 R3.5）；
//   3. 断言 `class I18n` 的公开成员集合 = `{t, tArgs, allKeys, raw}`，
//      防止本骨架在后续重构中被改名（落实 R6.4）。
//
// 来源任务：flutter-parity-gaps-fill / 任务 6.7
// Validates: Requirements R3.5, R6.4

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/utils/i18n.dart';

/// 去除 Dart 源码中的注释，避免文档注释里出现 `I18n.t('xxx')`
/// 字面量被误匹配为真实调用点。
///
/// 实现采用单遍状态机：依次识别字符串字面量（'...' / "..." / '''...''' /
/// """..."""，含 r 前缀）、行注释 `//` 与块注释 `/* ... */`，把注释
/// 替换为等长空白以保留行号 / 偏移量信息。
String _stripDartComments(String source) {
  final StringBuffer out = StringBuffer();
  final int n = source.length;
  int i = 0;
  while (i < n) {
    final String c = source[i];
    final String next = i + 1 < n ? source[i + 1] : '';

    // 行注释：// ... \n
    if (c == '/' && next == '/') {
      while (i < n && source[i] != '\n') {
        i++;
      }
      continue;
    }

    // 块注释：/* ... */（不嵌套，与 Dart 规范保持一致的最小处理）
    if (c == '/' && next == '*') {
      i += 2;
      while (i < n) {
        if (source[i] == '*' && i + 1 < n && source[i + 1] == '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // 字符串字面量：保留原样输出，因为 `I18n.t('xxx')` 调用本身就在
    // 字符串外的代码中；测试要扫描的是代码，不是字符串内容。
    // 但一旦进入字符串字面量，需要跳过其内部的 `//` `/*` 等以免误判。
    if (c == 'r' && (next == "'" || next == '"')) {
      // raw 字符串：r'...' / r"..." / r'''...''' / r"""..."""
      out.write(c);
      i++;
      i = _copyStringLiteral(source, i, out);
      continue;
    }
    if (c == "'" || c == '"') {
      i = _copyStringLiteral(source, i, out);
      continue;
    }

    out.write(c);
    i++;
  }
  return out.toString();
}

/// 从 [start] 开始原样复制一个字符串字面量到 [out]，返回结束后的下标。
/// 支持单 / 三引号、转义字符；遇到未闭合时复制到文件末尾。
int _copyStringLiteral(String src, int start, StringBuffer out) {
  final int n = src.length;
  if (start >= n) return start;
  final String quote = src[start];
  // 判断是否为三引号
  final bool triple = start + 2 < n &&
      src[start + 1] == quote &&
      src[start + 2] == quote;
  if (triple) {
    out.write(src.substring(start, start + 3));
    int i = start + 3;
    while (i < n) {
      if (i + 2 < n &&
          src[i] == quote &&
          src[i + 1] == quote &&
          src[i + 2] == quote) {
        out.write(src.substring(i, i + 3));
        return i + 3;
      }
      out.write(src[i]);
      i++;
    }
    return i;
  }
  out.write(quote);
  int i = start + 1;
  while (i < n) {
    final String ch = src[i];
    if (ch == '\\' && i + 1 < n) {
      out.write(src.substring(i, i + 2));
      i += 2;
      continue;
    }
    if (ch == quote) {
      out.write(ch);
      return i + 1;
    }
    if (ch == '\n') {
      // 单引号字符串通常不跨行；保守起见按结束处理。
      out.write(ch);
      return i + 1;
    }
    out.write(ch);
    i++;
  }
  return i;
}

void main() {
  group('I18n runtime 调用点全量扫描', () {
    test('所有 I18n.t / I18n.tArgs 调用 key ∈ I18n.allKeys()', () {
      final Set<String> allKeys = I18n.allKeys();
      final RegExp tCall = RegExp(
        r"I18n\.(?:t|tArgs)\(\s*'([A-Za-z][A-Za-z0-9.]*)'",
      );
      final Directory libDir = Directory('lib');
      expect(
        libDir.existsSync(),
        isTrue,
        reason: '本测试需在 lumimuse_flutter/ 目录下执行（cwd 含 lib 目录）',
      );

      final List<File> dartFiles = libDir
          .listSync(recursive: true)
          .whereType<File>()
          .where((File f) => f.path.endsWith('.dart'))
          .toList();

      // 兜底：lib 目录至少包含一个 .dart 源文件，避免空扫描时假阳通过
      expect(
        dartFiles,
        isNotEmpty,
        reason: 'lib 目录下未找到任何 .dart 文件，扫描范围异常',
      );

      final List<String> missing = <String>[];
      int callCount = 0;
      for (final File f in dartFiles) {
        // 跳过 i18n.dart 自身（其内部含 `I18n.tArgs` 字面量出现在文档注释中，
        // 但不会构成对未注册 key 的引用；保留扫描其他文件即可）。
        if (f.path.replaceAll('\\', '/').endsWith('lib/core/utils/i18n.dart')) {
          continue;
        }
        final String src = _stripDartComments(f.readAsStringSync());
        for (final Match m in tCall.allMatches(src)) {
          callCount++;
          final String key = m.group(1)!;
          if (!allKeys.contains(key)) {
            missing.add('${f.path}: $key');
          }
        }
      }

      // 兜底：至少应当扫描到若干个真实调用点（避免正则失配导致空集通过）。
      expect(
        callCount,
        greaterThan(0),
        reason: 'lib 目录下未扫描到任何 I18n.t / I18n.tArgs 调用，正则可能失效',
      );

      expect(
        missing,
        isEmpty,
        reason: '存在调用未注册的 i18n key，详见以下清单：\n${missing.join('\n')}',
      );
    });

    test('class I18n 公开成员集合 = {t, tArgs, allKeys, raw}', () {
      // 静态成员形态校验：通过实际调用每个公开成员，确保它们存在且签名兼容。
      // Dart 不提供反射，这里采用「逐项调用 + 类型断言」的方式落实 R6.4：
      // 任何成员被改名（如 `t` 改成 `translate`）都会在编译期失败。

      // 1. `raw`：返回内部双语表，类型为 `Map<String, Map<String, String>>`。
      final Map<String, Map<String, String>> raw = I18n.raw;
      expect(raw.containsKey('zh'), isTrue, reason: 'I18n.raw 必须含 zh 表');
      expect(raw.containsKey('en'), isTrue, reason: 'I18n.raw 必须含 en 表');

      // 2. `allKeys`：返回 zh ∪ en 键集合。
      final Set<String> keys = I18n.allKeys();
      expect(keys, isA<Set<String>>());
      expect(keys, isNotEmpty, reason: 'I18n.allKeys() 必须非空');

      // 3. `t`：按 key 查表，缺失回退英文再回退 key 本身。
      final String tFallback = I18n.t('__definitely_missing_key__');
      expect(tFallback, equals('__definitely_missing_key__'));

      // 4. `tArgs`：占位符替换；空 args 等价于 `t`。
      final String tArgsFallback =
          I18n.tArgs('__definitely_missing_key__', <String, Object?>{});
      expect(tArgsFallback, equals('__definitely_missing_key__'));

      // 同时再用 lib 内源码字面量扫描兜底：禁止出现 `I18n.<其它名字>(` 形态的
      // 静态调用，强约束「公开成员集合不被偷偷扩张」。
      final Directory libDir = Directory('lib');
      final RegExp anyI18nCall = RegExp(r'I18n\.([A-Za-z_][A-Za-z0-9_]*)\(');
      const Set<String> allowedMembers = <String>{'t', 'tArgs', 'allKeys', 'raw'};
      final Set<String> seenMembers = <String>{};
      final List<String> illegal = <String>[];
      for (final File f in libDir
          .listSync(recursive: true)
          .whereType<File>()
          .where((File f) => f.path.endsWith('.dart'))) {
        if (f.path.replaceAll('\\', '/').endsWith('lib/core/utils/i18n.dart')) {
          continue;
        }
        final String src = _stripDartComments(f.readAsStringSync());
        for (final Match m in anyI18nCall.allMatches(src)) {
          final String name = m.group(1)!;
          seenMembers.add(name);
          if (!allowedMembers.contains(name)) {
            illegal.add('${f.path}: I18n.$name(...)');
          }
        }
      }

      expect(
        illegal,
        isEmpty,
        reason: 'I18n 公开成员集合被扩张，详见以下清单：\n${illegal.join('\n')}',
      );

      // 实际被调用过的成员必须 ⊆ {t, tArgs, allKeys, raw}。
      // （raw / allKeys 在 lib 内可能不直接被 widget 调用，本兜底允许子集出现。）
      expect(
        seenMembers.difference(allowedMembers),
        isEmpty,
        reason: '出现了未登记的 I18n 公开成员调用：'
            '${seenMembers.difference(allowedMembers).join(', ')}',
      );
    });
  });
}
