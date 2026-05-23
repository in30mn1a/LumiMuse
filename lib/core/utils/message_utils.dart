/// 消息工具集 —— 为消息列表提供去重等公共能力。
///
/// 用途说明：
/// - 用于 R17 防 ListView ValueKey 冲突：Flutter 列表会基于 `ValueKey('msg_${id}')`
///   作为节点标识，若同一 id 出现两次，widgets 会抛重复 key 异常。
/// - 用于导入对话备份后旧 ID 与新 ID 重叠的兜底场景：备份导入流程会重新生成
///   消息 ID，但仍可能存在历史数据 / 跨备份合并导致的偶发重叠。
///
/// 关联需求：flutter-parity-completion R17.1 ~ R17.4。
library;

import '../database/database.dart';

/// 按消息 `id` 去重，同一 id 仅保留 `created_at` 最早的一条；
/// 输出列表保持「按原列表整体顺序」的相对位置。
///
/// 设计要点（参见 design.md「P1 / R17」一节）：
/// - 第一次扫描计算每个 id 的最早 `created_at`，记入 `earliest` 映射。
/// - 第二次扫描按原顺序输出：仅放行「id 未输出过 且 createdAt 等于最早值」的元素，
///   既保证「保留最早一条」，又保证「相对顺序按原列表」。
/// - 对空列表与「无重复 id」列表执行零拷贝快返，避免无谓的内存分配。
List<Message> uniqueById(List<Message> messages) {
  // 空列表：直接快返，避免分配。
  if (messages.isEmpty) return messages;

  // 第一遍：找出每个 id 的最早 createdAt。
  final earliest = <String, DateTime>{};
  for (final m in messages) {
    final cur = earliest[m.id];
    if (cur == null || m.createdAt.isBefore(cur)) {
      earliest[m.id] = m.createdAt;
    }
  }

  // 全部唯一：earliest 长度等于输入长度即可断定无重复 id，零拷贝快返。
  if (earliest.length == messages.length) return messages;

  // 第二遍：按原顺序输出每个 id 的最早一条。
  final seen = <String>{};
  final out = <Message>[];
  for (final m in messages) {
    if (seen.contains(m.id)) continue;
    if (m.createdAt == earliest[m.id]) {
      out.add(m);
      seen.add(m.id);
    }
  }
  return out;
}
