// 文件：lib/core/services/safe_stream_sink.dart
//
// 用途：把所有流式分支（流式聊天、SSE 代理、记忆任务广播等）统一封装在
// `SafeStreamSink<T>` 之后，让"只关一次"成为类型层面的保证。任何流式产物的
// 出口都应通过 [SafeStreamSink.add] / [SafeStreamSink.close]，禁止直接对底层
// `StreamController` 调用 `add` / `close`。
//
// ───────────────────────────────────────────────────────────────────
// INV-5（来自 design.md §概览「关键不变量清单」）：
//   1. `_closed` 一旦为 true，永远不会回到 false（单调性）。
//   2. `close()` 之后所有 `add(event)` 一律 no-op，不再向底层 controller 转发，
//      也不会抛出异常。
//   3. 底层 `StreamController.close()` 至多被调用一次（即使外部多次调用
//      [SafeStreamSink.close]，只有第一次会实际关闭底层流）。
//
// 额外保护：当底层 `controller.add` 抛出异常（典型场景是已被外部关闭、或
// 队列已满）时，立即把 `_closed` 翻转为 true，使后续所有 add 自动 no-op，
// 防止「fire-and-forget 异步任务在 controller 已关闭后继续 enqueue 触发崩溃」
// 这一在主项目 SSE 流上反复出现的 Bug 在 Flutter 端复发。
//
// ───────────────────────────────────────────────────────────────────
// 回归扫描契约（见 tasks.md §9 与 design.md §工程契约）：
//
//   • RC-1：`scripts/regression-check-flutter-parity.js` 会在
//     `lumimuse_flutter/lib/core/services/` 下 grep `_closed` 与 `SafeStreamSink`
//     两个关键字，命中数必须 ≥ 1。本文件正是 RC-1 的命中目标，禁止移除
//     `_closed` 字段或类名 `SafeStreamSink`。
//
//   • RC-9：`scripts/regression-check-flutter-parity.js` 会在
//     `lumimuse_flutter/lib/core/services/` 下 grep
//     `unawaited(.*chatCompletion` 与 `unawaited(.*streamChat`，命中数必须为 0。
//     即：所有流式 / 非流式 LLM 调用都必须挂在 `cancelToken` 链上，禁止
//     fire-and-forget。`SafeStreamSink` 提供的 isClosed 检查与 try/catch 兜底
//     是 RC-9 的运行时辅助保险，但不替代静态扫描。
//
// 两条扫描契约共同保证：①「closed 后 add no-op」是结构性强制，不依赖调用方
// 自觉；②「不会出现游离的异步 LLM 调用在 sink 已关闭后乱入」。
//
// ───────────────────────────────────────────────────────────────────
// 与现有代码的关系：
//   • 任务 4.2 仅引入本封装；将现有 `StreamController` 直接 add/close 的位置
//     替换为 `SafeStreamSink` 由任务 4.3 完成。
//   • 完整的属性测试（Property 21：closed 单调性 + close 至多一次 + add 在
//     closed 后 no-op）位于 `test/properties/property_21_safe_stream_sink_closed_test.dart`，
//     由任务 5.21 实现。本任务只配套迷你单测（任务 4.5）。

import 'dart:async';

/// 「只关一次」的流式 sink 封装。
///
/// 内部持有一个 [StreamController]，并以 `_closed` 标志保证：
///   • 关闭后所有 `add` no-op；
///   • 底层 `close` 至多被调用一次；
///   • enqueue 抛出异常时自动进入 closed 状态，不再继续向底层转发。
///
/// 调用方需要 `Stream<T>` 时通过 [stream] 取用，不要绕过去直接持有
/// `_controller.stream` 后再独立调用 `add`/`close`，否则会破坏不变量。
class SafeStreamSink<T> {
  /// 底层数据流控制器；除 [SafeStreamSink] 之外不应再有外部引用。
  final StreamController<T> _controller;

  /// 是否已经关闭。INV-5（1）单调字段：一旦为 true 永不再回 false。
  bool _closed = false;

  /// 用既有的 [StreamController] 包装为安全 sink。
  ///
  /// 调用方需要保证传入的 controller 之前没有被外部 close；如果传入的
  /// controller 已经处于 closed 状态，本封装并不会去探测，但首次 [add]
  /// 触发的 `controller.add` 抛出异常会被 catch 住并把 `_closed` 翻成 true。
  SafeStreamSink(StreamController<T> controller) : _controller = controller;

  /// 工厂：内部新建一个广播型 controller（适合多订阅场景，例如把 ChatProvider
  /// 的状态变更广播给 ChatView 与其它面板）。
  factory SafeStreamSink.broadcast({
    void Function()? onListen,
    void Function()? onCancel,
    bool sync = false,
  }) {
    return SafeStreamSink<T>(
      StreamController<T>.broadcast(
        onListen: onListen,
        onCancel: onCancel,
        sync: sync,
      ),
    );
  }

  /// 工厂：内部新建一个单订阅 controller（适合一次性的流式聊天回包通道）。
  factory SafeStreamSink.single({
    void Function()? onListen,
    void Function()? onCancel,
    bool sync = false,
  }) {
    return SafeStreamSink<T>(
      StreamController<T>(
        onListen: onListen,
        onCancel: onCancel,
        sync: sync,
      ),
    );
  }

  /// 暴露给订阅方的只读流。
  Stream<T> get stream => _controller.stream;

  /// 是否已关闭。closed 之后所有 [add] 都会 no-op。
  bool get isClosed => _closed;

  /// 推送一条事件。
  ///
  /// 行为约定：
  ///   • 若 `_closed == true`：直接 return，不向底层转发，不抛异常（INV-5（2））。
  ///   • 若底层 `controller.add` 抛异常（例如 controller 已经因为外部原因
  ///     关闭、或者订阅方在 add 过程中抛异常导致的级联失败）：吞掉异常，
  ///     立即把 `_closed` 翻为 true，让后续 add 自动 no-op，避免 fire-and-forget
  ///     在 sink 已死的情况下继续轰炸（RC-9 兜底）。
  void add(T event) {
    if (_closed) return;
    try {
      _controller.add(event);
    } catch (_) {
      // enqueue 失败即视为 sink 已死；标记 closed，但不再尝试关闭底层
      // controller（它要么已经关闭，要么处于异常态，再次 close 反而可能抛）。
      _closed = true;
    }
  }

  /// 关闭 sink。
  ///
  /// 行为约定：
  ///   • 仅生效一次：第二次及之后的调用直接 return（INV-5（3））。
  ///   • 首次调用时先把 `_closed` 翻成 true，再调用底层 `controller.close()`，
  ///     确保即使底层 close 同步抛错也不会导致状态回退。
  void close() {
    if (_closed) return;
    _closed = true;
    _controller.close();
  }
}
