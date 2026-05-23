// Feature: flutter-parity-gaps-fill, Property 2: I18n.tArgs 占位符替换语义
// Validates: Requirements R1.7
//
// 设计说明
// ────────
// design.md §Correctness Properties §Property 2 / requirements.md §R1.7 要求：
// 对任意合法 template（含 0 ~ N 个 `{name}` 占位符，name 为
// `[A-Za-z_][A-Za-z0-9_]*`）与任意 args（Map<String, Object?>），下列四条
// 子属性恒成立。
//
//   1. 替换正确：对每个 `name ∈ template ∩ args.keys`，结果中对应位置的
//      `{name}` 字面量被替换为 `args[name]?.toString() ?? ''`，其他位置
//      保持原样。
//   2. 幂等性：当 args 中所有值的 `toString()` 不再含 `{any}` 形态占位符
//      时，`tArgs(tArgs(t, args), args) == tArgs(t, args)`。
//   3. 缺失保留：当 `name ∈ template` 但 `name ∉ args.keys` 时，输出中
//      对应的 `{name}` 字面量必须原样保留（次数与 template 中相同）。
//   4. 多余忽略：args 中含有 template 不出现的键时，结果与剔除这些
//      多余键后的 args 等价。
//
// 实施位置：`lumimuse_flutter/lib/core/utils/i18n.dart` 中的
// `I18n.tArgs(key, args, {lang})`。
//
// 测试基础设施
// ────────────
// 由于 `I18n.tArgs(key, ...)` 内部先调用 `I18n.t(key)` 取模板，本测试通过
// 临时把模板写入 `I18n.raw['zh']!['__pbt_t_args_synthetic_template__']`
// 的方式让 `t(key)` 返回随机生成的模板字符串，再调用 `tArgs(...)`
// 验证替换语义。每个用例执行后通过 `try/finally` 清理写入，避免污染
// 其他测试。
//
// 100 次 runs。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/utils/i18n.dart';

// ──────────────────────────────────────────────────────────────────────────
// 用例数据结构
// ──────────────────────────────────────────────────────────────────────────

class _TArgsCase {
  final String template;
  final Map<String, Object?> args;

  const _TArgsCase(this.template, this.args);

  @override
  String toString() =>
      '_TArgsCase(template="${_quote(template)}", args=$args)';
}

String _quote(String s) => s
    .replaceAll(r'\', r'\\')
    .replaceAll('\n', r'\n')
    .replaceAll('\r', r'\r')
    .replaceAll('\t', r'\t');

// ──────────────────────────────────────────────────────────────────────────
// 生成器
//
// - 名字池子用一个较小的集合，确保模板占位符与 args.keys 之间有较高的
//   交集概率，避免大部分用例都退化成「全部多余忽略」。
// - 普通字面段池子刻意排除 `{` / `}` 字符，避免无意中构造出额外的
//   占位符（例如 `{0}` / `{name}`），保证「name ∉ args.keys 时保留」这
//   一断言只对生成器明确插入的占位符负责。
// - args 的值同时覆盖 String / int / null / bool 四种典型 toString 路径，
//   并保证 String 值不含 `{` 或 `}`，以便属性 2（幂等性）能稳定走通。
// ──────────────────────────────────────────────────────────────────────────

const List<String> _kNamePool = <String>[
  'name',
  'page',
  'totalPages',
  'pageSize',
  'count',
  'a',
  'x',
  '_b',
  'foo',
  'bar',
];

const List<String> _kPlainPool = <String>[
  '你', '好', '页', '条', '/', '-', ':', '.', ' ', 'a', 'b', '0', '1',
];

extension on Any {
  Generator<_TArgsCase> get tArgsCase {
    return intInRange(0, 1 << 30).map(_buildCase);
  }
}

_TArgsCase _buildCase(int seed) {
  final rng = math.Random(seed);

  // 模板：1 ~ 6 段，每段以 50% 概率为占位符 / 50% 概率为普通字面段。
  // 普通字面段长度 0 ~ 4，组成元素来自 `_kPlainPool`（不含 `{` / `}`）。
  final segCount = 1 + rng.nextInt(6);
  final buffer = StringBuffer();
  for (var i = 0; i < segCount; i++) {
    if (rng.nextBool()) {
      final name = _kNamePool[rng.nextInt(_kNamePool.length)];
      buffer.write('{$name}');
    } else {
      final len = rng.nextInt(5);
      for (var j = 0; j < len; j++) {
        buffer.write(_kPlainPool[rng.nextInt(_kPlainPool.length)]);
      }
    }
  }
  final template = buffer.toString();

  // args：0 ~ 5 项；键来自同一名字池子（保证有较高重叠概率）；
  // 值覆盖 String/int/null/bool 四类，且 String 值不含 `{` / `}`。
  final argCount = rng.nextInt(6);
  final args = <String, Object?>{};
  for (var i = 0; i < argCount; i++) {
    final key = _kNamePool[rng.nextInt(_kNamePool.length)];
    final kind = rng.nextInt(4);
    final Object? value = switch (kind) {
      0 => 'v${rng.nextInt(1000)}',
      1 => rng.nextInt(10000),
      2 => null,
      _ => rng.nextBool(),
    };
    args[key] = value;
  }

  return _TArgsCase(template, args);
}

// ──────────────────────────────────────────────────────────────────────────
// 参考实现 / 工具函数
//
// `_referenceSubstitute` 用 StringBuffer + substring 拼接的方式独立实现
// 占位符替换语义，与 `I18n.tArgs` 内部使用的 `replaceAllMapped` 路径不同；
// 用于属性 1 的等价性比较。
// ──────────────────────────────────────────────────────────────────────────

final RegExp _placeholderPattern =
    RegExp(r'\{([A-Za-z_][A-Za-z0-9_]*)\}');

String _referenceSubstitute(String template, Map<String, Object?> args) {
  final buffer = StringBuffer();
  int cursor = 0;
  for (final m in _placeholderPattern.allMatches(template)) {
    buffer.write(template.substring(cursor, m.start));
    final name = m.group(1)!;
    if (args.containsKey(name)) {
      final v = args[name];
      buffer.write(v?.toString() ?? '');
    } else {
      buffer.write(m.group(0)!);
    }
    cursor = m.end;
  }
  buffer.write(template.substring(cursor));
  return buffer.toString();
}

Set<String> _placeholderNames(String template) {
  return _placeholderPattern
      .allMatches(template)
      .map((m) => m.group(1)!)
      .toSet();
}

int _countLiteral(String haystack, String needle) {
  if (needle.isEmpty) return 0;
  var count = 0;
  var i = 0;
  while (true) {
    final idx = haystack.indexOf(needle, i);
    if (idx < 0) break;
    count += 1;
    i = idx + needle.length;
  }
  return count;
}

// 测试期间用来塞入 `I18n.raw['zh']` 的合成键。命名故意带双下划线
// 与 PBT 后缀，避免与主项目任何真实 i18n 键冲突。
const String _kSyntheticKey = '__pbt_t_args_synthetic_template__';

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 2: I18n.tArgs 占位符替换语义', () {
    Glados<_TArgsCase>(
      any.tArgsCase,
      ExploreConfig(numRuns: 100),
    ).test(
      '替换正确 / 幂等性 / 缺失保留 / 多余忽略 四条子属性同时成立',
      (c) {
        // 预先把模板写入 zh 表，让 t(_kSyntheticKey) 返回模板字符串。
        // 用 try/finally 保证用例结束后还原，避免污染其他测试。
        final Map<String, String> zhTable = I18n.raw['zh']!;
        zhTable[_kSyntheticKey] = c.template;
        try {
          final String result = I18n.tArgs(
            _kSyntheticKey,
            c.args,
            lang: 'zh',
          );

          // ── 子属性 1：替换正确 ────────────────────────────────────────
          // 用独立参考实现（StringBuffer + substring 路径）计算期望值，
          // 与 `I18n.tArgs` 内部 `replaceAllMapped` 路径双向印证。
          final String expected = _referenceSubstitute(c.template, c.args);
          expect(
            result,
            expected,
            reason:
                '违反子属性 1（替换正确）：tArgs 输出与参考实现不一致。\n'
                '  输入 = $c\n'
                '  实际 = "${_quote(result)}"\n'
                '  期望 = "${_quote(expected)}"',
          );

          // ── 子属性 3：缺失保留 ────────────────────────────────────────
          // 模板中出现但 args 没有的占位符，必须以同样的字面量数量
          // 保留在结果里。
          final Set<String> templateNames = _placeholderNames(c.template);
          for (final String name in templateNames) {
            if (c.args.containsKey(name)) continue;
            final String literal = '{$name}';
            final int expectedCount =
                _countLiteral(c.template, literal);
            final int actualCount = _countLiteral(result, literal);
            expect(
              actualCount,
              equals(expectedCount),
              reason:
                  '违反子属性 3（缺失保留）：占位符 $literal 不在 args 中，'
                  '应原样保留。\n'
                  '  输入 = $c\n'
                  '  模板出现次数 = $expectedCount\n'
                  '  结果出现次数 = $actualCount\n'
                  '  结果 = "${_quote(result)}"',
            );
          }

          // ── 子属性 4：多余忽略 ────────────────────────────────────────
          // 把 args 中模板未出现的键剔除后，再调用一次 tArgs，结果应
          // 与原结果相等。
          final Map<String, Object?> filteredArgs = <String, Object?>{};
          for (final entry in c.args.entries) {
            if (templateNames.contains(entry.key)) {
              filteredArgs[entry.key] = entry.value;
            }
          }
          final String resultFiltered = I18n.tArgs(
            _kSyntheticKey,
            filteredArgs,
            lang: 'zh',
          );
          expect(
            resultFiltered,
            equals(result),
            reason:
                '违反子属性 4（多余忽略）：剔除多余键后结果应不变。\n'
                '  输入 = $c\n'
                '  原结果 = "${_quote(result)}"\n'
                '  过滤后结果 = "${_quote(resultFiltered)}"\n'
                '  过滤后 args = $filteredArgs',
          );

          // ── 子属性 2：幂等性 ──────────────────────────────────────────
          // 仅当 args 中所有值的 toString 不含 `{any}` 形态占位符时才
          // 测试，避免「值本身含占位符」造成的二次替换破坏（这是设计
          // 决策选择 replaceAllMapped 而非两步 replace 的核心原因）。
          final bool valuesContainPlaceholder = c.args.values.any((v) {
            if (v == null) return false;
            return _placeholderPattern.hasMatch(v.toString());
          });
          if (!valuesContainPlaceholder) {
            // 把 result 当作新模板再走一次替换，然后比较。
            zhTable[_kSyntheticKey] = result;
            final String twice = I18n.tArgs(
              _kSyntheticKey,
              c.args,
              lang: 'zh',
            );
            // 还原模板以便其他用例（虽然 finally 也会移除，但这里
            // 保持局部逻辑清晰）。
            zhTable[_kSyntheticKey] = c.template;
            expect(
              twice,
              equals(result),
              reason:
                  '违反子属性 2（幂等性）：tArgs(tArgs(t, args), args) ≠ '
                  'tArgs(t, args)，且 args 值不含 `{any}` 形态。\n'
                  '  输入 = $c\n'
                  '  一次 = "${_quote(result)}"\n'
                  '  二次 = "${_quote(twice)}"',
            );
          }
        } finally {
          zhTable.remove(_kSyntheticKey);
        }
      },
    );
  });
}
