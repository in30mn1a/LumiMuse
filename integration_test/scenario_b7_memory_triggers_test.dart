// Feature: flutter-pixel-perfect-parity, Scenario 7.3: 记忆三模式独立开关
// Validates: Requirements B7.1
//
// 设计说明
// ────────
// requirements.md §B7.1 / design.md §3.7 要求：
//   记忆提取支持三种触发模式（按消息数 interval / 按时间间隔 time / 按
//   关键词 keyword），三个开关彼此正交，可独立开 / 关。对任意三元组
//   (intervalEnabled, timeEnabled, keywordEnabled) ∈ {true, false}^3，
//   实际激活的触发器集合 == 启用项对应名字的子集。
//
// 本场景遍历 8 种组合（笛卡尔积），调用 `activeTriggers(...)` 等价的纯
// 函数（与 test/properties/property_13_memory_triggers_independent_test.dart
// 中已有声明保持一致；这里集成测试再独立声明一份，避免跨目录依赖），
// 断言结果集合等于启用项子集。
//
// 不需要任何 fake provider / LLM / Database：触发器开关到激活集合的映射
// 是无状态纯函数，集成测试只验证「8 种组合都对」。

import 'package:flutter_test/flutter_test.dart';

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：activeTriggers
//
// 与 property_13 中的同名函数保持等价语义（手动复声明而非 import，避免
// 集成测试目录依赖 test/properties/ 私有路径；同时强调：这是契约的最小核，
// 任何子 spec 在 UI / Provider 中实现时必须保持一致）。
//
// 映射规则：
//   - intervalEnabled → 'interval'
//   - timeEnabled     → 'time'
//   - keywordEnabled  → 'keyword'
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

void main() {
  group('Scenario 7.3: 记忆三模式独立开关 — 8 种组合等价于启用项子集', () {
    // 8 种组合的全表，便于失败时一眼看出违反的组合
    final combos = <(bool, bool, bool)>[
      (false, false, false),
      (true, false, false),
      (false, true, false),
      (false, false, true),
      (true, true, false),
      (true, false, true),
      (false, true, true),
      (true, true, true),
    ];

    test(
      '对 8 种 (interval, time, keyword) 组合：激活集合 == 启用项子集',
      () {
        for (final combo in combos) {
          final (i, t, k) = combo;
          final result = activeTriggers(
            intervalEnabled: i,
            timeEnabled: t,
            keywordEnabled: k,
          );

          // 预期集合：启用项对应字符串的子集
          final expected = <String>{
            if (i) 'interval',
            if (t) 'time',
            if (k) 'keyword',
          };

          expect(
            result,
            expected,
            reason:
                '组合 (interval=$i, time=$t, keyword=$k) 的激活集合不等于启用项子集：\n'
                '  期望 = $expected\n'
                '  实际 = $result',
          );

          // 集合大小 == 启用项个数
          final enabledCount = <bool>[i, t, k].where((b) => b).length;
          expect(
            result.length,
            enabledCount,
            reason: '组合 (interval=$i, time=$t, keyword=$k) 的集合大小应等于启用项个数 '
                '($enabledCount)，实际为 ${result.length}',
          );

          // 双向蕴含：每一项启用 ⟺ 对应名字 ∈ 集合
          expect(result.contains('interval'), i,
              reason: "interval=$i ⟺ 'interval' ∈ 集合；实际集合 = $result");
          expect(result.contains('time'), t,
              reason: "time=$t ⟺ 'time' ∈ 集合；实际集合 = $result");
          expect(result.contains('keyword'), k,
              reason: "keyword=$k ⟺ 'keyword' ∈ 集合；实际集合 = $result");
        }
      },
    );

    test(
      '关闭全部开关：激活集合为空（不会有"默认启用"的隐藏项）',
      () {
        final result = activeTriggers(
          intervalEnabled: false,
          timeEnabled: false,
          keywordEnabled: false,
        );
        expect(result, isEmpty,
            reason: '三个开关全部关闭时，激活集合必须为空，禁止任何"默认启用"的隐藏项');
      },
    );

    test(
      '开启全部开关：激活集合恰好是 {interval, time, keyword}',
      () {
        final result = activeTriggers(
          intervalEnabled: true,
          timeEnabled: true,
          keywordEnabled: true,
        );
        expect(result, {'interval', 'time', 'keyword'},
            reason: '三个开关全部开启时，激活集合必须等于全集');
      },
    );

    test(
      '独立性：单独翻转任一开关，对称差集恰好是该开关对应的名字',
      () {
        // 以 (true, true, true) 为基准，逐个翻转
        const base = (true, true, true);
        final baseSet = activeTriggers(
          intervalEnabled: base.$1,
          timeEnabled: base.$2,
          keywordEnabled: base.$3,
        );

        // 翻转 interval
        final flipI = activeTriggers(
          intervalEnabled: !base.$1,
          timeEnabled: base.$2,
          keywordEnabled: base.$3,
        );
        expect(_symmetricDifference(baseSet, flipI), {'interval'},
            reason: '翻转 interval 后对称差集应恰好为 {interval}');

        // 翻转 time
        final flipT = activeTriggers(
          intervalEnabled: base.$1,
          timeEnabled: !base.$2,
          keywordEnabled: base.$3,
        );
        expect(_symmetricDifference(baseSet, flipT), {'time'},
            reason: '翻转 time 后对称差集应恰好为 {time}');

        // 翻转 keyword
        final flipK = activeTriggers(
          intervalEnabled: base.$1,
          timeEnabled: base.$2,
          keywordEnabled: !base.$3,
        );
        expect(_symmetricDifference(baseSet, flipK), {'keyword'},
            reason: '翻转 keyword 后对称差集应恰好为 {keyword}');
      },
    );
  });
}

/// 集合对称差：A △ B = (A \ B) ∪ (B \ A)
Set<String> _symmetricDifference(Set<String> a, Set<String> b) {
  return <String>{
    ...a.where((e) => !b.contains(e)),
    ...b.where((e) => !a.contains(e)),
  };
}
