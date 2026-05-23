import 'package:flutter/material.dart';
import '../../../theme/app_theme.dart';

/// 聊天 Toast — 严格 1:1 对照 src/components/chat/ChatView.tsx 中的轻量 Toast 组件
/// （TSX 第 35~54 行）。
///
/// 视觉契约：
/// - 容器：`fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2`
///   - bottom-6 = 24px
///   - flex-col + gap-2 = 多条 toast 纵向堆叠，间距 8px
///   - z-[60] 在弹窗（z-50）之上
/// - 单条：`pointer-events-auto flex cursor-pointer items-center gap-2`
///   `rounded-2xl(16) border px-4 py-2.5 text-sm shadow-lg backdrop-blur-xl`
///   - error 类型：`border-red-200/60 bg-red-50/90 text-red-700`
///   - info  类型：`border-accent/20 bg-white/90 text-text-primary`
/// - 点击 toast 立即关闭（onDismiss）；自动关闭由调用方 setTimeout 4 秒控制
///
/// 主项目 ToastItem 类型：
/// ```ts
/// interface ToastItem { id: number; message: string; type: 'error' | 'info' }
/// ```
class ChatToastItem {
  final int id;
  final String message;
  final ChatToastType type;

  const ChatToastItem({
    required this.id,
    required this.message,
    this.type = ChatToastType.error,
  });
}

enum ChatToastType { error, info }

/// Toast 主题 — 渲染当前所有 toast，垂直堆叠在屏幕底部居中
///
/// 与 TSX 端行为一致：列表为空返回 SizedBox.shrink。
class ChatToast extends StatelessWidget {
  final List<ChatToastItem> items;
  final ValueChanged<int> onDismiss;

  const ChatToast({
    super.key,
    required this.items,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return IgnorePointer(
      // 容器整体不拦截下层手势（pointer-events-none on container）；
      // 真正可点击的是下方每条 toast 上的 IgnorePointer(ignoring: false)。
      ignoring: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 24), // bottom-6
        child: Align(
          alignment: Alignment.bottomCenter,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              for (int i = 0; i < items.length; i++) ...[
                // 单条 toast 内部恢复点击（pointer-events-auto on each toast）
                IgnorePointer(
                  ignoring: false,
                  child: _ToastBubble(
                    item: items[i],
                    isDark: isDark,
                    onTap: () => onDismiss(items[i].id),
                  ),
                ),
                if (i != items.length - 1) const SizedBox(height: 8), // gap-2
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ToastBubble extends StatelessWidget {
  final ChatToastItem item;
  final bool isDark;
  final VoidCallback onTap;

  const _ToastBubble({
    required this.item,
    required this.isDark,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final isError = item.type == ChatToastType.error;

    // 颜色对照 TSX：
    // error: border-red-200/60 bg-red-50/90 text-red-700
    // info : border-accent/20  bg-white/90  text-text-primary
    final borderColor = isError
        ? const Color(0xFFFECACA).withValues(alpha: 0.60) // red-200
        : (isDark ? AppTheme.darkAccent : AppTheme.accent)
            .withValues(alpha: 0.20);
    final bgColor = isError
        ? (isDark
            ? const Color(0xFF450A0A).withValues(alpha: 0.90) // red-950
            : const Color(0xFFFEF2F2).withValues(alpha: 0.90)) // red-50
        : (isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.90)
            : Colors.white.withValues(alpha: 0.90));
    final textColor = isError
        ? (isDark
            ? const Color(0xFFFECACA) // red-200
            : const Color(0xFFB91C1C)) // red-700
        : (isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary);

    return Material(
      color: Colors.transparent,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(
              color: bgColor,
              border: Border.all(color: borderColor),
              borderRadius: BorderRadius.circular(16), // rounded-2xl
              boxShadow: const [
                // shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)
                BoxShadow(
                  color: Color(0x1A000000),
                  blurRadius: 15,
                  spreadRadius: -3,
                  offset: Offset(0, 10),
                ),
                BoxShadow(
                  color: Color(0x1A000000),
                  blurRadius: 6,
                  spreadRadius: -4,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            // px-4 py-2.5
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Text(
              item.message,
              style: TextStyle(
                fontSize: 14, // text-sm
                color: textColor,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Toast 控制器 — 简化外部调用，自动管理 id 与 4 秒后自动消失
///
/// 主项目用法（TSX）：
/// ```ts
/// const showToast = useCallback((message, type = 'error') => {
///   const id = ++toastIdRef.current;
///   setToasts(prev => [...prev, { id, message, type }]);
///   setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
/// }, []);
/// ```
///
/// 在 Flutter 端我们暴露相同接口，让 [ChatView] 调用方式贴近 TSX。
class ChatToastController extends ChangeNotifier {
  final List<ChatToastItem> _items = [];
  int _nextId = 0;

  List<ChatToastItem> get items => List.unmodifiable(_items);

  /// 弹出一条 Toast，4 秒后自动消失
  void show(String message, {ChatToastType type = ChatToastType.error}) {
    final id = ++_nextId;
    _items.add(ChatToastItem(id: id, message: message, type: type));
    notifyListeners();
    // 4 秒后自动消失（与 TSX setTimeout 一致）
    Future.delayed(const Duration(milliseconds: 4000), () {
      dismiss(id);
    });
  }

  /// 手动关闭指定 id 的 toast；不存在时静默忽略
  void dismiss(int id) {
    final removed = _items.length;
    _items.removeWhere((t) => t.id == id);
    if (_items.length != removed) notifyListeners();
  }

  /// 清空所有 toast
  void clear() {
    if (_items.isEmpty) return;
    _items.clear();
    notifyListeners();
  }
}
