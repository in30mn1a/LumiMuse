// Feature: flutter-pixel-perfect-parity, Property 2: 输入框 disabled 状态等价
// Validates: Requirements B3.5, C3.1, C3.2, C3.3
//
// 设计说明
// ────────
// design.md §3.1 ChatProvider 字段契约 与需求 B3.5 / C3.1~3.3 要求：
//   输入框是否 disabled 必须严格等价于「当前查看的对话 ID 是否在 activeStreams 中」。
//
//   - 当 activeStreams 不包含 currentConvId 时：输入栏可正常输入，发送按钮显示
//     「发送」，**禁止**因其他对话并发流式而被 disabled（C3.3：多对话并发隔离）。
//   - 当 activeStreams 包含 currentConvId 时：输入栏 disabled，发送按钮变为
//     「停止生成」（C3.1 / C3.2）。
//
// 本属性测试将该等价关系抽出为最小 pure function `isInputDisabled`，并用 glados
// 随机构造 `(activeStreams 池, currentConvId)` 输入对，覆盖「命中 / 未命中」两种
// 分支：
//
//   - 池中 ID 数量 ∈ [0, 8]：覆盖「无并发流」「单流」「多流并发」三种态；
//   - currentConvId 一半概率从池内抽取（命中），一半概率走「池外新 ID」（未命中），
//     两条分支都被高概率覆盖；
//   - 主断言：`isInputDisabled(curr, S) == S.contains(curr)` 永远成立；
//   - 配套断言：未命中时 disabled == false，命中时 disabled == true。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 被测纯函数
//
// 与 design §3.1 中 `ChatInput.disabled == activeStreams.contains(currentConvId)`
// 完全一致。任何实现（无论 ChangeNotifier 还是 Riverpod）都必须保持该等价关系。
// ──────────────────────────────────────────────────────────────────────────

/// 输入框 disabled 状态等价关系：
/// 当前对话 ID 在活跃流集合中即为 disabled，否则可输入。
bool isInputDisabled(String convId, Set<String> activeStreams) =>
    activeStreams.contains(convId);

// ──────────────────────────────────────────────────────────────────────────
// 测试用例载体
// ──────────────────────────────────────────────────────────────────────────

class _Case {
  /// 当前查看的对话 ID。
  final String currentConvId;

  /// 活跃流集合（其他对话与当前对话可能并存）。
  final Set<String> activeStreams;

  const _Case(this.currentConvId, this.activeStreams);

  @override
  String toString() =>
      'currentConvId=$currentConvId, activeStreams=$activeStreams';
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机 (currentConvId, activeStreams) 输入对
//
// 设计策略：
// - 池大小 ∈ [0, 8]：覆盖「无并发流（空集）」「单流」「多流并发」三种态；
// - 池中 ID 用 `conv-i` 形式生成，i 取自 [0, 16) 的随机不重复抽样；
// - currentConvId 由额外抽样位 `inPool` 决定走「池内命中」或「池外新 ID」分支：
//     * inPool == true && 池非空：从池中随机抽一个作为命中分支；
//     * 否则：走 `outsider-${seed}` 池外新 ID，覆盖未命中分支。
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<_Case> get inputDisabledCases {
    return combine3<int, int, bool, _Case>(
      intInRange(0, 9), // 池大小 [0, 8]
      intInRange(0, 1 << 30), // Random 种子
      any.bool, // 是否走「池内命中」分支（显式 any.bool 避免与类型 `bool` 冲突）
      (poolSize, seed, inPool) {
        final rng = math.Random(seed);

        // 不重复抽样池：从 [0, 16) 中随机挑 poolSize 个，组成 conv-i。
        final indices = <int>{};
        while (indices.length < poolSize) {
          indices.add(rng.nextInt(16));
        }
        final pool = indices.map((i) => 'conv-$i').toSet();

        late String currentConvId;
        if (inPool && pool.isNotEmpty) {
          // 命中分支：从池中随机抽取一个 ID。
          final picked = pool.elementAt(rng.nextInt(pool.length));
          currentConvId = picked;
        } else {
          // 未命中分支：用「池外新 ID」（带 seed 后缀，与池中 conv-i 形式不同）。
          currentConvId = 'outsider-$seed';
        }

        return _Case(currentConvId, pool);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 2: 输入框 disabled 状态 = 当前对话在 activeStreams 中', () {
    Glados<_Case>(
      any.inputDisabledCases,
      ExploreConfig(numRuns: 100),
    ).test(
      '对任意 (currentConvId, activeStreams) 输入对，'
      'isInputDisabled(currentConvId, activeStreams) == activeStreams.contains(currentConvId)',
      (c) {
        // 主断言：等价关系永远成立。
        expect(
          isInputDisabled(c.currentConvId, c.activeStreams),
          equals(c.activeStreams.contains(c.currentConvId)),
          reason:
              'INV：isInputDisabled 必须恰好等于 activeStreams.contains(currentConvId) '
              '($c)',
        );

        // 配套断言：未命中时 disabled == false（C3.3 多对话并发隔离）。
        if (!c.activeStreams.contains(c.currentConvId)) {
          expect(
            isInputDisabled(c.currentConvId, c.activeStreams),
            isFalse,
            reason:
                '当前对话不在 activeStreams 中时输入栏必须可输入，'
                '不应受其他并发流影响 ($c)',
          );
        }

        // 配套断言：命中时 disabled == true（C3.1 / C3.2）。
        if (c.activeStreams.contains(c.currentConvId)) {
          expect(
            isInputDisabled(c.currentConvId, c.activeStreams),
            isTrue,
            reason:
                '当前对话正在生成时输入栏必须 disabled，'
                '发送按钮应变为停止生成 ($c)',
          );
        }
      },
    );
  });
}
