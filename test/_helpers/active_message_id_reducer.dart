// Feature: flutter-parity-completion, Property 16: activeMessageId 状态机不变量
//
// 把 ChatView `_activeActionMessageId` 状态机从 build 流程中抽出，便于属性测试。
//
// 状态规则（与 chat_view.dart 实现保持一致）：
// - 初始：null
// - toggle(id)：当前等于 id → null（再次点击隐藏），否则 → id（切换到新气泡）
// - clickBlank：→ null（点击空白区域关闭已展开的操作按钮）
//
// 这份纯函数是测试夹具：实现层不直接调用，但 ChatView 的内部状态转换
// 必须与之等价（参见 design.md 「P1 / R9」）。

/// 操作种类：点击某条消息 / 点击空白区域。
enum ActiveActionKind { toggle, clickBlank }

/// 状态机操作。toggle 必须携带消息 id；clickBlank 不带 id。
class ActiveAction {
  final ActiveActionKind kind;
  final String? id;
  const ActiveAction.toggle(String this.id) : kind = ActiveActionKind.toggle;
  const ActiveAction.clickBlank()
      : kind = ActiveActionKind.clickBlank,
        id = null;

  @override
  String toString() => kind == ActiveActionKind.toggle
      ? 'toggle($id)'
      : 'clickBlank';
}

/// activeMessageId 状态机的 reducer。
///
/// 输入 `prev` 为上一步状态，`action` 为本次操作；
/// 返回新状态（保持原样或改变）。
String? reduceActiveActionState(String? prev, ActiveAction action) {
  switch (action.kind) {
    case ActiveActionKind.toggle:
      // 协议保证：toggle 必带 id；测试夹具不容忍 null
      assert(action.id != null, 'toggle 必须携带消息 id');
      return prev == action.id ? null : action.id;
    case ActiveActionKind.clickBlank:
      return null;
  }
}
