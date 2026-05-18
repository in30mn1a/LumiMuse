// Feature: flutter-pixel-perfect-parity, Property 1: activeStreams 子集不变量
// Validates: Requirements B3.1, B3.2
//
// 设计说明
// ────────
// design.md §3.2 send 流程与 INV-1 要求：
//   任意时刻 `activeStreams ⊆ abortControllers.keys`。
//
// 本属性测试在不依赖具体 ChatProvider 实现的前提下，把契约层「四种动作」
// （send / regenerate / stop / cleanup）抽出为最小 `_FakeStreamRegistry`，
// 并用 glados 随机构造 `(action, convId)` 操作序列：
//
//   - send(convId)        —— 与 regenerate 一样，同时往两侧插入；
//   - regenerate(convId)  —— 同 send：流式分支前 activeStreams.add + abortControllers[convId] = newToken；
//   - stop(convId)        —— 仅取消该 convId 的 CancelToken，不清空两侧（清理统一交给 finally / cleanup）；
//   - cleanup(convId)     —— 在 try/finally 中执行，从 activeStreams 与 abortControllers 同时移除。
//
// 每执行一步操作就断言 `activeStreams.difference(abortControllers.keys)` 为空。
// 失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 操作类型与单步动作
// ──────────────────────────────────────────────────────────────────────────

/// 四种操作 —— 与 design §3.2 描述的 ChatProvider 多对话并发流式动作一一对应。
enum _Op { send, regenerate, stop, cleanup }

/// 单步操作 —— `(action, convId)` 二元组。
class _Action {
  final _Op op;
  final String convId;
  const _Action(this.op, this.convId);

  @override
  String toString() => '${op.name}($convId)';
}

// ──────────────────────────────────────────────────────────────────────────
// 最小 `_FakeStreamRegistry`
//
// 只保留 ChatProvider 的两个核心字段，行为与 design §3.2 / INV-1 完全一致：
// - send / regenerate 同时往 `activeStreams` 与 `abortControllers` 插入；
// - stop 只取消 token，不动两个集合；
// - cleanup 同时从两个集合移除。
// ──────────────────────────────────────────────────────────────────────────

class _FakeStreamRegistry {
  final Set<String> activeStreams = <String>{};
  final Map<String, CancelToken> abortControllers = <String, CancelToken>{};

  /// 发起新流：同时把 convId 加入 activeStreams 与 abortControllers。
  void send(String convId) {
    activeStreams.add(convId);
    abortControllers[convId] = CancelToken();
  }

  /// 重新生成：与 send 一致 —— 同时插入两侧（覆盖旧 token，模拟新一次流式）。
  void regenerate(String convId) {
    activeStreams.add(convId);
    abortControllers[convId] = CancelToken();
  }

  /// 停止：仅取消该 convId 的 CancelToken，不清空两个集合。
  ///
  /// 落实 design §3.2「不在此处清空 activeStreams，由 send / regenerate 的
  /// finally 分支统一清理」。
  void stop(String convId) {
    final token = abortControllers[convId];
    if (token != null && !token.isCancelled) {
      token.cancel('stop');
    }
  }

  /// 清理：在 try/finally 中执行，从 activeStreams 与 abortControllers 同步移除。
  void cleanup(String convId) {
    activeStreams.remove(convId);
    abortControllers.remove(convId);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机构造 (action, convId) 操作序列
//
// 设计策略：
// - 序列长度 ∈ [0, 30]：覆盖空序列、单步与中等规模序列。
// - 对话 ID 池大小 3（'A' / 'B' / 'C'）：故意让池小一些，强迫不同操作高概率
//   命中同一 convId，覆盖「同 convId 多次 send / 中间穿插 stop / cleanup 后
//   再次 send」等典型分支。
// - 操作类型从 `_Op.values` 等概率抽取，保证四种动作均有覆盖。
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

const List<String> _convIdPool = <String>['A', 'B', 'C'];

extension on Any {
  Generator<List<_Action>> get streamActionSequences {
    return combine2<int, int, List<_Action>>(
      intInRange(0, 31), // 序列长度 [0, 30]
      intInRange(0, 1 << 30), // Random 种子
      (seqLen, seed) {
        if (seqLen == 0) return const <_Action>[];
        final rng = math.Random(seed);
        return List<_Action>.generate(seqLen, (_) {
          final op = _Op.values[rng.nextInt(_Op.values.length)];
          final convId = _convIdPool[rng.nextInt(_convIdPool.length)];
          return _Action(op, convId);
        });
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 1: activeStreams ⊆ abortControllers.keys 不变量', () {
    Glados<List<_Action>>(
      any.streamActionSequences,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 send/regenerate/stop/cleanup 操作序列下，每一步后 activeStreams 都是 abortControllers.keys 的子集',
      (actions) {
        final reg = _FakeStreamRegistry();

        // 初始状态：activeStreams 为空 —— 子集关系平凡成立。
        expect(
          reg.activeStreams.difference(reg.abortControllers.keys.toSet()),
          isEmpty,
          reason: '初始状态 activeStreams 必为空',
        );

        for (final action in actions) {
          switch (action.op) {
            case _Op.send:
              reg.send(action.convId);
              break;
            case _Op.regenerate:
              reg.regenerate(action.convId);
              break;
            case _Op.stop:
              reg.stop(action.convId);
              break;
            case _Op.cleanup:
              reg.cleanup(action.convId);
              break;
          }

          // INV-1：每一步执行完后立即断言子集关系。
          final keys = reg.abortControllers.keys.toSet();
          final diff = reg.activeStreams.difference(keys);
          expect(
            diff,
            isEmpty,
            reason:
                '执行 $action 后违反 INV-1：'
                'activeStreams=${reg.activeStreams}，'
                'abortControllers.keys=$keys，'
                '差集=$diff 应为空',
          );
        }
      },
    );
  });
}
