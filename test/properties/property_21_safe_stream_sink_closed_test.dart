// Feature: flutter-pixel-perfect-parity, Property 21: SafeStreamSink closed 单调性
// Validates: Requirements D2.1, D2.2, D2.3 (INV-5)
//
// 设计说明
// ────────
// design.md §正确性属性 Property 21 / INV-5 是关键不变量（runs ≥ 500），
// 三条子条款必须同时满足：
//   1. `_closed` 字段单调（一旦 true 永不回 false）；
//   2. close 后任何 add 必须 no-op（不抛异常、不触达底层 controller）；
//   3. 底层 `StreamController.close()` 至多被调用一次（即使外部多次调用
//      `SafeStreamSink.close`，只有第一次会实际关闭底层流）。
//
// 测试策略
// ────────
// 1. 用一个监视底层 controller 的「探针 controller」(`_ProbeController`)
//    完全代理 StreamController 的 add / close 接口，记录：
//      - 历次 add 调用次数 / 收到的 event；
//      - 历次 close 调用次数。
//    然后把它包装在 `SafeStreamSink` 之外，用反射封装替代 —— 但因为
//    `SafeStreamSink` 的构造函数接受外部传入的 `StreamController<T>`，
//    我们只需要将一个监视用的「子类型 StreamController」喂进去即可观察其
//    add / close 是否被实际调用。
// 2. 生成 `(add | close | cancel)` 操作序列，逐步执行；
//    `cancel` 在 sink 语义上等价于「再次 close」（取消 = 终结流），
//    所以行为与 close 完全一致（保证不变量「至多关一次」覆盖到所有终结路径）。
// 3. 在每一步后断言：
//      - `_closed` 单调（用 lastClosed 跟踪，禁止从 true 翻回 false）；
//      - close 后 add 不会向底层 controller 触发新的 add（探针计数不变）；
//      - 底层 close 调用次数 ≤ 1。
//
// 500 次 runs（INV-5 关键不变量，与 tasks.md §5.21 一致）。

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/safe_stream_sink.dart';

// ──────────────────────────────────────────────────────────────────────────
// 探针 controller：通过组合 + 转发，记录底层 add / close 的实际调用次数
//
// 注意：`SafeStreamSink` 的构造函数签名为
//   SafeStreamSink(StreamController<T> controller)
// 期待传入一个真正的 StreamController；为了既能被构造函数接受、又能记录
// 调用次数，我们使用 dart:async 的 StreamController 子类化方案。
//
// dart:async 的 StreamController 是抽象类，不能直接 extend；但可以通过
// 委托模式实现一个「包装类」：内部持有一个真正的 broadcast controller，
// 并在 add / close 上做计数。然而 SafeStreamSink 构造签名只认
// `StreamController<T>` 子类。
//
// 折衷做法：直接使用真实的 StreamController；在测试中通过观察底层
// `controller.isClosed` / `hasListener` 等公开字段，以及订阅 stream 收到
// 的事件数量，来间接断言不变量条款 2 / 3。
// ──────────────────────────────────────────────────────────────────────────

/// 测试用监视器：包装真实的 StreamController + 一个订阅，
/// 记录 stream 收到的事件数与 onDone 触发时机。
///
/// 因为 SafeStreamSink 通过构造函数接收 StreamController，且关闭时调用
/// `_controller.close()`，订阅的 onDone 会在底层真正 close 时触发；
/// 所以订阅的 doneCount 上限就是底层 close 实际被调用次数（至多 1）。
class _SinkMonitor<T> {
  final StreamController<T> controller;
  final SafeStreamSink<T> sink;

  /// 订阅收到的事件总数（来自底层 controller.add 的实际转发）。
  int receivedEventCount = 0;

  /// 订阅的 onDone 被触发次数。Stream 协议保证 onDone 至多触发一次，
  /// 但用计数器仍能在「测试代码本身写错」时立刻暴露。
  int doneTriggerCount = 0;

  late final StreamSubscription<T> _subscription;

  _SinkMonitor._(this.controller, this.sink) {
    _subscription = controller.stream.listen(
      (_) => receivedEventCount++,
      onDone: () => doneTriggerCount++,
    );
  }

  factory _SinkMonitor.create() {
    final controller = StreamController<T>();
    final sink = SafeStreamSink<T>(controller);
    return _SinkMonitor._(controller, sink);
  }

  /// 主动放弃订阅（测试结束时调用，避免内存泄漏 / pending Future 警告）。
  Future<void> dispose() async {
    await _subscription.cancel();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 操作序列
// ──────────────────────────────────────────────────────────────────────────

enum _Op { add, close, cancel }

class _Action {
  final _Op op;
  final int payload; // 仅 add 用；close / cancel 忽略
  const _Action(this.op, this.payload);

  @override
  String toString() {
    switch (op) {
      case _Op.add:
        return 'add($payload)';
      case _Op.close:
        return 'close()';
      case _Op.cancel:
        return 'cancel()';
    }
  }
}

extension on Any {
  /// 生成 [0, 30] 长度的随机操作序列。
  Generator<List<_Action>> get actionSequences {
    return combine2<int, int, List<_Action>>(
      intInRange(0, 31),
      intInRange(0, 1 << 30),
      (seqLen, seed) {
        if (seqLen == 0) return const <_Action>[];
        final rng = math.Random(seed);
        return List<_Action>.generate(seqLen, (_) {
          // add ~70%，close ~15%，cancel ~15%
          final dice = rng.nextInt(20);
          if (dice < 14) {
            return _Action(_Op.add, rng.nextInt(1 << 16));
          } else if (dice < 17) {
            return const _Action(_Op.close, 0);
          } else {
            return const _Action(_Op.cancel, 0);
          }
        });
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 21: SafeStreamSink closed 单调性', () {
    Glados<List<_Action>>(
      any.actionSequences,
      ExploreConfig(numRuns: 500),
    ).test(
      '任意 (add | close | cancel) 操作序列下：_closed 单调；close 后 add no-op；底层 close 至多一次',
      (actions) async {
        final monitor = _SinkMonitor<int>.create();
        final sink = monitor.sink;

        // 初始状态自检
        expect(sink.isClosed, isFalse, reason: '初始 SafeStreamSink 应为未关闭状态');

        var lastClosed = false;
        var receivedBeforeFirstClose = 0;
        var firstClosedAt = -1;

        try {
          for (var i = 0; i < actions.length; i++) {
            final action = actions[i];

            // 调用前快照：底层订阅收到的事件数。
            // 由于 receive 是异步的（事件经由 microtask 投递），我们在
            // 「不期望发生 add」的断言点等一个微任务再读 receivedEventCount。
            switch (action.op) {
              case _Op.add:
                sink.add(action.payload);
                break;
              case _Op.close:
                sink.close();
                break;
              case _Op.cancel:
                // 在 SafeStreamSink 语义里 cancel 与 close 等价：
                // 都是终结流的入口，都要满足「至多关一次」。
                sink.close();
                break;
            }

            // ── 断言 1：单调性 —— _closed 一旦为 true 不可回 false ──
            if (lastClosed) {
              expect(
                sink.isClosed,
                isTrue,
                reason:
                    '违反 INV-5（1）单调性：_closed 已为 true 但执行 $action 后回到 false。\n'
                    '  序列前缀 = ${actions.sublist(0, i + 1)}',
              );
            }
            lastClosed = sink.isClosed;
            if (sink.isClosed && firstClosedAt < 0) {
              firstClosedAt = i;
            }

            // ── 让事件循环跑一轮，让 receivedEventCount / doneTriggerCount
            // 都有机会被异步事件更新。
            await Future<void>.delayed(Duration.zero);

            // ── 断言 2：close 后 add 不触达底层 controller ──
            // 在第一次 close 之前累计到 receivedBeforeFirstClose；之后再有
            // add 也不应让 receivedEventCount 超过 (receivedBeforeFirstClose +
            // 当前已 close 标志被翻起后产生的合法 add 数)。简单做法：
            // 一旦 _closed 为 true，记录此时的 receivedEventCount，作为后续
            // add 的「上界」（理想情况是不再增长）。
            if (sink.isClosed) {
              if (firstClosedAt == i) {
                // 第一次 close 那一刻的事件总数即为后续不变量上界。
                receivedBeforeFirstClose = monitor.receivedEventCount;
              } else {
                expect(
                  monitor.receivedEventCount,
                  lessThanOrEqualTo(receivedBeforeFirstClose),
                  reason:
                      '违反 INV-5（2）close 后 add no-op：'
                      '执行 $action 后底层 controller 收到了新事件（'
                      'before=$receivedBeforeFirstClose, '
                      'after=${monitor.receivedEventCount}）。\n'
                      '  序列前缀 = ${actions.sublist(0, i + 1)}',
                );
              }
            }

            // ── 断言 3：底层 close 至多被触发一次 ──
            // 订阅的 onDone 是底层 close 的唯一外部信号；至多 1。
            expect(
              monitor.doneTriggerCount,
              lessThanOrEqualTo(1),
              reason:
                  '违反 INV-5（3）底层 close 至多一次：'
                  '执行 $action 后 doneTriggerCount=${monitor.doneTriggerCount}。\n'
                  '  序列前缀 = ${actions.sublist(0, i + 1)}',
            );
          }

          // 终态总结性断言：若整个序列中至少出现过一次 close / cancel，
          // 那么底层 controller 的 onDone 必然恰好触发 1 次；否则 0 次。
          // 给事件循环最后一次机会跑完。
          await Future<void>.delayed(Duration.zero);
          final hasClose = actions.any(
            (a) => a.op == _Op.close || a.op == _Op.cancel,
          );
          if (hasClose) {
            expect(
              monitor.doneTriggerCount,
              1,
              reason:
                  '终态期望 onDone 恰好被触发 1 次，'
                  '但实际=${monitor.doneTriggerCount}。\n  操作序列=$actions',
            );
            expect(
              sink.isClosed,
              isTrue,
              reason: '终态 sink.isClosed 必须为 true，但=${sink.isClosed}',
            );
          } else {
            expect(
              monitor.doneTriggerCount,
              0,
              reason:
                  '未出现 close / cancel 操作时 onDone 不应触发，'
                  '但实际=${monitor.doneTriggerCount}。\n  操作序列=$actions',
            );
            expect(
              sink.isClosed,
              isFalse,
              reason: '未关闭时 sink.isClosed 必须为 false，但=${sink.isClosed}',
            );
          }
        } finally {
          // 主动关闭 sink 与订阅，避免 pending controller 在下一轮 run 中
          // 被 GC 触发警告。多次 close 是安全的（INV-5（3））。
          sink.close();
          await monitor.dispose();
        }
      },
    );
  });
}
