// 文件：lib/core/providers/chat_provider_contract.dart
//
// FIX(Major-5)：契约目前没有任何类 implements。当前 ChatController 是
// `StateNotifier<ChatState>` + `autoDispose.family<.., String>` 形态——按对话 ID
// 隔离的实例，方法签名（`sendMessage(content)` / `regenerate(messageId)` /
// `stop()`）不带 `convId` 参数；契约假设的是一个**全局多对话**控制器
// （`send(convId, ...)` / `stop(convId)` / `activeStreams` / `abortControllers`
// / `messagesByConv` / `activeConvId` / `smartDelete` / `switchVersion` /
// `refreshMessagesForConversation` 等），二者形态差距已远超 30 行修改预算
// （DeleteOutcome 不存在、forceScrollToBottom/skipScroll 在 UI 层而非 controller
// 中、activeStreams 集合需要重写并发模型）。
//
// 因此本次仅保留契约文件 + TODO，不强行让 ChatController 实现，避免维护两份。
// TODO(parity-completion): ChatController 尚未 implements 此契约。任务 5.x 完成时
// 改 ChatController 继承此 abstract class，使 INV-1/INV-2/INV-3/INV-7 在
// 编译期就被强约束。届时需要把 ChatController 重构为「全局多对话状态机」，
// 把 _conversationId 字段替换为 activeConvId/messagesByConv，把 _cancelToken
// 替换为 abortControllers map，并把 sendMessage/regenerate/stop 的 convId 参数补齐。
//
// flutter-pixel-perfect-parity 总纲 spec —— 任务 3.1
// 状态机契约：把主项目 ChatView.tsx 内联的 activeStreams /
// abortControllersRef / forceScrollToBottomRef / skipScrollRef 抽象为
// 可观察、可测试的字段集合的抽象接口。本接口只暴露签名，禁止任何实现。
//
// ─────────── 落实的不变量（INV-1 ~ INV-3 / INV-7） ───────────
// 详细原文见 .kiro/specs/flutter-pixel-perfect-parity/design.md §概览。
//
// • INV-1 任意时刻 activeStreams 是 abortControllers 的 keySet 子集。
//   实现责任：flutter-data-management（在本契约之上落地多对话并发流式
//             状态机；send / regenerate / stop 必须在 try / finally 中
//             同步维护两个集合，避免半挂状态）。
//   PBT 校验：Property 1
//             （test/properties/property_01_active_streams_subset_test.dart）
//
// • INV-2 重新生成后 metadata.versions 长度严格递增；首次重新生成时一次
//         性 +2，因为先归档当前 content 为版本 0、再追加新版本。
//   实现责任：flutter-parity-completion（ChatProvider.regenerate 完整逻辑
//             与消息编辑版本同步）。
//   PBT 校验：Property 4（runs ≥ 500，关键不变量）
//
// • INV-3 智能删除（smartDelete）后「整条消息减 1」与「单个版本减 1」二
//         选一发生，不会同时发生，也不会两者都不发生。
//   实现责任：flutter-parity-completion（ChatProvider.smartDelete 与
//             Lightbox / 消息气泡删除按钮的 UI 联动）。
//   PBT 校验：Property 5（runs ≥ 500，关键不变量）
//
// • INV-7 serializeMessage 的 metadata 出口一定是 Map / Object，绝不是
//         已 JSON.stringify 的字符串；三个出口（API、备份导出、Provider
//         暴露给 UI）必须形态一致。
//   实现责任：flutter-data-management（消息序列化层、备份服务、Provider
//             对外暴露层共同保证出口形态）。
//   PBT 校验：Property 8
//
// 备注：
// 1. 本契约文件仅暴露字段与方法签名，禁止提供任何实现；
//    具体实现由各子 spec 在 ChatProviderContract 之上 extend。
// 2. CancelToken 复用 package:dio/dio.dart 中已在 LlmService 使用的版本，
//    与任务 3.2 的 LlmServiceContract 保持一致；不另外引入抽象 token，
//    避免在主流程外维护两套生命周期。
// 3. 所有注释一律中文直写（不允许 \uXXXX 转义），与 AGENTS.md
//    「编码防护」与 RC-10 扫描规则一致。

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/foundation.dart';

import '../database/database.dart' show Message;
import '../models/attachment_item.dart';

/// 智能删除结果（落实 INV-3）。
///
/// 两种取值严格互斥：`smartDelete` 必须返回其中之一，且仅返回一种。
/// 对应主项目第二十二轮「智能删除」语义——多版本时只删当前版本，仅剩
/// 一条版本时才删整条消息。
enum DeleteOutcome {
  /// 整条消息被删除：消息条数 -1，无版本残留。
  removedMessage,

  /// 仅删除当前展示的版本：消息条数不变，metadata.versions 长度 -1。
  removedVersion,
}

/// ChatProvider 抽象契约。
///
/// 子 spec（flutter-data-management / flutter-parity-completion）将在
/// 此契约之上提供具体实现。本接口只承担「把主项目 ChatView.tsx 内联状态
/// 抽出为可机器校验字段集合」的职责，不绑定具体状态管理库（Riverpod /
/// Provider / 其他）的特定 API。
///
/// 约束：
/// - 所有字段以 getter 暴露，禁止在契约层提供 setter；
/// - 所有方法仅声明签名，禁止在此处提供默认实现；
/// - 继承 [ChangeNotifier] 仅约定一种「可观察」形态，子类可自由选择
///   notifyListeners 的时机，但禁止提供「全局静默」开关。
abstract class ChatProviderContract extends ChangeNotifier {
  // ─────────── 多对话并发流式（INV-1 / B3） ───────────

  /// 当前正在生成中的对话 ID 集合。
  ///
  /// 与主项目 `activeStreams: Set<string>` 等价；任意时刻必须满足
  /// `activeStreams ⊆ abortControllers.keys`（INV-1）。
  Set<String> get activeStreams;

  /// 每个对话独立的中止控制器映射。
  ///
  /// 与主项目 `abortControllersRef: Map<string, AbortController>` 等价；
  /// stop(convId) 只能影响 `abortControllers[convId]`，禁止串扰其他对话。
  Map<String, CancelToken> get abortControllers;

  // ─────────── 自动滚动策略（C1） ───────────

  /// 用户主动发送消息后置位的一次性「强制滚到底部」标志。
  ///
  /// 与主项目 `forceScrollToBottomRef = true` 等价；消息列表完成布局
  /// 后由 ChatView 消费一次后立即清零，不参与后续流式跟随判定。
  bool get forceScrollToBottom;

  /// 仅 metadata 更新（如版本切换）时跳过本次自动滚动的标志。
  ///
  /// 与主项目 `skipScrollRef` 等价；落实 C1.4 / C5.4。
  bool get skipScroll;

  // ─────────── 消息列表与当前对话（B3 / B4） ───────────

  /// 按对话 ID 分组的消息列表快照。
  ///
  /// 出口形态约束（INV-7）：每条 [Message] 的 metadata 在被 UI 消费时
  /// 必须已是 Map / Object，禁止以 String 暴露。
  Map<String, List<Message>> get messagesByConv;

  /// 用户当前正在查看的对话 ID；尚未选择时为 null。
  String? get activeConvId;

  // ─────────── 行为方法（仅签名） ───────────

  /// 发送消息到指定对话。
  ///
  /// - [convId]：目标对话 ID；
  /// - [content]：消息正文，可为空字符串（仅附件场景，参见 B3 验收准则）；
  /// - [attachments]：附件列表（图片 / 文本），默认空列表。
  ///
  /// 实现要求：进入流式分支前把 [convId] 加入 [activeStreams]，并保证
  /// 异常 / 取消 / 正常完成三种结局都从 [activeStreams] 与
  /// [abortControllers] 同步移除该 convId（落实 INV-1）。
  Future<void> send(
    String convId,
    String content, {
    List<AttachmentItem> attachments = const [],
  });

  /// 对指定对话内的某条 AI 消息触发重新生成。
  ///
  /// 实现要求：首次重新生成时必须把当前 content 归档为 metadata.versions[0]，
  /// 再追加新版本；后续重新生成仅追加新版本（落实 INV-2）。
  Future<void> regenerate(String convId, String assistantMessageId);

  /// 停止指定对话的当前生成。
  ///
  /// 实现要求：仅取消 `abortControllers[convId]`，禁止影响其他并发流；
  /// 不在此处清空 [activeStreams]，由 send / regenerate 的 finally 分支统一清理。
  void stop(String convId);

  /// 切换某条多版本消息的当前展示版本。
  ///
  /// 实现要求：仅更新 metadata.activeVersion 索引，禁止发起任何网络请求，
  /// 也禁止触发自动滚动（参见 Property 7 / C1.4 / C5.4）。
  void switchVersion(String messageId, int versionIndex);

  /// 智能删除一条消息或其当前版本（落实 INV-3）。
  ///
  /// - 若该消息存在多个版本：仅删除当前展示版本，返回
  ///   [DeleteOutcome.removedVersion]；
  /// - 若该消息仅剩一个版本：删除整条消息，返回
  ///   [DeleteOutcome.removedMessage]。
  ///
  /// 两种结局严格互斥；返回值由 UI 决定如何刷新（替换某条消息 vs.
  /// 移除整条消息）。
  Future<DeleteOutcome> smartDelete(String messageId);

  /// 按对话 ID 显式刷新该对话的消息列表。
  ///
  /// 适用场景：
  /// - 后台流完成且用户当前正在查看该对话；
  /// - 新建对话首条消息完成后立即触发自动生图等后续动作时，避免依赖
  ///   尚未更新的 [activeConvId]（与主项目第二十二轮 refresh 修复一致）。
  Future<void> refreshMessagesForConversation(String convId);
}
