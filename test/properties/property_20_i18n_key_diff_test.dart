// Feature: flutter-pixel-perfect-parity, Property 20: i18n 键集合差集为空
// Validates: Requirements A6.4, A6.5, A6.6 (INV-10)
//
// 设计说明
// ────────
// requirements.md §A6.4 ~ §A6.6 / design.md §正确性属性 Property 20 / INV-10
// 要求：
//   主项目键集 K_web 与 Flutter 端键集 K_flutter 的对称差集 K_web △ K_flutter
//   必须始终为 ∅。当且仅当差集为 ∅ 时，断言函数 `assertI18nDiffEmpty(...)`
//   通过；否则函数返回详细的差集报告（数据结构与 `scripts/check-i18n-key-diff.js`
//   输出格式保持一致：`{ onlyA: [...], onlyB: [...] }`）。
//
// 测试策略
// ────────
// 1. 验证函数：在测试文件内实现纯函数 `symmetricDiff(Set<String> a, Set<String> b)
//    -> ({List<String> onlyA, List<String> onlyB})`，逐键比对并按字典序输出
//    差集。
// 2. 断言函数 `assertI18nDiffEmpty(a, b)`：当且仅当 symmetricDiff 返回的两个
//    列表均为空时通过；否则返回结构化报告（与 scripts/check-i18n-key-diff.js
//    一致）。
// 3. 生成器：
//    · 用一个固定的"基准键集"模拟两端共有键，例如 `{'k0', 'k1', 'k2', ...}`；
//    · 在两端各随机加 1 ~ 5 个不同的键，或者删 0 ~ 5 个共同键，造出含差集
//      的输入；
//    · 同时提供"零突变"分支（两端都返回基准）以验证 valid 路径返回 ok。
// 4. 断言：
//    · 零突变：assertI18nDiffEmpty 通过；
//    · 突变：assertI18nDiffEmpty 失败，且 onlyA / onlyB 与突变记录吻合。
//
// 100 次 runs（与 tasks.md §5.20 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 纯函数：symmetricDiff
//
// 返回值用 record 类型 ({onlyA, onlyB})，与 scripts/check-i18n-key-diff.js
// 的输出格式语义一致：
//   - onlyA：仅在 a 中出现、不在 b 中的键（按字典序）；
//   - onlyB：仅在 b 中出现、不在 a 中的键（按字典序）。
//
// 当且仅当 onlyA / onlyB 都为空时，对称差集为 ∅。
// ──────────────────────────────────────────────────────────────────────────

({List<String> onlyA, List<String> onlyB}) symmetricDiff(
  Set<String> a,
  Set<String> b,
) {
  final onlyA = (a.difference(b)).toList()..sort();
  final onlyB = (b.difference(a)).toList()..sort();
  return (onlyA: onlyA, onlyB: onlyB);
}

// ──────────────────────────────────────────────────────────────────────────
// 差集报告 + 断言函数
//
// 数据结构与 scripts/check-i18n-key-diff.js 输出格式保持一致：
//   {
//     "onlyA": [...],   // 仅在主项目键集中出现
//     "onlyB": [...]    // 仅在 Flutter 键集中出现
//   }
//
// assertI18nDiffEmpty(a, b) 的语义：
//   - 当差集为 ∅ → 返回一个空报告对象（onlyA / onlyB 都为空），不 fail；
//   - 否则 → 返回包含完整差集的报告对象，并把 isEmpty 标记为 false。
// ──────────────────────────────────────────────────────────────────────────

class I18nDiffReport {
  final List<String> onlyA;
  final List<String> onlyB;

  const I18nDiffReport({required this.onlyA, required this.onlyB});

  bool get isEmpty => onlyA.isEmpty && onlyB.isEmpty;

  @override
  String toString() =>
      'I18nDiffReport(onlyA=$onlyA, onlyB=$onlyB)';
}

I18nDiffReport assertI18nDiffEmpty(Set<String> a, Set<String> b) {
  final diff = symmetricDiff(a, b);
  return I18nDiffReport(onlyA: diff.onlyA, onlyB: diff.onlyB);
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器：模拟两端键集合 + 随机增删
//
// 设计：
//   - 基准共有键集 baseShared：'common-0' ~ 'common-9' 共 10 个；
//   - 在 A（主项目）侧随机加 0 ~ 5 个独有键 'extra-a-x'；
//   - 在 B（Flutter）侧随机加 0 ~ 5 个独有键 'extra-b-x'；
//   - 在两端各随机删 0 ~ 5 个共有键（独立删，不必同步）。
//
// 突变记录用 _DiffMutation 描述，便于失败时打印精确反例。
// ──────────────────────────────────────────────────────────────────────────

class _DiffMutation {
  /// 在 A 中独有的额外键集合（基准外）
  final Set<String> extraA;

  /// 在 B 中独有的额外键集合（基准外）
  final Set<String> extraB;

  /// 从 A 中删除的共有键（应出现在 onlyB 中，因为 B 仍保留）
  final Set<String> removedFromA;

  /// 从 B 中删除的共有键（应出现在 onlyA 中，因为 A 仍保留）
  final Set<String> removedFromB;

  const _DiffMutation({
    required this.extraA,
    required this.extraB,
    required this.removedFromA,
    required this.removedFromB,
  });

  /// 是否真正构成了对称差集偏离。
  bool get hasDeviation =>
      extraA.isNotEmpty ||
      extraB.isNotEmpty ||
      // removedFromA \ removedFromB → 仍出现在 B、不在 A → onlyB；
      // 反之亦然。两者完全相同时不构成差集偏离。
      removedFromA.difference(removedFromB).isNotEmpty ||
      removedFromB.difference(removedFromA).isNotEmpty;

  @override
  String toString() =>
      '_DiffMutation(extraA=$extraA, extraB=$extraB, '
      'removedFromA=$removedFromA, removedFromB=$removedFromB)';
}

/// 基准共有键集（被两端共享）。
const Set<String> _kBaseSharedKeys = <String>{
  'common-0', 'common-1', 'common-2', 'common-3', 'common-4',
  'common-5', 'common-6', 'common-7', 'common-8', 'common-9',
};

extension on Any {
  Generator<_DiffMutation> get diffMutation {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final extraACount = rng.nextInt(6); // 0 ~ 5
      final extraBCount = rng.nextInt(6);
      final removeACount = rng.nextInt(6);
      final removeBCount = rng.nextInt(6);

      final extraA = <String>{
        for (var i = 0; i < extraACount; i++) 'extra-a-${rng.nextInt(100)}',
      };
      final extraB = <String>{
        for (var i = 0; i < extraBCount; i++) 'extra-b-${rng.nextInt(100)}',
      };

      final shared = _kBaseSharedKeys.toList()..sort();
      shared.shuffle(rng);
      final removedFromA = <String>{...shared.take(removeACount)};
      shared.shuffle(rng);
      final removedFromB = <String>{...shared.take(removeBCount)};

      return _DiffMutation(
        extraA: extraA,
        extraB: extraB,
        removedFromA: removedFromA,
        removedFromB: removedFromB,
      );
    });
  }
}

/// 根据突变描述构造两端键集合。
({Set<String> a, Set<String> b}) _buildKeySets(_DiffMutation m) {
  final a = <String>{..._kBaseSharedKeys}
    ..removeAll(m.removedFromA)
    ..addAll(m.extraA);
  final b = <String>{..._kBaseSharedKeys}
    ..removeAll(m.removedFromB)
    ..addAll(m.extraB);
  return (a: a, b: b);
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 20: i18n 键集合差集为空', () {
    // 基础健壮性自检：两端均为基准时差集为空。
    test('两端均为基准 → 差集为空 / assertI18nDiffEmpty 通过', () {
      final report = assertI18nDiffEmpty(_kBaseSharedKeys, _kBaseSharedKeys);
      expect(report.isEmpty, isTrue);
      expect(report.onlyA, isEmpty);
      expect(report.onlyB, isEmpty);
    });

    Glados<_DiffMutation>(
      any.diffMutation,
      ExploreConfig(numRuns: 100),
    ).test(
      '当且仅当对称差集为 ∅ 时 assertI18nDiffEmpty 通过；否则返回结构化差集报告',
      (m) {
        final sets = _buildKeySets(m);
        final report = assertI18nDiffEmpty(sets.a, sets.b);
        final diff = symmetricDiff(sets.a, sets.b);

        // ── 断言 1：onlyA / onlyB 与 symmetricDiff 输出一致 ──────────────
        expect(
          report.onlyA,
          equals(diff.onlyA),
          reason:
              '违反 Property 20：报告的 onlyA 与 symmetricDiff 不一致。\n'
              '  突变 = $m\n'
              '  报告 = $report\n'
              '  symmetricDiff = $diff',
        );
        expect(
          report.onlyB,
          equals(diff.onlyB),
          reason:
              '违反 Property 20：报告的 onlyB 与 symmetricDiff 不一致。\n'
              '  突变 = $m\n'
              '  报告 = $report\n'
              '  symmetricDiff = $diff',
        );

        // ── 断言 2：双向蕴含 isEmpty ⟺ 差集为 ∅ ────────────────────────
        // 当且仅当差集为 ∅ 时，assertI18nDiffEmpty 返回的报告 isEmpty == true。
        final symmetricEmpty = diff.onlyA.isEmpty && diff.onlyB.isEmpty;
        expect(
          report.isEmpty,
          symmetricEmpty,
          reason:
              '违反 Property 20（双向蕴含）：'
              '报告 isEmpty=${report.isEmpty}, '
              '但 symmetricDiff 实际差集大小='
              '${diff.onlyA.length + diff.onlyB.length}。\n'
              '  突变 = $m',
        );

        // ── 断言 3：对真实突变与零突变两条路径分别验证 ───────────────
        if (!m.hasDeviation) {
          expect(
            report.isEmpty,
            isTrue,
            reason:
                '零偏离突变下 assertI18nDiffEmpty 必须通过，但报告=$report',
          );
        } else {
          expect(
            report.isEmpty,
            isFalse,
            reason:
                '突变 $m 已构成对称差集偏离，但 assertI18nDiffEmpty 仍判为通过。\n'
                '  A=${sets.a}\n  B=${sets.b}',
          );
          // onlyA 应包含「extraA」与「removedFromB \ removedFromA」。
          for (final k in m.extraA) {
            expect(
              report.onlyA.contains(k),
              isTrue,
              reason: 'extraA 中的键 $k 必须出现在 onlyA 中，'
                  '但实际 onlyA=${report.onlyA}',
            );
          }
          for (final k in m.removedFromB.difference(m.removedFromA)) {
            expect(
              report.onlyA.contains(k),
              isTrue,
              reason: 'B 删除而 A 仍保留的键 $k 必须出现在 onlyA 中，'
                  '但实际 onlyA=${report.onlyA}',
            );
          }
          // onlyB 应包含「extraB」与「removedFromA \ removedFromB」。
          for (final k in m.extraB) {
            expect(
              report.onlyB.contains(k),
              isTrue,
              reason: 'extraB 中的键 $k 必须出现在 onlyB 中，'
                  '但实际 onlyB=${report.onlyB}',
            );
          }
          for (final k in m.removedFromA.difference(m.removedFromB)) {
            expect(
              report.onlyB.contains(k),
              isTrue,
              reason: 'A 删除而 B 仍保留的键 $k 必须出现在 onlyB 中，'
                  '但实际 onlyB=${report.onlyB}',
            );
          }
        }

        // ── 断言 4：onlyA / onlyB 严格按字典序输出（与脚本格式一致）──
        final sortedA = List<String>.from(report.onlyA)..sort();
        final sortedB = List<String>.from(report.onlyB)..sort();
        expect(
          report.onlyA,
          equals(sortedA),
          reason: 'onlyA 必须按字典序输出，但实际=${report.onlyA}',
        );
        expect(
          report.onlyB,
          equals(sortedB),
          reason: 'onlyB 必须按字典序输出，但实际=${report.onlyB}',
        );
      },
    );
  });
}
