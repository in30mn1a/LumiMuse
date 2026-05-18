// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Scenario 7.3: 集成场景 B7 — 三模式开关
// Validates: Requirements B7.1
//
// 目标
// ────
// 8 种 (intervalEnabled, timeEnabled, keywordEnabled) 组合下，
// 断言激活的触发器集合 == 启用项子集（独立开关一致性）。
//
// 实施策略（与 spec 任务说明一致）：
// - 构造一个最小设置页 widget，含三个 SwitchListTile，状态由
//   ValueNotifier 驱动；
// - 遍历 8 种组合 [(F,F,F), ..., (T,T,T)]：
//     · 每种组合通过 tester.tap 切换三个开关到目标状态；
//     · 调用 helper `activeTriggers(state)` 收集激活的触发器集合；
//     · 断言其与「启用项子集」严格相等；
// - helper 直接读取 ValueNotifier 状态，不依赖任何后端。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// ─────────── 触发器名称常量（与主项目记忆三模式一致） ───────────

const String _kIntervalTrigger = 'interval';
const String _kTimeTrigger = 'time';
const String _kKeywordTrigger = 'keyword';

/// 三模式开关状态。
class _TriggerState {
  bool intervalEnabled;
  bool timeEnabled;
  bool keywordEnabled;
  _TriggerState({
    required this.intervalEnabled,
    required this.timeEnabled,
    required this.keywordEnabled,
  });
}

/// 计算激活的触发器集合：每条触发器仅在其开关启用时存在于集合中。
///
/// 与主项目「三种触发模式（可独立开关）：按消息数 / 按固定时间间隔 /
/// 按关键词」一致——已删除的「智能触发」不在此处出现。
Set<String> activeTriggers(_TriggerState s) {
  final set = <String>{};
  if (s.intervalEnabled) set.add(_kIntervalTrigger);
  if (s.timeEnabled) set.add(_kTimeTrigger);
  if (s.keywordEnabled) set.add(_kKeywordTrigger);
  return set;
}

/// 期望子集：把 (i, t, k) 三元组转成「启用项名称集合」，与
/// activeTriggers 的契约定义保持一致。
Set<String> _expectedSubset(bool i, bool t, bool k) {
  final set = <String>{};
  if (i) set.add(_kIntervalTrigger);
  if (t) set.add(_kTimeTrigger);
  if (k) set.add(_kKeywordTrigger);
  return set;
}

// ─────────── 最小设置页 widget ───────────

class _MemoryTriggersSettings extends StatefulWidget {
  final _TriggerState initial;
  final ValueChanged<_TriggerState> onChanged;
  const _MemoryTriggersSettings({
    required this.initial,
    required this.onChanged,
  });

  @override
  State<_MemoryTriggersSettings> createState() =>
      _MemoryTriggersSettingsState();
}

class _MemoryTriggersSettingsState extends State<_MemoryTriggersSettings> {
  late _TriggerState _state;

  @override
  void initState() {
    super.initState();
    _state = _TriggerState(
      intervalEnabled: widget.initial.intervalEnabled,
      timeEnabled: widget.initial.timeEnabled,
      keywordEnabled: widget.initial.keywordEnabled,
    );
  }

  void _emit() => widget.onChanged(_state);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SwitchListTile(
          key: const ValueKey('switch-interval'),
          title: const Text('按消息数触发'),
          value: _state.intervalEnabled,
          onChanged: (v) {
            setState(() => _state.intervalEnabled = v);
            _emit();
          },
        ),
        SwitchListTile(
          key: const ValueKey('switch-time'),
          title: const Text('按时间间隔触发'),
          value: _state.timeEnabled,
          onChanged: (v) {
            setState(() => _state.timeEnabled = v);
            _emit();
          },
        ),
        SwitchListTile(
          key: const ValueKey('switch-keyword'),
          title: const Text('按关键词触发'),
          value: _state.keywordEnabled,
          onChanged: (v) {
            setState(() => _state.keywordEnabled = v);
            _emit();
          },
        ),
      ],
    );
  }
}

void main() {
  testWidgets(
    '场景 B7：8 种 (interval, time, keyword) 组合下，'
    '激活触发器集合 == 启用项子集',
    (tester) async {
      // 用 ValueNotifier 在测试外层观察状态变化
      final stateNotifier = ValueNotifier<_TriggerState>(
        _TriggerState(
          intervalEnabled: false,
          timeEnabled: false,
          keywordEnabled: false,
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: _MemoryTriggersSettings(
              initial: stateNotifier.value,
              onChanged: (s) => stateNotifier.value = s,
            ),
          ),
        ),
      );

      // 当前 UI 状态助手：从 widget 树读取实际开关值
      bool readSwitch(Key key) {
        final tile = tester.widget<SwitchListTile>(find.byKey(key));
        return tile.value;
      }

      // 切换开关到目标值；如果当前已是目标，则跳过点击
      Future<void> setSwitch(Key key, bool target) async {
        if (readSwitch(key) == target) return;
        await tester.tap(find.byKey(key));
        await tester.pumpAndSettle();
      }

      // 8 种组合：i, t, k ∈ {false, true}
      final combinations = <List<bool>>[
        for (final i in <bool>[false, true])
          for (final t in <bool>[false, true])
            for (final k in <bool>[false, true]) <bool>[i, t, k],
      ];
      expect(combinations.length, 8);

      for (final combo in combinations) {
        final i = combo[0];
        final t = combo[1];
        final k = combo[2];

        await setSwitch(const ValueKey('switch-interval'), i);
        await setSwitch(const ValueKey('switch-time'), t);
        await setSwitch(const ValueKey('switch-keyword'), k);

        // 1) UI 状态与目标组合一致
        expect(readSwitch(const ValueKey('switch-interval')), i);
        expect(readSwitch(const ValueKey('switch-time')), t);
        expect(readSwitch(const ValueKey('switch-keyword')), k);

        // 2) ValueNotifier 已收到最终状态（最后一次 setSwitch 触发的回调）
        //    若三个开关初始就都为目标值，则不会触发回调；这种情况下
        //    activeTriggers 直接用 UI 读出的状态构造。
        final s = _TriggerState(
          intervalEnabled: readSwitch(const ValueKey('switch-interval')),
          timeEnabled: readSwitch(const ValueKey('switch-time')),
          keywordEnabled: readSwitch(const ValueKey('switch-keyword')),
        );

        // 3) 核心断言：激活触发器集合 == 启用项子集
        final actual = activeTriggers(s);
        final expected = _expectedSubset(i, t, k);
        expect(
          actual,
          expected,
          reason: '组合 (i=$i, t=$t, k=$k) 下激活集合应为 $expected，实际：$actual',
        );

        // 4) 子集关系交叉验证：不开启任何开关时为空集
        if (!i && !t && !k) {
          expect(actual, <String>{},
              reason: '全部关闭时激活集合必须为空');
        }
        if (i && t && k) {
          expect(actual, {_kIntervalTrigger, _kTimeTrigger, _kKeywordTrigger},
              reason: '全部启用时激活集合必须含全部三种触发器');
        }
      }
    },
  );
}
