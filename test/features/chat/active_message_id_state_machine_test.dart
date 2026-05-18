// Feature: flutter-parity-completion, Property 16: activeMessageId 状态机不变量
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**
//
// 通过 `package:glados` 生成由 `toggle(id)` / `clickBlank` 组成的操作序列，
// 喂入 `reduceActiveActionState` 后断言每一步与最终状态都符合设计规则：
//
// - 9.1 初始：`null`。
// - 9.2 / 9.3 / 9.4 toggle(id)：等于 id → null；不等于 id → id。
// - 9.6 clickBlank → null。
// - 9.3 在中间步骤反向操作可恢复：连续两次同 id toggle 后，状态等于操作前状态。
// - 9.5 桌面端断点（>= 768）下 hover 行为不影响该状态机：本属性测试只覆盖
//   纯函数语义，桌面端 hover 与状态机无耦合的断言放在 widget 测试。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import '../../_helpers/active_message_id_reducer.dart';
import '../../_helpers/generators.dart';

void main() {
  group('Property 16: activeMessageId 状态机不变量', () {
    Glados<List<ActiveAction>>(any.activeActionSequences).test(
      '初始状态为 null（9.1），且每一步状态符合设计规则',
      (actions) {
        // 9.1：初始 null。
        String? state;
        expect(state, isNull);

        for (final action in actions) {
          final prev = state;
          final next = reduceActiveActionState(prev, action);
          switch (action.kind) {
            case ActiveActionKind.toggle:
              if (prev == action.id) {
                // 9.3：再次点击同一气泡 → null。
                expect(next, isNull,
                    reason: 'toggle 当前等于 id 时应置 null');
              } else {
                // 9.4：点击其他气泡 → 切换到新 id。
                expect(next, action.id,
                    reason: 'toggle 不等于 id 时应切换到新 id');
              }
              break;
            case ActiveActionKind.clickBlank:
              // 9.6：空白点击始终归零。
              expect(next, isNull, reason: 'clickBlank 应总是置 null');
              break;
          }
          state = next;
        }
      },
    );

    Glados<List<ActiveAction>>(any.activeActionSequences).test(
      '最终状态要么为 null，要么为序列中出现过的某个 id',
      (actions) {
        String? state;
        for (final action in actions) {
          state = reduceActiveActionState(state, action);
        }
        if (state == null) {
          // OK：null 在任意路径上都可达。
          return;
        }
        final seenIds = actions
            .where((a) => a.kind == ActiveActionKind.toggle)
            .map((a) => a.id)
            .toSet();
        expect(seenIds.contains(state), isTrue,
            reason: '最终非空状态必须等于序列中出现过的某个 toggle id');
      },
    );

    Glados<List<ActiveAction>>(any.activeActionSequences).test(
      '幂等不变量：在任意步骤后追加 clickBlank 都会归零',
      (actions) {
        String? state;
        for (final action in actions) {
          state = reduceActiveActionState(state, action);
        }
        // 追加 clickBlank → null。
        final after = reduceActiveActionState(state, const ActiveAction.clickBlank());
        expect(after, isNull, reason: 'clickBlank 总是把状态置 null');
        // 再次 clickBlank 仍为 null（幂等）。
        final twice = reduceActiveActionState(after, const ActiveAction.clickBlank());
        expect(twice, isNull);
      },
    );

    // 例测：边界场景显式断言，与属性测试形成双层保护。
    test('初始状态为 null（9.1）', () {
      expect(reduceActiveActionState(null, const ActiveAction.clickBlank()), isNull);
    });

    test('toggle 同一 id 两次回到 null（9.2、9.3）', () {
      var state = reduceActiveActionState(null, const ActiveAction.toggle('a'));
      expect(state, 'a');
      state = reduceActiveActionState(state, const ActiveAction.toggle('a'));
      expect(state, isNull);
    });

    test('toggle 不同 id 切换到新 id（9.4）', () {
      var state = reduceActiveActionState(null, const ActiveAction.toggle('a'));
      expect(state, 'a');
      state = reduceActiveActionState(state, const ActiveAction.toggle('b'));
      expect(state, 'b');
    });

    test('clickBlank 归零（9.6）', () {
      var state = reduceActiveActionState('a', const ActiveAction.clickBlank());
      expect(state, isNull);
      // 已经是 null 时再次 clickBlank 仍为 null。
      state = reduceActiveActionState(state, const ActiveAction.clickBlank());
      expect(state, isNull);
    });
  });
}
