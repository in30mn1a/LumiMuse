import 'package:flutter/material.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';

/// 聊天页通用确认/输入对话框 — 严格对照
/// src/components/chat/ChatView.tsx 的 renameOpen / deleteOpen 弹窗。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - 背景遮罩：`fixed inset-0 z-50 bg-black/35 px-4`
/// - 弹窗容器：`surface-panel w-full max-w-md p-5`（≈ 448 宽）
/// - 标题 `section-title text-xl`：1.28rem(20.5)、line 1.18、color text-primary、display 字体
/// - 正文 `mt-3 section-copy`：text-secondary 0.94rem(15) line 1.65
/// - 输入框 `input-rich mt-4`：min-h 2.8rem(45) padding 0.75×0.95 rounded-2xl(16) border 1
/// - 操作行 `mt-5 flex justify-end gap-2`
///   - 取消：soft-button-secondary
///   - 确认：soft-button-primary
///   - 危险：soft-button-danger（删除按钮专用）

/// 弹出重命名对话框，确认时返回新名称（trim 后），取消返回 null。
Future<String?> showRenameConversationDialog(
  BuildContext context, {
  required String initialValue,
}) {
  return showGeneralDialog<String?>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: const Color(0x59000000), // bg-black/35
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (ctx, animation, secondary) {
      return _RenameDialog(initialValue: initialValue);
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      // 淡入 + 轻微缩放（fade + scale 0.96 → 1.0）
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          ),
          child: child,
        ),
      );
    },
  );
}

/// 弹出删除对话二次确认，确认返回 true，取消返回 false / null。
Future<bool?> showDeleteConversationDialog(
  BuildContext context, {
  required String title,
  required String body,
  required String confirmLabel,
  required String cancelLabel,
}) {
  return showGeneralDialog<bool>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: const Color(0x59000000),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (ctx, animation, secondary) {
      return _ConfirmDialog(
        title: title,
        body: body,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        danger: true,
      );
    },
    transitionBuilder: (ctx, animation, secondary, child) {
      return FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          ),
          child: child,
        ),
      );
    },
  );
}

class _RenameDialog extends StatefulWidget {
  final String initialValue;

  const _RenameDialog({required this.initialValue});

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _ctrl;
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _ctrl = TextEditingController(text: widget.initialValue);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focus.requestFocus();
      _ctrl.selection =
          TextSelection(baseOffset: 0, extentOffset: _ctrl.text.length);
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;

    return _DialogScaffold(
      isDark: isDark,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ── 标题 section-title text-xl ──
          Text(
            '重命名对话',
            style: TextStyle(
              fontSize: 20, // text-xl
              height: 1.18,
              fontWeight: FontWeight.w600,
              color: isDark
                  ? AppTheme.darkTextPrimary
                  : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 16), // mt-4

          // ── 输入框 input-rich ──
          _InputRich(
            controller: _ctrl,
            focusNode: _focus,
            hintText: '输入新的对话名称',
            isDark: isDark,
            borderLight: borderLight,
            onSubmitted: (_) => _confirm(),
          ),
          const SizedBox(height: 20), // mt-5

          // ── 操作按钮：取消 + 确认 ──
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _SoftBtn(
                label: '取消',
                kind: _BtnKind.secondary,
                isDark: isDark,
                onTap: () => Navigator.of(context).pop(),
              ),
              const SizedBox(width: 8),
              _SoftBtn(
                label: '确认修改',
                kind: _BtnKind.primary,
                isDark: isDark,
                onTap: _confirm,
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _confirm() {
    final v = _ctrl.text.trim();
    if (v.isEmpty) {
      Navigator.of(context).pop();
      return;
    }
    Navigator.of(context).pop(v);
  }
}

class _ConfirmDialog extends StatelessWidget {
  final String title;
  final String body;
  final String confirmLabel;
  final String cancelLabel;
  final bool danger;

  const _ConfirmDialog({
    required this.title,
    required this.body,
    required this.confirmLabel,
    required this.cancelLabel,
    this.danger = false,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return _DialogScaffold(
      isDark: isDark,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 标题
          Text(
            title,
            style: TextStyle(
              fontSize: 20,
              height: 1.18,
              fontWeight: FontWeight.w600,
              color: isDark
                  ? AppTheme.darkTextPrimary
                  : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 12), // mt-3
          // 正文 section-copy
          Text(
            body,
            style: TextStyle(
              fontSize: 15, // 0.94rem
              height: 1.65,
              color: isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary,
            ),
          ),
          const SizedBox(height: 20), // mt-5

          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _SoftBtn(
                label: cancelLabel,
                kind: _BtnKind.secondary,
                isDark: isDark,
                onTap: () => Navigator.of(context).pop(false),
              ),
              const SizedBox(width: 8),
              _SoftBtn(
                label: confirmLabel,
                kind: danger ? _BtnKind.danger : _BtnKind.primary,
                isDark: isDark,
                onTap: () => Navigator.of(context).pop(true),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DialogScaffold extends StatelessWidget {
  final bool isDark;
  final Widget child;

  const _DialogScaffold({required this.isDark, required this.child});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 448), // max-w-md
            child: Material(
              color: Colors.transparent,
              child: Container(
                decoration: AppSurfaces.panel(isDark: isDark),
                padding: const EdgeInsets.all(20), // p-5
                child: child,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _InputRich extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode? focusNode;
  final String hintText;
  final bool isDark;
  final Color borderLight;
  final ValueChanged<String>? onSubmitted;

  const _InputRich({
    required this.controller,
    this.focusNode,
    required this.hintText,
    required this.isDark,
    required this.borderLight,
    this.onSubmitted,
  });

  @override
  Widget build(BuildContext context) {
    final textColor =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final mutedColor =
        isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    return Container(
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.86),
        border: Border.all(color: borderLight),
        borderRadius: BorderRadius.circular(16), // rounded-2xl
      ),
      child: TextField(
        controller: controller,
        focusNode: focusNode,
        textInputAction: TextInputAction.done,
        onSubmitted: onSubmitted,
        style: TextStyle(fontSize: 15, color: textColor, height: 1.5),
        decoration: InputDecoration(
          hintText: hintText,
          hintStyle: TextStyle(fontSize: 15, color: mutedColor),
          // input-rich min-h 2.8rem padding 0.75×0.95
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 15.2, vertical: 12),
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          isDense: false,
        ),
      ),
    );
  }
}

enum _BtnKind { primary, secondary, danger }

class _SoftBtn extends StatefulWidget {
  final String label;
  final _BtnKind kind;
  final bool isDark;
  final VoidCallback onTap;

  const _SoftBtn({
    required this.label,
    required this.kind,
    required this.isDark,
    required this.onTap,
  });

  @override
  State<_SoftBtn> createState() => _SoftBtnState();
}

class _SoftBtnState extends State<_SoftBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = widget.isDark;
    BoxDecoration deco;
    Color textColor;
    switch (widget.kind) {
      case _BtnKind.primary:
        deco = AppSurfaces.buttonPrimary(isDark: isDark);
        textColor = Colors.white;
        break;
      case _BtnKind.secondary:
        deco = BoxDecoration(
          color: isDark
              ? AppTheme.darkSurface.withValues(alpha: 0.6)
              : Colors.white.withValues(alpha: 0.72),
          border: Border.all(
            color:
                isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
          ),
          borderRadius: BorderRadius.circular(16),
        );
        textColor = isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
        break;
      case _BtnKind.danger:
        deco = BoxDecoration(
          color: const Color(0xFFB6499A).withValues(alpha: 0.08),
          border: Border.all(
            color: const Color(0xFFB6499A).withValues(alpha: 0.16),
          ),
          borderRadius: BorderRadius.circular(16),
        );
        textColor = const Color(0xFFA33375);
        break;
    }

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
          transform: Matrix4.translationValues(0, _hover ? -1 : 0, 0),
          padding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          constraints: const BoxConstraints(minHeight: 45),
          decoration: deco,
          child: Center(
            child: Text(
              widget.label,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: textColor,
                height: 1,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
