// Feature: flutter-pixel-perfect-parity, Task 3.2 LlmServiceContract
//
// 这一层是「LLM 调用」的横切契约，对齐主项目 src/lib/api-client.ts
// 中 chatCompletion(signal) 与流式分支的设计先例：
//
//   1. 非流式 chatCompletion 与流式 streamChatCompletion 两种分支
//      都必须接受 [CancelToken] 并透传到底层 HTTP 调用，确保用户
//      点击「停止生成」时两条路径都能立即中止（对应需求 C4.1 /
//      C4.2，对应主项目第二十一轮非流式停止生成 signal 透传修复）。
//
//   2. 禁止 fire-and-forget：任何调用方都不得把这两个方法以
//      `unawaited(...)` 形式悬挂到主流程之外；它们必须挂在主流程
//      的 cancelToken 链上。这一条由 RC-9 回归脚本扫描保证
//      （见 tasks.md 任务 9.9 / 设计文档 §正确性属性 INV-5）。
//
//   3. 本文件只定义抽象签名与最小占位数据形态，不绑定具体
//      实现：现有 LlmService（Dio 实现）由子 spec
//      flutter-data-management 在其上 implement / extend，本
//      spec 仅锁定接口形态。
//
// CancelToken 复用策略：
//   - 项目已统一使用 package:dio/dio.dart 的 CancelToken
//     （core/providers/chat_provider.dart、core/services/llm_service.dart
//     等多处证据），契约直接 re-export，避免一处再造、双份维护。
//   - 若未来需要脱离 dio，可在同目录新增 cancel_token.dart 提供
//     等价实现（bool isCancelled / void cancel() / Future<void>
//     whenCancelled），并把这里的 typedef 切换过去。
//
// 与 design.md 的对照见 §组件与接口 §4「服务层：LlmService 的
// AbortSignal 透传」与 §正确性属性 Property 3 / 21。

import 'package:dio/dio.dart' show CancelToken;

export 'package:dio/dio.dart' show CancelToken;

/// 一次 LLM 调用所需的最小消息形态。
///
/// 子 spec 可在自身 ChatMessage / 多模态消息类型上 implements 这个
/// 契约，或通过适配器转换；这里刻意保持字段最少，避免提前固定
/// 多模态结构。
class ChatMsg {
  /// 取值：`system` / `user` / `assistant`。
  final String role;

  /// 文本内容；多模态附件由 [attachments] 表达。
  final String content;

  /// 附件占位（图片、音频等）；具体形态由子 spec 定义，本契约
  /// 不约束元素类型。
  final List<Object> attachments;

  const ChatMsg({
    required this.role,
    required this.content,
    this.attachments = const [],
  });
}

/// 非流式调用的最终结果。
///
/// 仅包含「拼装完成的完整文本」；token 用量、原始响应等细节由
/// 子 spec 通过子类 / 扩展类型补充，不在契约层暴露。
class ChatResult {
  final String content;

  const ChatResult({required this.content});
}

/// 流式调用的单个增量块。
///
/// `delta` 为本次新增片段，`isDone` 为 true 时代表流结束（最后一块
/// 可能 delta 为空字符串）。
class ChatChunk {
  final String delta;
  final bool isDone;

  const ChatChunk({required this.delta, this.isDone = false});
}

/// LLM 调用契约。
///
/// 两个方法都必须把 [cancelToken] 透传到底层 HTTP 客户端：
///   - 非流式分支：取消时立即中断 HTTP 请求，禁止继续等待响应再
///     落库（对应需求 C4.2，主项目第二十一轮修复）。
///   - 流式分支：取消时关闭 sink、停止读取上游 chunk；底层
///     SafeStreamSink 保证 closed 标志单调（对应 INV-5）。
///
/// 实现类禁止把这两个方法以 fire-and-forget 形式调用，违反者由
/// RC-9 扫描捕获。
abstract class LlmServiceContract {
  /// 非流式聊天补全。
  Future<ChatResult> chatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  });

  /// 流式聊天补全。
  ///
  /// 返回的 Stream 必须监听 [cancelToken]：一旦 token 被取消，
  /// 上游应立即关闭 sink，下游 listen 收到 onDone 而非 onError。
  Stream<ChatChunk> streamChatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  });
}
