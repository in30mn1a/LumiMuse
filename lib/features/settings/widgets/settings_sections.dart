import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/app_settings.dart';
import '../../../core/providers/api_provider_provider.dart';
import '../../../core/providers/database_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/providers/character_provider.dart';
import '../../../core/providers/conversation_provider.dart';
import '../../../core/providers/memory_provider.dart';
import '../../../core/services/llm_service.dart';
import '../../../core/services/maintenance_service.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import 'settings_form_widgets.dart';

double _parseDouble(String v) {
  final n = double.tryParse(v);
  return (n != null && n.isFinite) ? n : 0;
}

int _parseInt(String v) {
  final n = int.tryParse(v);
  return n ?? 0;
}

class OverviewSection extends ConsumerWidget {
  const OverviewSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    final lang = ref.watch(localeProvider).languageCode;

    final apiOn = settings.apiBase.isNotEmpty && settings.model.isNotEmpty;
    final memOn = settings.memoryInject || settings.memoryTriggerIntervalEnabled || settings.memoryTriggerTimeEnabled || settings.memoryTriggerKeywordEnabled;
    final maxInjectText = settings.limitInject
        ? settings.memoryMaxInject.toString()
        : '不限';

    return LumiSectionPanel(
      title: I18n.t('settings.overview', lang: lang),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final w = constraints.maxWidth;
          final cols = w >= 1100
              ? 4
              : w >= 720
                  ? 2
                  : 1;
          return SettingsGrid(
            columnCount: cols,
            spacing: 12,
            children: [
              SettingsStatTile(
                label: I18n.t('settings.apiStatus', lang: lang),
                value: apiOn
                    ? I18n.t('settings.connected', lang: lang)
                    : I18n.t('settings.notConfigured', lang: lang),
                hint: settings.model.isEmpty
                    ? I18n.t('settings.modelPlaceholder', lang: lang)
                    : settings.model,
              ),
              SettingsStatTile(
                label: I18n.t('settings.themeStatus', lang: lang),
                value: Theme.of(context).brightness == Brightness.dark
                    ? I18n.t('settings.themeDark', lang: lang)
                    : I18n.t('settings.themeLight', lang: lang),
                hint: I18n.t('settings.display', lang: lang),
              ),
              SettingsStatTile(
                label: I18n.t('settings.languageStatus', lang: lang),
                value: settings.language == 'zh' ? '中文' : 'English',
                hint: I18n.t('settings.display', lang: lang),
              ),
              SettingsStatTile(
                label: I18n.t('settings.memoryStatus', lang: lang),
                value: memOn
                    ? I18n.t('settings.connected', lang: lang)
                    : I18n.t('settings.notConfigured', lang: lang),
                hint:
                    '$maxInjectText ${I18n.t('settings.maxMemoriesInject', lang: lang)}',
              ),
            ],
          );
        },
      ),
    );
  }
}

/// 供应商管理区块 — 对照主项目 settings/page.tsx 的 providerManage section
class ProviderManageSection extends ConsumerStatefulWidget {
  const ProviderManageSection({super.key});

  @override
  ConsumerState<ProviderManageSection> createState() =>
      _ProviderManageSectionState();
}

class _ProviderManageSectionState
    extends ConsumerState<ProviderManageSection> {
  Map<String, dynamic>? _editingProvider;

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final providers = ref.watch(apiProviderListProvider).valueOrNull ?? [];
    final activeId = ref.watch(activeProviderIdProvider);
    final borderLight =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;
    final accentDark =
        isDark ? AppTheme.darkAccentDark : AppTheme.accentDark;

    return LumiSectionPanel(
      title: I18n.t('settings.providerManage', lang: lang),
      actions: [
        if (activeId.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: LumiSoftButton(
              kind: LumiSoftButtonKind.secondary,
              label: I18n.t('settings.providerUpdateCurrent', lang: lang),
              onTap: () => ref
                  .read(apiProviderListProvider.notifier)
                  .updateCurrentProvider(),
              tiny: true,
            ),
          ),
        LumiSoftButton(
          kind: LumiSoftButtonKind.primary,
          label: I18n.t('settings.providerSaveCurrent', lang: lang),
          onTap: _handleSaveCurrentAsProvider,
          tiny: true,
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (providers.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                I18n.t('settings.providerEmpty', lang: lang),
                style: TextStyle(
                  fontSize: 14,
                  color: isDark
                      ? AppTheme.darkTextMuted
                      : AppTheme.textMuted,
                ),
              ),
            )
          else
            ...providers.map((p) => _buildProviderCard(
                  p, activeId, isDark, lang, borderLight, accentDark)),
          if (_editingProvider != null)
            _buildEditForm(isDark, lang, borderLight),
        ],
      ),
    );
  }

  Widget _buildProviderCard(
    ApiProviderData p,
    String activeId,
    bool isDark,
    String lang,
    Color borderLight,
    Color accentDark,
  ) {
    final isActive = p.id == activeId;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: isActive
            ? AppTheme.accent.withValues(alpha: 0.08)
            : (isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.5)
                : Colors.white.withValues(alpha: 0.7)),
        border: Border.all(
          color: isActive
              ? AppTheme.accent.withValues(alpha: 0.3)
              : borderLight,
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      p.name,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                    if (isActive) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppTheme.accent.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          I18n.t('settings.providerActive', lang: lang),
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w500,
                            color: accentDark,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  '${p.apiBase} · ${p.model.isNotEmpty ? p.model : I18n.t('settings.modelPlaceholder', lang: lang)}',
                  style: TextStyle(
                    fontSize: 12,
                    color: isDark
                        ? AppTheme.darkTextMuted
                        : AppTheme.textMuted,
                  ),
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                ),
              ],
            ),
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!isActive)
                LumiSoftButton(
                  kind: LumiSoftButtonKind.primary,
                  label: I18n.t('settings.providerSwitch', lang: lang),
                  onTap: () => ref
                      .read(apiProviderListProvider.notifier)
                      .activateProvider(p.id),
                  tiny: true,
                ),
              const SizedBox(width: 6),
              LumiSoftButton(
                kind: LumiSoftButtonKind.secondary,
                label: I18n.t('common.edit', lang: lang),
                onTap: () => setState(() {
                  _editingProvider = {
                    'id': p.id,
                    'name': p.name,
                    'api_base': p.apiBase,
                    'api_key': p.apiKey,
                    'model': p.model,
                    'temperature': p.temperature,
                    'max_tokens': p.maxTokens,
                    'context_window': p.contextWindow,
                    'json_mode': p.jsonMode,
                  };
                }),
                tiny: true,
              ),
              const SizedBox(width: 6),
              LumiSoftButton(
                kind: LumiSoftButtonKind.danger,
                label: I18n.t('common.delete', lang: lang),
                onTap: () => _handleDeleteProvider(p.id, lang),
                tiny: true,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEditForm(bool isDark, String lang, Color borderLight) {
    final ep = _editingProvider!;
    final isEdit = ep['id'] != null && (ep['id'] as String).isNotEmpty;
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.6)
            : Colors.white.withValues(alpha: 0.8),
        border: Border.all(
            color: AppTheme.accent.withValues(alpha: 0.2)),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            isEdit
                ? I18n.t('settings.providerEdit', lang: lang)
                : I18n.t('settings.providerNew', lang: lang),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: isDark
                  ? AppTheme.darkTextPrimary
                  : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 12),
          _editField(
            isDark: isDark,
            label: I18n.t('settings.providerName', lang: lang),
            value: ep['name'] ?? '',
            placeholder: 'OpenAI',
            onChanged: (v) => setState(() {
              _editingProvider = {..._editingProvider!, 'name': v};
            }),
          ),
          const SizedBox(height: 12),
          _editField(
            isDark: isDark,
            label: I18n.t('settings.apiBase', lang: lang),
            value: ep['api_base'] ?? '',
            placeholder: 'https://api.openai.com/v1',
            onChanged: (v) => setState(() {
              _editingProvider = {..._editingProvider!, 'api_base': v};
            }),
          ),
          const SizedBox(height: 12),
          _editField(
            isDark: isDark,
            label: I18n.t('settings.apiKey', lang: lang),
            value: ep['api_key'] ?? '',
            obscure: true,
            onChanged: (v) => setState(() {
              _editingProvider = {..._editingProvider!, 'api_key': v};
            }),
          ),
          const SizedBox(height: 12),
          _editField(
            isDark: isDark,
            label: I18n.t('settings.model', lang: lang),
            value: ep['model'] ?? '',
            placeholder: I18n.t('settings.modelPlaceholder', lang: lang),
            onChanged: (v) => setState(() {
              _editingProvider = {..._editingProvider!, 'model': v};
            }),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              LumiSoftButton(
                kind: LumiSoftButtonKind.primary,
                label: I18n.t('common.save', lang: lang),
                onTap: _handleSaveProvider,
                tiny: true,
              ),
              const SizedBox(width: 8),
              LumiSoftButton(
                kind: LumiSoftButtonKind.secondary,
                label: I18n.t('common.cancel', lang: lang),
                onTap: () => setState(() => _editingProvider = null),
                tiny: true,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _editField({
    required bool isDark,
    required String label,
    required String value,
    String? placeholder,
    bool obscure = false,
    required ValueChanged<String> onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w500,
            color: isDark
                ? AppTheme.darkTextSecondary
                : AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 6),
        Container(
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.7)
                : Colors.white.withValues(alpha: 0.86),
            border: Border.all(
              color: isDark
                  ? AppTheme.darkBorderLight
                  : AppTheme.borderLight,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: TextFormField(
            initialValue: value,
            obscureText: obscure,
            onChanged: onChanged,
            style: TextStyle(
              fontSize: 14,
              color: isDark
                  ? AppTheme.darkTextPrimary
                  : AppTheme.textPrimary,
            ),
            decoration: InputDecoration(
              hintText: placeholder,
              hintStyle: TextStyle(
                fontSize: 13,
                color: (isDark
                        ? AppTheme.darkTextMuted
                        : AppTheme.textMuted)
                    .withValues(alpha: 0.7),
              ),
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12, vertical: 10),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _handleSaveCurrentAsProvider() async {
    final lang = ref.read(localeProvider).languageCode;
    final name = await _showNamePrompt(
      I18n.t('settings.providerNamePrompt', lang: lang),
    );
    if (name == null || name.trim().isEmpty) return;
    try {
      await ref
          .read(apiProviderListProvider.notifier)
          .saveCurrentAsProvider(name.trim());
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('保存失败: $e')),
        );
      }
    }
  }

  Future<void> _handleDeleteProvider(String id, String lang) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(I18n.t('settings.providerDeleteConfirm', lang: lang)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(I18n.t('common.cancel', lang: lang)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(I18n.t('common.delete', lang: lang)),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(apiProviderListProvider.notifier).deleteProvider(id);
    }
  }

  Future<void> _handleSaveProvider() async {
    final ep = _editingProvider;
    if (ep == null) return;
    final isEdit = ep['id'] != null && (ep['id'] as String).isNotEmpty;

    if (isEdit) {
      await ref.read(apiProviderListProvider.notifier).updateProvider(
            ApiProviderData(
              id: ep['id'] as String,
              name: ep['name'] as String? ?? 'Provider',
              apiBase: ep['api_base'] as String? ?? '',
              apiKey: ep['api_key'] as String? ?? '',
              model: ep['model'] as String? ?? '',
              temperature:
                  (ep['temperature'] as num?)?.toDouble() ?? 1.0,
              maxTokens: ep['max_tokens'] as int? ?? 4096,
              contextWindow: ep['context_window'] as int? ?? 131072,
              jsonMode: ep['json_mode'] as bool? ?? false,
              createdAt: DateTime.now(),
            ),
          );
    } else {
      await ref
          .read(apiProviderListProvider.notifier)
          .saveCurrentAsProvider(ep['name'] as String? ?? 'Provider');
    }
    setState(() => _editingProvider = null);
  }

  Future<String?> _showNamePrompt(String title) async {
    final controller = TextEditingController();
    try {
      return await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(title),
          content: TextField(
            controller: controller,
            autofocus: true,
            decoration: const InputDecoration(hintText: 'OpenAI'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(ctx, controller.text),
              child: const Text('确定'),
            ),
          ],
        ),
      );
    } finally {
      controller.dispose();
    }
  }
}

class ApiSection extends ConsumerStatefulWidget {
  const ApiSection({super.key});

  @override
  ConsumerState<ApiSection> createState() => _ApiSectionState();
}

class _ApiSectionState extends ConsumerState<ApiSection> {
  final _apiBaseController = TextEditingController();
  final _apiKeyController = TextEditingController();
  final _modelController = TextEditingController();

  bool _loaded = false;
  List<String> _availableModels = [];
  bool _loadingModels = false;
  String? _modelError;

  @override
  void initState() {
    super.initState();
    // P1-15：监听外部 settings 变化，按需更新 controller（避免覆盖光标）
    ref.listenManual<AsyncValue<AppSettings>>(settingsProvider, (prev, next) {
      final settings = next.valueOrNull;
      if (settings == null) return;
      if (_apiBaseController.text != settings.apiBase) {
        _apiBaseController.text = settings.apiBase;
      }
      if (_apiKeyController.text != settings.apiKey) {
        _apiKeyController.text = settings.apiKey;
      }
      if (_modelController.text != settings.model) {
        _modelController.text = settings.model;
      }
    });
  }

  @override
  void dispose() {
    _apiBaseController.dispose();
    _apiKeyController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  void _loadControllers(AppSettings settings) {
    if (_loaded) return;
    _apiBaseController.text = settings.apiBase;
    _apiKeyController.text = settings.apiKey;
    _modelController.text = settings.model;
    _loaded = true;
  }

  Future<void> _updateSetting(String key, dynamic value) async {
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  Future<void> _fetchModels() async {
    setState(() {
      _loadingModels = true;
      _modelError = null;
    });
    try {
      final llm = LlmService();
      final models = await llm.fetchModels(
        apiBase: _apiBaseController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
      );
      setState(() => _availableModels = models);
      if (models.isEmpty) {
        setState(() => _modelError = '未获取到模型，请检查 API 配置');
      }
    } catch (e) {
      setState(() => _modelError = '$e');
    } finally {
      if (mounted) setState(() => _loadingModels = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    _loadControllers(settings);
    final lang = ref.watch(localeProvider).languageCode;

    return LumiSectionPanel(
      title: I18n.t('settings.api', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsLabeledField(
            label: I18n.t('settings.apiBase', lang: lang),
            child: SettingsRichInput(
              controller: _apiBaseController,
              hint: I18n.t('settings.apiBasePlaceholder', lang: lang),
              onChanged: (v) => _updateSetting('api_base', v),
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          SettingsLabeledField(
            label: I18n.t('settings.apiKey', lang: lang),
            hintBelow: I18n.t('settings.apiKeyHint', lang: lang),
            child: SettingsRichInput(
              controller: _apiKeyController,
              obscure: true,
              onChanged: (v) => _updateSetting('api_key', v),
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          SettingsLabeledField(
            label: I18n.t('settings.model', lang: lang),
            child: LayoutBuilder(
              builder: (ctx, constraints) {
                final wide = constraints.maxWidth >= 480;
                final modelInput = _availableModels.isNotEmpty
                    ? SettingsRichSelect<String?>(
                        value: _availableModels
                                .contains(_modelController.text)
                            ? _modelController.text
                            : null,
                        items: [
                          SettingsRichSelectItem<String?>(
                            value: null,
                            label:
                                I18n.t('settings.modelPlaceholder', lang: lang),
                          ),
                          ..._availableModels.map(
                            (m) =>
                                SettingsRichSelectItem<String?>(value: m, label: m),
                          ),
                        ],
                        onChanged: (v) {
                          _modelController.text = v ?? '';
                          _updateSetting('model', v ?? '');
                        },
                      )
                    : SettingsRichInput(
                        controller: _modelController,
                        hint:
                            I18n.t('settings.modelPlaceholder', lang: lang),
                        onChanged: (v) => _updateSetting('model', v),
                      );
                final fetchBtn = LumiSoftButton(
                  label: _loadingModels
                      ? I18n.t('common.loading', lang: lang)
                      : I18n.t('settings.fetchModels', lang: lang),
                  kind: LumiSoftButtonKind.secondary,
                  onTap: _loadingModels ? null : _fetchModels,
                );
                if (wide) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(child: modelInput),
                          const SizedBox(width: AppSpacing.sm),
                          fetchBtn,
                        ],
                      ),
                      if (_modelError != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          _modelError!,
                          style: const TextStyle(
                            fontSize: 12,
                            color: Color(0xFFEF4444),
                          ),
                        ),
                      ],
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    modelInput,
                    const SizedBox(height: 8),
                    Align(alignment: Alignment.centerLeft, child: fetchBtn),
                    if (_modelError != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        _modelError!,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Color(0xFFEF4444),
                        ),
                      ),
                    ],
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          SettingsCheckboxRow(
            checked: settings.jsonMode,
            label: I18n.t('settings.jsonMode', lang: lang),
            hintBelow: I18n.t('settings.jsonModeHint', lang: lang),
            onChanged: (v) => _updateSetting('json_mode', v),
          ),
        ],
      ),
    );
  }
}

class ModelSection extends ConsumerStatefulWidget {
  const ModelSection({super.key});

  @override
  ConsumerState<ModelSection> createState() => _ModelSectionState();
}

class _ModelSectionState extends ConsumerState<ModelSection> {
  final _temperatureController = TextEditingController();
  final _maxTokensController = TextEditingController();
  final _contextWindowController = TextEditingController();

  bool _loaded = false;

  @override
  void dispose() {
    _temperatureController.dispose();
    _maxTokensController.dispose();
    _contextWindowController.dispose();
    super.dispose();
  }

  void _loadControllers(AppSettings settings) {
    if (_loaded) return;
    _temperatureController.text = settings.temperature.toString();
    _maxTokensController.text = settings.maxTokens.toString();
    _contextWindowController.text = settings.contextWindow.toString();
    _loaded = true;
  }

  Future<void> _updateSetting(String key, dynamic value) async {
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    _loadControllers(settings);
    final lang = ref.watch(localeProvider).languageCode;

    return LumiSectionPanel(
      title: I18n.t('settings.modelParams', lang: lang),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final cols = constraints.maxWidth >= 720 ? 3 : 1;
          return SettingsGrid(
            columnCount: cols,
            spacing: 16,
            children: [
              SettingsLabeledField(
                label: I18n.t('settings.temperature', lang: lang),
                child: SettingsRichInput(
                  controller: _temperatureController,
                  numberMode: true,
                  onChanged: (v) =>
                      _updateSetting('temperature', _parseDouble(v)),
                ),
              ),
              SettingsLabeledField(
                label: I18n.t('settings.maxTokens', lang: lang),
                child: SettingsRichInput(
                  controller: _maxTokensController,
                  numberMode: true,
                  onChanged: (v) => _updateSetting('max_tokens', _parseInt(v)),
                ),
              ),
              SettingsLabeledField(
                label: I18n.t('settings.contextWindow', lang: lang),
                child: SettingsRichInput(
                  controller: _contextWindowController,
                  numberMode: true,
                  onChanged: (v) =>
                      _updateSetting('context_window', _parseInt(v)),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class ChatBehaviorSection extends ConsumerWidget {
  const ChatBehaviorSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    final lang = ref.watch(localeProvider).languageCode;

    Future<void> updateSetting(String key, dynamic value) async {
      await ref.read(settingsProvider.notifier).updateSetting(key, value);
    }

    return LumiSectionPanel(
      title: I18n.t('settings.chatBehavior', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsCheckboxRow(
            checked: settings.streaming,
            label: I18n.t('settings.streaming', lang: lang),
            onChanged: (v) => updateSetting('streaming', v),
          ),
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.exampleDialogue,
            label: I18n.t('settings.exampleDialogue', lang: lang),
            onChanged: (v) => updateSetting('example_dialogue', v),
          ),
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.showTimestamps,
            label: I18n.t('settings.showTimestamps', lang: lang),
            onChanged: (v) => updateSetting('show_timestamps', v),
          ),
        ],
      ),
    );
  }
}

class MemorySection extends ConsumerStatefulWidget {
  const MemorySection({super.key});

  @override
  ConsumerState<MemorySection> createState() => _MemorySectionState();
}

class _MemorySectionState extends ConsumerState<MemorySection> {
  final _memoryIntervalController = TextEditingController();
  final _memoryTriggerTimeHoursController = TextEditingController();
  final _memoryTriggerKeywordsController = TextEditingController();
  final _memoryMaxInjectController = TextEditingController();

  bool _loaded = false;

  @override
  void dispose() {
    _memoryIntervalController.dispose();
    _memoryTriggerTimeHoursController.dispose();
    _memoryTriggerKeywordsController.dispose();
    _memoryMaxInjectController.dispose();
    super.dispose();
  }

  void _loadControllers(AppSettings settings) {
    if (_loaded) return;
    _memoryIntervalController.text = settings.memoryInterval.toString();
    _memoryTriggerTimeHoursController.text =
        settings.memoryTriggerTimeHours.toString();
    _memoryTriggerKeywordsController.text = settings.memoryTriggerKeywords;
    _memoryMaxInjectController.text = settings.memoryMaxInject.toString();
    _loaded = true;
  }

  Future<void> _updateSetting(String key, dynamic value) async {
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    _loadControllers(settings);
    final lang = ref.watch(localeProvider).languageCode;

    return LumiSectionPanel(
      title: I18n.t('settings.memoryEngine', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsCheckboxRow(
            checked: settings.memoryTriggerIntervalEnabled,
            label: I18n.t('settings.triggerInterval', lang: lang),
            onChanged: (v) =>
                _updateSetting('memory_trigger_interval_enabled', v),
          ),
          if (settings.memoryTriggerIntervalEnabled) ...[
            const SizedBox(height: 12),
            SettingsConditionalNumberInput(
              label: I18n.t('settings.extractionInterval', lang: lang),
              controller: _memoryIntervalController,
              onChanged: (v) => _updateSetting('memory_interval', _parseInt(v)),
            ),
          ],
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.memoryTriggerTimeEnabled,
            label: I18n.t('settings.triggerTime', lang: lang),
            onChanged: (v) =>
                _updateSetting('memory_trigger_time_enabled', v),
          ),
          if (settings.memoryTriggerTimeEnabled) ...[
            const SizedBox(height: 12),
            SettingsConditionalNumberInput(
              label: I18n.t('settings.triggerTimeMinutes', lang: lang),
              controller: _memoryTriggerTimeHoursController,
              onChanged: (v) =>
                  _updateSetting('memory_trigger_time_hours', _parseInt(v)),
            ),
          ],
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.memoryTriggerKeywordEnabled,
            label: I18n.t('settings.triggerKeyword', lang: lang),
            onChanged: (v) =>
                _updateSetting('memory_trigger_keyword_enabled', v),
          ),
          if (settings.memoryTriggerKeywordEnabled) ...[
            const SizedBox(height: 12),
            SettingsConditionalTextInput(
              label: I18n.t('settings.triggerKeywords', lang: lang),
              hint: I18n.t('settings.triggerKeywordsHint', lang: lang),
              controller: _memoryTriggerKeywordsController,
              placeholder: '晚安',
              onChanged: (v) => _updateSetting('memory_trigger_keywords', v),
            ),
          ],
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.memoryInject,
            label: I18n.t('settings.memoryInject', lang: lang),
            onChanged: (v) => _updateSetting('memory_inject', v),
          ),
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.limitInject,
            label: I18n.t('settings.limitInject', lang: lang),
            onChanged: (v) => _updateSetting('limit_inject', v),
          ),
          if (settings.limitInject) ...[
            const SizedBox(height: 12),
            SettingsConditionalNumberInput(
              label: I18n.t('settings.maxMemoriesInject', lang: lang),
              hint: I18n.t('settings.limitInjectHint', lang: lang),
              controller: _memoryMaxInjectController,
              onChanged: (v) =>
                  _updateSetting('memory_max_inject', _parseInt(v)),
            ),
          ],
        ],
      ),
    );
  }
}

class DisplaySection extends ConsumerWidget {
  const DisplaySection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    final lang = ref.watch(localeProvider).languageCode;

    Future<void> updateSetting(String key, dynamic value) async {
      await ref.read(settingsProvider.notifier).updateSetting(key, value);
    }

    return LumiSectionPanel(
      title: I18n.t('settings.display', lang: lang),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final wide = constraints.maxWidth >= 720;
          final themeBlock = SettingsLabeledFieldFramed(
            label: I18n.t('settings.theme', lang: lang),
            child: SettingsRichSelect<String>(
              value: settings.theme,
              items: [
                SettingsRichSelectItem(
                  value: 'light',
                  label: I18n.t('settings.themeLight', lang: lang),
                ),
                SettingsRichSelectItem(
                  value: 'dark',
                  label: I18n.t('settings.themeDark', lang: lang),
                ),
              ],
              onChanged: (v) => updateSetting('theme', v),
            ),
          );
          final langBlock = SettingsLabeledFieldFramed(
            label: I18n.t('settings.language', lang: lang),
            child: SettingsRichSelect<String>(
              value: settings.language,
              items: const [
                SettingsRichSelectItem(value: 'zh', label: '中文'),
                SettingsRichSelectItem(value: 'en', label: 'English'),
              ],
              onChanged: (v) => updateSetting('language', v),
            ),
          );
          if (wide) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: themeBlock),
                    const SizedBox(width: 16),
                    Expanded(child: langBlock),
                  ],
                ),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              themeBlock,
              const SizedBox(height: AppSpacing.lg),
              langBlock,
            ],
          );
        },
      ),
    );
  }
}

enum _MaintStatus { idle, checking, previewed, cleaning, done }

class MaintenanceSection extends ConsumerStatefulWidget {
  const MaintenanceSection({super.key});

  @override
  ConsumerState<MaintenanceSection> createState() => _MaintenanceSectionState();
}

class _MaintenanceSectionState extends ConsumerState<MaintenanceSection> {
  _MaintStatus _maintStatus = _MaintStatus.idle;
  int _maintPreviewCount = 0;
  int _maintCleanedCount = 0;
  Map<String, OrphanFileStats>? _maintPreviewFiles;
  CleanupResult? _cleanupResult;
  int _statsRefreshSeq = 0;

  Future<void> _maintPreview() async {
    setState(() => _maintStatus = _MaintStatus.checking);
    try {
      final db = ref.read(databaseProvider);
      final service = MaintenanceService(db);
      final result = await service.countOrphans();
      if (mounted) {
        setState(() {
          _maintPreviewCount = result.total;
          _maintPreviewFiles = result.orphanFiles;
          _maintStatus = _MaintStatus.previewed;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _maintStatus = _MaintStatus.idle);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  Future<void> _maintCleanup() async {
    setState(() => _maintStatus = _MaintStatus.cleaning);
    try {
      final db = ref.read(databaseProvider);
      final service = MaintenanceService(db);
      final result = await service.cleanOrphans();
      if (mounted) {
        setState(() {
          _cleanupResult = result;
          _maintCleanedCount = result.dbDeleted;
          _maintStatus = _MaintStatus.done;
          if (result.dbDeleted > 0 || result.fileResults.values.any((stat) => stat.deleted > 0)) {
            _statsRefreshSeq++;
          }
        });
        ref.invalidate(memoryListProvider);
        ref.invalidate(conversationListProvider);
        ref.invalidate(characterListProvider);
      }
    } catch (e) {
      if (mounted) {
        setState(() => _maintStatus = _MaintStatus.idle);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final running = _maintStatus == _MaintStatus.checking ||
        _maintStatus == _MaintStatus.cleaning;

    String? msg;
    String? subMsg;
    Color? msgColor;
    Color? subMsgColor;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    final totalOrphans = _maintPreviewCount;
    final hasFileOrphans = _maintPreviewFiles?.values.any((stat) => stat.orphanCount > 0) ?? false;

    if (running) {
      msg = I18n.t('settings.cleanupRunning', lang: lang);
      msgColor = mutedColor;
    } else if (_maintStatus == _MaintStatus.done) {
      final dbCount = _maintCleanedCount;
      final fileResults = _cleanupResult?.fileResults;
      final totalDeletedFiles = fileResults?.values.fold<int>(0, (sum, item) => sum + item.deleted) ?? 0;

      if (dbCount == 0 && totalDeletedFiles == 0) {
        msg = I18n.t('settings.cleanupClean', lang: lang);
        msgColor = mutedColor;
      } else {
        msg = I18n.tArgs(
          'settings.cleanupResult',
          {'count': dbCount},
          lang: lang,
        );
        msgColor = const Color(0xFF16A34A);

        if (fileResults != null) {
          final aDel = fileResults['avatars']?.deleted ?? 0;
          final atDel = fileResults['attachments']?.deleted ?? 0;
          final gDel = fileResults['generated']?.deleted ?? 0;
          if (aDel > 0 || atDel > 0 || gDel > 0) {
            subMsg = I18n.tArgs(
              'settings.cleanupFileResult',
              {'a': aDel, 'at': atDel, 'g': gDel},
              lang: lang,
            );
            subMsgColor = const Color(0xFF16A34A);
          }
        }
      }
    } else if (_maintStatus == _MaintStatus.previewed) {
      if (totalOrphans == 0 && !hasFileOrphans) {
        msg = I18n.t('settings.cleanupClean', lang: lang);
        msgColor = mutedColor;
      } else {
        msg = I18n.tArgs(
          'settings.cleanupPreview',
          {'count': totalOrphans},
          lang: lang,
        );
        msgColor = const Color(0xFFD97706);

        if (_maintPreviewFiles != null) {
          final av = _maintPreviewFiles!['avatars'];
          final att = _maintPreviewFiles!['attachments'];
          final gen = _maintPreviewFiles!['generated'];
          final avStr = '${av?.orphanCount ?? 0}/${av?.total ?? 0}';
          final attStr = '${att?.orphanCount ?? 0}/${att?.total ?? 0}';
          final genStr = '${gen?.orphanCount ?? 0}/${gen?.total ?? 0}';

          subMsg = I18n.tArgs(
            'settings.cleanupFilePreview',
            {'a': avStr, 'at': attStr, 'g': genStr},
            lang: lang,
          );
          subMsgColor = const Color(0xFFD97706);
        }
      }
    }

    return LumiSectionPanel(
      title: I18n.t('settings.maintenance', lang: lang),
      subtitle: I18n.t('settings.maintenanceHint', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DatabaseStatsView(key: ValueKey<int>(_statsRefreshSeq)),
          const SizedBox(height: AppSpacing.lg),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              LumiSoftButton(
                label: _maintStatus == _MaintStatus.checking
                    ? I18n.t('settings.cleanupRunning', lang: lang)
                    : I18n.t('settings.cleanupDryRun', lang: lang),
                kind: LumiSoftButtonKind.secondary,
                onTap: running ? null : _maintPreview,
              ),
              if (_maintStatus == _MaintStatus.previewed &&
                  (totalOrphans > 0 || hasFileOrphans))
                LumiSoftButton(
                  label: I18n.t('settings.cleanupConfirm', lang: lang),
                  kind: LumiSoftButtonKind.danger,
                  onTap: _maintCleanup,
                ),
              if (msg != null)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(msg, style: TextStyle(fontSize: 14, color: msgColor)),
                    if (subMsg != null) ...[
                      const SizedBox(height: 4),
                      Text(subMsg, style: TextStyle(fontSize: 13, color: subMsgColor)),
                    ],
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class DatabaseStatsView extends ConsumerStatefulWidget {
  const DatabaseStatsView({super.key});

  @override
  ConsumerState<DatabaseStatsView> createState() => _DatabaseStatsViewState();
}

class _DatabaseStatsViewState extends ConsumerState<DatabaseStatsView> {
  late Future<DatabaseStats> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<DatabaseStats> _load() async {
    final db = ref.read(databaseProvider);
    final service = MaintenanceService(db);
    return service.getDatabaseStats();
  }

  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 B';
    if (bytes < 1024) return '$bytes B';
    const kb = 1024;
    const mb = 1024 * 1024;
    if (bytes < mb) return '${(bytes / kb).toStringAsFixed(1)} KB';
    return '${(bytes / mb).toStringAsFixed(2)} MB';
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
    final secondaryColor =
        isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary;
    final primaryColor =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final borderColor =
        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight;

    return FutureBuilder<DatabaseStats>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              children: [
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 10),
                Text(
                  '正在读取数据库统计…',
                  style: TextStyle(fontSize: 13, color: mutedColor),
                ),
              ],
            ),
          );
        }
        if (snap.hasError) {
          // ignore: avoid_print
          print('[settings] getDatabaseStats 失败: ${snap.error}');
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              '无法读取数据库统计',
              style: TextStyle(fontSize: 13, color: mutedColor),
            ),
          );
        }
        final stats = snap.data;
        if (stats == null || stats.tables.isEmpty) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              '无法读取数据库统计',
              style: TextStyle(fontSize: 13, color: mutedColor),
            ),
          );
        }
        final entries = stats.tables.entries.toList()
          ..sort((a, b) {
            final cmp = b.value.compareTo(a.value);
            if (cmp != 0) return cmp;
            return a.key.compareTo(b.key);
          });

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '数据库统计',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: primaryColor,
                  ),
                ),
                Text(
                  '总大小 ${_formatBytes(stats.totalBytes)}',
                  style: TextStyle(fontSize: 12, color: secondaryColor),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkSurface.withValues(alpha: 0.5)
                    : Colors.white.withValues(alpha: 0.6),
                border: Border.all(color: borderColor),
                borderRadius: BorderRadius.circular(12),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Column(
                children: [
                  for (int i = 0; i < entries.length; i++) ...[
                    if (i > 0)
                      Divider(
                        height: 1,
                        color: borderColor.withValues(alpha: 0.5),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            entries[i].key,
                            style: TextStyle(
                              fontSize: 13,
                              color: secondaryColor,
                            ),
                          ),
                          Text(
                            '${entries[i].value}',
                            style: TextStyle(
                              fontSize: 13,
                              fontFeatures: const [
                                FontFeature.tabularFigures(),
                              ],
                              color: primaryColor,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  if (stats.imageCount > 0 || stats.attachmentCount > 0) ...[
                    Divider(
                      height: 1,
                      color: borderColor.withValues(alpha: 0.5),
                    ),
                    if (stats.imageCount > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              '生成图片',
                              style: TextStyle(
                                fontSize: 13,
                                color: secondaryColor,
                              ),
                            ),
                            Text(
                              '${stats.imageCount}（${stats.imageReadyCount} 完成${stats.imageFailedCount > 0 ? "，${stats.imageFailedCount} 失败" : ""}）',
                              style: TextStyle(
                                fontSize: 13,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                                color: primaryColor,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                    if (stats.attachmentCount > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              '消息附件',
                              style: TextStyle(
                                fontSize: 13,
                                color: secondaryColor,
                              ),
                            ),
                            Text(
                              '${stats.attachmentCount}',
                              style: TextStyle(
                                fontSize: 13,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                                color: primaryColor,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}
