import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/database/database.dart';
import '../../../core/models/message_metadata.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_breakpoints.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import '../../../theme/surfaces.dart';
import 'image_attachment.dart';

/// 移动端触摸目标最小尺寸（逻辑像素）
/// 符合 WCAG / Apple HIG 的 44×44 最小触摸目标要求
const double kMinTouchTargetSize = 44.0;

/// 消息气泡 — 完整复刻原版 MessageBubble.tsx
///
/// 视觉要点：
/// - AI 消息：左侧头像 + 右侧气泡（白底毛玻璃 + 边框 + 阴影）
/// - 用户消息：右对齐，无头像，紫色渐变填充
/// - 顶部 meta 行：角色名 / 时间 / 操作按钮组（hover 显示）
/// - 气泡内底部：版本切换 ‹ 1/2 ›
/// - 系统消息（总结）：分割线 + 标签 + 卡片
///
/// 移动端触摸适配：
/// - 屏幕宽度 < 768px 时默认隐藏操作按钮
/// - 点击气泡切换操作按钮显示/隐藏
/// - 通过 [activeMessageId] 和 [onToggleActions] 协调多气泡状态
/// - 操作按钮触摸目标 ≥ 44×44 逻辑像素
/// - 气泡最大宽度限制为屏幕宽度的 88%
///
/// 删除回调说明：
/// - 本 widget 仅负责 UI 与回调透传，不直接调用 `ImageGenService`，
///   也不负责更新数据库 metadata。所有真正的清理副作用由上层
///   （`ChatView` 之类的承载页面）在回调内完成。
class MessageBubble extends ConsumerStatefulWidget {
  final Message message;
  final String? characterName;
  final String? characterAvatarUrl;
  final bool showTimestamps;
  final VoidCallback? onRegenerate;
  final VoidCallback? onCopy;
  final VoidCallback? onDelete;
  final void Function(int versionIndex)? onSwitchVersion;
  final VoidCallback? onEdit;
  final void Function(String imagePath, {String? prompt})? onRegenerateImage;

  /// 用户消息重答 — 对照 TSX `onRegenerateFromHere(messageId)`
  ///
  /// 仅在 [Message.role] == 'user' 时显示对应图标按钮（ReplyIcon）。
  /// 调用方负责定位下一条 assistant 消息并以当前 user content 重新生成。
  final VoidCallback? onRegenerateFromHere;

  /// AI 消息生图 — 对照主项目 `onGenerateImage(messageId, existingPrompt?, replaceImageId?)`
  ///
  /// 仅在 [Message.role] == 'assistant' 且回调非空时显示 ImageIcon。
  /// 调用方负责走 prompt 生成 → 图片生成 → metadata 持久化全流程。
  /// [prompt] 不为空时跳过 AI prompt 生成，直接使用该 prompt 生图。
  /// [replaceImageId] 不为空时在原位替换（追加版本），否则创建新图片条目。
  final void Function({String? prompt, String? replaceImageId})? onGenerateImage;

  /// 删除整条生图气泡（含其所有 versions）
  ///
  /// 入参 `imageId` 优先取 `metadata.generatedImages[].id`，缺失时退化为
  /// 该条目的本地路径（`path` 字段），与「角色图片管理」侧的稳定 ID 语义对齐。
  /// 调用方负责在事务内更新 metadata 移除该条目，并对所有被移除的本地路径
  /// 调用 `ImageGenService.deleteImage`。
  final void Function(String imageId)? onDeleteGeneratedImage;

  /// 删除当前展示版本（lightbox 触发）
  ///
  /// 第一个参数 `imageId` 与 [onDeleteGeneratedImage] 同源，第二个参数
  /// `versionLocalPath` 为 lightbox 当前展示版本对应的本地路径。
  /// 调用方负责更新 metadata 移除该 version，并对该路径调用
  /// `ImageGenService.deleteImage`。
  final void Function(String imageId, String versionLocalPath)?
      onDeleteGeneratedImageVersion;

  /// 编辑图片提示词回调 — 对照主项目 handleEditImagePrompt
  final void Function(String imageId, String newPrompt)? onEditImagePrompt;

  /// 设置图片激活版本回调 — 对照主项目 handleSetPrimaryImage
  final void Function(String imageId, int versionIndex)? onSetPrimaryImage;

  /// 删除附件回调 — 传入附件索引
  final void Function(int attachmentIndex)? onDeleteAttachment;

  /// 当前展开操作按钮的消息 ID（用于跨气泡协调）
  final String? activeMessageId;

  /// 点击气泡时通知父级切换操作按钮状态
  final void Function(String messageId)? onToggleActions;

  const MessageBubble({
    super.key,
    required this.message,
    this.characterName,
    this.characterAvatarUrl,
    this.showTimestamps = true,
    this.onRegenerate,
    this.onCopy,
    this.onDelete,
    this.onSwitchVersion,
    this.onEdit,
    this.onRegenerateImage,
    this.onRegenerateFromHere,
    this.onGenerateImage,
    this.onDeleteGeneratedImage,
    this.onDeleteGeneratedImageVersion,
    this.onEditImagePrompt,
    this.onSetPrimaryImage,
    this.onDeleteAttachment,
    this.activeMessageId,
    this.onToggleActions,
  });

  @override
  ConsumerState<MessageBubble> createState() => _MessageBubbleState();
}

class _MessageBubbleState extends ConsumerState<MessageBubble> {
  bool _copied = false;

  /// 读取当前语言并查 i18n 表的便捷方法
  String _i18n(String key) {
    final String lang = ref.watch(localeProvider).languageCode;
    return I18n.t(key, lang: lang);
  }

  /// 判断当前是否为移动端（屏幕宽度 < 768px）
  bool _isMobile(BuildContext context) {
    return AppBreakpoints.isMobile(MediaQuery.of(context).size.width);
  }

  // ───────── 解析 metadata ─────────

  MessageMetadata _parseMeta() {
    return MessageMetadata.fromJsonString(widget.message.metadata);
  }

  bool get _isSummary => _parseMeta().isSummary;

  _VersionInfo? _parseVersionInfo() {
    final meta = _parseMeta();
    final versions = meta.versions;
    final activeVersion = meta.activeVersion;
    if (versions.length > 1) {
      return _VersionInfo(
        total: versions.length,
        active: activeVersion ?? 0,
      );
    }
    return null;
  }

  String _formatTime(DateTime dt) {
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  void _handleCopy() {
    widget.onCopy?.call();
    setState(() => _copied = true);
    Future.delayed(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.message.role == 'system' || _isSummary) {
      return _SummaryCard(
        message: widget.message,
        showTimestamps: widget.showTimestamps,
        onEdit: widget.onEdit,
        onDelete: widget.onDelete,
      );
    }

    final isUser = widget.message.role == 'user';
    return Padding(
      padding: isUser
          ? const EdgeInsets.fromLTRB(0, 6, 12, 6)
          : const EdgeInsets.fromLTRB(12, 6, 0, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment:
            isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          // AI 消息：左侧头像
          if (!isUser) ...[
            _buildAvatar(),
            const SizedBox(width: 12),
          ],
          // 气泡（含正下方图片）
          Flexible(
            child: Column(
              crossAxisAlignment:
                  isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              children: [
                _buildBubble(isUser),
                _buildGeneratedImages(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ───────── 头像 ─────────

  Widget _buildAvatar() {
    final hasAvatar = widget.characterAvatarUrl != null &&
        widget.characterAvatarUrl!.isNotEmpty;
    return Container(
      margin: const EdgeInsets.only(top: 2),
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            AppTheme.accent.withValues(alpha: 0.18),
            AppTheme.accentLight.withValues(alpha: 0.28),
          ],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: AppTheme.accent.withValues(alpha: 0.10),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: hasAvatar
          ? LumiNetworkImage(
              url: widget.characterAvatarUrl!,
              fit: BoxFit.cover,
              errorWidget: _avatarInitial(),
            )
          : _avatarInitial(),
    );
  }

  Widget _avatarInitial() {
    final name = widget.characterName ?? '';
    return Center(
      child: Text(
        name.isNotEmpty ? name[0] : '?',
        style: const TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: AppTheme.accentDark,
        ),
      ),
    );
  }

  // ───────── 气泡 ─────────

  Widget _buildBubble(bool isUser) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isMobile = _isMobile(context);

    // 对照主项目 globals.css .message-card：
    // 桌面 max-width: 72%（相对于聊天区容器宽度，非屏幕宽度）
    // 移动端 max-width: 88%
    // 使用 LayoutBuilder 获取父容器实际宽度，避免大屏幕上 72%*屏幕宽度过宽
    final maxWidthFraction = isMobile ? 0.85 : 0.65;
    final maxBubbleCap = isMobile ? 480.0 : 680.0;

    return LayoutBuilder(
      builder: (context, constraints) {
        final maxBubbleWidth = (constraints.maxWidth * maxWidthFraction).clamp(0.0, maxBubbleCap);

        return HoverBuilder(
          builder: (isHovering) {
            final showActions = isMobile
                ? widget.activeMessageId == widget.message.id
                : isHovering;

            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                if (isMobile) {
                  widget.onToggleActions?.call(widget.message.id);
                }
              },
              onLongPress: widget.onEdit,
              // IntrinsicWidth 让气泡收缩到内容实际宽度，
              // 同时 Column(stretch) 让 meta 行填满气泡宽度
              child: IntrinsicWidth(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: maxBubbleWidth,
                  ),
                  child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  decoration: BoxDecoration(
                    gradient: isUser
                        ? const LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [AppTheme.accent, AppTheme.accentDark],
                          )
                        : null,
                    color: isUser
                        ? null
                        : (isDark
                            ? AppTheme.darkSurface.withValues(alpha: 0.88)
                            : Colors.white.withValues(alpha: 0.88)),
                    border: isUser
                        ? null
                        : Border.all(
                            color: isDark
                                ? AppTheme.darkBorderLight
                                : AppTheme.borderLight,
                          ),
                    borderRadius: BorderRadius.circular(22),
                    boxShadow: [
                      isUser
                          ? const BoxShadow(
                              color: Color(0x386F52C5),
                              blurRadius: 30,
                              offset: Offset(0, 14),
                            )
                          : AppSurfaces.softCardShadow,
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _buildMetaRow(isUser, isDark, showActions: showActions),
                      // 用户消息附件预览（图片/文本文件）— 对照主项目 MessageBubble.tsx
                      if (isUser) _buildUserAttachments(isDark),
                      if (widget.message.content.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        _buildContent(isUser),
                      ],
                      _buildVersionNav(isUser),
                    ],
                  ),
                ),
              ),
              ),
        );
      },
    );
      },
    );
  }

  // ───────── 顶部 meta 行：角色名 + 时间 + 操作按钮 ─────────
  // 主项目对照：左边 角色名+时间，右边 操作按钮，中间 Spacer 撑开。
  // meta 行填满气泡宽度（由内容文本决定），不影响气泡收缩。

  Widget _buildMetaRow(bool isUser, bool isDark, {required bool showActions}) {
    final metaColor = isUser
        ? Colors.white.withValues(alpha: 0.75)
        : (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted);

    final roleLabel = isUser ? '你' : (widget.characterName ?? 'AI');
    final isMobile = _isMobile(context);

    // 左侧：角色名 + 时间
    final leftPart = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          roleLabel,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w500,
            color: metaColor,
          ),
        ),
        if (widget.showTimestamps) ...[
          const SizedBox(width: 6),
          Icon(Icons.access_time, size: 11, color: metaColor),
          const SizedBox(width: 3),
          Text(
            _formatTime(widget.message.createdAt),
            style: TextStyle(fontSize: 11, color: metaColor),
          ),
        ],
      ],
    );

    // 右侧：操作按钮
    final rightPart = isMobile
        ? AnimatedOpacity(
            duration: const Duration(milliseconds: 150),
            opacity: showActions ? 1.0 : 0.5,
            child: _buildActionButtons(isUser, isMobile: true),
          )
        : AnimatedOpacity(
            duration: const Duration(milliseconds: 150),
            opacity: showActions ? 1 : 0,
            child: IgnorePointer(
              ignoring: !showActions,
              child: _buildActionButtons(isUser, isMobile: false),
            ),
          );

    return Row(
      children: [
        leftPart,
        const Spacer(),
        rightPart,
      ],
    );
  }

  Widget _buildActionButtons(bool isUser, {bool isMobile = false}) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (widget.onCopy != null)
          _MetaButton(
            icon: _copied ? Icons.check : Icons.copy_rounded,
            tooltip: _copied ? _i18n('message.copied') : _i18n('message.copy'),
            onTap: _handleCopy,
            isUser: isUser,
            isMobile: isMobile,
          ),
        if (widget.onEdit != null)
          _MetaButton(
            icon: Icons.edit_outlined,
            tooltip: _i18n('message.edit'),
            onTap: widget.onEdit!,
            isUser: isUser,
            isMobile: isMobile,
          ),
        if (widget.onDelete != null)
          _MetaButton(
            icon: Icons.delete_outline,
            tooltip: _i18n('message.delete'),
            onTap: widget.onDelete!,
            isUser: isUser,
            isMobile: isMobile,
          ),
        // 用户消息：重新回答（ReplyIcon）
        if (isUser && widget.onRegenerateFromHere != null)
          _MetaButton(
            icon: Icons.reply_outlined,
            tooltip: _i18n('message.regenerateFromHere'),
            onTap: widget.onRegenerateFromHere!,
            isUser: isUser,
            isMobile: isMobile,
          ),
        // AI 消息：重新生成（RefreshIcon）
        if (!isUser && widget.onRegenerate != null)
          _MetaButton(
            icon: Icons.refresh_rounded,
            tooltip: _i18n('message.regenerate'),
            onTap: widget.onRegenerate!,
            isUser: isUser,
            isMobile: isMobile,
          ),
        // AI 消息：生图（ImageIcon）— 阶段 2D 接通
        if (!isUser && widget.onGenerateImage != null)
          _MetaButton(
            icon: Icons.image_outlined,
            // 'imageGen.button' 属 imageGen.* 命名空间，i18n 表中已存在
            tooltip: _i18n('imageGen.button'),
            onTap: () => widget.onGenerateImage!(),
            isUser: isUser,
            isMobile: isMobile,
          ),
      ],
    );
  }

  // ───────── 用户消息附件预览 ─────────

  Widget _buildUserAttachments(bool isDark) {
    final meta = _parseMeta();
    final attachments = meta.attachments;
    if (attachments.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 2),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: List.generate(attachments.length, (index) {
          final att = attachments[index];
          final canDelete = widget.onDeleteAttachment != null;
          if (att.type == 'image') {
            final src = att.url;
            if (src.isEmpty) return const SizedBox.shrink();
            Widget imageWidget;
            if (src.startsWith('data:')) {
              final base64Part = src.split(',').last;
              try {
                final bytes = base64Decode(base64Part);
                imageWidget = ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.memory(
                    bytes,
                    height: 120,
                    width: 160,
                    fit: BoxFit.cover,
                  ),
                );
              } catch (_) {
                return const SizedBox.shrink();
              }
            } else {
              final file = File(src);
              if (file.existsSync()) {
                imageWidget = ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.file(
                    file,
                    height: 120,
                    width: 160,
                    fit: BoxFit.cover,
                  ),
                );
              } else {
                return const SizedBox.shrink();
              }
            }
            if (!canDelete) return imageWidget;
            return Stack(
              clipBehavior: Clip.none,
              children: [
                imageWidget,
                Positioned(
                  top: -6,
                  right: -6,
                  child: _AttachmentDeleteButton(
                    onTap: () => widget.onDeleteAttachment!(index),
                  ),
                ),
              ],
            );
          } else {
            final ext = (att.name ?? '').split('.').last.toUpperCase();
            final chip = Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    ext,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(width: 6),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 120),
                    child: Text(
                      att.name ?? '',
                      style: TextStyle(
                        fontSize: 11,
                        color: Colors.white.withValues(alpha: 0.8),
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            );
            if (!canDelete) return chip;
            return Stack(
              clipBehavior: Clip.none,
              children: [
                chip,
                Positioned(
                  top: -6,
                  right: -6,
                  child: _AttachmentDeleteButton(
                    onTap: () => widget.onDeleteAttachment!(index),
                  ),
                ),
              ],
            );
          }
        }),
      ),
    );
  }

  // ───────── 正文 ─────────

  Widget _buildContent(bool isUser) {
    if (isUser) {
      return SelectableText(
        widget.message.content,
        style: const TextStyle(
          fontSize: 15,
          height: 1.75,
          color: Colors.white,
        ),
      );
    }
    return MarkdownBody(
      data: widget.message.content,
      selectable: true,
      styleSheet: _buildMarkdownStyle(),
      onTapLink: (text, href, title) {
        // 链接处理交给上层
      },
    );
  }

  MarkdownStyleSheet _buildMarkdownStyle() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final textColor =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final mutedColor =
        isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;

    final base = TextStyle(fontSize: 15, height: 1.75, color: textColor);

    return MarkdownStyleSheet(
      p: base,
      h1: base.copyWith(
        fontSize: 17,
        fontWeight: FontWeight.w600,
      ),
      h2: base.copyWith(
        fontSize: 16,
        fontWeight: FontWeight.w600,
      ),
      h3: base.copyWith(fontSize: 15, fontWeight: FontWeight.w600),
      strong: base.copyWith(fontWeight: FontWeight.w600),
      em: base.copyWith(fontStyle: FontStyle.italic),
      code: TextStyle(
        fontSize: 13,
        fontFamily: 'monospace',
        color: textColor,
        backgroundColor: AppTheme.accent.withValues(alpha: 0.08),
      ),
      codeblockDecoration: BoxDecoration(
        color: AppTheme.accent.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border:
            Border.all(color: AppTheme.accent.withValues(alpha: 0.18)),
      ),
      codeblockPadding: const EdgeInsets.all(10),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: AppTheme.accent.withValues(alpha: 0.4),
            width: 3,
          ),
        ),
      ),
      blockquotePadding:
          const EdgeInsets.only(left: 12, top: 4, bottom: 4),
      blockquote: base.copyWith(color: mutedColor),
      listBullet: base,
      tableBorder: TableBorder.all(color: borderColor, width: 1),
      a: base.copyWith(
        color: AppTheme.accentDark,
        decoration: TextDecoration.underline,
      ),
    );
  }

  // ───────── 版本切换 ─────────

  Widget _buildVersionNav(bool isUser) {
    final info = _parseVersionInfo();
    if (info == null) return const SizedBox.shrink();

    final isDark = Theme.of(context).brightness == Brightness.dark;
    // 暗色模式适配：版本切换按钮使用 darkTextSecondary 颜色
    final color = isUser
        ? Colors.white.withValues(alpha: 0.7)
        : (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted);
    final disabledColor = isUser
        ? Colors.white.withValues(alpha: 0.3)
        : (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted)
            .withValues(alpha: 0.4);

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isUser) const Spacer(),
          _VersionButton(
            icon: Icons.chevron_left,
            color: info.active > 0 ? color : disabledColor,
            onTap: info.active > 0
                ? () => widget.onSwitchVersion?.call(info.active - 1)
                : null,
            isUser: isUser,
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              '${info.active + 1}/${info.total}',
              style: TextStyle(fontSize: 11, color: color),
            ),
          ),
          _VersionButton(
            icon: Icons.chevron_right,
            color: info.active < info.total - 1 ? color : disabledColor,
            onTap: info.active < info.total - 1
                ? () => widget.onSwitchVersion?.call(info.active + 1)
                : null,
            isUser: isUser,
          ),
        ],
      ),
    );
  }

  // ───────── 生成的图片（气泡正下方） ─────────

  Widget _buildGeneratedImages() {
    if (widget.message.role != 'assistant') return const SizedBox.shrink();
    final meta = _parseMeta();
    final images = meta.generatedImages;
    if (images.isEmpty) return const SizedBox.shrink();

    final messageVersions = meta.imageVersions;
    final messageActiveVersion = meta.activeImageVersion;

    List<String>? msgVersionPaths;
    if (messageVersions != null && messageVersions.length >= 2) {
      msgVersionPaths = messageVersions
          .map((v) => v.path ?? v.url)
          .where((p) => p.isNotEmpty)
          .toList();
    }

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: images.map((e) {
          final path = e.path ?? e.url;
          final isPendingImage = e.status == 'pending' || e.status == 'pending_prompt' || e.status == 'pending_image';
          final isFailedImage = e.status == 'failed';
          if (isPendingImage) {
            return _buildPendingImageCard(e);
          }
          if (isFailedImage) {
            return _buildFailedImageCard(e, path);
          }

          final itemVersions = e.versions;
          final itemActiveVersion = e.activeVersion;
          List<String>? versionPaths = msgVersionPaths;
          int? activeVersion = messageActiveVersion;
          String? activePrompt = e.prompt;

          if (versionPaths == null || versionPaths.length < 2) {
            versionPaths = itemVersions
                .map((v) => v.path ?? v.url)
                .where((p) => p.isNotEmpty)
                .toList();
            activeVersion = itemActiveVersion;
            if (itemVersions.isNotEmpty) {
              final activeIdx =
                  itemActiveVersion.clamp(0, itemVersions.length - 1);
              final versionPrompt = itemVersions[activeIdx].prompt;
              if (versionPrompt != null && versionPrompt.trim().isNotEmpty) {
                activePrompt = versionPrompt;
              }
            }
          }

          if (versionPaths.length < 2) {
            versionPaths = null;
            activeVersion = null;
          }

          return _buildImageEntry(
            image: e,
            path: path,
            activePrompt: activePrompt,
            versionPaths: versionPaths,
            activeVersion: activeVersion,
          );
        }).toList(),
      ),
    );
  }

  /// 生图占位卡片（pending 状态）— 对照主项目 ImageGenCard pending 分支
  Widget _buildPendingImageCard(GeneratedImage e) {
    final imageId = _resolveImageId(e, e.path ?? e.url);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Container(
        width: 280,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: isDark
              ? AppTheme.darkSurface.withValues(alpha: 0.8)
              : Colors.white.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    e.status == 'pending_prompt' ? '生成提示词中' : '图片生成中',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  // 三点跳动
                  Row(
                    children: List.generate(3, (i) => Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: _TypingDot(delay: i * 160),
                    )),
                  ),
                  if (e.prompt != null && e.prompt!.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      e.prompt!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            // 编辑提示词按钮
            if (widget.onEditImagePrompt != null)
              _miniIconButton(
                icon: Icons.edit_outlined,
                onTap: () => _showEditPromptDialog(imageId, e.prompt ?? ''),
              ),
          ],
        ),
      ),
    );
  }

  /// 生图失败卡片 — 对照主项目 ImageGenCard failed 分支
  Widget _buildFailedImageCard(GeneratedImage e, String path) {
    final imageId = _resolveImageId(e, path);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Container(
        width: 280,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: isDark
              ? AppTheme.darkSurface.withValues(alpha: 0.8)
              : Colors.white.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '图片生成失败',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
                    ),
                  ),
                  if (e.prompt != null && e.prompt!.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      e.prompt!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                      ),
                    ),
                  ],
                  const SizedBox(height: 6),
                  Text(
                    e.error ?? '上游图片生成失败，请稍后重试',
                    style: TextStyle(fontSize: 11, color: Colors.red.shade400),
                  ),
                ],
              ),
            ),
            // 右侧操作按钮组
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // 编辑提示词
                if (widget.onEditImagePrompt != null)
                  _miniIconButton(
                    icon: Icons.edit_outlined,
                    onTap: () => _showEditPromptDialog(imageId, e.prompt ?? ''),
                  ),
                // 重试
                if (widget.onRegenerateImage != null)
                  _miniIconButton(
                    icon: Icons.refresh,
                    color: AppTheme.accentDark,
                    onTap: () {
                      if (widget.onGenerateImage != null) {
                        widget.onGenerateImage!(
                          prompt: e.prompt,
                          replaceImageId: imageId,
                        );
                      } else {
                        widget.onRegenerateImage!(path, prompt: e.prompt);
                      }
                    },
                  ),
                // 删除
                if (widget.onDeleteGeneratedImage != null)
                  _miniIconButton(
                    icon: Icons.delete_outline,
                    color: Colors.red.shade400,
                    onTap: () => widget.onDeleteGeneratedImage!(imageId),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// 小图标按钮（用于生图卡片右侧操作区）
  Widget _miniIconButton({
    required IconData icon,
    required VoidCallback onTap,
    Color? color,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(
            color: (color ?? AppTheme.textMuted).withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(icon, size: 14, color: color ?? AppTheme.textMuted),
        ),
      ),
    );
  }

  /// 弹出编辑提示词对话框 — 对照主项目 ImageGenCard editingPrompt 模式
  void _showEditPromptDialog(String imageId, String currentPrompt) {
    final controller = TextEditingController(text: currentPrompt);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          '查看 / 编辑提示词',
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
        ),
        content: TextField(
          controller: controller,
          maxLines: 6,
          style: TextStyle(
            fontSize: 12,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
          decoration: InputDecoration(
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            contentPadding: const EdgeInsets.all(12),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              widget.onEditImagePrompt?.call(imageId, controller.text);
              Navigator.pop(ctx);
            },
            child: const Text('保存'),
          ),
          TextButton(
            onPressed: () {
              final newPrompt = controller.text;
              widget.onEditImagePrompt?.call(imageId, newPrompt);
              Navigator.pop(ctx);
              // 保存并重新生成 — 在原位替换（传入 replaceImageId）
              widget.onGenerateImage?.call(prompt: newPrompt, replaceImageId: imageId);
            },
            child: const Text('保存并重新生成'),
          ),
        ],
      ),
    );
  }

  /// 取生图条目的稳定 ID：优先使用 `metadata.generatedImages[].id`，
  /// 旧数据缺失 id 时退化为本地 `path`，保证回调入参始终非空。
  String _resolveImageId(GeneratedImage image, String path) {
    if (image.id.isNotEmpty) return image.id;
    return path;
  }

  /// 单条生图条目 — 对照主项目 ImageGenCard（ready 状态）
  /// 按钮在图片右上角，桌面端 hover 显示，移动端常显示
  Widget _buildImageEntry({
    required GeneratedImage image,
    required String path,
    required String? activePrompt,
    required List<String>? versionPaths,
    required int? activeVersion,
  }) {
    final imageId = _resolveImageId(image, path);
    return ImageAttachment(
      imagePath: path,
      versionPaths: versionPaths,
      activeVersion: activeVersion,
      onRegenerate: widget.onRegenerateImage != null
          ? () => widget.onRegenerateImage!(path, prompt: activePrompt)
          : null,
      onEditPrompt: widget.onEditImagePrompt != null
          ? () => _showEditPromptDialog(imageId, activePrompt ?? '')
          : null,
      onDelete: widget.onDeleteGeneratedImage != null
          ? () => widget.onDeleteGeneratedImage!(imageId)
          : null,
      onDeleteCurrentVersion: widget.onDeleteGeneratedImageVersion == null
          ? null
          : (versionLocalPath) {
              widget.onDeleteGeneratedImageVersion!(imageId, versionLocalPath);
            },
      onConfirmVersion: (versionPaths != null && versionPaths.length > 1 && widget.onSetPrimaryImage != null)
          ? (versionIndex) => widget.onSetPrimaryImage!(imageId, versionIndex)
          : null,
    );
  }

  /// 长按生图卡片弹出底部操作菜单：当前仅提供「删除生图」入口。
  ///
  /// 风格沿用全局 `bottomSheetTheme`（透明背景 + 圆角面板），保持与
  /// 「更多」「会话设置」等已有底部菜单一致的视觉。
  // ignore: unused_element
  void _showImageContextMenu(String imageId) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.delete_outline),
                // TODO(parity): 主项目缺失 'image.delete' 键，硬编码兜底
                title: const Text('删除生图'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  widget.onDeleteGeneratedImage?.call(imageId);
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 版本信息
// ═══════════════════════════════════════════════════════════════

class _VersionInfo {
  final int total;
  final int active;
  const _VersionInfo({required this.total, required this.active});
}

// ═══════════════════════════════════════════════════════════════
// meta 行操作按钮
// ═══════════════════════════════════════════════════════════════

class _AttachmentDeleteButton extends StatelessWidget {
  final VoidCallback onTap;

  const _AttachmentDeleteButton({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 18,
        height: 18,
        decoration: BoxDecoration(
          color: Colors.red[400],
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.close,
          size: 12,
          color: Colors.white,
        ),
      ),
    );
  }
}

class _MetaButton extends StatefulWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool isUser;
  /// 是否为移动端模式（触摸目标 ≥ 44×44）
  final bool isMobile;

  const _MetaButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    required this.isUser,
    this.isMobile = false,
  });

  @override
  State<_MetaButton> createState() => _MetaButtonState();
}

class _MetaButtonState extends State<_MetaButton> {
  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final base = widget.isUser
        ? Colors.white.withValues(alpha: 0.6)
        : (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted)
            .withValues(alpha: 0.5);
    final hoverColor = widget.isUser
        ? Colors.white
        : (isDark ? AppTheme.darkAccent : AppTheme.textSecondary);
    final hoverBg = widget.isUser
        ? Colors.white.withValues(alpha: 0.2)
        : (isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.3)
            : Colors.black.withValues(alpha: 0.05));

    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: HoverBuilder(
        builder: (isHovering) => GestureDetector(
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            alignment: Alignment.center,
            // 主项目对照：rounded-lg p-1.5（无最小宽高强制），按钮挨着排列
            // 移除原先 ConstrainedBox(minWidth/minHeight: 36) 与 horizontal margin
            padding: const EdgeInsets.all(6), // p-1.5 ≈ 6px
            decoration: BoxDecoration(
              color: isHovering ? hoverBg : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(
              widget.icon,
              size: 14, // h-3.5 w-3.5 ≈ 14px
              color: isHovering ? hoverColor : base,
            ),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 版本切换小按钮
// ═══════════════════════════════════════════════════════════════

class _VersionButton extends StatefulWidget {
  final IconData icon;
  final Color color;
  final VoidCallback? onTap;
  final bool isUser;

  const _VersionButton({
    required this.icon,
    required this.color,
    required this.onTap,
    required this.isUser,
  });

  @override
  State<_VersionButton> createState() => _VersionButtonState();
}

class _VersionButtonState extends State<_VersionButton> {
  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isMobile = AppBreakpoints.isMobile(MediaQuery.of(context).size.width);
    final hoverBg = widget.isUser
        ? Colors.white.withValues(alpha: 0.2)
        : (isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.3)
            : Colors.black.withValues(alpha: 0.05));

    return HoverBuilder(
      cursor: widget.onTap != null
          ? SystemMouseCursors.click
          : SystemMouseCursors.basic,
      builder: (isHovering) => GestureDetector(
        onTap: widget.onTap,
        child: ConstrainedBox(
          constraints: isMobile
              ? const BoxConstraints(
                  minWidth: kMinTouchTargetSize,
                  minHeight: kMinTouchTargetSize,
                )
              : const BoxConstraints(),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            alignment: Alignment.center,
            padding: EdgeInsets.symmetric(
              horizontal: isMobile ? 12 : 4,
              vertical: isMobile ? 12 : 2,
            ),
            decoration: BoxDecoration(
              color: isHovering && widget.onTap != null
                  ? hoverBg
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Icon(widget.icon, size: isMobile ? 18 : 16, color: widget.color),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 总结消息卡片 — 复刻原版 SummaryCard
// ═══════════════════════════════════════════════════════════════

class _SummaryCard extends ConsumerWidget {
  final Message message;
  final bool showTimestamps;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;

  const _SummaryCard({
    required this.message,
    required this.showTimestamps,
    this.onEdit,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final lang = ref.watch(localeProvider).languageCode;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Column(
        children: [
          // 分隔线 + 标签
          Row(
            children: [
              Expanded(
                child: Container(
                  height: 1,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        AppTheme.accent.withValues(alpha: 0),
                        AppTheme.accent.withValues(alpha: 0.3),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: AppTheme.accent.withValues(alpha: 0.06),
                  border: Border.all(
                    color: AppTheme.accent.withValues(alpha: 0.20),
                  ),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.auto_awesome,
                      size: 12,
                      color: AppTheme.accentDark,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      I18n.t('chat.summaryLabel', lang: lang),
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: AppTheme.accentDark,
                      ),
                    ),
                  ],
                ),
              ),
              if (onEdit != null) ...[
                const SizedBox(width: 4),
                IconButton(
                  onPressed: onEdit,
                  iconSize: 13,
                  padding: const EdgeInsets.all(4),
                  constraints: const BoxConstraints(
                      minWidth: 24, minHeight: 24),
                  icon: Icon(
                    Icons.edit_outlined,
                    // 暗色模式适配：使用 darkTextSecondary
                    color: (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted)
                        .withValues(alpha: 0.5),
                  ),
                ),
              ],
              if (onDelete != null)
                IconButton(
                  onPressed: onDelete,
                  iconSize: 13,
                  padding: const EdgeInsets.all(4),
                  constraints: const BoxConstraints(
                      minWidth: 24, minHeight: 24),
                  icon: Icon(
                    Icons.delete_outline,
                    // 暗色模式适配：使用 darkTextSecondary
                    color: (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted)
                        .withValues(alpha: 0.5),
                  ),
                ),
              const SizedBox(width: 12),
              Expanded(
                child: Container(
                  height: 1,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        AppTheme.accent.withValues(alpha: 0.3),
                        AppTheme.accent.withValues(alpha: 0),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // 内容卡片
          Container(
            width: double.infinity,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  AppTheme.accent.withValues(alpha: 0.05),
                  AppTheme.accentLight.withValues(alpha: 0.08),
                ],
              ),
              border: Border.all(
                color: AppTheme.accent.withValues(alpha: 0.15),
              ),
              borderRadius: BorderRadius.circular(20),
            ),
            padding:
                const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  I18n.t('chat.summaryHint', lang: lang),
                  style: TextStyle(
                    fontSize: 11,
                    // 暗色模式适配：使用 darkTextSecondary
                    color: (isDark ? AppTheme.darkTextSecondary : AppTheme.textMuted)
                        .withValues(alpha: 0.7),
                  ),
                ),
                const SizedBox(height: 10),
                MarkdownBody(
                  data: message.content,
                  selectable: true,
                  styleSheet: MarkdownStyleSheet(
                    p: TextStyle(
                      fontSize: 13,
                      height: 1.75,
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 三点跳动动画（生图占位卡片用）
// ═══════════════════════════════════════════════════════════════

class _TypingDot extends StatefulWidget {
  final int delay;
  const _TypingDot({required this.delay});

  @override
  State<_TypingDot> createState() => _TypingDotState();
}

class _TypingDotState extends State<_TypingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _animation = Tween<double>(begin: 0.3, end: 1.0).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
    Future.delayed(Duration(milliseconds: widget.delay), () {
      if (mounted) _controller.repeat(reverse: true);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) => Opacity(
        opacity: _animation.value,
        child: Container(
          width: 6,
          height: 6,
          decoration: const BoxDecoration(
            color: AppTheme.accent,
            shape: BoxShape.circle,
          ),
        ),
      ),
    );
  }
}
