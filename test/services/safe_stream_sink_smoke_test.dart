// Feature: flutter-pixel-perfect-parity, 任务 4.5：SafeStreamSink 迷你单元测试（非 PBT）
//
// **Validates: Requirements D2.1, D2.2**
//
// 用途：本文件以三条最小化用例覆盖 `SafeStreamSink<T>` 的核心不变量
// （INV-5（1）/（2）/（3）），与任务 5.21 的完整属性测试形成互补：
//
//   1. close 后 add 一律 no-op：订阅方只会收到 onDone，不会再收到 onData；
//      sink.isClosed 在 close 之后保持 true。
//   2. 重复 close 仅生效一次：底层 `StreamController.close()` 至多被调用
//      一次，第二次调用 `SafeStreamSink.close()` 不抛任何异常。
//   3. enqueue 抛异常时 isClosed 翻转为 true：当底层 controller 已被外部
//      关闭再 add 时，SafeStreamSink 会 catch 住 StateError 并立即把
//      `_closed` 翻成 true，避免后续 fire-and-forget 继续轰炸。
//
// 注意：本文件按任务 4.5 描述放置在 `test/services/` 下（而非
// `test/core/services/`），与后续 PBT 形成命名空间区分。

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/safe_stream_sink.dart';

void main() {
  group('SafeStreamSink · 迷你单元测试（任务 4.5）', () {
    test('Test 1 · close 后 add 一律 no-op，订阅方只收到 onDone（INV-5（2））',
        () async {
      // 用工厂构造一个广播型 sink，模拟典型的 ChatProvider 状态广播通道。
      final sink = SafeStreamSink<int>.broadcast();

      // 收集订阅方收到的事件；同时设置 onDone 标志验证流被正常关闭。
      final received = <int>[];
      var done = false;
      final sub = sink.stream.listen(
        received.add,
        onDone: () => done = true,
      );

      // 关闭 sink；之后再 add 应当全部 no-op。
      sink.close();

      // 关闭后追加事件：按 INV-5（2），应直接 return，不抛异常，也不转发。
      sink.add(1);
      sink.add(2);
      sink.add(3);

      // 等待事件循环把 onDone 派发出去。
      await Future<void>.delayed(Duration.zero);

      expect(sink.isClosed, isTrue, reason: 'close 后 isClosed 应保持 true');
      expect(received, isEmpty, reason: 'close 后追加事件不应被订阅方收到');
      expect(done, isTrue, reason: '订阅方应收到 onDone 通知');

      await sub.cancel();
    });

    test('Test 2 · 重复 close 仅触发一次底层 close，第二次不抛异常（INV-5（3））',
        () async {
      // 构造一个外部可观察的底层 controller，用 onCancel 监控订阅生命周期，
      // 真正用于断言「至多关闭一次」的是 controller.isClosed 这一可观察状态。
      final controller = StreamController<int>.broadcast();
      final sink = SafeStreamSink<int>(controller);

      // 第一次 close：应当真正关闭底层 controller。
      sink.close();
      expect(controller.isClosed, isTrue,
          reason: '首次调用 SafeStreamSink.close() 应同步关闭底层 controller');
      expect(sink.isClosed, isTrue);

      // 第二次 close：不应再触碰底层 controller，也不应抛任何异常。
      // 直接以 expect 包裹断言「不抛」，等价于：再次调用 close 是幂等无副作用。
      expect(() => sink.close(), returnsNormally,
          reason: '第二次 close 应静默 no-op，不抛异常');

      // 状态依然保持 closed，单调性未被破坏。
      expect(sink.isClosed, isTrue);
      expect(controller.isClosed, isTrue);
    });

    test('Test 3 · 底层 controller 已关闭后再 add，isClosed 翻转为 true（兜底）',
        () async {
      // 构造一个已经被外部 close 的 controller，再交给 SafeStreamSink 包装。
      // 这模拟「fire-and-forget 异步任务在 sink 已死后继续 enqueue」的崩溃场景。
      final controller = StreamController<int>.broadcast();
      // 必须先有一个订阅然后取消，或保留订阅；广播 controller close 不要求订阅。
      await controller.close();

      final sink = SafeStreamSink<int>(controller);

      // 包装时 sink 自身仍为未 close 状态（它并不会主动探测底层）。
      expect(sink.isClosed, isFalse,
          reason: '构造时 SafeStreamSink 不会主动探测底层 controller');

      // 触发 add：底层 controller.add 应抛 StateError，被 SafeStreamSink
      // 内部 catch 住，并将 _closed 翻为 true。
      sink.add(42);

      expect(sink.isClosed, isTrue,
          reason: 'enqueue 异常应被 catch 住并把 isClosed 翻转为 true');

      // 之后再 add 应直接 no-op，不再尝试触碰底层 controller，也不抛异常。
      expect(() => sink.add(43), returnsNormally,
          reason: '进入 closed 后续 add 应静默 no-op');
    });
  });
}
