import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 主屏选中状态 — 与原版 page.tsx 的 selectedCharacterId / selectedConversationId 对应
///
/// 主屏是「左侧栏 + 右侧 ChatView」常驻布局，选中行为只切右侧内容，不跳路由。

class SelectionState {
  /// 当前选中的角色 ID（null 表示未选中，右侧显示空态）
  final String? characterId;

  /// 当前选中的对话 ID（null 表示在该角色下未选中具体对话，由 ChatView 决定取最近一条还是新建）
  final String? conversationId;

  /// 滚动定位用的目标消息 ID（来自全局搜索跳转，定位后清空）
  final String? targetMessageId;

  const SelectionState({
    this.characterId,
    this.conversationId,
    this.targetMessageId,
  });

  SelectionState copyWith({
    String? characterId,
    String? conversationId,
    String? targetMessageId,
    bool clearConversation = false,
    bool clearTargetMessage = false,
  }) {
    return SelectionState(
      characterId: characterId ?? this.characterId,
      conversationId:
          clearConversation ? null : (conversationId ?? this.conversationId),
      targetMessageId:
          clearTargetMessage ? null : (targetMessageId ?? this.targetMessageId),
    );
  }
}

class SelectionNotifier extends StateNotifier<SelectionState> {
  SelectionNotifier() : super(const SelectionState());

  /// 选择角色（清空对话和目标消息）
  void selectCharacter(String characterId) {
    state = SelectionState(characterId: characterId);
  }

  /// 选择对话（同时切角色，并设置滚动目标）
  void selectConversation({
    required String characterId,
    required String conversationId,
    String? targetMessageId,
  }) {
    state = SelectionState(
      characterId: characterId,
      conversationId: conversationId,
      targetMessageId: targetMessageId,
    );
  }

  /// 当前角色下设置活跃对话（不切角色）
  void setActiveConversation(String? conversationId) {
    state = state.copyWith(
      conversationId: conversationId,
      clearConversation: conversationId == null,
      clearTargetMessage: true,
    );
  }

  /// 清空目标消息（滚动定位完成后调用）
  void clearTargetMessage() {
    state = state.copyWith(clearTargetMessage: true);
  }

  /// 清空选中（删除当前角色后调用）
  void clear() {
    state = const SelectionState();
  }
}

final selectionProvider =
    StateNotifierProvider<SelectionNotifier, SelectionState>(
  (ref) => SelectionNotifier(),
);
