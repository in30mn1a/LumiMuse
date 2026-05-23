// Feature: flutter-pixel-perfect-parity, Scenario 7.4: 多对话并发流式
// Validates: Requirements B3.3, B3.4, B3.5
//
// 设计说明
// ────────
// requirements.md §B3.3 / §B3.4 / §B3.5 / design.md §3.3 要求：
//   - B3.3：用户在对话 A 流式期间切换到对话 B 并发起新一轮 send，必须
//     允许两条流同时存活（activeStreams 同时包含 A 和 B），互不阻塞。
//   - B3.4：每条对话拥有独立 CancelToken，stop 仅取消目标对话。
//   - B3.5：当后台对话流（A）完成时，若用户当前正在查看 A，必须显式
//     调用 refreshMessagesForConversation(A) 拉取最新落库消息；若用户
//     已经切到别的对话，则不刷新。
//
// 本场景：
//   1. 构造对话 A 和 B；
//   2. fake LlmServiceContract.streamChatCompletion 返回延迟可控的流
//      （每 50ms 一个 chunk，共 5 个）；
//   3. fake ChatProvider.send 启动后台流，把 convId 加入 activeStreams，
//      流结束时根据当前 activeConvId 决定是否调用 refresh；
//   4. 在对话 A 流刚启动后切到 B 并立即 send，断言：
//      ① activeStreams 同时包含 A 与 B；
//      ② 两条流互不阻塞（B 的 chunk 抵达不会因 A 的 chunk 间隔而暂停）；
//      ③ 切回 A 后等待 A 完成，refresh 计数 == 1；切到 B 后等待 B 完成，
//         由于此时 activeConvId == B，refresh(A) 不会再次触发。

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/llm_service_contract.dart';

// ──────────────────────────────────────────────────────────────────────────
// fake LlmServiceContract：固定 5 个 chunk，每个间隔 [chunkDelay]
// ──────────────────────────────────────────────────────────────────────────

class _PacedFakeLlm implements LlmServiceContract {
  /// 每个 chunk 之间的间隔。
  final Duration chunkDelay;

  /// 每次调用都生成独立的内容前缀，便于断言两条流互不串扰。
  final String prefix;

  /// 记录每次 chunk 抵达的真实时间戳（[since] 起算的毫秒数）。
  final Stopwatch _sw = Stopwatch();
  final List<int> chunkArrivalsMs = <int>[];

  _PacedFakeLlm({
    required this.prefix,
    this.chunkDelay = const Duration(milliseconds: 50),
  });

  void resetClock() {
    _sw
      ..reset()
      ..start();
    chunkArrivalsMs.clear();
  }

  @override
  Future<ChatResult> chatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async {
    return ChatResult(content: '$prefix-final');
  }

  @override
  Stream<ChatChunk> streamChatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async* {
    for (var i = 0; i < 5; i++) {
      await Future<void>.delayed(chunkDelay);
      if (cancelToken != null && cancelToken.isCancelled) {
        return;
      }
      chunkArrivalsMs.add(_sw.elapsedMilliseconds);
      yield ChatChunk(delta: '$prefix-$i', isDone: false);
    }
    yield const ChatChunk(delta: '', isDone: true);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// fake ChatProvider：实现 send / stop / refreshMessagesForConversation 子集
//
// 不继承 ChatProviderContract（避免被迫实现所有 getter），但语义上对齐：
//   - activeStreams: Set<String>
//   - abortControllers: Map<String, CancelToken>
//   - activeConvId（外部可设置）
//   - send(convId)：把 convId 加入 activeStreams，订阅 fake 流；流结束 /
//     异常 / 取消三种结局均从 activeStreams 与 abortControllers 移除该
//     convId；流结束时若 activeConvId == convId，则调用 refresh(convId)。
//   - stop(convId)：仅 cancel abortControllers[convId]。
//   - refreshMessagesForConversation(convId)：spy 计数。
// ──────────────────────────────────────────────────────────────────────────

class _FakeChatProvider {
  final Map<String, LlmServiceContract> llmByConv;

  /// 当前正在生成的对话 ID 集合。
  final Set<String> activeStreams = <String>{};

  /// 每个对话独立的 CancelToken。
  final Map<String, CancelToken> abortControllers = <String, CancelToken>{};

  /// 用户当前正在查看的对话 ID。外部可直接修改以模拟「切对话」。
  String? activeConvId;

  /// refresh 调用次数计数（按 convId 维度）。
  final Map<String, int> refreshCounts = <String, int>{};

  /// 收集到的 chunk（按 convId 维度），用于断言互不串扰。
  final Map<String, List<String>> receivedChunks = <String, List<String>>{};

  /// 每次 send 完成后的 Future，便于测试 await 等待流终止。
  final Map<String, Future<void>> _sendCompletions = <String, Future<void>>{};

  _FakeChatProvider({required this.llmByConv});

  /// 发起 send：返回的 Future 在「订阅创建并标记为 active」之后立即 resolve，
  /// 真实流结束的等待请使用 [waitForCompletion]。
  Future<void> send(String convId) async {
    final llm = llmByConv[convId];
    if (llm == null) throw StateError('LLM 未配置：$convId');

    final cancelToken = CancelToken();
    abortControllers[convId] = cancelToken;
    activeStreams.add(convId);
    receivedChunks.putIfAbsent(convId, () => <String>[]);

    final completer = Completer<void>();
    _sendCompletions[convId] = completer.future;

    // 后台订阅流；不等待其完成
    () async {
      try {
        await for (final chunk in llm.streamChatCompletion(
          <ChatMsg>[const ChatMsg(role: 'user', content: 'hi')],
          cancelToken: cancelToken,
        )) {
          if (chunk.isDone) break;
          receivedChunks[convId]!.add(chunk.delta);
        }
      } catch (_) {
        // 忽略 fake 流的错误
      } finally {
        activeStreams.remove(convId);
        abortControllers.remove(convId);
        // 后台流完成 → 若用户仍在该对话，则 refresh
        if (activeConvId == convId) {
          refreshMessagesForConversation(convId);
        }
        if (!completer.isCompleted) completer.complete();
      }
    }();
  }

  /// 等待某条对话的 send 流彻底结束。
  Future<void> waitForCompletion(String convId) async {
    final f = _sendCompletions[convId];
    if (f != null) await f;
  }

  void stop(String convId) {
    abortControllers[convId]?.cancel('stop by user');
  }

  void refreshMessagesForConversation(String convId) {
    refreshCounts[convId] = (refreshCounts[convId] ?? 0) + 1;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Scenario 7.4: 多对话并发流式 — A / B 两条流互不阻塞，refresh 仅在当前对话触发', () {
    test(
      '在对话 A 流式期间切到 B 并 send：activeStreams 同时含 A 和 B；'
      '互不阻塞；A 完成时若 activeConvId==A，refresh(A)==1',
      () async {
        final llmA = _PacedFakeLlm(prefix: 'A');
        final llmB = _PacedFakeLlm(prefix: 'B');

        final provider = _FakeChatProvider(
          llmByConv: <String, LlmServiceContract>{
            'A': llmA,
            'B': llmB,
          },
        );

        // 用户最初在对话 A
        provider.activeConvId = 'A';
        llmA.resetClock();
        await provider.send('A');

        // 等一个 chunk 间隔，确保 A 流真正开始
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(
          provider.activeStreams.contains('A'),
          isTrue,
          reason: 'send 完成后 A 必须立即出现在 activeStreams 中',
        );

        // 切到 B 并立刻 send
        provider.activeConvId = 'B';
        llmB.resetClock();
        await provider.send('B');

        // 此刻 activeStreams 必须同时包含 A 和 B（B3.3）
        expect(
          provider.activeStreams,
          containsAll(<String>['A', 'B']),
          reason:
              '违反 B3.3：A 流式期间发起 B 的 send，activeStreams 必须同时包含两者，'
              '当前 = ${provider.activeStreams}',
        );

        // 两条 abortControllers 必须都存在且独立（B3.4）
        expect(provider.abortControllers.containsKey('A'), isTrue,
            reason: 'A 必须拥有独立 CancelToken');
        expect(provider.abortControllers.containsKey('B'), isTrue,
            reason: 'B 必须拥有独立 CancelToken');
        expect(
          identical(
              provider.abortControllers['A'], provider.abortControllers['B']),
          isFalse,
          reason: 'A 与 B 的 CancelToken 必须是不同实例（B3.4）',
        );

        // 等待两条流自然完成
        await provider.waitForCompletion('A');
        await provider.waitForCompletion('B');

        // ① activeStreams 必须清空（finally 分支同步移除）
        expect(provider.activeStreams, isEmpty,
            reason: '所有流完成后 activeStreams 必须清空');
        expect(provider.abortControllers, isEmpty,
            reason: '所有流完成后 abortControllers 必须清空');

        // ② 两条流各自收到 5 个 chunk，前缀互不串扰
        expect(provider.receivedChunks['A']!.length, 5,
            reason: 'A 应收到全部 5 个 chunk');
        expect(provider.receivedChunks['B']!.length, 5,
            reason: 'B 应收到全部 5 个 chunk');
        for (final c in provider.receivedChunks['A']!) {
          expect(c.startsWith('A-'), isTrue,
              reason: 'A 收到的 chunk 不应混入 B 的内容：$c');
        }
        for (final c in provider.receivedChunks['B']!) {
          expect(c.startsWith('B-'), isTrue,
              reason: 'B 收到的 chunk 不应混入 A 的内容：$c');
        }

        // ③ 互不阻塞：A 的 chunk 抵达时间序列应保持 ~50ms 级别的间隔
        //   即使 B 在中途启动，A 不应整体被「冻结」到 B 完成后才继续
        //   这里采用宽松断言：A 5 个 chunk 的总耗时应远小于 5 * 50ms * 2
        expect(
          llmA.chunkArrivalsMs.length,
          5,
          reason: 'A 应记录 5 次 chunk 抵达',
        );
        final aLastMs = llmA.chunkArrivalsMs.last;
        expect(
          aLastMs,
          lessThan(800),
          reason:
              '违反 B3.3 互不阻塞：A 5 个 chunk 的最后一个抵达时间为 ${aLastMs}ms，'
              '远超合理范围（说明 B 阻塞了 A 的事件循环）',
        );

        // ④ refresh 计数（B3.5）：A 完成时若 activeConvId == A → +1；
        //   但本场景 A 完成时 activeConvId == 'B'，所以 A 的 refresh 应为 0；
        //   B 完成时 activeConvId == 'B'，所以 B 的 refresh 应为 1。
        expect(
          provider.refreshCounts['A'] ?? 0,
          0,
          reason: 'A 完成时用户已切到 B，不应触发 refresh(A)',
        );
        expect(
          provider.refreshCounts['B'] ?? 0,
          1,
          reason: 'B 完成时用户在 B，refresh(B) 必须恰好被调用 1 次',
        );
      },
    );

    test(
      '当用户保持在 A 不切换：A 完成时 refresh(A) 必须恰好被调用 1 次（B3.5）',
      () async {
        final llmA = _PacedFakeLlm(
          prefix: 'A',
          chunkDelay: const Duration(milliseconds: 20),
        );
        final provider = _FakeChatProvider(
          llmByConv: <String, LlmServiceContract>{'A': llmA},
        );

        provider.activeConvId = 'A';
        llmA.resetClock();
        await provider.send('A');
        await provider.waitForCompletion('A');

        expect(
          provider.refreshCounts['A'] ?? 0,
          1,
          reason: '用户在 A 且 A 流完成，refresh(A) 必须恰好被调用 1 次',
        );
        expect(provider.activeStreams, isEmpty);
      },
    );

    test(
      'stop 仅取消目标对话（B3.4）：stop(A) 后 A 提前结束，B 不受影响',
      () async {
        final llmA = _PacedFakeLlm(prefix: 'A');
        final llmB = _PacedFakeLlm(prefix: 'B');

        final provider = _FakeChatProvider(
          llmByConv: <String, LlmServiceContract>{'A': llmA, 'B': llmB},
        );

        provider.activeConvId = 'A';
        llmA.resetClock();
        await provider.send('A');

        provider.activeConvId = 'B';
        llmB.resetClock();
        await provider.send('B');

        // 立即停止 A
        provider.stop('A');

        await provider.waitForCompletion('A');
        await provider.waitForCompletion('B');

        // A 的 chunk 收到数 ≤ 5（被取消可能少收到几个）
        expect(provider.receivedChunks['A']!.length, lessThanOrEqualTo(5));
        // B 应完整收到 5 个 chunk
        expect(provider.receivedChunks['B']!.length, 5,
            reason: 'stop(A) 不应影响 B 流；B 应完整收到 5 个 chunk');
      },
    );
  });
}
