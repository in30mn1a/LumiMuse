import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/models/attachment_item.dart';
import '../../../core/providers/llm_service_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import '../../../theme/app_breakpoints.dart';
import '../../../theme/app_spacing.dart';
import 'attachment_picker_button.dart';
import 'attachment_preview_bar.dart';

String _sanitizeModelFetchError(Object error) {
  var message = error.toString();
  message = message.replaceAll(RegExp(r'https?://[^\s]+'), '<URL>');
  message = message.replaceAll(
    RegExp(r'Bearer\s+[A-Za-z0-9._\-]+', caseSensitive: false),
    'Bearer <KEY>',
  );
  message = message.replaceAll(RegExp(r'[A-Za-z0-9_\-]{24,}'), '<KEY>');
  if (message.length > 200) {
    message = '${message.substring(0, 200)}...';
  }
  return message;
}

/// 聊天输入栏 — 严格 1:1 对照 src/components/chat/ChatInput.tsx 复刻。
///
/// 视觉契约（每处都对应 TSX 中的 className）：
/// - 外层容器 `chat-input-safe border-t border-border-light bg-[rgba(248,244,255,0.82)]`
///   `px-4 py-2 md:py-4 backdrop-blur-xl dark:bg-[rgba(25,20,37,0.82)]`
///   - chat-input-safe 处理 safe-area bottom（移动端）
/// - 内容居中 `mx-auto max-w-6xl`（72rem≈1152px）
/// - 附件预览：`mb-2 flex flex-wrap gap-2`
/// - 错误提示：`mb-2 text-xs text-red-500`
/// - 输入条容器：`flex items-center gap-2 rounded-[1.25rem](20) border border-border-light`
///   `bg-white/70 px-3 py-2 shadow-[0_8px_22px_rgba(92,74,139,0.04)]`
/// - 三个槽位顺序锁定（A3.2.7 / RC-11）：
///   1. paperclipIcon（附件按钮）：self-end mb-1.5 rounded-xl(12) p-2
///      hover:bg-accent/8 hover:text-accent-dark disabled:opacity-40
///   2. textarea：textarea-rich min-h-[3.1rem]≈50 max-h-44≈176
///      border-none bg-transparent px-1 py-1 shadow-none focus:ring-0
///   3. sendOrStopButton：soft-button(min-h 2.8rem≈45) self-end mb-1
///      px-3 / md:min-w-[6.6rem] md:px-4
///      生成中：soft-button-secondary border-accent/20 text-accent-dark
///      默认：  soft-button-primary 渐变填充
///
/// **注意**：原版 TSX 输入栏**没有**生图按钮 — 生图按钮在 MessageBubble 上。
/// Flutter 端早期版本错误地把生图按钮放进了输入栏，本次重写已移除。
class ChatInput extends ConsumerStatefulWidget {
  /// 发送回调：text 已 trim，attachments 为空时传 null
  final Future<void> Function(String text, List<AttachmentItem>? attachments)
  onSend;

  /// 停止当前流式生成的回调（仅在 isGenerating 时启用）
  final VoidCallback? onStop;

  /// 输入框是否禁用（当前对话正在生成时为 true）
  final bool disabled;

  /// 是否正在生成中（决定显示发送 / 停止按钮）
  final bool isGenerating;

  /// 当前使用的模型名称
  final String? currentModel;

  /// 模型切换回调
  final ValueChanged<String>? onModelChange;

  const ChatInput({
    super.key,
    required this.onSend,
    this.onStop,
    required this.disabled,
    required this.isGenerating,
    this.currentModel,
    this.onModelChange,
  });

  @override
  ConsumerState<ChatInput> createState() => _ChatInputState();
}

class _ChatInputState extends ConsumerState<ChatInput> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  final List<AttachmentItem> _attachments = [];
  String? _attachError;
  List<String> _fetchedModels = [];
  bool _modelLoading = false;

  @override
  void initState() {
    super.initState();
    _focusNode.onKeyEvent = _handleKey;
    _controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  /// 文本变化时触发 setState 让发送按钮 disabled 状态实时更新
  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _submit() async {
    final trimmed = _controller.text.trim();
    if ((trimmed.isEmpty && _attachments.isEmpty) || widget.disabled) return;

    final attachmentsToSend = _attachments.isEmpty
        ? null
        : List<AttachmentItem>.from(_attachments);
    // TSX 同款：纯附件场景把 content 占位为 ' '
    final content = trimmed.isEmpty ? ' ' : trimmed;

    _controller.clear();
    setState(() {
      _attachments.clear();
      _attachError = null;
    });

    final isMobilePlatform =
        Theme.of(context).platform == TargetPlatform.iOS ||
        Theme.of(context).platform == TargetPlatform.android;
    // 仅在真实触摸平台 unfocus；桌面端窄窗口不应被当作"移动端"打断键入，
    // 与 didUpdateWidget 的判定保持对称。
    if (isMobilePlatform) {
      _focusNode.unfocus();
    }

    await widget.onSend(content, attachmentsToSend);
  }

  @override
  void didUpdateWidget(covariant ChatInput oldWidget) {
    super.didUpdateWidget(oldWidget);

    // 仅在真实触摸平台（iOS/Android）上做 isGenerating 切换时的强制 unfocus；
    // 桌面端不论窗口宽度都不强制 unfocus，避免缩窄窗口时键入被打断。
    final isMobilePlatform =
        Theme.of(context).platform == TargetPlatform.iOS ||
        Theme.of(context).platform == TargetPlatform.android;

    if (isMobilePlatform) {
      // 无论是从“不生成”变成“正在生成”（即输入框被禁用），还是从“正在生成”变成“结束生成”（即输入框恢复可用），
      // 在移动端/触摸平台都确保取消聚焦，关闭/防止键盘弹出。
      if ((oldWidget.isGenerating && !widget.isGenerating) ||
          (!oldWidget.isGenerating && widget.isGenerating)) {
        _focusNode.unfocus();
      }
    }
  }

  /// Enter 发送 / Shift+Enter 换行（与 TSX 一致）
  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final isEnter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;
    final isMobilePlatform =
        Theme.of(context).platform == TargetPlatform.iOS ||
        Theme.of(context).platform == TargetPlatform.android;
    // 移动端输入法的 Enter 应交给 TextField 默认处理，以便插入换行。
    if (isMobilePlatform) return KeyEventResult.ignored;
    // 中文 / 日文等 IME 选词期间 Enter 不应触发发送，交给输入法处理选词确认
    if (_controller.value.composing.isValid) return KeyEventResult.ignored;
    final isShift = HardwareKeyboard.instance.isShiftPressed;
    if (isShift) return KeyEventResult.ignored; // Shift+Enter 走默认换行
    _submit();
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final lang = ref.watch(localeProvider).languageCode;
    // 细粒度订阅：避免整 MediaQueryData rebuild。
    // 键盘弹起仅刷 viewInsetsOf；窗口宽度变化仅刷 sizeOf；安全区仅刷 paddingOf。
    final isMobile = AppBreakpoints.isMobile(MediaQuery.sizeOf(context).width);

    final canSend =
        (_controller.text.trim().isNotEmpty || _attachments.isNotEmpty) &&
        !widget.disabled;

    // chat-input-safe：safe-area-inset-bottom + 1rem
    final safeBottom = MediaQuery.paddingOf(context).bottom;
    // 键盘弹起时优先用 viewInsets.bottom，否则用 safe-area
    final viewInsetsBottom = MediaQuery.viewInsetsOf(context).bottom;
    final bottomInset = viewInsetsBottom > 0 ? viewInsetsBottom : safeBottom;

    final borderLight = isDark
        ? AppTheme.darkBorderLight
        : AppTheme.borderLight;
    // bg-[rgba(248,244,255,0.82)] / dark:bg-[rgba(25,20,37,0.82)]
    final containerBg = isDark
        ? const Color(0xFF191425).withValues(alpha: 0.82)
        : const Color(0xFFF8F4FF).withValues(alpha: 0.82);

    return AnimatedPadding(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Container(
        decoration: BoxDecoration(
          color: containerBg,
          border: Border(top: BorderSide(color: borderLight)),
        ),
        // px-4 py-2 md:py-4
        padding: EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: isMobile ? AppSpacing.sm : AppSpacing.lg,
        ),
        child: Center(
          child: ConstrainedBox(
            // mx-auto max-w-6xl (72rem)
            constraints: const BoxConstraints(maxWidth: 1152),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 附件预览栏：mb-2
                if (_attachments.isNotEmpty) ...[
                  AttachmentPreviewBar(
                    attachments: _attachments,
                    onRemove: (i) => setState(() => _attachments.removeAt(i)),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],

                // 错误提示：mb-2 text-xs text-red-500
                if (_attachError != null) ...[
                  Text(
                    _attachError!,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFFEF4444), // red-500
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],

                // 输入条主体
                _buildInputRow(
                  context,
                  isDark,
                  lang,
                  isMobile,
                  borderLight,
                  canSend,
                ),

                // 模型切换栏（对照 TSX ChatInput 底部 model picker）
                if (widget.onModelChange != null)
                  _buildModelPickerRow(isDark, lang),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 输入条三槽位主体
  Widget _buildInputRow(
    BuildContext context,
    bool isDark,
    String lang,
    bool isMobile,
    Color borderLight,
    bool canSend,
  ) {
    return Container(
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.7),
        border: Border.all(color: borderLight),
        // rounded-[1.25rem] = 20
        borderRadius: BorderRadius.circular(20),
        boxShadow: const [
          // shadow-[0_8px_22px_rgba(92,74,139,0.04)]
          BoxShadow(
            color: Color(0x0A5C4A8B),
            blurRadius: 22,
            offset: Offset(0, 8),
          ),
        ],
      ),
      // px-3 py-2
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          // ── 槽位 1：附件按钮（self-end mb-1.5）──
          Padding(
            // mb-1.5 = 6
            padding: const EdgeInsets.only(bottom: 6),
            child: AttachmentPickerButton(
              currentCount: _attachments.length,
              disabled: widget.disabled,
              isDark: isDark,
              onPicked: (att) {
                setState(() {
                  _attachments.add(att);
                  _attachError = null;
                });
              },
              onSizeExceeded: () {
                // TODO(parity): 主项目缺失 'chat.attachmentSizeExceeded' 键，硬编码兜底
                setState(() => _attachError = '文件超过 10MB 大小限制');
              },
            ),
          ),

          const SizedBox(width: AppSpacing.sm), // gap-2
          // ── 槽位 2：textarea（min-w-0 flex-1）──
          Expanded(
            child: TextField(
              controller: _controller,
              focusNode: _focusNode,
              readOnly: widget.disabled,
              maxLines: 6, // max-h-44 ≈ 176px ≈ 6 行 ≈ 11×16
              minLines: 1,
              textInputAction: TextInputAction.newline,
              style: TextStyle(
                fontSize: 15, // 0.95rem
                height: 1.5,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: I18n.t('input.placeholder', lang: lang),
                hintStyle: TextStyle(
                  fontSize: 15,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
                // border-none focus:ring-0：完全无边框无聚焦框
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                isDense: true,
                // px-1 py-1
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 4,
                  vertical: 4,
                ),
                // textarea-rich min-h-[3.1rem] ≈ 50px
                isCollapsed: false,
              ),
            ),
          ),

          const SizedBox(width: AppSpacing.sm), // gap-2
          // ── 槽位 3：发送 / 停止按钮（self-end mb-1）──
          Padding(
            padding: const EdgeInsets.only(bottom: 4), // mb-1
            child: widget.isGenerating
                ? LumiSoftButton(
                    kind: LumiSoftButtonKind.secondary,
                    icon: Icons.stop_outlined,
                    label: isMobile ? null : I18n.t('input.stop', lang: lang),
                    onTap: widget.onStop,
                    minWidth: isMobile ? 45 : 105.6,
                    padding: EdgeInsets.symmetric(
                      horizontal: isMobile ? 12 : 16,
                      vertical: 8,
                    ),
                  )
                : LumiSoftButton(
                    kind: LumiSoftButtonKind.primary,
                    icon: Icons.auto_awesome,
                    label: isMobile ? null : I18n.t('input.send', lang: lang),
                    onTap: canSend ? _submit : null,
                    minWidth: isMobile ? 45 : 105.6,
                    padding: EdgeInsets.symmetric(
                      horizontal: isMobile ? 12 : 16,
                      vertical: 8,
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  /// 模型切换栏 — 对照 TSX ChatInput 底部 `relative mt-1.5 flex items-center justify-between px-1`
  Widget _buildModelPickerRow(bool isDark, String lang) {
    final muted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final displayModel = widget.currentModel?.isNotEmpty == true
        ? widget.currentModel!
        : I18n.t('settings.modelPlaceholder', lang: lang);

    return Padding(
      padding: const EdgeInsets.only(top: 6, left: 4, right: 4), // mt-1.5 px-1
      child: GestureDetector(
        onTap: _handleOpenModelPicker,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(8)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 192),
                  child: Text(
                    displayModel,
                    style: TextStyle(fontSize: 11, color: muted),
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                  ),
                ),
                const SizedBox(width: 4),
                Icon(Icons.expand_more, size: 12, color: muted),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _handleOpenModelPicker() async {
    String? fetchError;

    // 先确保模型列表已加载
    if (_fetchedModels.isEmpty && !_modelLoading) {
      setState(() => _modelLoading = true);
      try {
        final settings = await ref.read(settingsProvider.future);
        if (settings.apiBase.isNotEmpty && settings.apiKey.isNotEmpty) {
          // LlmService.fetchModels 内部已做 30min TTL 缓存 + 失败回退旧缓存
          // （对齐主项目 api/models/route.ts），此处不再重复读写 ModelCache 表。
          final llm = ref.read(llmServiceProvider);
          final models = await llm.fetchModels(
            apiBase: settings.apiBase,
            apiKey: settings.apiKey,
          );
          if (models.isNotEmpty) {
            _fetchedModels = models;
          }
        }
      } catch (e) {
        fetchError = _sanitizeModelFetchError(e);
      }
      if (mounted) setState(() => _modelLoading = false);
    }

    if (!mounted) return;

    // 使用 showMenu 弹出模型选择列表（渲染在 Overlay 层，不受父级裁剪影响）
    final RenderBox button = context.findRenderObject() as RenderBox;
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final position = RelativeRect.fromRect(
      Rect.fromPoints(
        button.localToGlobal(Offset.zero, ancestor: overlay),
        button.localToGlobal(
          button.size.bottomLeft(Offset.zero),
          ancestor: overlay,
        ),
      ),
      Offset.zero & overlay.size,
    );

    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentDark = isDark ? AppTheme.darkAccentDark : AppTheme.accentDark;

    if (fetchError != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(fetchError),
          duration: const Duration(seconds: 3),
        ),
      );
      return;
    }

    if (_fetchedModels.isEmpty) {
      // 没有模型可选，显示提示
      final lang = ref.read(localeProvider).languageCode;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(I18n.t('input.noModels', lang: lang)),
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }

    final selected = await showMenu<String>(
      context: context,
      position: position,
      constraints: const BoxConstraints(maxWidth: 320, maxHeight: 300),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      items: _fetchedModels.map((model) {
        final isActive = model == widget.currentModel;
        return PopupMenuItem<String>(
          value: model,
          height: 36,
          child: Text(
            model,
            style: TextStyle(
              fontSize: 12,
              fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
              color: isActive ? accentDark : null,
            ),
            overflow: TextOverflow.ellipsis,
          ),
        );
      }).toList(),
    );

    if (selected != null) {
      widget.onModelChange?.call(selected);
    }
  }
}
