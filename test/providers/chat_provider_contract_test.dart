// Feature: flutter-pixel-perfect-parity, Task 3.3
// 状态机契约的接口编译测试
//
// 测试目标：在不实现任何业务逻辑的前提下，校验
// `lib/core/providers/chat_provider_contract.dart` 暴露的契约形态
// 是否符合 design.md §3.1 与 tasks.md 任务 3.1 的要求：
//
//   1. `DeleteOutcome` 枚举严格包含 `removedMessage` / `removedVersion`
//      两个互斥取值，长度等于 2（落实 INV-3 的 PBT 前提）；
//   2. 抽象类 `ChatProviderContract` 的方法签名存在并可被最小子类
//      实现：`send / regenerate / stop / switchVersion / smartDelete /
//      refreshMessagesForConversation` 的参数列表与返回类型固定，任何
//      偏离都会触发 Dart 强类型检查导致测试文件直接编译失败；
//   3. 字段 getter 存在性：`activeStreams / abortControllers /
//      forceScrollToBottom / skipScroll / messagesByConv /
//      activeConvId` 在最小子类中可实现并被读取，类型与契约一致。
//
// 实现策略：
//   - 定义一个内部 `_FakeChatProvider extends ChatProviderContract`，
//     所有抽象方法体内 `throw UnimplementedError()`，但保证它能编译；
//   - 在 test 中先实例化该 fake，再把每个方法以 tear-off 形式赋给
//     具名 `typedef`，让 Dart 静态类型系统在编译期校验签名（任何
//     签名漂移都会让本文件无法编译，从而比运行时断言更严格）；
//   - 字段 getter 通过 `expect(... , isA<...>())` 做运行时类型校验，
//     兼顾对 `Map<String, List<Message>>` 等泛型外壳形态的检查。
//
// Validates: Requirements B4.4

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_test/flutter_test.dart';

import 'package:lumimuse/core/database/database.dart' show Message;
import 'package:lumimuse/core/models/attachment_item.dart';
import 'package:lumimuse/core/providers/chat_provider_contract.dart';

// 把契约方法签名固化为具名函数类型；任何参数 / 返回值漂移都会让
// 下方 tear-off 赋值在编译期失败，从而构成「签名级」契约断言。
typedef _SendFn = Future<void> Function(
  String convId,
  String content, {
  List<AttachmentItem> attachments,
});
typedef _RegenerateFn = Future<void> Function(
  String convId,
  String assistantMessageId,
);
typedef _StopFn = void Function(String convId);
typedef _SwitchVersionFn = void Function(
  String messageId,
  int versionIndex,
);
typedef _SmartDeleteFn = Future<DeleteOutcome> Function(String messageId);
typedef _RefreshFn = Future<void> Function(String convId);

void main() {
  group('DeleteOutcome 枚举（INV-3 / 需求 B4.4）', () {
    test('values 集合恰好等价于 {removedMessage, removedVersion}', () {
      // 取值集合等价：用 Set 比较避免顺序差异
      expect(
        DeleteOutcome.values.toSet(),
        equals(<DeleteOutcome>{
          DeleteOutcome.removedMessage,
          DeleteOutcome.removedVersion,
        }),
      );
    });

    test('values.length 严格等于 2，禁止新增第三种结局', () {
      // 一旦有人擅自加入第三种结局（例如 removedAll），互斥不变量
      // INV-3 立刻被打破，本断言守住边界。
      expect(DeleteOutcome.values.length, 2);
    });

    test('两枚取值彼此不相等', () {
      expect(
        DeleteOutcome.removedMessage == DeleteOutcome.removedVersion,
        isFalse,
      );
    });
  });

  group('ChatProviderContract 字段 getter 存在性与类型', () {
    final provider = _FakeChatProvider();

    test('activeStreams 是 Set<String>', () {
      // 既检查泛型外壳也检查元素类型；空集合也能通过 isA 检查
      expect(provider.activeStreams, isA<Set<String>>());
      expect(provider.activeStreams, isEmpty);
    });

    test('abortControllers 是 Map<String, CancelToken>', () {
      expect(
        provider.abortControllers,
        isA<Map<String, CancelToken>>(),
      );
      expect(provider.abortControllers, isEmpty);
    });

    test('forceScrollToBottom 是 bool', () {
      expect(provider.forceScrollToBottom, isA<bool>());
    });

    test('skipScroll 是 bool', () {
      expect(provider.skipScroll, isA<bool>());
    });

    test('messagesByConv 是 Map<String, List<Message>>', () {
      expect(
        provider.messagesByConv,
        isA<Map<String, List<Message>>>(),
      );
      expect(provider.messagesByConv, isEmpty);
    });

    test('activeConvId 是可空 String', () {
      // 允许 null：契约约定「尚未选择对话」时返回 null
      expect(provider.activeConvId, isNull);
    });
  });

  group('ChatProviderContract 方法签名（编译期校验）', () {
    final provider = _FakeChatProvider();

    test('send(convId, content, {attachments}) 返回 Future<void>', () {
      // 把 tear-off 赋值给精确签名变量；类型不一致会让本测试文件
      // 编译失败，从而比运行时断言更严格。
      final _SendFn fn = provider.send;
      expect(fn, isNotNull);
    });

    test('regenerate(convId, assistantMessageId) 返回 Future<void>', () {
      final _RegenerateFn fn = provider.regenerate;
      expect(fn, isNotNull);
    });

    test('stop(convId) 返回 void', () {
      final _StopFn fn = provider.stop;
      expect(fn, isNotNull);
    });

    test('switchVersion(messageId, versionIndex) 返回 void', () {
      final _SwitchVersionFn fn = provider.switchVersion;
      expect(fn, isNotNull);
    });

    test('smartDelete(messageId) 返回 Future<DeleteOutcome>', () {
      final _SmartDeleteFn fn = provider.smartDelete;
      expect(fn, isNotNull);
    });

    test('refreshMessagesForConversation(convId) 返回 Future<void>', () {
      final _RefreshFn fn = provider.refreshMessagesForConversation;
      expect(fn, isNotNull);
    });
  });

  group('ChatProviderContract 继承关系', () {
    test('继承自 ChangeNotifier（可被 Provider / Listener 监听）', () {
      // ChangeNotifier 是 Listenable 的实现；通过 Listenable 接口
      // 检查可以避免显式 import flutter/foundation.dart。
      final provider = _FakeChatProvider();
      var notifyCount = 0;
      // 注册 / 反注册一次监听器，确保 ChangeNotifier 行为可用
      void noop() {
        notifyCount += 1;
      }
      provider.addListener(noop);
      provider.debugNotifyForTesting();
      expect(notifyCount, 1);
      provider.removeListener(noop);
      provider.debugNotifyForTesting();
      expect(notifyCount, 1);
    });
  });
}

/// 最小子类实现：所有方法 throw UnimplementedError，但保证编译通过。
///
/// 该类只在测试文件内可见，目的是借 Dart 强类型系统校验抽象类的
/// 签名集合 — 一旦 `ChatProviderContract` 增删 / 改签任何抽象方法或
/// getter，本类会立即编译失败，从而把契约漂移挡在 CI 之前。
class _FakeChatProvider extends ChatProviderContract {
  void debugNotifyForTesting() {
    notifyListeners();
  }

  // 字段 getter 实现：返回不可变的空集合 / 空映射 / 默认布尔，避免
  // 调用方在测试时碰到 LateInitializationError 而干扰断言。
  @override
  final Set<String> activeStreams = <String>{};

  @override
  final Map<String, CancelToken> abortControllers = <String, CancelToken>{};

  @override
  final bool forceScrollToBottom = false;

  @override
  final bool skipScroll = false;

  @override
  final Map<String, List<Message>> messagesByConv =
      <String, List<Message>>{};

  @override
  final String? activeConvId = null;

  // 方法实现：仅校验签名，不承担业务逻辑；测试中通过 tear-off 类型
  // 检查即可，无需实际调用，因此 throw UnimplementedError 是安全的。
  @override
  Future<void> send(
    String convId,
    String content, {
    List<AttachmentItem> attachments = const [],
  }) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }

  @override
  Future<void> regenerate(String convId, String assistantMessageId) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }

  @override
  void stop(String convId) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }

  @override
  void switchVersion(String messageId, int versionIndex) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }

  @override
  Future<DeleteOutcome> smartDelete(String messageId) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }

  @override
  Future<void> refreshMessagesForConversation(String convId) {
    throw UnimplementedError('契约测试 fake，禁止在测试中实际调用');
  }
}
