import 'package:flutter/material.dart';

import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';
import 'avatar_upload_widget.dart';

Widget _sectionPanel({
  required bool isDark,
  required String title,
  required Widget child,
}) {
  return Container(
    decoration: AppSurfaces.panel(isDark: isDark),
    padding: const EdgeInsets.all(AppSpacing.xl),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.lg),
          child: Text(
            title,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
        ),
        child,
      ],
    ),
  );
}

Widget _richTextarea({
  required TextEditingController controller,
  required String hint,
  required int rows,
  required bool isDark,
  bool mono = false,
}) {
  return Container(
    decoration: BoxDecoration(
      color: isDark
          ? AppTheme.darkSurface.withValues(alpha: 0.7)
          : Colors.white.withValues(alpha: 0.86),
      border: Border.all(
        color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: AppRadius.mdBorder,
    ),
    padding: const EdgeInsets.symmetric(horizontal: 15, vertical: AppSpacing.sm),
    child: TextField(
      controller: controller,
      minLines: rows,
      maxLines: rows + 4,
      style: TextStyle(
        fontSize: 14,
        height: 1.55,
        fontFamily: mono ? 'monospace' : null,
        color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
      ),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(
          fontSize: 13,
          fontFamily: mono ? 'monospace' : null,
          color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
              .withValues(alpha: 0.7),
        ),
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      ),
    ),
  );
}

Widget _richInput({
  required TextEditingController controller,
  required String hint,
  required bool isDark,
  ValueChanged<String>? onChanged,
}) {
  return Container(
    decoration: BoxDecoration(
      color: isDark
          ? AppTheme.darkSurface.withValues(alpha: 0.7)
          : Colors.white.withValues(alpha: 0.86),
      border: Border.all(
        color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
      ),
      borderRadius: AppRadius.mdBorder,
    ),
    child: TextField(
      controller: controller,
      onChanged: onChanged,
      style: TextStyle(
        fontSize: 15,
        height: 1.5,
        color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
      ),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(
          fontSize: 14,
          color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
              .withValues(alpha: 0.7),
        ),
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 15, vertical: AppSpacing.md),
        isDense: false,
      ),
    ),
  );
}

Widget _sectionLabel(String label, bool isDark) {
  return Padding(
    padding: const EdgeInsets.only(left: AppSpacing.xs, bottom: AppSpacing.sm),
    child: Text(
      label,
      style: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w500,
        color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
      ),
    ),
  );
}

class IdentitySection extends StatelessWidget {
  final TextEditingController nameController;
  final String? avatarPath;
  final ValueChanged<String?> onAvatarChanged;
  final String lang;
  final bool isDark;

  const IdentitySection({
    super.key,
    required this.nameController,
    required this.avatarPath,
    required this.onAvatarChanged,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final mutedColor =
        isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;

    // macOS 无 Camera 实现，不显示拍照按钮（由 AvatarUploadWidget 内 _isMobilePlatform 控制）
    final avatar = AvatarUploadWidget(
      currentAvatarPath: avatarPath,
      characterName: nameController.text,
      onAvatarChanged: onAvatarChanged,
    );

    final nameField = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm, left: AppSpacing.xs),
          child: Text(
            I18n.t('editor.name', lang: lang),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: mutedColor,
            ),
          ),
        ),
        _richInput(
          controller: nameController,
          hint: I18n.t('editor.namePlaceholder', lang: lang),
          isDark: isDark,
        ),
      ],
    );

    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.identityInfo', lang: lang),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final wide = constraints.maxWidth >= 480;
          if (wide) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                avatar,
                const SizedBox(width: AppSpacing.lg),
                Expanded(child: nameField),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(child: avatar),
              const SizedBox(height: AppSpacing.lg),
              nameField,
            ],
          );
        },
      ),
    );
  }
}

class BasicInfoSection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const BasicInfoSection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.basicInfo', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.basicInfoPlaceholder', lang: lang),
        rows: 6,
        isDark: isDark,
      ),
    );
  }
}

class PersonalitySection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const PersonalitySection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.personality', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.personalityPlaceholder', lang: lang),
        rows: 6,
        isDark: isDark,
      ),
    );
  }
}

class ScenarioSection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const ScenarioSection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.scenario', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.scenarioPlaceholder', lang: lang),
        rows: 6,
        isDark: isDark,
      ),
    );
  }
}

class GreetingSection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const GreetingSection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.greeting', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.greetingPlaceholder', lang: lang),
        rows: 5,
        isDark: isDark,
      ),
    );
  }
}

class OtherInfoSection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const OtherInfoSection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.other', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.otherPlaceholder', lang: lang),
        rows: 6,
        isDark: isDark,
      ),
    );
  }
}

class ExampleDialogueSection extends StatelessWidget {
  final TextEditingController controller;
  final String lang;
  final bool isDark;

  const ExampleDialogueSection({
    super.key,
    required this.controller,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return _sectionPanel(
      isDark: isDark,
      title: I18n.t('editor.exampleDialogue', lang: lang),
      child: _richTextarea(
        controller: controller,
        hint: I18n.t('editor.dialoguePlaceholder', lang: lang),
        rows: 8,
        mono: true,
        isDark: isDark,
      ),
    );
  }
}

class AdvancedSettingsSection extends StatelessWidget {
  final TextEditingController systemPromptController;
  final TextEditingController imageTagsController;
  final TextEditingController userImageTagsController;
  final bool isExpanded;
  final VoidCallback onToggle;
  final String lang;
  final bool isDark;

  const AdvancedSettingsSection({
    super.key,
    required this.systemPromptController,
    required this.imageTagsController,
    required this.userImageTagsController,
    required this.isExpanded,
    required this.onToggle,
    required this.lang,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: AppSurfaces.panel(isDark: isDark),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          InkWell(
            onTap: onToggle,
            child: Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: AppSpacing.xl, vertical: AppSpacing.lg),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      I18n.t('editor.advanced', lang: lang),
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  AnimatedRotation(
                    turns: isExpanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 180),
                    child: Icon(
                      Icons.expand_more,
                      size: 20,
                      color: isDark
                          ? AppTheme.darkTextMuted
                          : AppTheme.textMuted,
                    ),
                  ),
                ],
              ),
            ),
          ),
          AnimatedCrossFade(
            crossFadeState: isExpanded
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 220),
            firstChild: const SizedBox(width: double.infinity),
            secondChild: Container(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: isDark
                        ? AppTheme.darkBorderLight
                        : AppTheme.borderLight,
                  ),
                ),
              ),
              padding: const EdgeInsets.fromLTRB(AppSpacing.xl, AppSpacing.lg, AppSpacing.xl, AppSpacing.xl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _sectionLabel(I18n.t('editor.systemPrompt', lang: lang), isDark),
                  const SizedBox(height: AppSpacing.sm),
                  _richTextarea(
                    controller: systemPromptController,
                    hint: I18n.t('editor.systemPromptPlaceholder', lang: lang),
                    rows: 8,
                    mono: true,
                    isDark: isDark,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _sectionLabel(I18n.t('editor.imageTags', lang: lang), isDark),
                  const SizedBox(height: AppSpacing.xs),
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm, left: AppSpacing.xs),
                    child: Text(
                      I18n.t('editor.imageTagsHint', lang: lang),
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.65,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                    ),
                  ),
                  _richTextarea(
                    controller: imageTagsController,
                    hint:
                        '1girl, 银发, 短发, 橙眼, 纤细...',
                    rows: 3,
                    mono: true,
                    isDark: isDark,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _sectionLabel(I18n.t('editor.userImageTags', lang: lang), isDark),
                  const SizedBox(height: AppSpacing.xs),
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm, left: AppSpacing.xs),
                    child: Text(
                      I18n.t('editor.userImageTagsHint', lang: lang),
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.65,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                    ),
                  ),
                  _richTextarea(
                    controller: userImageTagsController,
                    hint:
                        '1boy, black hair, brown eyes, glasses...',
                    rows: 3,
                    mono: true,
                    isDark: isDark,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
