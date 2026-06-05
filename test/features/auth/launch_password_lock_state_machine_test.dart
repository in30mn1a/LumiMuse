// Feature: flutter-parity-completion, Property 23: 5 次失败锁定 30 秒状态机
// **Validates: Requirements 13.4**
//
// 通过 `package:glados` 生成 `(timestamp, success | failure)` 尝试序列，
// 喂入纯函数 reducer `reduceLockState` 后断言每一步及最终的
// `(failureCount, lockUntil)` 与 `canSubmit(now)` 均符合状态机定义：
//
// - 初始：`(failureCount=0, lockUntil=null)`，对任意 `now`，`canSubmit(now)==true`。
// - failure → `failureCount += 1`；累计达 5 次时改为
//   `lockUntil = action.timestamp + 30s` 且 `failureCount` 重置为 0。
// - success → `failureCount = 0`、`lockUntil = null`。
// - 锁定期内（`action.timestamp < lockUntil`）所有尝试被忽略，状态保持。
// - 任意 `now` 下：`canSubmit(now) ⇔ lockUntil == null ∨ now >= lockUntil`。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。
//
// 注：状态机抽出为纯函数 reducer 是为了「让属性测试与 widget 测试都能复用」
// 同时不暴露 `_LaunchPasswordGateState` 的私有字段（参见 tasks.md 16.6）。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import '../../_helpers/generators.dart';
import '../../_helpers/launch_password_lock_reducer.dart';

void main() {
  group('Property 23: 5 次失败锁定 30 秒状态机', () {
    Glados<List<LockAction>>(any.lockAttemptSequences).test(
      '每一步状态满足状态机定义',
      (actions) {
        var state = LockState.initial;
        // 初始不变量：失败为 0、未锁定。
        expect(state.failureCount, 0);
        expect(state.lockUntil, isNull);

        for (final action in actions) {
          final prev = state;
          final next = reduceLockState(prev, action);

          final until = prev.lockUntil;
          final lockedAtAttempt =
              until != null && action.timestamp.isBefore(until);

          if (lockedAtAttempt) {
            // 锁定期内尝试应被忽略 — 与 gate 中 `if (_isLocked) return;` 对齐。
            expect(next, prev,
                reason: '锁定期内的尝试不应改变状态');
          } else {
            switch (action.kind) {
              case LockAttemptKind.success:
                // success → 立即归零。
                expect(next.failureCount, 0,
                    reason: 'success 应把失败计数重置为 0');
                expect(next.lockUntil, isNull,
                    reason: 'success 应清除锁定截止');
                break;
              case LockAttemptKind.failure:
                final expectedNext = prev.failureCount + 1;
                if (expectedNext >= kLaunchPasswordMaxFailures) {
                  // 5 次失败 → 锁定 30s 且失败计数归零。
                  expect(next.failureCount, 0,
                      reason: '触发锁定时失败计数应重置为 0');
                  expect(
                    next.lockUntil,
                    action.timestamp.add(kLaunchPasswordLockDuration),
                    reason: '触发锁定时 lockUntil = timestamp + 30s',
                  );
                } else {
                  // 未达上限 → 仅累加失败计数，不锁定。
                  expect(next.failureCount, expectedNext,
                      reason: '未达上限时失败计数应递增');
                  expect(next.lockUntil, isNull,
                      reason: '未达上限时不应进入锁定');
                }
                break;
            }
          }

          // 通用不变量：失败计数始终 ∈ [0, 4]。
          expect(next.failureCount, greaterThanOrEqualTo(0));
          expect(next.failureCount,
              lessThan(kLaunchPasswordMaxFailures));

          state = next;
        }
      },
    );

    Glados<List<LockAction>>(any.lockAttemptSequences).test(
      'canSubmit(now) 与 lockUntil 一致',
      (actions) {
        var state = LockState.initial;
        for (final action in actions) {
          state = reduceLockState(state, action);

          final until = state.lockUntil;
          if (until == null) {
            // 未锁定时任意 now 都允许提交。
            expect(state.canSubmit(action.timestamp), isTrue);
            expect(
              state.canSubmit(action.timestamp.add(const Duration(days: 1))),
              isTrue,
            );
          } else {
            // 严格小于 lockUntil 不允许；等于 / 大于 lockUntil 允许。
            expect(
              state.canSubmit(
                until.subtract(const Duration(milliseconds: 1)),
              ),
              isFalse,
              reason: 'now < lockUntil 时不允许提交',
            );
            expect(state.canSubmit(until), isTrue,
                reason: 'now == lockUntil 时允许提交（解锁瞬间）');
            expect(
              state.canSubmit(until.add(const Duration(seconds: 1))),
              isTrue,
              reason: 'now > lockUntil 时允许提交',
            );
          }
        }
      },
    );

    // ─────────────────────────────────────────────
    // 例测：显式覆盖 design.md 锁定状态机的关键样本，
    // 与属性测试形成双层保护。
    // ─────────────────────────────────────────────

    test('初始状态：未失败、未锁定、允许提交', () {
      const state = LockState.initial;
      expect(state.failureCount, 0);
      expect(state.lockUntil, isNull);
      expect(state.canSubmit(DateTime.utc(2025, 1, 1)), isTrue);
    });

    test('累计 4 次失败仍未触发锁定', () {
      var state = LockState.initial;
      final base = DateTime.utc(2025, 1, 1);
      for (var i = 0; i < 4; i++) {
        state = reduceLockState(
          state,
          LockAction(base.add(Duration(seconds: i)), LockAttemptKind.failure),
        );
      }
      expect(state.failureCount, 4);
      expect(state.lockUntil, isNull);
      expect(state.canSubmit(base.add(const Duration(seconds: 5))), isTrue);
    });

    test('第 5 次失败触发 30s 锁定且失败计数归零', () {
      var state = LockState.initial;
      final base = DateTime.utc(2025, 1, 1);
      for (var i = 0; i < 4; i++) {
        state = reduceLockState(
          state,
          LockAction(base.add(Duration(seconds: i)), LockAttemptKind.failure),
        );
      }
      final fifth = base.add(const Duration(seconds: 4));
      state = reduceLockState(
        state,
        LockAction(fifth, LockAttemptKind.failure),
      );
      expect(state.failureCount, 0,
          reason: '触发锁定时失败计数应重置为 0');
      expect(state.lockUntil, fifth.add(const Duration(seconds: 30)));
      // 锁定期内不允许提交。
      expect(
        state.canSubmit(fifth.add(const Duration(seconds: 29))),
        isFalse,
      );
      // 解锁瞬间起允许提交。
      expect(
        state.canSubmit(fifth.add(const Duration(seconds: 30))),
        isTrue,
      );
    });

    test('锁定期内的尝试被忽略', () {
      var state = LockState.initial;
      final base = DateTime.utc(2025, 1, 1);
      // 凑齐 5 次失败触发锁定。
      for (var i = 0; i < 5; i++) {
        state = reduceLockState(
          state,
          LockAction(base.add(Duration(seconds: i)), LockAttemptKind.failure),
        );
      }
      final lockedSnapshot = state;
      // 锁定期内追加任意尝试都应保持状态不变。
      final inLock = base.add(const Duration(seconds: 10));
      state = reduceLockState(state, LockAction(inLock, LockAttemptKind.failure));
      expect(state, lockedSnapshot,
          reason: '锁定期内的失败尝试不应改变状态');
      state = reduceLockState(state, LockAction(inLock, LockAttemptKind.success));
      expect(state, lockedSnapshot,
          reason: '锁定期内的成功尝试也不应改变状态');
    });

    test('解锁后第一次成功立即归零', () {
      var state = LockState.initial;
      final base = DateTime.utc(2025, 1, 1);
      for (var i = 0; i < 5; i++) {
        state = reduceLockState(
          state,
          LockAction(base.add(Duration(seconds: i)), LockAttemptKind.failure),
        );
      }
      // 解锁后立即成功。
      final unlocked = base.add(const Duration(seconds: 35));
      state = reduceLockState(
        state,
        LockAction(unlocked, LockAttemptKind.success),
      );
      expect(state.failureCount, 0);
      expect(state.lockUntil, isNull);
      expect(state.canSubmit(unlocked), isTrue);
    });

    test('解锁后失败计数从 0 起重新累计', () {
      var state = LockState.initial;
      final base = DateTime.utc(2025, 1, 1);
      for (var i = 0; i < 5; i++) {
        state = reduceLockState(
          state,
          LockAction(base.add(Duration(seconds: i)), LockAttemptKind.failure),
        );
      }
      final unlocked = base.add(const Duration(seconds: 35));
      state = reduceLockState(
        state,
        LockAction(unlocked, LockAttemptKind.failure),
      );
      expect(state.failureCount, 1,
          reason: '解锁后失败计数应从 0 重新累计而非沿用旧值');
      expect(state.lockUntil, isNull);
    });
  });
}
