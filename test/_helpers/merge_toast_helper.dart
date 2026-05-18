// 记忆任务 mergeCount Toast 与「记忆提取中」指示器的判定纯函数。
//
// 把 `chat_view.dart` 中的 `ref.listen<AsyncValue<MemoryTaskStatus?>>` 回调
// 内的「processing → done 边沿 + mergeCount > 0 → toast」逻辑抽出为纯函数，
// 便于 R6 Property 13 单独属性测试，无需真实启动 Widget tree。
//
// 与真实实现保持等价（详见 `lib/features/chat/chat_view.dart` 的 build 顶部
// ref.listen 回调与 `_buildMemoryExtractionIndicator`）：
// - prev / next 任一为 null（订阅尚无值或 snap 被清空）→ 不触发。
// - prev.taskId != next.taskId（新任务，仅记录初始状态）→ 不触发。
// - prev.status == 'processing' && next.status == 'done' && next.mergeCount > 0
//   → 触发 toast。
// - 其它情况（包括 next.status == 'failed' / 'pending' 等）→ 不触发。
//
// 指示器显示当且仅当 `snap.status == 'processing'`，与真实实现完全一致。

import 'package:lumimuse/core/services/memory_extraction_service.dart';

/// 判定是否应触发「已合并/更新 N 条记忆」Toast。
///
/// [prev]：上一次状态机记录的快照（首次订阅 / snap==null 后重置时为 null）。
/// [next]：当前 Drift 流推送过来的最新快照。
bool shouldShowMergeToast(
  MemoryTaskStatus? prev,
  MemoryTaskStatus? next,
) {
  if (next == null) return false;
  if (prev == null) return false;
  if (prev.taskId != next.taskId) return false;
  return prev.status == 'processing' &&
      next.status == 'done' &&
      next.mergeCount > 0;
}

/// 判定是否应显示「记忆提取中」指示器。
///
/// 行为（与 `_buildMemoryExtractionIndicator` 一致）：
/// - snap 为 null 或 status != 'processing' → 隐藏。
/// - status == 'processing' → 显示。
/// - status == 'failed' → 隐藏（不弹 toast，仅隐藏指示器）。
bool shouldShowExtractionIndicator(MemoryTaskStatus? snap) {
  return snap != null && snap.status == 'processing';
}

/// 将任务快照映射成消息头上的提取状态 chip。
///
/// `done` 但 `mergeCount == 0` 表示本轮没有写入任何记忆，不能显示
/// 「提取完成」，避免给用户造成已经提取到内容的错觉。
String memoryExtractStatusForTask(MemoryTaskStatus? snap) {
  if (snap == null) return 'idle';
  if (snap.status == 'pending' || snap.status == 'processing') {
    return 'extracting';
  }
  if (snap.status == 'done') {
    return snap.mergeCount > 0 ? 'done' : 'idle';
  }
  if (snap.status == 'failed') return 'failed';
  return 'idle';
}
