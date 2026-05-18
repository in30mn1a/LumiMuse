// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 18: 自动滚动策略组合不变量
// Validates: Requirements C1.1, C1.2, C1.3, C1.4, C1.5
//
// 设计说明
// ────────
// design.md §Property 18 / requirements.md C1.1 ~ C1.5 要求：
//   对任意消息流事件序列 E 与「距底距离」d，自动滚动策略 `decideAutoScroll`
//   必须满足：
//     · 用户主动 send → 强制滚到底部一次（forceScrollToBottom=true，无动画）；
//     · 流式期间且距底 < 180 像素 → 跟随滚动（smooth）；
//     · 流式期间且距底 ≥ 180 像素 → 不滚（用户在看历史，不强行拉回）；
//     · 仅 metadata 更新 → 不滚（与主项目 skipScrollRef 等价）；
//     · regenerate 完成 → 与 send 同处理（强制滚到底部一次）；
//     · 初次加载与「加载更早」事件 → 不触发滚动（与 flutter-visual-polish
//       需求 2 一致）。
//
// 实现策略
// ────────
// 在测试内定义最小：
//   - `_FakeScrollController`：模拟距底距离 d，提供 distanceToBottom 字段；
//   - `_ScrollEventKind`：枚举 6 种事件 send / streamChunk / metadataOnly /
//      regenerateDone / initialLoad / loadEarlier；
//   - `_ScrollEvent`：携带 kind 与一个时刻的 distanceToBottom；
//   - 纯函数 `decideAutoScroll(event, distanceToBottom)`：返回 `_ScrollDecision`
//     {shouldScroll, animated}。
//
// glados 随机构造长度 ∈ [0, 12] 的事件序列，逐步驱动 controller 与决策函数；
// 每一步独立断言上述五条 if/then 条款。
//
// 100 次 runs（与 tasks.md §5.18 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 数据模型
// ──────────────────────────────────────────────────────────────────────────

/// 距底阈值（与主项目 `isMessageListNearBottom()` 的 180 像素阈值一致）。
const double _kNearBottomThreshold = 180.0;

enum _ScrollEventKind {
  /// 用户主动发送消息 —— 强制滚到底部一次（无动画）。
  send,

  /// 流式 chunk 到达 —— 接近底部时跟随（动画）；远离底部不动。
  streamChunk,

  /// 仅 metadata 更新（如生图气泡更新展示版本但不改变文本）—— 不滚。
  metadataOnly,

  /// 重新生成完成 —— 与 send 同处理。
  regenerateDone,

  /// 初次进入对话 —— 不触发出现动画与跟随滚动。
  initialLoad,

  /// 加载更早历史消息 —— 不触发出现动画与跟随滚动。
  loadEarlier,
}

class _ScrollEvent {
  final _ScrollEventKind kind;
  final double distanceToBottom; // ≥ 0；流式分支才会被使用

  const _ScrollEvent({
    required this.kind,
    required this.distanceToBottom,
  });

  @override
  String toString() =>
      '_ScrollEvent(kind=$kind, distanceToBottom=$distanceToBottom)';
}

/// 决策结果：
/// - `shouldScroll`：是否触发滚动；
/// - `animated`：是否使用 smooth 动画（false 表示无动画 / instant）；
/// - `forced`：是否「强制」滚到底部（即一次性 forceScrollToBottom）。
class _ScrollDecision {
  final bool shouldScroll;
  final bool animated;
  final bool forced;

  const _ScrollDecision({
    required this.shouldScroll,
    required this.animated,
    required this.forced,
  });

  static const _ScrollDecision noScroll = _ScrollDecision(
    shouldScroll: false,
    animated: false,
    forced: false,
  );

  @override
  String toString() => '_ScrollDecision('
      'shouldScroll=$shouldScroll, animated=$animated, forced=$forced)';
}

// ──────────────────────────────────────────────────────────────────────────
// fake ScrollController：仅追踪距底距离与「滚到底部」调用次数
// ──────────────────────────────────────────────────────────────────────────

class _FakeScrollController {
  double distanceToBottom;
  int instantScrollToBottomCount = 0;
  int smoothScrollToBottomCount = 0;

  _FakeScrollController({required this.distanceToBottom});

  void apply(_ScrollDecision decision) {
    if (!decision.shouldScroll) return;
    if (decision.animated) {
      smoothScrollToBottomCount++;
    } else {
      instantScrollToBottomCount++;
    }
    // 滚到底部 → 距底距离归零。
    distanceToBottom = 0.0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：decideAutoScroll
//
// 落实 design §Property 18 / requirements §C1.1~C1.5 的契约：
//   - send / regenerateDone：forced + 无动画 + shouldScroll=true；
//   - streamChunk：当 distanceToBottom < 180 → smooth 跟随；否则不动；
//   - metadataOnly / initialLoad / loadEarlier：不动。
// ──────────────────────────────────────────────────────────────────────────

_ScrollDecision decideAutoScroll(_ScrollEvent event) {
  switch (event.kind) {
    case _ScrollEventKind.send:
    case _ScrollEventKind.regenerateDone:
      return const _ScrollDecision(
        shouldScroll: true,
        animated: false,
        forced: true,
      );
    case _ScrollEventKind.streamChunk:
      if (event.distanceToBottom < _kNearBottomThreshold) {
        return const _ScrollDecision(
          shouldScroll: true,
          animated: true,
          forced: false,
        );
      }
      return _ScrollDecision.noScroll;
    case _ScrollEventKind.metadataOnly:
    case _ScrollEventKind.initialLoad:
    case _ScrollEventKind.loadEarlier:
      return _ScrollDecision.noScroll;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机事件序列 + 初始距底距离
//
// 设计策略：
// - 序列长度 ∈ [0, 12]：覆盖空、单条、长链路；
// - 每事件 distanceToBottom 独立从 [0, 600] 区间抽样，覆盖 < 180 与 ≥ 180
//   两条分支；
// - 事件 kind 等概率从 6 种事件抽取；
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

class _Scenario {
  final int seqLen;
  final int seed;
  final double initialDistance;

  const _Scenario({
    required this.seqLen,
    required this.seed,
    required this.initialDistance,
  });

  @override
  String toString() => '_Scenario('
      'seqLen=$seqLen, seed=$seed, initialDistance=$initialDistance)';
}

extension on Any {
  Generator<_Scenario> get scrollScenarios {
    return combine3<int, int, int, _Scenario>(
      intInRange(0, 13), // 序列长度 [0, 12]
      intInRange(0, 1 << 30), // Random 种子
      intInRange(0, 601), // 初始距底距离 [0, 600]
      (len, seed, dist) => _Scenario(
        seqLen: len,
        seed: seed,
        initialDistance: dist.toDouble(),
      ),
    );
  }
}

List<_ScrollEvent> _buildEvents(_Scenario s) {
  final rng = math.Random(s.seed);
  return List<_ScrollEvent>.generate(s.seqLen, (_) {
    final kind = _ScrollEventKind.values[rng.nextInt(_ScrollEventKind.values.length)];
    final dist = rng.nextInt(601).toDouble(); // [0, 600]
    return _ScrollEvent(kind: kind, distanceToBottom: dist);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 18: 自动滚动策略组合不变量', () {
    Glados<_Scenario>(
      any.scrollScenarios,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意事件序列：每步决策独立满足 C1.1~C1.5 五条不变量',
      (s) {
        final controller =
            _FakeScrollController(distanceToBottom: s.initialDistance);
        final events = _buildEvents(s);

        var sendForcedCount = 0;
        var regenForcedCount = 0;
        var smoothFollowCount = 0;
        var farFromBottomNoScroll = 0;
        var metadataNoScroll = 0;
        var initialLoadNoScroll = 0;
        var loadEarlierNoScroll = 0;

        for (var step = 0; step < events.length; step++) {
          final ev = events[step];
          final decision = decideAutoScroll(ev);

          switch (ev.kind) {
            case _ScrollEventKind.send:
              // C1.1：用户主动 send → 强制滚到底部一次（forced=true，无动画）。
              expect(
                decision.shouldScroll,
                isTrue,
                reason: 'step=$step send 必须 shouldScroll=true：$ev / $decision',
              );
              expect(
                decision.forced,
                isTrue,
                reason: 'step=$step send 必须 forced=true：$ev / $decision',
              );
              expect(
                decision.animated,
                isFalse,
                reason: 'step=$step send 必须无动画 (animated=false)：$ev / $decision',
              );
              sendForcedCount++;
              break;

            case _ScrollEventKind.regenerateDone:
              // C1（与 send 同处理）：regenerate 完成强制滚到底部一次。
              expect(
                decision.shouldScroll,
                isTrue,
                reason: 'step=$step regenerateDone 必须 shouldScroll=true：'
                    '$ev / $decision',
              );
              expect(
                decision.forced,
                isTrue,
                reason: 'step=$step regenerateDone 必须 forced=true：$ev / $decision',
              );
              expect(
                decision.animated,
                isFalse,
                reason: 'step=$step regenerateDone 必须无动画：$ev / $decision',
              );
              regenForcedCount++;
              break;

            case _ScrollEventKind.streamChunk:
              if (ev.distanceToBottom < _kNearBottomThreshold) {
                // C1.2：距底 < 180 → smooth 跟随。
                expect(
                  decision.shouldScroll,
                  isTrue,
                  reason: 'step=$step 流式且距底 < 180，必须跟随：$ev / $decision',
                );
                expect(
                  decision.animated,
                  isTrue,
                  reason: 'step=$step 流式跟随必须使用 smooth 动画：$ev / $decision',
                );
                expect(
                  decision.forced,
                  isFalse,
                  reason: 'step=$step 流式跟随不应是 forced：$ev / $decision',
                );
                smoothFollowCount++;
              } else {
                // C1.3：距底 ≥ 180 → 一定不发生跟随（用户在看历史）。
                expect(
                  decision.shouldScroll,
                  isFalse,
                  reason: 'step=$step 流式且距底 ≥ 180，必须不滚：$ev / $decision',
                );
                farFromBottomNoScroll++;
              }
              break;

            case _ScrollEventKind.metadataOnly:
              // C1.4：仅 metadata 更新 → 不滚。
              expect(
                decision,
                _ScrollDecision.noScroll,
                reason: 'step=$step 仅 metadata 更新必须不滚：$ev / $decision',
              );
              metadataNoScroll++;
              break;

            case _ScrollEventKind.initialLoad:
              // C1.5：初次加载不触发出现动画与跟随滚动。
              expect(
                decision,
                _ScrollDecision.noScroll,
                reason: 'step=$step 初次加载必须不滚：$ev / $decision',
              );
              initialLoadNoScroll++;
              break;

            case _ScrollEventKind.loadEarlier:
              // C1.5（同上）：加载更早历史不触发出现动画与跟随滚动。
              expect(
                decision,
                _ScrollDecision.noScroll,
                reason: 'step=$step 加载更早历史必须不滚：$ev / $decision',
              );
              loadEarlierNoScroll++;
              break;
          }

          // 应用决策到 fake controller。
          controller.apply(decision);
        }

        // 终态总不变量：send / regenerateDone 共触发了多少次 instant 滚动；
        // streamChunk 距底 < 180 触发了多少次 smooth 滚动 —— 与上面计数一致。
        expect(
          controller.instantScrollToBottomCount,
          sendForcedCount + regenForcedCount,
          reason: 'instant 滚动次数应等于 send + regenerateDone 总数。\n'
              '  send=$sendForcedCount, regenerate=$regenForcedCount, '
              'instant=${controller.instantScrollToBottomCount}',
        );
        expect(
          controller.smoothScrollToBottomCount,
          smoothFollowCount,
          reason: 'smooth 滚动次数应等于流式跟随次数。\n'
              '  follow=$smoothFollowCount, '
              'smooth=${controller.smoothScrollToBottomCount}',
        );

        // 计数总和 == 序列长度（每步事件被精确分类一次）。
        expect(
          sendForcedCount +
              regenForcedCount +
              smoothFollowCount +
              farFromBottomNoScroll +
              metadataNoScroll +
              initialLoadNoScroll +
              loadEarlierNoScroll,
          events.length,
          reason: '事件分类计数总和应等于序列长度，但实际不一致',
        );
      },
    );

    // ──────────────────────────────────────────────
    // 例测：固化 design §Property 18 列出的关键边界
    // ──────────────────────────────────────────────

    test('用户主动 send：强制滚到底部一次（无动画）', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.send,
        distanceToBottom: 500.0,
      );
      final decision = decideAutoScroll(ev);
      expect(decision.shouldScroll, isTrue);
      expect(decision.forced, isTrue);
      expect(decision.animated, isFalse);
    });

    test('流式 chunk 距底 100（< 180）：smooth 跟随', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.streamChunk,
        distanceToBottom: 100.0,
      );
      final decision = decideAutoScroll(ev);
      expect(decision.shouldScroll, isTrue);
      expect(decision.animated, isTrue);
    });

    test('流式 chunk 距底 200（≥ 180）：不滚', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.streamChunk,
        distanceToBottom: 200.0,
      );
      final decision = decideAutoScroll(ev);
      expect(decision.shouldScroll, isFalse);
    });

    test('流式 chunk 距底恰好 180：不滚（边界 [180, ∞) 不跟随）', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.streamChunk,
        distanceToBottom: 180.0,
      );
      final decision = decideAutoScroll(ev);
      expect(
        decision.shouldScroll,
        isFalse,
        reason: '距底恰好等于 180 像素时不跟随（< 严格小于）',
      );
    });

    test('仅 metadata 更新：不滚', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.metadataOnly,
        distanceToBottom: 0.0,
      );
      final decision = decideAutoScroll(ev);
      expect(decision, _ScrollDecision.noScroll);
    });

    test('regenerate 完成：与 send 同处理', () {
      const ev = _ScrollEvent(
        kind: _ScrollEventKind.regenerateDone,
        distanceToBottom: 500.0,
      );
      final decision = decideAutoScroll(ev);
      expect(decision.shouldScroll, isTrue);
      expect(decision.forced, isTrue);
      expect(decision.animated, isFalse);
    });

    test('初次加载与加载更早：不触发滚动', () {
      const ev1 = _ScrollEvent(
        kind: _ScrollEventKind.initialLoad,
        distanceToBottom: 50.0,
      );
      const ev2 = _ScrollEvent(
        kind: _ScrollEventKind.loadEarlier,
        distanceToBottom: 0.0,
      );
      expect(decideAutoScroll(ev1), _ScrollDecision.noScroll);
      expect(decideAutoScroll(ev2), _ScrollDecision.noScroll);
    });
  });
}
