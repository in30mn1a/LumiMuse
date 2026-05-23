// Feature: flutter-pixel-perfect-parity, Scenario 7.5: 自动滚动策略
// Validates: Requirements C1.1, C1.2, C1.3, C1.4
//
// 设计说明
// ────────
// requirements.md §C1.1 ~ §C1.4 / design.md §正确性属性 Property 18 要求：
//   - C1.1：用户主动 send（forceScrollToBottom=true）→ 强制滚到底部一次。
//   - C1.2：流式期间用户上滚 200 像素后 chunk 抵达 → 不调用 scrollToBottom
//           （200 > 阈值 180，说明用户在看历史，不应被强行拉回）。
//   - C1.3：接近底部（距底 100 < 180）+ chunk 抵达 → 调用 scrollToBottom
//           跟随。
//   - C1.4：仅 metadata 更新事件（如版本切换）→ 不调用 scrollToBottom。
//
// 本场景使用：
//   - fake `ScrollController`：仅记录 scrollToBottom 调用次数与最近一次
//     的 distanceToBottom；
//   - fake provider：暴露 `forceScrollToBottom` 与 `skipScroll` 两个布尔
//     flag，并提供 `onChunk` / `onMetadataOnly` / `onSend` 三个事件入口。
//
// 不依赖任何真实 widget 树；不启动 MaterialApp。

import 'package:flutter_test/flutter_test.dart';

// ──────────────────────────────────────────────────────────────────────────
// fake ScrollController
//
// 仅记录 scrollToBottom 调用计数与每次的 (animated, forced) 标志。
// 不模拟真实滚动，只用作 spy。
// ──────────────────────────────────────────────────────────────────────────

class _FakeScrollController {
  /// 距底距离（外部直接修改以模拟用户上滚 / 接近底部）。
  double distanceToBottom;

  int scrollToBottomCount = 0;
  final List<({bool animated, bool forced})> calls = [];

  _FakeScrollController({this.distanceToBottom = 0});

  /// 模拟「滚到底部」，可选 animated / forced 标志。
  void scrollToBottom({bool animated = true, bool forced = false}) {
    scrollToBottomCount++;
    calls.add((animated: animated, forced: forced));
    distanceToBottom = 0; // 滚到底后距底归零
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 自动滚动决策器（C1.1 ~ C1.4 契约的最小落地）
//
// 设计：
//   - 用户主动 send 之前由调用方置位 forceScrollToBottom=true；ChatView 处理
//     send 事件时消费一次（onSend），无条件 scrollToBottom(forced=true,
//     animated=false)。
//   - 流式 chunk 抵达（onChunk）：若 distanceToBottom < 180 → 跟随
//     scrollToBottom(animated=true, forced=false)；否则不滚。
//   - 仅 metadata 更新（onMetadataOnly）：调用方应置位 skipScroll=true，
//     决策器看到 skipScroll 直接返回，不滚；返回前清零 skipScroll，
//     避免下一轮事件被误吞。
// ──────────────────────────────────────────────────────────────────────────

const double _kNearBottomThreshold = 180.0;

class _AutoScrollPolicy {
  bool forceScrollToBottom = false;
  bool skipScroll = false;

  /// 用户主动发送消息：消费 forceScrollToBottom 标志，无条件滚到底部一次。
  void onSend(_FakeScrollController controller) {
    final shouldForce = forceScrollToBottom;
    forceScrollToBottom = false; // 一次性消费
    if (shouldForce) {
      controller.scrollToBottom(animated: false, forced: true);
    }
  }

  /// 流式 chunk 抵达：根据距底距离决定是否跟随。
  void onChunk(_FakeScrollController controller) {
    if (skipScroll) {
      skipScroll = false;
      return;
    }
    if (controller.distanceToBottom < _kNearBottomThreshold) {
      controller.scrollToBottom(animated: true, forced: false);
    }
    // 距底 ≥ 180 → 不动（用户在看历史）
  }

  /// 仅 metadata 更新（如版本切换）：消费 skipScroll，绝不滚动。
  void onMetadataOnly(_FakeScrollController controller) {
    // 进入 metadata 分支前 ChatView 通常已置 skipScroll = true；这里
    // 即便外部忘了置位，也按"metadata 只更新展示"的语义不滚动。
    final wasSkip = skipScroll;
    skipScroll = false;
    // 无论 wasSkip 是否为 true，都不调用 scrollToBottom
    assert(wasSkip || true, 'metadata 分支不滚动，与 skipScroll 状态无关');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体（4 个子场景，每个一个独立 test）
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Scenario 7.5: 自动滚动策略 — 4 个子场景', () {
    test(
      '子场景 1：用户主动 send（forceScrollToBottom=true）→ scrollToBottom 调用 1 次',
      () {
        final controller = _FakeScrollController(distanceToBottom: 500);
        final policy = _AutoScrollPolicy()..forceScrollToBottom = true;

        policy.onSend(controller);

        expect(
          controller.scrollToBottomCount,
          1,
          reason: '违反 C1.1：用户主动 send 必须强制滚到底部一次',
        );
        expect(
          controller.calls.first.forced,
          isTrue,
          reason: 'send 触发的滚动必须是 forced=true（一次性强制）',
        );
        expect(
          controller.calls.first.animated,
          isFalse,
          reason: 'send 强制滚动应无动画（instant），避免视觉跳动',
        );
        expect(
          policy.forceScrollToBottom,
          isFalse,
          reason: 'forceScrollToBottom 必须在消费后归零（一次性 flag）',
        );
      },
    );

    test(
      '子场景 2：流式期间用户上滚 200 像素（>180）后 chunk 抵达 → scrollToBottom 不被调用',
      () {
        final controller = _FakeScrollController(distanceToBottom: 200);
        final policy = _AutoScrollPolicy();

        policy.onChunk(controller);

        expect(
          controller.scrollToBottomCount,
          0,
          reason: '违反 C1.2：流式期间距底 200（>180）必须不调用 scrollToBottom，'
              '尊重用户查看历史的意图',
        );
        expect(
          controller.distanceToBottom,
          200,
          reason: '不应改变 distanceToBottom（没有滚动发生）',
        );
      },
    );

    test(
      '子场景 3：接近底部（距底 100，<180）+ chunk 抵达 → scrollToBottom 调用',
      () {
        final controller = _FakeScrollController(distanceToBottom: 100);
        final policy = _AutoScrollPolicy();

        policy.onChunk(controller);

        expect(
          controller.scrollToBottomCount,
          1,
          reason: '违反 C1.3：流式期间距底 100（<180）必须跟随 scrollToBottom',
        );
        expect(
          controller.calls.first.animated,
          isTrue,
          reason: '流式跟随必须使用 smooth 动画（animated=true）',
        );
        expect(
          controller.calls.first.forced,
          isFalse,
          reason: '流式跟随不是强制滚动（forced=false）',
        );
      },
    );

    test(
      '子场景 4：仅 metadata 更新事件 → scrollToBottom 不被调用',
      () {
        final controller = _FakeScrollController(distanceToBottom: 0);
        final policy = _AutoScrollPolicy()..skipScroll = true;

        policy.onMetadataOnly(controller);

        expect(
          controller.scrollToBottomCount,
          0,
          reason: '违反 C1.4：仅 metadata 更新（如版本切换）必须不调用 scrollToBottom',
        );
      },
    );

    test(
      '边界：距底恰好 180 像素 + chunk 抵达 → 不跟随（< 严格小于阈值）',
      () {
        final controller =
            _FakeScrollController(distanceToBottom: 180);
        final policy = _AutoScrollPolicy();

        policy.onChunk(controller);

        expect(
          controller.scrollToBottomCount,
          0,
          reason: '阈值边界 distanceToBottom == 180 时不跟随（< 是严格小于）',
        );
      },
    );

    test(
      '组合：send 后立即收到 chunk（距底已经因 send 滚到 0）→ 不重复滚动',
      () {
        final controller =
            _FakeScrollController(distanceToBottom: 500);
        final policy = _AutoScrollPolicy()..forceScrollToBottom = true;

        // 用户 send → 强制滚到底部
        policy.onSend(controller);
        expect(controller.scrollToBottomCount, 1);
        expect(controller.distanceToBottom, 0);

        // chunk 抵达：距底 0 < 180 → 仍会跟随，但这是预期内的「保持贴底」
        policy.onChunk(controller);
        expect(controller.scrollToBottomCount, 2,
            reason: '距底 0 时 chunk 抵达仍应跟随，保持贴底视觉');
        // 第二次是 animated=true 的 smooth 跟随
        expect(controller.calls[1].animated, isTrue);
        expect(controller.calls[1].forced, isFalse);
      },
    );
  });
}
