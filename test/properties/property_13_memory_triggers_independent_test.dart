// Feature: flutter-pixel-perfect-parity, Property 13: 记忆三模式独立开关一致性
// Validates: Requirements B7.1
//
// 设计说明
// ────────
// requirements.md §B7.1 / design.md §正确性属性 Property 13 要求：
//   对任意三元组 (intervalEnabled, timeEnabled, keywordEnabled) ∈ {true, false}^3，
//   运行时实际激活的触发器集合 == 启用项对应名字的子集；任一项独立切换
//   true ↔ false 只会改变该项是否在结果集合中，不影响其它两项。
//
// 这一不变量是「记忆三模式 UI / 设置」契约的最小核：三个开关彼此正交、
// 不存在隐藏的组合状态。把它落到一个纯函数 `activeTriggers(...)` 上，
// 用 glados `combine3(any.bool, any.bool, any.bool, ...)` 在所有 8 种
// 组合之间随机抽样验证。
//
// glados 1.1.7 中 `any.bool` 是 `Any` 上的 extension getter（see
// `glados/lib/src/anys.dart` 第 20 行：`Generator<core.bool> get bool
// => choose([false, true]);`），可直接喂给 `combine3` 的三个参数。
//
// 100 次 runs（与 tasks.md §5.13 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 被测纯函数：activeTriggers
//
// 返回 enabled==true 项对应的触发器字符串名集合：
//   - intervalEnabled → 'interval'
//   - timeEnabled     → 'time'
//   - keywordEnabled  → 'keyword'
//
// 例如 (true, false, true) → {'interval', 'keyword'}。
//
// 这是设置页三个开关到「实际激活触发器集合」的最小映射，不引入任何隐藏
// 状态；任何子 spec 在实现 UI / Provider 时都必须保持等价行为。
// ──────────────────────────────────────────────────────────────────────────

Set<String> activeTriggers({
  required bool intervalEnabled,
  required bool timeEnabled,
  required bool keywordEnabled,
}) {
  final s = <String>{};
  if (intervalEnabled) s.add('interval');
  if (timeEnabled) s.add('time');
  if (keywordEnabled) s.add('keyword');
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// 三元组 record：用于打印 / 比对方便
// ──────────────────────────────────────────────────────────────────────────

class _TriggerCombo {
  final bool interval;
  final bool time;
  final bool keyword;
  const _TriggerCombo(this.interval, this.time, this.keyword);

  @override
  String toString() =>
      '(interval=$interval, time=$time, keyword=$keyword)';
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器：combine3(any.bool, any.bool, any.bool, ...)
//
// 三个独立的 bool 各自从 {true, false} 选取，一共 8 种组合。glados 随机
// 抽样并在反例时按位 shrink 到最小三元组（典型为 (false, false, false)
// 或单个 true）。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<_TriggerCombo> get triggerCombo {
    return combine3<bool, bool, bool, _TriggerCombo>(
      any.bool,
      any.bool,
      any.bool,
      (i, t, k) => _TriggerCombo(i, t, k),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 13: 记忆三模式独立开关一致性', () {
    Glados<_TriggerCombo>(
      any.triggerCombo,
      ExploreConfig(numRuns: 100),
    ).test(
      '对任意 (intervalEnabled, timeEnabled, keywordEnabled) ∈ {true,false}^3：'
      '激活集合 == 启用项子集，且单独切换任一项只影响该项',
      (combo) {
        final result = activeTriggers(
          intervalEnabled: combo.interval,
          timeEnabled: combo.time,
          keywordEnabled: combo.keyword,
        );

        // ── 断言 1：集合大小 == 启用项数量 ────────────────────────────
        // 没有"额外触发器"也没有"被吞掉的开关"。
        final enabledCount = <bool>[combo.interval, combo.time, combo.keyword]
            .where((b) => b)
            .length;
        expect(
          result.length,
          enabledCount,
          reason:
              '违反 Property 13（启用项数 == 集合大小）：\n'
              '  组合 = $combo\n'
              '  启用项数 = $enabledCount\n'
              '  实际集合 = $result',
        );

        // ── 断言 2：双向蕴含 ────────────────────────────────────────
        // intervalEnabled ⟺ 'interval' ∈ result，时间 / 关键词同理。
        expect(
          result.contains('interval'),
          combo.interval,
          reason:
              "违反 Property 13（interval ⟺ 'interval' ∈ 集合）：\n"
              '  组合 = $combo\n'
              '  实际集合 = $result',
        );
        expect(
          result.contains('time'),
          combo.time,
          reason:
              "违反 Property 13（time ⟺ 'time' ∈ 集合）：\n"
              '  组合 = $combo\n'
              '  实际集合 = $result',
        );
        expect(
          result.contains('keyword'),
          combo.keyword,
          reason:
              "违反 Property 13（keyword ⟺ 'keyword' ∈ 集合）：\n"
              '  组合 = $combo\n'
              '  实际集合 = $result',
        );

        // ── 断言 3：独立性（symmetric difference 仅在该项的元素上） ──
        // 单独切换 interval 时，前后两个集合的对称差集恰好是 {'interval'}：
        // 即 time / keyword 这两项是否在集合中，不会因 interval 翻转而改变。
        // 同理验证 time、keyword。
        final flipInterval = activeTriggers(
          intervalEnabled: !combo.interval,
          timeEnabled: combo.time,
          keywordEnabled: combo.keyword,
        );
        final flipTime = activeTriggers(
          intervalEnabled: combo.interval,
          timeEnabled: !combo.time,
          keywordEnabled: combo.keyword,
        );
        final flipKeyword = activeTriggers(
          intervalEnabled: combo.interval,
          timeEnabled: combo.time,
          keywordEnabled: !combo.keyword,
        );

        expect(
          _symmetricDifference(result, flipInterval),
          {'interval'},
          reason:
              '违反 Property 13（interval 独立性）：\n'
              "  翻转 interval 后对称差集应恰好为 {'interval'}。\n"
              '  组合 = $combo\n'
              '  原集合 = $result\n'
              '  翻转后 = $flipInterval',
        );
        expect(
          _symmetricDifference(result, flipTime),
          {'time'},
          reason:
              '违反 Property 13（time 独立性）：\n'
              "  翻转 time 后对称差集应恰好为 {'time'}。\n"
              '  组合 = $combo\n'
              '  原集合 = $result\n'
              '  翻转后 = $flipTime',
        );
        expect(
          _symmetricDifference(result, flipKeyword),
          {'keyword'},
          reason:
              '违反 Property 13（keyword 独立性）：\n'
              "  翻转 keyword 后对称差集应恰好为 {'keyword'}。\n"
              '  组合 = $combo\n'
              '  原集合 = $result\n'
              '  翻转后 = $flipKeyword',
        );
      },
    );
  });
}

/// 计算两个集合的 symmetric difference（对称差集）：
///   A △ B = (A \ B) ∪ (B \ A)。
Set<String> _symmetricDifference(Set<String> a, Set<String> b) {
  return <String>{
    ...a.where((e) => !b.contains(e)),
    ...b.where((e) => !a.contains(e)),
  };
}
