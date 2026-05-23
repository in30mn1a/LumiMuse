import 'package:flutter/material.dart';

import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';

class SettingsLabeledField extends StatelessWidget {
  final String label;
  final Widget child;
  final String? hintBelow;

  const SettingsLabeledField({
    super.key,
    required this.label,
    required this.child,
    this.hintBelow,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8, left: 4),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary,
            ),
          ),
        ),
        child,
        if (hintBelow != null && hintBelow!.isNotEmpty) ...[
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Text(
              hintBelow!,
              style: TextStyle(
                fontSize: 12,
                height: 1.65,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class SettingsLabeledFieldFramed extends StatelessWidget {
  final String label;
  final Widget child;

  const SettingsLabeledFieldFramed({
    super.key,
    required this.label,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.5)
            : Colors.white.withValues(alpha: 0.7),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: AppRadius.mdBorder,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 14,
                color: isDark
                    ? AppTheme.darkTextSecondary
                    : AppTheme.textSecondary,
              ),
            ),
          ),
          child,
        ],
      ),
    );
  }
}

class SettingsRichInput extends StatelessWidget {
  final TextEditingController controller;
  final String? hint;
  final bool obscure;
  final bool numberMode;
  final ValueChanged<String>? onChanged;

  const SettingsRichInput({
    super.key,
    required this.controller,
    this.hint,
    this.obscure = false,
    this.numberMode = false,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
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
        obscureText: obscure,
        keyboardType: numberMode ? TextInputType.number : null,
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
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 15,
            vertical: 12,
          ),
          isDense: false,
        ),
      ),
    );
  }
}

class SettingsRichSelect<T> extends StatelessWidget {
  final T value;
  final List<SettingsRichSelectItem<T>> items;
  final ValueChanged<T> onChanged;

  const SettingsRichSelect({
    super.key,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.7)
            : Colors.white.withValues(alpha: 0.86),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: AppRadius.mdBorder,
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          isExpanded: true,
          value: items.any((it) => it.value == value) ? value : null,
          items: items
              .map((it) => DropdownMenuItem<T>(
                    value: it.value,
                    child: Text(
                      it.label,
                      style: TextStyle(
                        fontSize: 14,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                  ))
              .toList(),
          onChanged: (v) {
            if (v != null) onChanged(v);
          },
          icon: Icon(
            Icons.expand_more,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
      ),
    );
  }
}

class SettingsRichSelectItem<T> {
  final T value;
  final String label;
  const SettingsRichSelectItem({required this.value, required this.label});
}

class SettingsCheckboxRow extends StatelessWidget {
  final bool checked;
  final String label;
  final String? hintBelow;
  final ValueChanged<bool> onChanged;

  const SettingsCheckboxRow({
    super.key,
    required this.checked,
    required this.label,
    required this.onChanged,
    this.hintBelow,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(!checked),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.5)
                : Colors.white.withValues(alpha: 0.7),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
            borderRadius: AppRadius.mdBorder,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: Checkbox(
                      value: checked,
                      onChanged: (v) {
                        if (v != null) onChanged(v);
                      },
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      activeColor: AppTheme.accent,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 14,
                        color: isDark
                            ? AppTheme.darkTextSecondary
                            : AppTheme.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
              if (hintBelow != null && hintBelow!.isNotEmpty) ...[
                const SizedBox(height: 8),
                Padding(
                  padding: const EdgeInsets.only(left: 32),
                  child: Text(
                    hintBelow!,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.65,
                      color: isDark
                          ? AppTheme.darkTextMuted
                          : AppTheme.textMuted,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class SettingsConditionalNumberInput extends StatelessWidget {
  final String label;
  final String? hint;
  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  const SettingsConditionalNumberInput({
    super.key,
    required this.label,
    required this.controller,
    required this.onChanged,
    this.hint,
  });

  @override
  Widget build(BuildContext context) {
    return SettingsLabeledFieldFramed(
      label: label,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (hint != null && hint!.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                hint!,
                style: TextStyle(
                  fontSize: 12,
                  height: 1.65,
                  color: Theme.of(context).brightness == Brightness.dark
                      ? AppTheme.darkTextMuted
                      : AppTheme.textMuted,
                ),
              ),
            ),
          ],
          SettingsRichInput(
            controller: controller,
            numberMode: true,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class SettingsConditionalTextInput extends StatelessWidget {
  final String label;
  final String hint;
  final String placeholder;
  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  const SettingsConditionalTextInput({
    super.key,
    required this.label,
    required this.hint,
    required this.placeholder,
    required this.controller,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return SettingsLabeledFieldFramed(
      label: label,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              hint,
              style: TextStyle(
                fontSize: 12,
                height: 1.65,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ),
          SettingsRichInput(
            controller: controller,
            hint: placeholder,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class SettingsFontPickerRow extends StatelessWidget {
  final String current;
  final ValueChanged<String> onPick;
  final String lang;

  const SettingsFontPickerRow({
    super.key,
    required this.current,
    required this.onPick,
    required this.lang,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: SettingsFontPickerButton(
            kind: 'wenkai',
            label: '霞鹜文楷',
            previewFamily: 'LXGW WenKai Screen',
            hint: I18n.t('settings.fontWenkai', lang: lang),
            current: current,
            onPick: onPick,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: SettingsFontPickerButton(
            kind: 'system',
            label: '系统字体',
            previewFamily: 'PingFang SC',
            hint: I18n.t('settings.fontSystem', lang: lang),
            current: current,
            onPick: onPick,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: SettingsFontPickerButton(
            kind: 'serif',
            label: '衬线字体',
            previewFamily: 'Noto Serif SC',
            hint: I18n.t('settings.fontSerif', lang: lang),
            current: current,
            onPick: onPick,
          ),
        ),
      ],
    );
  }
}

class SettingsFontPickerButton extends StatefulWidget {
  final String kind;
  final String label;
  final String previewFamily;
  final String hint;
  final String current;
  final ValueChanged<String> onPick;

  const SettingsFontPickerButton({
    super.key,
    required this.kind,
    required this.label,
    required this.previewFamily,
    required this.hint,
    required this.current,
    required this.onPick,
  });

  @override
  State<SettingsFontPickerButton> createState() =>
      _SettingsFontPickerButtonState();
}

class _SettingsFontPickerButtonState extends State<SettingsFontPickerButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final selected = widget.current == widget.kind;

    final Color bg;
    final Color borderColor;
    final Color labelColor;
    if (selected) {
      borderColor = AppTheme.accent;
      bg = AppTheme.accent.withValues(alpha: 0.10);
      labelColor = isDark ? AppTheme.darkAccent : AppTheme.accentDark;
    } else if (_hover) {
      borderColor = AppTheme.accent.withValues(alpha: 0.40);
      bg = AppTheme.accent.withValues(alpha: 0.05);
      labelColor = isDark
          ? AppTheme.darkTextSecondary
          : AppTheme.textSecondary;
    } else {
      borderColor =
          isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
      bg = (isDark ? AppTheme.darkSurface : Colors.white)
          .withValues(alpha: 0.5);
      labelColor = isDark
          ? AppTheme.darkTextSecondary
          : AppTheme.textSecondary;
    }

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onPick(widget.kind),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: bg,
            border: Border.all(color: borderColor),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.label,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 16,
                  fontFamily: widget.previewFamily,
                  fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                  color: labelColor,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                widget.hint,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  color: isDark
                      ? AppTheme.darkTextMuted
                      : AppTheme.textMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class SettingsStatTile extends StatelessWidget {
  final String label;
  final String value;
  final String hint;

  const SettingsStatTile({
    super.key,
    required this.label,
    required this.value,
    required this.hint,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.50)
            : Colors.white.withValues(alpha: 0.72),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.5,
              color: isDark
                  ? AppTheme.darkTextSecondary
                  : AppTheme.textSecondary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color:
                  isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          Text(
            hint,
            style: TextStyle(
              fontSize: 12,
              color:
                  isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class SettingsGrid extends StatelessWidget {
  final int columnCount;
  final double spacing;
  final List<Widget> children;

  const SettingsGrid({
    super.key,
    required this.columnCount,
    required this.spacing,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    if (columnCount <= 1) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (int i = 0; i < children.length; i++) ...[
            if (i > 0) SizedBox(height: spacing),
            children[i],
          ],
        ],
      );
    }
    final rows = <Widget>[];
    for (int i = 0; i < children.length; i += columnCount) {
      final rowChildren = <Widget>[];
      for (int j = 0; j < columnCount; j++) {
        if (j > 0) rowChildren.add(SizedBox(width: spacing));
        if (i + j < children.length) {
          rowChildren.add(Expanded(child: children[i + j]));
        } else {
          rowChildren.add(const Expanded(child: SizedBox.shrink()));
        }
      }
      if (rows.isNotEmpty) rows.add(SizedBox(height: spacing));
      rows.add(Row(crossAxisAlignment: CrossAxisAlignment.start, children: rowChildren));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: rows,
    );
  }
}
