// Feature: flutter-parity-completion, Property 23: 5 次失败锁定 30 秒状态机
//
// 把启动密码闸门 `_LaunchPasswordGateState` 的失败计数 / 锁定状态机抽出
// 成纯函数 reducer，便于属性测试与（未来）widget 测试复用，避免改动 lib
// 层私有字段（参见 tasks.md 16.6 与 design.md「P2 / R13」）。
//
// 状态规则（与 `lib/features/auth/launch_password_gate.dart` 中
// `_LaunchPasswordGateState._submit` 行为一致）：
// - 初始：`(failureCount=0, lockUntil=null)`。
// - failure 累计达到 5 次 → `lockUntil = action.timestamp + 30s`，
//   `failureCount` 立刻重置为 0（避免锁后再失败 1 次又锁）。
// - success → `failureCount = 0`、`lockUntil = null`。
// - 锁定期内（`action.timestamp < lockUntil`）所有尝试被忽略，
//   状态保持不变（与 gate 中 `if (_isLocked) return;` 等价）。
// - 任意 `now` 下：`canSubmit(now) ⇔ lockUntil == null ∨ now >= lockUntil`。

/// 单次锁定时长 — 与 `LaunchPasswordGate` 中的 `_kLockDuration` 一致。
const Duration kLaunchPasswordLockDuration = Duration(seconds: 30);

/// 单轮允许的最大失败次数 — 与 `LaunchPasswordGate` 中的 `_kMaxFailures` 一致。
const int kLaunchPasswordMaxFailures = 5;

/// 尝试结果种类：成功或失败。
enum LockAttemptKind { success, failure }

/// 状态机操作 — 携带尝试发生时刻与结果种类。
class LockAction {
  /// 尝试发生时刻 — 同时也是潜在的「锁定起点」。
  final DateTime timestamp;

  /// 尝试结果种类。
  final LockAttemptKind kind;

  const LockAction(this.timestamp, this.kind);

  @override
  String toString() =>
      'LockAction(${timestamp.toIso8601String()}, ${kind.name})';
}

/// 锁定状态：当前轮失败计数 + 锁定截止时间（null 表示未锁定）。
class LockState {
  /// 当前轮失败计数；恒在 `[0, kLaunchPasswordMaxFailures - 1]`。
  final int failureCount;

  /// 锁定截止时间；为 null 时未处于锁定期。
  final DateTime? lockUntil;

  const LockState({this.failureCount = 0, this.lockUntil});

  /// 状态机初始值 — 等价于「未失败也未锁定」。
  static const LockState initial = LockState();

  /// 在查询时刻 `now` 判断是否允许提交。
  ///
  /// 规则与 design.md 一致：`now < lockUntil` 时不允许；
  /// `lockUntil == null` 或 `now >= lockUntil` 均允许。
  bool canSubmit(DateTime now) {
    final until = lockUntil;
    if (until == null) return true;
    return !now.isBefore(until);
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! LockState) return false;
    return failureCount == other.failureCount && lockUntil == other.lockUntil;
  }

  @override
  int get hashCode => Object.hash(failureCount, lockUntil);

  @override
  String toString() =>
      'LockState(failureCount=$failureCount, lockUntil=$lockUntil)';
}

/// 状态机 reducer：根据上一状态 + 本次尝试 → 下一状态。
///
/// 纯函数：不读时钟、不依赖外部副作用，全部信息来自 `prev` 与 `action`。
LockState reduceLockState(LockState prev, LockAction action) {
  // 1. 锁定期内尝试被忽略 — 与 gate 中 `if (_isLocked) return;` 对齐。
  final until = prev.lockUntil;
  if (until != null && action.timestamp.isBefore(until)) {
    return prev;
  }
  switch (action.kind) {
    case LockAttemptKind.success:
      // 2. 成功 → 立即重置失败计数与锁定截止。
      return LockState.initial;
    case LockAttemptKind.failure:
      final next = prev.failureCount + 1;
      if (next >= kLaunchPasswordMaxFailures) {
        // 3. 累计达到上限 → 进入 30s 锁定期，失败计数归零。
        return LockState(
          failureCount: 0,
          lockUntil: action.timestamp.add(kLaunchPasswordLockDuration),
        );
      }
      // 4. 未达上限 → 仅累加失败计数。
      return LockState(failureCount: next, lockUntil: null);
  }
}
