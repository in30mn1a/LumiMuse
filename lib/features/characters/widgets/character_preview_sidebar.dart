import 'dart:io';

import 'package:flutter/material.dart';

import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';
import 'avatar_upload_widget.dart';

String _truncate(String text, int maxLen) {
  if (text.length <= maxLen) return text;
  return '${text.substring(0, maxLen)}...';
}

BoxDecoration _statTile(bool isDark) => BoxDecoration(
      color: isDark
          ? AppTheme.darkSurface.withValues(alpha: 0.50)
          : Colors.white.withValues(alpha: 0.72),
      border: Border.all(
        color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: BorderRadius.circular(20),
    );

Widget _previewFallback(String? firstChar, bool isDark) {
  return Center(
    child: firstChar != null
        ? Text(
            firstChar,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
            ),
          )
        : Icon(
            Icons.person_rounded,
            size: 22,
            color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
          ),
  );
}

Widget _previewBubble({
  required String text,
  required bool isUser,
  required bool isDark,
}) {
  return Align(
    alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: double.infinity),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: isUser
              ? (isDark ? AppTheme.darkWarm100 : AppTheme.warm100)
              : (isDark ? AppTheme.darkAccent : AppTheme.accent)
                  .withValues(alpha: 0.10),
          borderRadius: AppRadius.mdBorder,
        ),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 14,
            height: 1.65,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
        ),
      ),
    ),
  );
}

class CharacterMiniCard extends StatelessWidget {
  final String name;
  final String? avatarPath;
  final String lang;
  final bool isDark;

  const CharacterMiniCard({
    super.key,
    required this.name,
    required this.avatarPath,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final firstChar = AvatarUploadWidgetState.extractFirstCharacter(name);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: 14),
      decoration: _statTile(isDark),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  AppTheme.accent.withValues(alpha: 0.15),
                  AppTheme.accentLight.withValues(alpha: 0.25),
                ],
              ),
              borderRadius: AppRadius.mdBorder,
            ),
            clipBehavior: Clip.antiAlias,
            child: avatarPath != null && avatarPath!.isNotEmpty
                ? Image.file(
                    File(avatarPath!),
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) =>
                        _previewFallback(firstChar, isDark),
                  )
                : _previewFallback(firstChar, isDark),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name.isEmpty
                      ? I18n.t('editor.namePlaceholder', lang: lang)
                      : name,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  I18n.t('editor.previewNote', lang: lang),
                  style: TextStyle(
                    fontSize: 12,
                    color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ChatMiniPreview extends StatelessWidget {
  final String name;
  final String greeting;
  final String lang;
  final bool isDark;

  const ChatMiniPreview({
    super.key,
    required this.name,
    required this.greeting,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final greetingText = greeting.trim().isEmpty
        ? '我会在这里陪着你。'
        : greeting.trim();
    final assistantText = _truncate(greetingText.replaceAll(RegExp(r'\s+'), ' '), 96);
    return Container(
      decoration: AppSurfaces.card(isDark: isDark),
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: Text(
              name.toUpperCase(),
              style: TextStyle(
                fontSize: 12,
                letterSpacing: 0.18 * 12,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ),
          _previewBubble(
            text: '我今天有点累，想听你慢慢说话。',
            isUser: true,
            isDark: isDark,
          ),
          const SizedBox(height: AppSpacing.md),
          _previewBubble(
            text: assistantText,
            isUser: false,
            isDark: isDark,
          ),
        ],
      ),
    );
  }
}

class SystemPromptMiniCard extends StatelessWidget {
  final String systemPrompt;
  final String lang;
  final bool isDark;

  const SystemPromptMiniCard({
    super.key,
    required this.systemPrompt,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final preview = _truncate(
      systemPrompt.trim().isEmpty
          ? I18n.t('editor.systemPromptPlaceholder', lang: lang)
          : systemPrompt.trim(),
      120,
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: 14),
      decoration: _statTile(isDark),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            I18n.t('editor.advanced', lang: lang),
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.5,
              color: isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            preview,
            style: TextStyle(
              fontSize: 14,
              height: 1.65,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}

class CharacterPreviewSidebar extends StatelessWidget {
  final String name;
  final String? avatarPath;
  final String greeting;
  final String systemPrompt;
  final String lang;
  final bool isDark;

  const CharacterPreviewSidebar({
    super.key,
    required this.name,
    required this.avatarPath,
    required this.greeting,
    required this.systemPrompt,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: AppSurfaces.panel(isDark: isDark),
      padding: const EdgeInsets.all(AppSpacing.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            I18n.t('editor.previewTitle', lang: lang),
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              height: 1.18,
              color: isDark
                  ? AppTheme.darkTextPrimary
                  : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            I18n.t('editor.previewSubtitle', lang: lang),
            style: TextStyle(
              fontSize: 13,
              height: 1.65,
              color: isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          CharacterMiniCard(
            name: name,
            avatarPath: avatarPath,
            lang: lang,
            isDark: isDark,
          ),
          const SizedBox(height: AppSpacing.md),
          ChatMiniPreview(
            name: name,
            greeting: greeting,
            lang: lang,
            isDark: isDark,
          ),
          const SizedBox(height: AppSpacing.md),
          SystemPromptMiniCard(
            systemPrompt: systemPrompt,
            lang: lang,
            isDark: isDark,
          ),
        ],
      ),
    );
  }
}
