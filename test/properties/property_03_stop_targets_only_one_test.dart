// Feature: flutter-pixel-perfect-parity, Property 3: stop 仅取消目标对话
// Validates: Requirements B3.6, C4.1, C4.2
//
// 设计说明
// ────────
// design.md §3 ChatProvider 状态机契约要求：
//   stop(convId) 必须仅取消 abortControllers[convId] 这一个 CancelToken，
//   不影响其它并发对话；同时 stop 自身不清空 abortControllers / activeStreams
//   两个集合，清理交由 send / regenerate 的 finally 分支统一处理。
//
// 与之对应的需求条款：
//   - B3.6：用户点击「停止生成」时，仅取消当前对话对应的中止控制器，
//           不影响其它对话的并发流；
//   - C4.1：CancelToken 在被 stop 调用后必须真实标记为已取消；
//   - C4.2：非目标对话的 CancelToken 状态必须保持不变。
//
// 本属性测试不依赖具体 ChatProvider 实现，只校验「stop 的语义切片」：
//   - 在测试内部定义最小的 `_FakeStreamRegistry`，含
//     `Map<String, CancelToken> abortControllers` 与 `void stop(String convId)`；
//   - stop 的实现严格按 design 描述：仅取出 `abortControllers[convId]` 调用
//     `.cancel()`，不移除条目，不影响其它条目；
//   - glados 随机生成 `(convPool, stopTarget)` 二元组：
//       * convPool 是初始 conv ID 列表（允许去重前包含重复，去重后注册到
//         registry，避免同一 convId 多次覆盖 token 影响断言）；
//       * stopTarget 可能在 convPool 中，也可能不在（覆盖「停止不存在的
//         对话」边界）；
//   - 断言：调用 `registry.stop(stopTarget)` 后
//       * 所有非 stopTarget 的 CancelToken 仍 `isCancelled == false`；
//       * 仅当 stopTarget 已在池中且 stop 之前未取消时，stopTarget 的
//         CancelToken 才 `isCancelled == true`；其它情况均不应触发取消。

import 'dart:math' as math;

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 最小 `_FakeStreamRegistry`
//
// 仅保留 ChatProviderContract 中与 stop 语义直接相关的字段与方法，
// 行为与 design §3 / B3.6 / C4.1 / C4.2 完全一致：
//   - register(convId)：登记一个新的 CancelToken；同 convId 重复登记会
//     覆盖旧 token（与 send / regenerate 多次发起新流的语义一致）；
//   - stop(convId)：仅取消该 convId 的 CancelToken；不存在则 no-op；
//     不从 abortControllers 中移除条目，避免在并发场景下与 finally 清理
//     抢占职责。
// ──────────────────────────────────────────────────────────────────────────

class _FakeStreamRegistry {
  final Map<String, CancelToken> abortControllers = <String, CancelToken>{};

  /// 登记一个对话的中止控制器（模拟 send / regenerate 进入流式分支）。
  void register(String convId) {
    abortControllers[convId] = CancelToken();
  }

  /// 停止指定对话：仅取消对应的 CancelToken，不影响其它条目。
  ///
  /// 实现严格按 design §3 描述——「仅取出 `abortControllers[convId]`
  /// 调用 `.cancel()`，不移除条目，不影响其它对话」。
  void stop(String convId) {
    final token = abortControllers[convId];
    if (token != null && !token.isCancelled) {
      token.cancel('stop');
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试场景
//
// `(convPool, stopTarget)` 二元组：
//   - convPool：初始注册到 registry 的对话 ID 列表（可能包含重复，注册
//     时按集合语义去重，最终每个唯一 convId 持有唯一的 CancelToken）；
//   - stopTarget：调用 stop 时传入的目标 convId，可能在池中也可能不在。
// ──────────────────────────────────────────────────────────────────────────

class _Scenario {
  final List<String> convPool;
  final String stopTarget;
  const _Scenario(this.convPool, this.stopTarget);

  @override
  String toString() => 'pool=$convPool, stopTarget=$stopTarget';
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：构造 `(convPool, stopTarget)` 场景
//
// 设计策略：
//   - 池大小 ∈ [0, 8]：覆盖空池、单条与中等规模池；
//   - 池中 convId 从固定字母表 ['conv-0' .. 'conv-9'] 抽取，允许重复；
//   - stopTarget 取自一个稍大的字母表 ['conv-0' .. 'conv-11']，从而以
//     一定概率落到池外（覆盖「停止不存在的对话」边界），同时也以较高
//     概率命中池内（覆盖正常路径）；
//   - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<_Scenario> get stopScenarios {
    return combine3<int, int, int, _Scenario>(
      intInRange(0, 9), // 池大小 [0, 8]
      intInRange(0, 1 << 30), // 池采样种子
      intInRange(0, 12), // stopTarget 索引 [0, 11]：超出 [0, 9] 时落到池外
      (poolSize, seed, stopIdx) {
        final rng = math.Random(seed);
        final pool = List<String>.generate(
          poolSize,
          (_) => 'conv-${rng.nextInt(10)}',
        );
        final stopTarget = 'conv-$stopIdx';
        return _Scenario(pool, stopTarget);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 3: stop 仅取消目标对话', () {
    Glados<_Scenario>(
      any.stopScenarios,
      ExploreConfig(numRuns: 100),
    ).test(
      '调用 stop(stopTarget) 后：仅当 stopTarget 在池中时该 token 被取消，'
      '其它 token 一律保持未取消',
      (scenario) {
        final reg = _FakeStreamRegistry();

        // 步骤 1：把池中的对话依次注册到 registry（同 convId 重复出现时
        //         覆盖旧 token，最终保留唯一一个 CancelToken）。
        for (final convId in scenario.convPool) {
          reg.register(convId);
        }

        // 记录调用 stop 之前每个 convId 的 token 引用与取消状态，方便
        // 之后逐一比对。
        final priorTokens = Map<String, CancelToken>.from(reg.abortControllers);
        final priorCancelled = <String, bool>{
          for (final entry in priorTokens.entries)
            entry.key: entry.value.isCancelled,
        };

        // 步骤 2：调用 stop。
        reg.stop(scenario.stopTarget);

        // 步骤 3：断言每个登记中的对话状态。
        for (final entry in reg.abortControllers.entries) {
          final convId = entry.key;
          final token = entry.value;

          // 不变量 a：stop 不得移除任何条目，token 引用必须与 stop 之前一致。
          expect(
            identical(token, priorTokens[convId]),
            isTrue,
            reason:
                '违反 B3.6：stop 不允许移除或替换 '
                'abortControllers[$convId] 条目',
          );

          if (convId == scenario.stopTarget) {
            // stopTarget 在池中：当且仅当 stop 之前未取消时被取消。
            final wasCancelledBefore = priorCancelled[convId] ?? false;
            expect(
              token.isCancelled,
              isTrue,
              reason:
                  '违反 C4.1：stop($convId) 后目标 token 应处于已取消状态'
                  '（stop 之前 isCancelled=$wasCancelledBefore）',
            );
          } else {
            // 非目标对话：CancelToken 状态必须保持与 stop 之前一致。
            final wasCancelledBefore = priorCancelled[convId] ?? false;
            expect(
              token.isCancelled,
              wasCancelledBefore,
              reason:
                  '违反 C4.2：stop(${scenario.stopTarget}) 不应改变非目标 '
                  '$convId 的 isCancelled（之前=$wasCancelledBefore，'
                  '之后=${token.isCancelled}）',
            );
          }
        }

        // 不变量 b：若 stopTarget 不在池中，则整个 abortControllers 中
        // 不应出现任何被本次 stop 触发的取消（即所有 token 状态与之前一致）。
        if (!reg.abortControllers.containsKey(scenario.stopTarget)) {
          for (final entry in reg.abortControllers.entries) {
            final wasCancelledBefore = priorCancelled[entry.key] ?? false;
            expect(
              entry.value.isCancelled,
              wasCancelledBefore,
              reason:
                  '违反 B3.6：stop(${scenario.stopTarget}) 命中池外目标时'
                  '不应取消任何已登记 token，但 ${entry.key} 状态发生变化',
            );
          }
        }
      },
    );
  });
}
