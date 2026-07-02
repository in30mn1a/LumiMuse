import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/models/app_settings.dart';
import '../../../core/providers/api_provider_provider.dart';
import '../../../core/providers/database_provider.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/providers/character_provider.dart';
import '../../../core/providers/conversation_provider.dart';
import '../../../core/providers/llm_service_provider.dart';
import '../../../core/providers/memory_provider.dart';
import '../../../core/services/maintenance_service.dart';
import '../../../core/services/memory_archive_service.dart';
import '../../../core/services/memory_candidates_service.dart';
import '../../../core/services/memory_embedding_tasks_service.dart';
import '../../../core/services/memory_engine.dart';
import '../../../core/services/memory_profile_service.dart';
import '../../../core/services/secret_storage_service.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_spacing.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';
import 'settings_form_widgets.dart';

/// 过滤 LLM/HTTP 异常的对外文案：
/// - DioException 只露状态码，避免泄漏含 key 的完整 URL 与 stack；
/// - 其他异常：先替换 URL 与 key-like 长串，再截断长度——顺序反了会把
///   URL/Key 截成残段绕过正则，泄漏头部明文。
/// 文案通过 i18n 注入；[lang] 缺省为 zh，便于无上下文的简易调用。
String _sanitizeApiError(Object e, {String? lang}) {
  if (e is DioException) {
    final code = e.response?.statusCode;
    return I18n.tArgs('settings.connectFailed', {
      'code': code ?? I18n.t('settings.noResponse', lang: lang),
    }, lang: lang);
  }
  var msg = e.toString();
  // 先替换，再截断。
  msg = msg.replaceAll(RegExp(r'https?://[^\s]+'), '<URL>');
  msg = msg.replaceAll(RegExp(r'[A-Za-z0-9_\-]{24,}'), '<KEY>');
  if (msg.length > 200) msg = '${msg.substring(0, 200)}…';
  return msg;
}

class OverviewSection extends ConsumerWidget {
  const OverviewSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    final lang = ref.watch(localeProvider).languageCode;

    final apiOn = settings.apiBase.isNotEmpty && settings.model.isNotEmpty;
    final memOn =
        settings.memoryInject ||
        settings.memoryTriggerIntervalEnabled ||
        settings.memoryTriggerTimeEnabled ||
        settings.memoryTriggerKeywordEnabled;
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

class _ProviderManageSectionState extends ConsumerState<ProviderManageSection> {
  Map<String, dynamic>? _editingProvider;

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final providers = ref.watch(apiProviderListProvider).valueOrNull ?? [];
    final activeId = ref.watch(activeProviderIdProvider);
    final borderLight = isDark
        ? AppTheme.darkBorderLight
        : AppTheme.borderLight;
    final accentDark = isDark ? AppTheme.darkAccentDark : AppTheme.accentDark;

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
        mainAxisSize: MainAxisSize.min,
        children: [
          if (providers.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                I18n.t('settings.providerEmpty', lang: lang),
                style: TextStyle(
                  fontSize: 14,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
              ),
            )
          else
            ...providers.map(
              (p) => _buildProviderCard(
                p,
                activeId,
                isDark,
                lang,
                borderLight,
                accentDark,
              ),
            ),
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
                          horizontal: 8,
                          vertical: 2,
                        ),
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
                    color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
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
        border: Border.all(color: AppTheme.accent.withValues(alpha: 0.2)),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            isEdit
                ? I18n.t('settings.providerEdit', lang: lang)
                : I18n.t('settings.providerNew', lang: lang),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 12),
          _editField(
            fieldKey: 'name',
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
            fieldKey: 'api_base',
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
            fieldKey: 'api_key',
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
            fieldKey: 'model',
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
    required String fieldKey,
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
            color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 6),
        if (obscure)
          _SecretField(
            // 复用同一个 ValueKey 确保切换 provider 时清空内容。
            key: ValueKey('${_editingProvider?['id'] ?? 'new'}_$fieldKey'),
            initialValue: value,
            placeholder: placeholder,
            onChanged: onChanged,
          )
        else
          Container(
            decoration: BoxDecoration(
              color: isDark
                  ? AppTheme.darkSurface.withValues(alpha: 0.7)
                  : Colors.white.withValues(alpha: 0.86),
              border: Border.all(
                color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
              ),
              borderRadius: BorderRadius.circular(12),
            ),
            child: TextFormField(
              key: ValueKey('${_editingProvider?['id'] ?? 'new'}_$fieldKey'),
              initialValue: value,
              obscureText: obscure,
              onChanged: onChanged,
              style: TextStyle(
                fontSize: 14,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: placeholder,
                hintStyle: TextStyle(
                  fontSize: 13,
                  color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                      .withValues(alpha: 0.7),
                ),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
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
          SnackBar(
            content: Text(
              '${I18n.t('settings.saveFailed', lang: lang)}: ${_sanitizeApiError(e, lang: lang)}',
            ),
          ),
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
      await ref
          .read(apiProviderListProvider.notifier)
          .updateProvider(
            ApiProviderData(
              id: ep['id'] as String,
              name: ep['name'] as String? ?? 'Provider',
              apiBase: ep['api_base'] as String? ?? '',
              apiKey: ep['api_key'] as String? ?? '',
              model: ep['model'] as String? ?? '',
              temperature: (ep['temperature'] as num?)?.toDouble() ?? 1.0,
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
        builder: (ctx) {
          final isDark = Theme.of(ctx).brightness == Brightness.dark;
          final fieldStyle = Theme.of(ctx).textTheme.bodyMedium?.copyWith(
            fontSize: 14,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          );
          return AlertDialog(
            title: Text(title),
            content: TextField(
              controller: controller,
              autofocus: true,
              style: fieldStyle,
              decoration: InputDecoration(
                hintText: 'OpenAI',
                hintStyle: fieldStyle?.copyWith(
                  color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                      .withValues(alpha: 0.7),
                ),
              ),
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
          );
        },
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
      // apiKey 字段脱敏展示：已保存的 key 显示为掩码而非明文（对齐主项目
      // settings/route.ts 的 maskSettings）。用户未编辑时 controller 保持掩码，
      // 保存时见掩码跳过写入以保留 DB 旧值。
      final maskedKey = settings.apiKey.isEmpty
          ? ''
          : SecretStorageService.kApiKeyMask;
      if (_apiKeyController.text != maskedKey) {
        _apiKeyController.text = maskedKey;
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
    // apiKey 脱敏展示：已保存的 key 填掩码而非明文（对齐主项目 maskSettings）
    _apiKeyController.text = settings.apiKey.isEmpty
        ? ''
        : SecretStorageService.kApiKeyMask;
    _modelController.text = settings.model;
    _loaded = true;
  }

  Future<void> _updateSetting(String key, dynamic value) async {
    // 掩码=不修改：api_key 字段值为掩码时跳过写入，保留 DB 旧值
    // （对齐主项目 settings/route.ts 的 `if (key === 'api_key' && value === API_KEY_MASK) continue`）。
    // 空串=显式清空，其它非掩码值=写入新值。
    if (key == 'api_key' && value == SecretStorageService.kApiKeyMask) {
      return;
    }
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  Future<void> _fetchModels() async {
    setState(() {
      _loadingModels = true;
      _modelError = null;
    });
    try {
      final llm = ref.read(llmServiceProvider);
      // controller 持有掩码时，用 settings 里已保存的真实 key 拉模型
      // （对齐主项目 settings/page.tsx fetchModels 的 usingKey 回退逻辑）。
      // 真实 key 仅作为局部变量传给 fetchModels，不回写 controller。
      final controllerKey = _apiKeyController.text.trim();
      final masked = controllerKey == SecretStorageService.kApiKeyMask;
      final effectiveKey = masked
          ? (ref.read(settingsProvider).valueOrNull?.apiKey ?? '')
          : controllerKey;
      final models = await llm.fetchModels(
        apiBase: _apiBaseController.text.trim(),
        apiKey: effectiveKey,
      );
      if (!mounted) return;
      setState(() => _availableModels = models);
      if (models.isEmpty) {
        setState(() => _modelError = '服务返回空模型列表');
      }
    } catch (e) {
      if (!mounted) return;
      final lang = ref.read(localeProvider).languageCode;
      setState(() => _modelError = _sanitizeApiError(e, lang: lang));
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
        mainAxisSize: MainAxisSize.min,
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
            child: _SecretField(
              controller: _apiKeyController,
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
                        value: _availableModels.contains(_modelController.text)
                            ? _modelController.text
                            : null,
                        items: [
                          SettingsRichSelectItem<String?>(
                            value: null,
                            label: I18n.t(
                              'settings.modelPlaceholder',
                              lang: lang,
                            ),
                          ),
                          ..._availableModels.map(
                            (m) => SettingsRichSelectItem<String?>(
                              value: m,
                              label: m,
                            ),
                          ),
                        ],
                        onChanged: (v) {
                          _modelController.text = v ?? '';
                          _updateSetting('model', v ?? '');
                        },
                      )
                    : SettingsRichInput(
                        controller: _modelController,
                        hint: I18n.t('settings.modelPlaceholder', lang: lang),
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

  // 性能/正确性：onChanged 每个按键都写库会触发 N 次 DB I/O，且用户敲到一半
  // （如 "1" → "15" → "150"）中间状态会被持久化；删空字段会落地 0。
  // 用 300ms debounce 合并尾部一次写入，并对解析失败的值跳过写入（保持当前值）。
  Timer? _debounceTemperature;
  Timer? _debounceMaxTokens;
  Timer? _debounceContextWindow;

  bool _loaded = false;

  @override
  void dispose() {
    _debounceTemperature?.cancel();
    _debounceMaxTokens?.cancel();
    _debounceContextWindow?.cancel();
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

  /// 数值字段 debounce + clamp 写入辅助：
  /// - [raw] 解析失败（如用户清空字段）则不写库，保留当前持久化值，避免误落 0；
  /// - 解析成功后用 [clamp] 校正到合法范围（temperature 0–2，token 上限等）。
  void _debouncedCommitDouble({
    required Timer? Function() get,
    required void Function(Timer?) set,
    required String raw,
    required String key,
    required double Function(double) clamp,
  }) {
    get()?.cancel();
    set(Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      final n = double.tryParse(raw);
      if (n == null || !n.isFinite) return;
      _updateSetting(key, clamp(n));
    }));
  }

  void _debouncedCommitInt({
    required Timer? Function() get,
    required void Function(Timer?) set,
    required String raw,
    required String key,
    required int Function(int) clamp,
  }) {
    get()?.cancel();
    set(Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      final n = int.tryParse(raw);
      if (n == null) return;
      _updateSetting(key, clamp(n));
    }));
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
                  onChanged: (v) => _debouncedCommitDouble(
                    get: () => _debounceTemperature,
                    set: (t) => _debounceTemperature = t,
                    raw: v,
                    key: 'temperature',
                    clamp: (n) => n.clamp(0.0, 2.0),
                  ),
                ),
              ),
              SettingsLabeledField(
                label: I18n.t('settings.maxTokens', lang: lang),
                child: SettingsRichInput(
                  controller: _maxTokensController,
                  numberMode: true,
                  onChanged: (v) => _debouncedCommitInt(
                    get: () => _debounceMaxTokens,
                    set: (t) => _debounceMaxTokens = t,
                    raw: v,
                    key: 'max_tokens',
                    clamp: (n) => n.clamp(1, 100000),
                  ),
                ),
              ),
              SettingsLabeledField(
                label: I18n.t('settings.contextWindow', lang: lang),
                child: SettingsRichInput(
                  controller: _contextWindowController,
                  numberMode: true,
                  onChanged: (v) => _debouncedCommitInt(
                    get: () => _debounceContextWindow,
                    set: (t) => _debounceContextWindow = t,
                    raw: v,
                    key: 'context_window',
                    clamp: (n) => n.clamp(1, 200000),
                  ),
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
        mainAxisSize: MainAxisSize.min,
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

/// 记忆引擎配置区块 — 对照主项目 MemoryEngineSection.tsx 翻译。
/// 与下方 [MemorySection]（记忆触发 UI）分立：本区块管 retrieval_mode /
/// embedding / reranker / 后台模型 / 隐私开关等增强记忆配置。
class MemoryEngineSection extends ConsumerStatefulWidget {
  const MemoryEngineSection({super.key});

  @override
  ConsumerState<MemoryEngineSection> createState() =>
      _MemoryEngineSectionState();
}

class _MemoryEngineSectionState extends ConsumerState<MemoryEngineSection> {
  // 文本输入控制器
  final _bgModelController = TextEditingController();
  final _embeddingApiBaseController = TextEditingController();
  final _embeddingApiKeyController = TextEditingController();
  final _embeddingModelController = TextEditingController();
  final _embeddingDimensionController = TextEditingController();
  final _rerankerApiBaseController = TextEditingController();
  final _rerankerApiKeyController = TextEditingController();
  final _rerankerModelController = TextEditingController();
  final _memoryPackageTokenBudgetController = TextEditingController();

  // 三组 Fetch Models 状态
  List<String> _bgModelList = [];
  bool _bgModelLoading = false;
  String? _bgModelError;
  List<String> _embeddingModelList = [];
  bool _embeddingModelLoading = false;
  String? _embeddingModelError;
  List<String> _rerankerModelList = [];
  bool _rerankerModelLoading = false;
  String? _rerankerModelError;

  // 数字输入 debounce（对齐 _MemorySectionState 模式：300ms + 解析失败跳过）
  Timer? _debounceMemoryPackageTokenBudget;
  Timer? _debounceEmbeddingDimension;

  bool _loaded = false;

  // 记忆管理面板共享的角色 ID — 对照主项目 useMemoryManagementCharacters。
  String _selectedCharacterId = '';

  // 三档预设 — 对照主项目 settings/page.tsx 行 49-95 MEMORY_MODE_PRESETS
  static const _chatRetrievalTimeoutMs = 2500;
  static const _continuityChatRetrievalTimeoutMs = 5000;

  static const Map<String, Map<String, dynamic>> _memoryModePresets = {
    'local': {
      'retrieval_mode': 'local',
      'embedding_enabled': false,
      'reranker_enabled': false,
      'fallback_local_enabled': true,
      'memory_package_token_budget': 12000,
      'retrieval_token_budget': 8000,
      'vector_top_k': 80,
      'keyword_top_k': 20,
      'reranker_top_k': 40,
      'final_top_k': 30,
      'embedding_timeout_ms': 1500,
      'reranker_timeout_ms': 2000,
      'total_retrieval_timeout_ms': _chatRetrievalTimeoutMs,
    },
    'balanced': {
      'retrieval_mode': 'hybrid',
      'embedding_enabled': true,
      'reranker_enabled': false,
      'fallback_local_enabled': true,
      'memory_package_token_budget': 12000,
      'retrieval_token_budget': 8000,
      'vector_top_k': 80,
      'keyword_top_k': 20,
      'reranker_top_k': 40,
      'final_top_k': 30,
      'embedding_timeout_ms': 1500,
      'reranker_timeout_ms': 2000,
      'total_retrieval_timeout_ms': _chatRetrievalTimeoutMs,
    },
    'continuity': {
      'retrieval_mode': 'hybrid',
      'embedding_enabled': true,
      'reranker_enabled': true,
      'fallback_local_enabled': true,
      'memory_package_token_budget': 20000,
      'retrieval_token_budget': 14000,
      'vector_top_k': 120,
      'keyword_top_k': 30,
      'reranker_top_k': 80,
      'final_top_k': 50,
      'embedding_timeout_ms': 2500,
      'reranker_timeout_ms': 3500,
      'total_retrieval_timeout_ms': _continuityChatRetrievalTimeoutMs,
    },
  };

  /// 反推当前预设档位 — 对照主项目 page.tsx resolveMemoryModePreset
  String _resolveMemoryModePreset(MemoryEngineSettings engine) {
    if (!engine.embeddingEnabled) return 'local';
    if (engine.rerankerEnabled &&
        engine.memoryPackageTokenBudget >= 20000) {
      return 'continuity';
    }
    return 'balanced';
  }

  @override
  void initState() {
    super.initState();
    // P1-15：监听外部 settings 变化，按需更新 controller（避免覆盖光标）
    ref.listenManual<AsyncValue<AppSettings>>(settingsProvider, (prev, next) {
      final settings = next.valueOrNull;
      if (settings == null) return;
      _syncControllers(settings);
    });
  }

  void _syncControllers(AppSettings settings) {
    final engine = settings.memoryEngine;
    if (_bgModelController.text != settings.memoryBackgroundModel) {
      _bgModelController.text = settings.memoryBackgroundModel;
    }
    if (_embeddingApiBaseController.text != engine.embeddingApiBase) {
      _embeddingApiBaseController.text = engine.embeddingApiBase;
    }
    // apiKey 字段脱敏展示（对齐 _ApiSectionState 模式）
    final embMasked = engine.embeddingApiKey.isEmpty
        ? ''
        : SecretStorageService.kApiKeyMask;
    if (_embeddingApiKeyController.text != embMasked) {
      _embeddingApiKeyController.text = embMasked;
    }
    if (_embeddingModelController.text != engine.embeddingModel) {
      _embeddingModelController.text = engine.embeddingModel;
    }
    final dimText = engine.embeddingDimension == 0
        ? ''
        : engine.embeddingDimension.toString();
    if (_embeddingDimensionController.text != dimText) {
      _embeddingDimensionController.text = dimText;
    }
    if (_rerankerApiBaseController.text != engine.rerankerApiBase) {
      _rerankerApiBaseController.text = engine.rerankerApiBase;
    }
    final rerMasked = engine.rerankerApiKey.isEmpty
        ? ''
        : SecretStorageService.kApiKeyMask;
    if (_rerankerApiKeyController.text != rerMasked) {
      _rerankerApiKeyController.text = rerMasked;
    }
    if (_rerankerModelController.text != engine.rerankerModel) {
      _rerankerModelController.text = engine.rerankerModel;
    }
    final budgetText = engine.memoryPackageTokenBudget.toString();
    if (_memoryPackageTokenBudgetController.text != budgetText) {
      _memoryPackageTokenBudgetController.text = budgetText;
    }
  }

  void _loadControllers(AppSettings settings) {
    if (_loaded) return;
    final engine = settings.memoryEngine;
    _bgModelController.text = settings.memoryBackgroundModel;
    _embeddingApiBaseController.text = engine.embeddingApiBase;
    _embeddingApiKeyController.text = engine.embeddingApiKey.isEmpty
        ? ''
        : SecretStorageService.kApiKeyMask;
    _embeddingModelController.text = engine.embeddingModel;
    _embeddingDimensionController.text = engine.embeddingDimension == 0
        ? ''
        : engine.embeddingDimension.toString();
    _rerankerApiBaseController.text = engine.rerankerApiBase;
    _rerankerApiKeyController.text = engine.rerankerApiKey.isEmpty
        ? ''
        : SecretStorageService.kApiKeyMask;
    _rerankerModelController.text = engine.rerankerModel;
    _memoryPackageTokenBudgetController.text =
        engine.memoryPackageTokenBudget.toString();
    _loaded = true;
  }

  @override
  void dispose() {
    _debounceMemoryPackageTokenBudget?.cancel();
    _debounceEmbeddingDimension?.cancel();
    _bgModelController.dispose();
    _embeddingApiBaseController.dispose();
    _embeddingApiKeyController.dispose();
    _embeddingModelController.dispose();
    _embeddingDimensionController.dispose();
    _rerankerApiBaseController.dispose();
    _rerankerApiKeyController.dispose();
    _rerankerModelController.dispose();
    _memoryPackageTokenBudgetController.dispose();
    super.dispose();
  }

  /// 更新 memory_engine 嵌套对象的单个字段。
  /// 掩码=不修改：secret 字段值为掩码时跳过，保留 DB 旧值
  /// （对齐 _ApiSectionState._updateSetting 的掩码守卫）。
  Future<void> _updateMemoryEngine(String fieldKey, dynamic value) async {
    if ((fieldKey == 'embedding_api_key' ||
        fieldKey == 'reranker_api_key') &&
        value == SecretStorageService.kApiKeyMask) {
      return;
    }
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    final engineMap = Map<String, dynamic>.from(
      settings.memoryEngine.toJson(),
    );
    engineMap[fieldKey] = value;
    await ref
        .read(settingsProvider.notifier)
        .updateSetting('memory_engine', engineMap);
  }

  /// 更新顶级字段（memory_background_provider_id / model / deepseek 开关）
  Future<void> _updateTop(String key, dynamic value) async {
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  /// 切换预设档位 — 把对应预设的所有字段 merge 进 memory_engine
  void _handleMemoryModeChange(String mode) {
    final preset = _memoryModePresets[mode];
    if (preset == null) return;
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    final engineMap = Map<String, dynamic>.from(
      settings.memoryEngine.toJson(),
    );
    engineMap.addAll(preset);
    ref
        .read(settingsProvider.notifier)
        .updateSetting('memory_engine', engineMap);
  }

  /// 切换后台供应商：更新 provider_id + 清空模型列表 + 同步 provider.model
  Future<void> _handleBgProviderChange(String providerId) async {
    await _updateTop('memory_background_provider_id', providerId);
    if (!mounted) return;
    _clearBgModelList();
    final providers =
        ref.read(apiProviderListProvider).valueOrNull ?? [];
    String model = '';
    for (final p in providers) {
      if (p.id == providerId) {
        model = p.model;
        break;
      }
    }
    _bgModelController.text = model;
    await _updateTop('memory_background_model', model);
  }

  void _clearBgModelList() => setState(() => _bgModelList = []);
  void _clearEmbeddingModelList() => setState(() => _embeddingModelList = []);
  void _clearRerankerModelList() => setState(() => _rerankerModelList = []);

  /// 后台模型 Fetch：供应商优先，否则回退主接口
  Future<void> _fetchBgModels() async {
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    final lang = ref.read(localeProvider).languageCode;
    final providers =
        ref.read(apiProviderListProvider).valueOrNull ?? [];
    final providerId = settings.memoryBackgroundProviderId;
    String apiBase;
    String apiKey;
    if (providerId.isNotEmpty) {
      String? found;
      for (final p in providers) {
        if (p.id == providerId) {
          found = p.apiBase;
          break;
        }
      }
      apiBase = found ?? '';
      // 供应商 key 在 UI 是掩码，需从 DB 取 secret ref 再 resolve
      final db = ref.read(databaseProvider);
      final row = await (db.select(db.apiProviders)
            ..where((t) => t.id.equals(providerId)))
          .getSingleOrNull();
      apiKey = row == null
          ? ''
          : await ref
                .read(secretStorageServiceProvider)
                .resolveApiKey(row.apiKey);
    } else {
      apiBase = settings.apiBase;
      apiKey = settings.apiKey;
    }
    if (apiBase.isEmpty) {
      setState(() =>
          _bgModelError = I18n.t('settings.apiBaseRequired', lang: lang));
      return;
    }
    setState(() {
      _bgModelLoading = true;
      _bgModelError = null;
    });
    try {
      final models = await ref
          .read(llmServiceProvider)
          .fetchModels(apiBase: apiBase, apiKey: apiKey);
      if (!mounted) return;
      setState(() => _bgModelList = models);
      if (models.isEmpty) {
        setState(() => _bgModelError = '服务返回空模型列表');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _bgModelError = _sanitizeApiError(e, lang: lang));
    } finally {
      if (mounted) setState(() => _bgModelLoading = false);
    }
  }

  /// Embedding 模型 Fetch：掩码回退用 settings 里已保存的真实 key
  Future<void> _fetchEmbeddingModels() async {
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    final lang = ref.read(localeProvider).languageCode;
    final engine = settings.memoryEngine;
    final apiBase = _embeddingApiBaseController.text.trim();
    if (apiBase.isEmpty) {
      setState(() => _embeddingModelError =
          I18n.t('settings.memoryEmbeddingApiBaseRequired', lang: lang));
      return;
    }
    final controllerKey = _embeddingApiKeyController.text.trim();
    final effectiveKey =
        controllerKey == SecretStorageService.kApiKeyMask
            ? engine.embeddingApiKey
            : controllerKey;
    setState(() {
      _embeddingModelLoading = true;
      _embeddingModelError = null;
    });
    try {
      final models = await ref
          .read(llmServiceProvider)
          .fetchModels(apiBase: apiBase, apiKey: effectiveKey);
      if (!mounted) return;
      setState(() => _embeddingModelList = models);
      if (models.isEmpty) {
        setState(() => _embeddingModelError = '服务返回空模型列表');
      }
    } catch (e) {
      if (!mounted) return;
      setState(
          () => _embeddingModelError = _sanitizeApiError(e, lang: lang));
    } finally {
      if (mounted) setState(() => _embeddingModelLoading = false);
    }
  }

  /// Reranker 模型 Fetch：掩码回退用 settings 里已保存的真实 key
  Future<void> _fetchRerankerModels() async {
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    final lang = ref.read(localeProvider).languageCode;
    final engine = settings.memoryEngine;
    final apiBase = _rerankerApiBaseController.text.trim();
    if (apiBase.isEmpty) {
      setState(() => _rerankerModelError =
          I18n.t('settings.memoryRerankerApiBaseRequired', lang: lang));
      return;
    }
    final controllerKey = _rerankerApiKeyController.text.trim();
    final effectiveKey =
        controllerKey == SecretStorageService.kApiKeyMask
            ? engine.rerankerApiKey
            : controllerKey;
    setState(() {
      _rerankerModelLoading = true;
      _rerankerModelError = null;
    });
    try {
      final models = await ref
          .read(llmServiceProvider)
          .fetchModels(apiBase: apiBase, apiKey: effectiveKey);
      if (!mounted) return;
      setState(() => _rerankerModelList = models);
      if (models.isEmpty) {
        setState(() => _rerankerModelError = '服务返回空模型列表');
      }
    } catch (e) {
      if (!mounted) return;
      setState(
          () => _rerankerModelError = _sanitizeApiError(e, lang: lang));
    } finally {
      if (mounted) setState(() => _rerankerModelLoading = false);
    }
  }

  int _parseNumber(String value) {
    final n = int.tryParse(value);
    return n ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    _loadControllers(settings);
    final lang = ref.watch(localeProvider).languageCode;
    final engine = settings.memoryEngine;
    final enabled = engine.enabled;
    final providers =
        ref.watch(apiProviderListProvider).valueOrNull ?? [];
    final memoryModePreset = _resolveMemoryModePreset(engine);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return LumiSectionPanel(
      title: I18n.t('settings.memoryEngine', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          // enabled 开关
          SettingsCheckboxRow(
            checked: enabled,
            label: I18n.t('settings.memoryEngineEnabled', lang: lang),
            onChanged: (v) => _updateMemoryEngine('enabled', v),
          ),
          // 关闭时的提示
          if (!enabled) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 12,
              ),
              decoration: BoxDecoration(
                color: isDark
                    ? AppTheme.darkSurface.withValues(alpha: 0.5)
                    : Colors.white.withValues(alpha: 0.7),
                border: Border.all(
                  color: isDark
                      ? AppTheme.darkBorderLight
                      : AppTheme.borderLight,
                ),
                borderRadius: AppRadius.mdBorder,
              ),
              child: Text(
                I18n.t('settings.memoryEngineDisabledHint', lang: lang),
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
          // 记忆模式预设（仅 enabled 时显示）
          if (enabled) ...[
            const SizedBox(height: 12),
            SettingsLabeledField(
              label: I18n.t('settings.memoryRetrievalMode', lang: lang),
              child: SettingsRichSelect<String>(
                value: memoryModePreset,
                items: [
                  SettingsRichSelectItem(
                    value: 'local',
                    label: I18n.t(
                      'settings.memoryRetrievalModeLocal',
                      lang: lang,
                    ),
                  ),
                  SettingsRichSelectItem(
                    value: 'balanced',
                    label: I18n.t(
                      'settings.memoryRetrievalModeBalanced',
                      lang: lang,
                    ),
                  ),
                  SettingsRichSelectItem(
                    value: 'continuity',
                    label: I18n.t(
                      'settings.memoryRetrievalModeContinuity',
                      lang: lang,
                    ),
                  ),
                ],
                onChanged: _handleMemoryModeChange,
              ),
            ),
          ],
          // 后台任务供应商 + 模型 + DeepSeek 开关 + Token 预算
          const SizedBox(height: 12),
          _buildFramedBlock(
            isDark,
            [
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryBackgroundProvider',
                  lang: lang,
                ),
                hintBelow: I18n.t(
                  'settings.memoryBackgroundProviderHint',
                  lang: lang,
                ),
                child: SettingsRichSelect<String>(
                  value: settings.memoryBackgroundProviderId,
                  items: [
                    SettingsRichSelectItem(
                      value: '',
                      label: I18n.t(
                        'settings.memoryBackgroundProviderNone',
                        lang: lang,
                      ),
                    ),
                    ...providers.map(
                      (p) => SettingsRichSelectItem(
                        value: p.id,
                        label:
                            '${p.name} (${p.model.isNotEmpty ? p.model : I18n.t('settings.modelPlaceholder', lang: lang)})',
                      ),
                    ),
                  ],
                  onChanged: _handleBgProviderChange,
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryBackgroundModel',
                  lang: lang,
                ),
                hintBelow: I18n.t(
                  'settings.memoryBackgroundModelHint',
                  lang: lang,
                ),
                child: _buildModelFetchField(
                  controller: _bgModelController,
                  modelList: _bgModelList,
                  loading: _bgModelLoading,
                  error: _bgModelError,
                  onFetch: _fetchBgModels,
                  onModelChanged: (v) =>
                      _updateTop('memory_background_model', v),
                  lang: lang,
                ),
              ),
              const SizedBox(height: 12),
              SettingsCheckboxRow(
                checked: settings.disableDeepseekThinkingForBackground,
                label: I18n.t(
                  'settings.disableDeepseekThinkingForBackground',
                  lang: lang,
                ),
                hintBelow: I18n.t(
                  'settings.disableDeepseekThinkingForBackgroundHint',
                  lang: lang,
                ),
                onChanged: (v) => _updateTop(
                  'disable_deepseek_thinking_for_background',
                  v,
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryPackageTokenBudget',
                  lang: lang,
                ),
                hintBelow: I18n.t(
                  'settings.memoryPackageTokenBudgetHint',
                  lang: lang,
                ),
                child: SettingsRichInput(
                  controller: _memoryPackageTokenBudgetController,
                  numberMode: true,
                  onChanged: (v) {
                    _debounceMemoryPackageTokenBudget?.cancel();
                    _debounceMemoryPackageTokenBudget = Timer(
                      const Duration(milliseconds: 300),
                      () {
                        if (!mounted) return;
                        final n = int.tryParse(v);
                        if (n == null) return;
                        _updateMemoryEngine(
                          'memory_package_token_budget',
                          n,
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
          // Embedding 配置块
          const SizedBox(height: 12),
          _buildFramedBlock(
            isDark,
            [
              Text(
                I18n.t('settings.memoryEmbedding', lang: lang),
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryEmbeddingApiBase',
                  lang: lang,
                ),
                child: SettingsRichInput(
                  controller: _embeddingApiBaseController,
                  hint: I18n.t('settings.apiBasePlaceholder', lang: lang),
                  onChanged: (v) {
                    _updateMemoryEngine('embedding_api_base', v);
                    _clearEmbeddingModelList();
                  },
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryEmbeddingApiKey',
                  lang: lang,
                ),
                child: _SecretField(
                  controller: _embeddingApiKeyController,
                  onChanged: (v) =>
                      _updateMemoryEngine('embedding_api_key', v),
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryEmbeddingModel',
                  lang: lang,
                ),
                child: _buildModelFetchField(
                  controller: _embeddingModelController,
                  modelList: _embeddingModelList,
                  loading: _embeddingModelLoading,
                  error: _embeddingModelError,
                  onFetch: _fetchEmbeddingModels,
                  onModelChanged: (v) =>
                      _updateMemoryEngine('embedding_model', v),
                  lang: lang,
                ),
              ),
              const SizedBox(height: 12),
              SettingsLabeledField(
                label: I18n.t(
                  'settings.memoryEmbeddingDimension',
                  lang: lang,
                ),
                hintBelow: I18n.t(
                  'settings.memoryEmbeddingDimensionHint',
                  lang: lang,
                ),
                child: SettingsRichInput(
                  controller: _embeddingDimensionController,
                  numberMode: true,
                  onChanged: (v) {
                    _debounceEmbeddingDimension?.cancel();
                    _debounceEmbeddingDimension = Timer(
                      const Duration(milliseconds: 300),
                      () {
                        if (!mounted) return;
                        _updateMemoryEngine(
                          'embedding_dimension',
                          _parseNumber(v),
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
          // Reranker 配置块
          const SizedBox(height: 12),
          _buildFramedBlock(
            isDark,
            [
              Text(
                I18n.t('settings.memoryReranker', lang: lang),
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 12),
              SettingsCheckboxRow(
                checked: engine.rerankerEnabled,
                label: I18n.t(
                  'settings.memoryRerankerEnabled',
                  lang: lang,
                ),
                onChanged: (v) =>
                    _updateMemoryEngine('reranker_enabled', v),
              ),
              if (engine.rerankerEnabled) ...[
                const SizedBox(height: 12),
                SettingsLabeledField(
                  label: I18n.t(
                    'settings.memoryRerankerApiBase',
                    lang: lang,
                  ),
                  child: SettingsRichInput(
                    controller: _rerankerApiBaseController,
                    hint: I18n.t('settings.apiBasePlaceholder', lang: lang),
                    onChanged: (v) {
                      _updateMemoryEngine('reranker_api_base', v);
                      _clearRerankerModelList();
                    },
                  ),
                ),
                const SizedBox(height: 12),
                SettingsLabeledField(
                  label: I18n.t(
                    'settings.memoryRerankerApiKey',
                    lang: lang,
                  ),
                  child: _SecretField(
                    controller: _rerankerApiKeyController,
                    onChanged: (v) =>
                        _updateMemoryEngine('reranker_api_key', v),
                  ),
                ),
                const SizedBox(height: 12),
                SettingsLabeledField(
                  label: I18n.t(
                    'settings.memoryRerankerModel',
                    lang: lang,
                  ),
                  child: _buildModelFetchField(
                    controller: _rerankerModelController,
                    modelList: _rerankerModelList,
                    loading: _rerankerModelLoading,
                    error: _rerankerModelError,
                    onFetch: _fetchRerankerModels,
                    onModelChanged: (v) =>
                        _updateMemoryEngine('reranker_model', v),
                    lang: lang,
                  ),
                ),
              ],
            ],
          ),
          // 隐私块（仅 enabled 时显示）
          if (enabled) ...[
            const SizedBox(height: 12),
            _buildFramedBlock(
              isDark,
              [
                Text(
                  I18n.t('settings.memoryPrivacy', lang: lang),
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    color: isDark
                        ? AppTheme.darkTextPrimary
                        : AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 12),
                SettingsCheckboxRow(
                  checked: engine.allowMemoryContextInChat,
                  label: I18n.t(
                    'settings.memoryAllowChatContext',
                    lang: lang,
                  ),
                  onChanged: (v) => _updateMemoryEngine(
                    'allow_memory_context_in_chat',
                    v,
                  ),
                ),
                const SizedBox(height: 12),
                SettingsCheckboxRow(
                  checked: engine.allowExternalMemoryPayloads,
                  label: I18n.t(
                    'settings.memoryAllowExternalPayloads',
                    lang: lang,
                  ),
                  onChanged: (v) => _updateMemoryEngine(
                    'allow_external_memory_payloads',
                    v,
                  ),
                ),
              ],
            ),
          ],
          // 记忆管理面板（仅 enabled 时显示）— 对照主项目 page.tsx 1001-1046
          // 顺序：IndexPanel → DiagnosticsPanel → ProfilePanel → ArchivePanel → CandidatesPanel
          if (enabled) ...[
            const SizedBox(height: 12),
            _buildFramedBlock(
              isDark,
              [
                SettingsLabeledField(
                  label: I18n.t(
                    'settings.memoryManagementCharacter',
                    lang: lang,
                  ),
                  child: _MemoryCharacterSelector(
                    value: _selectedCharacterId,
                    onChanged: (v) =>
                        setState(() => _selectedCharacterId = v),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            MemoryIndexPanel(characterId: _selectedCharacterId),
            const SizedBox(height: 12),
            MemoryDiagnosticsPanel(characterId: _selectedCharacterId),
            const SizedBox(height: 12),
            MemoryProfilePanel(characterId: _selectedCharacterId),
            const SizedBox(height: 12),
            MemoryArchivePanel(characterId: _selectedCharacterId),
            const SizedBox(height: 12),
            MemoryCandidatesPanel(characterId: _selectedCharacterId),
          ],
        ],
      ),
    );
  }

  /// 带边框的容器块（对照主项目 rounded-2xl border bg-white/70）
  Widget _buildFramedBlock(bool isDark, List<Widget> children) {
    return Container(
      padding: const EdgeInsets.all(16),
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
        children: children,
      ),
    );
  }

  /// 模型输入 + Fetch 按钮 + 错误提示的通用行
  /// （对照 _ApiSectionState 的 model + fetchBtn 布局）
  Widget _buildModelFetchField({
    required TextEditingController controller,
    required List<String> modelList,
    required bool loading,
    required String? error,
    required VoidCallback onFetch,
    required ValueChanged<String> onModelChanged,
    required String lang,
  }) {
    return LayoutBuilder(
      builder: (ctx, constraints) {
        final wide = constraints.maxWidth >= 480;
        final modelInput = modelList.isNotEmpty
            ? SettingsRichSelect<String?>(
                value: modelList.contains(controller.text)
                    ? controller.text
                    : null,
                items: [
                  SettingsRichSelectItem<String?>(
                    value: null,
                    label: I18n.t(
                      'settings.modelSelectPlaceholder',
                      lang: lang,
                    ),
                  ),
                  ...modelList.map(
                    (m) => SettingsRichSelectItem<String?>(
                      value: m,
                      label: m,
                    ),
                  ),
                ],
                onChanged: (v) {
                  controller.text = v ?? '';
                  onModelChanged(v ?? '');
                },
              )
            : SettingsRichInput(
                controller: controller,
                hint: I18n.t('settings.modelPlaceholder', lang: lang),
                onChanged: onModelChanged,
              );
        final fetchBtn = LumiSoftButton(
          label: loading
              ? I18n.t('common.loading', lang: lang)
              : I18n.t('settings.fetchModels', lang: lang),
          kind: LumiSoftButtonKind.secondary,
          onTap: loading ? null : onFetch,
        );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (wide)
              Row(
                children: [
                  Expanded(child: modelInput),
                  const SizedBox(width: AppSpacing.sm),
                  fetchBtn,
                ],
              )
            else ...[
              modelInput,
              const SizedBox(height: 8),
              Align(alignment: Alignment.centerLeft, child: fetchBtn),
            ],
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(
                error,
                style: const TextStyle(
                  fontSize: 12,
                  color: Color(0xFFEF4444),
                ),
              ),
            ],
          ],
        );
      },
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

  // 见 _ModelSectionState 同名注释：debounce 300ms + 解析失败跳过 + 范围 clamp。
  Timer? _debounceMemoryInterval;
  Timer? _debounceMemoryTriggerTimeHours;
  Timer? _debounceMemoryMaxInject;
  // memory_trigger_keywords 是字符串，无需 clamp，但仍 debounce 以减少写库频次。
  Timer? _debounceMemoryTriggerKeywords;

  bool _loaded = false;

  @override
  void dispose() {
    _debounceMemoryInterval?.cancel();
    _debounceMemoryTriggerTimeHours?.cancel();
    _debounceMemoryMaxInject?.cancel();
    _debounceMemoryTriggerKeywords?.cancel();
    _memoryIntervalController.dispose();
    _memoryTriggerTimeHoursController.dispose();
    _memoryTriggerKeywordsController.dispose();
    _memoryMaxInjectController.dispose();
    super.dispose();
  }

  void _loadControllers(AppSettings settings) {
    if (_loaded) return;
    _memoryIntervalController.text = settings.memoryInterval.toString();
    _memoryTriggerTimeHoursController.text = settings.memoryTriggerTimeHours
        .toString();
    _memoryTriggerKeywordsController.text = settings.memoryTriggerKeywords;
    _memoryMaxInjectController.text = settings.memoryMaxInject.toString();
    _loaded = true;
  }

  Future<void> _updateSetting(String key, dynamic value) async {
    await ref.read(settingsProvider.notifier).updateSetting(key, value);
  }

  /// 与 _ModelSectionState._debouncedCommitInt 同语义；为避免跨文件抽公共 helper
  /// 而扩散改动，这里就近重复一份（两个 Section 都是私有 State）。
  void _debouncedCommitInt({
    required Timer? Function() get,
    required void Function(Timer?) set,
    required String raw,
    required String key,
    required int Function(int) clamp,
  }) {
    get()?.cancel();
    set(Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      final n = int.tryParse(raw);
      if (n == null) return;
      _updateSetting(key, clamp(n));
    }));
  }

  void _debouncedCommitString({
    required Timer? Function() get,
    required void Function(Timer?) set,
    required String raw,
    required String key,
  }) {
    get()?.cancel();
    set(Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      _updateSetting(key, raw);
    }));
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).valueOrNull;
    if (settings == null) return const SizedBox.shrink();
    _loadControllers(settings);
    final lang = ref.watch(localeProvider).languageCode;

    return LumiSectionPanel(
      title: I18n.t('settings.memoryTriggers', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
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
              onChanged: (v) => _debouncedCommitInt(
                get: () => _debounceMemoryInterval,
                set: (t) => _debounceMemoryInterval = t,
                raw: v,
                key: 'memory_interval',
                clamp: (n) => n.clamp(1, 100),
              ),
            ),
          ],
          const SizedBox(height: 12),
          SettingsCheckboxRow(
            checked: settings.memoryTriggerTimeEnabled,
            label: I18n.t('settings.triggerTime', lang: lang),
            onChanged: (v) => _updateSetting('memory_trigger_time_enabled', v),
          ),
          if (settings.memoryTriggerTimeEnabled) ...[
            const SizedBox(height: 12),
            SettingsConditionalNumberInput(
              label: I18n.t('settings.triggerTimeMinutes', lang: lang),
              controller: _memoryTriggerTimeHoursController,
              onChanged: (v) => _debouncedCommitInt(
                get: () => _debounceMemoryTriggerTimeHours,
                set: (t) => _debounceMemoryTriggerTimeHours = t,
                raw: v,
                key: 'memory_trigger_time_hours',
                // TODO(naming): 字段名为 hours、i18n key 为 triggerTimeMinutes、
                //   注释"看似分钟"，三者矛盾且 clamp 范围只能宽松兜底。
                //   后续核查真实单位并统一字段名/key/数据库 schema 含义。
                clamp: (n) => n.clamp(1, 10000),
              ),
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
              onChanged: (v) => _debouncedCommitString(
                get: () => _debounceMemoryTriggerKeywords,
                set: (t) => _debounceMemoryTriggerKeywords = t,
                raw: v,
                key: 'memory_trigger_keywords',
              ),
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
              onChanged: (v) => _debouncedCommitInt(
                get: () => _debounceMemoryMaxInject,
                set: (t) => _debounceMemoryMaxInject = t,
                raw: v,
                key: 'memory_max_inject',
                clamp: (n) => n.clamp(0, 50),
              ),
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
          final fontScaleBlock = SettingsLabeledFieldFramed(
            label: I18n.t('settings.fontSize', lang: lang),
            child: _FontScaleSlider(
              value: settings.fontScale,
              onCommit: (v) => updateSetting('font_scale', v),
            ),
          );
          final resumeBlock = SettingsLabeledFieldFramed(
            label: I18n.t('settings.autoResumeLastConversation', lang: lang),
            child: Switch(
              value: settings.autoResumeLastConversation,
              onChanged: (v) =>
                  updateSetting('auto_resume_last_conversation', v),
            ),
          );
          if (wide) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Expanded(child: themeBlock),
                    const SizedBox(width: 16),
                    Expanded(child: langBlock),
                  ],
                ),
                const SizedBox(height: AppSpacing.lg),
                Row(
                  children: [
                    Expanded(child: fontScaleBlock),
                    const SizedBox(width: 16),
                    Expanded(child: resumeBlock),
                  ],
                ),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              themeBlock,
              const SizedBox(height: AppSpacing.lg),
              langBlock,
              const SizedBox(height: AppSpacing.lg),
              fontScaleBlock,
              const SizedBox(height: AppSpacing.lg),
              resumeBlock,
            ],
          );
        },
      ),
    );
  }
}

/// 字体缩放滑块：拖动时仅更新 [fontScaleProvider] 预览，松手后写库。
class _FontScaleSlider extends ConsumerStatefulWidget {
  const _FontScaleSlider({required this.value, required this.onCommit});

  final double value;
  final Future<void> Function(double value) onCommit;

  @override
  ConsumerState<_FontScaleSlider> createState() => _FontScaleSliderState();
}

class _FontScaleSliderState extends ConsumerState<_FontScaleSlider> {
  late double _draft;

  @override
  void initState() {
    super.initState();
    _draft = widget.value.clamp(0.85, 1.5).toDouble();
  }

  @override
  void didUpdateWidget(covariant _FontScaleSlider oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value) {
      _draft = widget.value.clamp(0.85, 1.5).toDouble();
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Slider(
          value: _draft,
          min: 0.85,
          max: 1.5,
          divisions: 13,
          label: '${(_draft * 100).round()}%',
          onChanged: (v) {
            setState(() => _draft = v);
            ref.read(fontScaleProvider.notifier).state = v;
          },
          onChangeEnd: (v) => widget.onCommit(v),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            '${(_draft * 100).round()}%',
            style: TextStyle(
              fontSize: 12,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
        ),
      ],
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
        final lang = ref.read(localeProvider).languageCode;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_sanitizeApiError(e, lang: lang))));
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
          if (result.dbDeleted > 0 ||
              result.fileResults.values.any((stat) => stat.deleted > 0)) {
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
        final lang = ref.read(localeProvider).languageCode;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_sanitizeApiError(e, lang: lang))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final running =
        _maintStatus == _MaintStatus.checking ||
        _maintStatus == _MaintStatus.cleaning;

    String? msg;
    String? subMsg;
    Color? msgColor;
    Color? subMsgColor;
    final mutedColor = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    final totalOrphans = _maintPreviewCount;
    final hasFileOrphans =
        _maintPreviewFiles?.values.any((stat) => stat.orphanCount > 0) ?? false;

    if (running) {
      msg = I18n.t('settings.cleanupRunning', lang: lang);
      msgColor = mutedColor;
    } else if (_maintStatus == _MaintStatus.done) {
      final dbCount = _maintCleanedCount;
      final fileResults = _cleanupResult?.fileResults;
      final totalDeletedFiles =
          fileResults?.values.fold<int>(0, (sum, item) => sum + item.deleted) ??
          0;

      if (dbCount == 0 && totalDeletedFiles == 0) {
        msg = I18n.t('settings.cleanupClean', lang: lang);
        msgColor = mutedColor;
      } else {
        msg = I18n.tArgs('settings.cleanupResult', {
          'count': dbCount,
        }, lang: lang);
        msgColor = const Color(0xFF16A34A);

        if (fileResults != null) {
          final aDel = fileResults['avatars']?.deleted ?? 0;
          final atDel = fileResults['attachments']?.deleted ?? 0;
          final gDel = fileResults['generated']?.deleted ?? 0;
          if (aDel > 0 || atDel > 0 || gDel > 0) {
            subMsg = I18n.tArgs('settings.cleanupFileResult', {
              'a': aDel,
              'at': atDel,
              'g': gDel,
            }, lang: lang);
            subMsgColor = const Color(0xFF16A34A);
          }
        }
      }
    } else if (_maintStatus == _MaintStatus.previewed) {
      if (totalOrphans == 0 && !hasFileOrphans) {
        msg = I18n.t('settings.cleanupClean', lang: lang);
        msgColor = mutedColor;
      } else {
        msg = I18n.tArgs('settings.cleanupPreview', {
          'count': totalOrphans,
        }, lang: lang);
        msgColor = const Color(0xFFD97706);

        if (_maintPreviewFiles != null) {
          final av = _maintPreviewFiles!['avatars'];
          final att = _maintPreviewFiles!['attachments'];
          final gen = _maintPreviewFiles!['generated'];
          final avStr = '${av?.orphanCount ?? 0}/${av?.total ?? 0}';
          final attStr = '${att?.orphanCount ?? 0}/${att?.total ?? 0}';
          final genStr = '${gen?.orphanCount ?? 0}/${gen?.total ?? 0}';

          subMsg = I18n.tArgs('settings.cleanupFilePreview', {
            'a': avStr,
            'at': attStr,
            'g': genStr,
          }, lang: lang);
          subMsgColor = const Color(0xFFD97706);
        }
      }
    }

    return LumiSectionPanel(
      title: I18n.t('settings.maintenance', lang: lang),
      subtitle: I18n.t('settings.maintenanceHint', lang: lang),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
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
                      Text(
                        subMsg,
                        style: TextStyle(fontSize: 13, color: subMsgColor),
                      ),
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
    final secondaryColor = isDark
        ? AppTheme.darkTextSecondary
        : AppTheme.textSecondary;
    final primaryColor = isDark
        ? AppTheme.darkTextPrimary
        : AppTheme.textPrimary;
    final borderColor = isDark
        ? AppTheme.darkBorderLight
        : AppTheme.borderLight;

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

/// 私有 API Key 输入框：obscure + 显隐 IconButton。
/// 视觉与 SettingsRichInput 保持一致（半透明白底 + borderLight + 圆角 12 / md）。
/// 支持两种构造：传 controller（与外部状态同步）或传 initialValue（内部建临时 controller）。
class _SecretField extends ConsumerStatefulWidget {
  final TextEditingController? controller;
  final String? initialValue;
  final String? placeholder;
  final ValueChanged<String>? onChanged;

  const _SecretField({
    super.key,
    this.controller,
    this.initialValue,
    this.placeholder,
    this.onChanged,
  });

  @override
  ConsumerState<_SecretField> createState() => _SecretFieldState();
}

class _SecretFieldState extends ConsumerState<_SecretField> {
  bool _obscure = true;
  TextEditingController? _internalCtrl;

  TextEditingController get _effectiveCtrl =>
      widget.controller ?? _internalCtrl!;

  @override
  void initState() {
    super.initState();
    if (widget.controller == null) {
      _internalCtrl = TextEditingController(text: widget.initialValue ?? '');
    }
  }

  @override
  void dispose() {
    _internalCtrl?.dispose();
    super.dispose();
  }

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
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _effectiveCtrl,
              obscureText: _obscure,
              onChanged: widget.onChanged,
              style: TextStyle(
                fontSize: 15,
                height: 1.5,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: widget.placeholder,
                hintStyle: TextStyle(
                  fontSize: 14,
                  color:
                      (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
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
          ),
          IconButton(
            tooltip: _obscure
                ? I18n.t('common.reveal', lang: ref.watch(localeProvider).languageCode)
                : I18n.t('common.hide', lang: ref.watch(localeProvider).languageCode),
            icon: Icon(
              _obscure ? Icons.visibility : Icons.visibility_off,
              size: 18,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
            onPressed: () => setState(() => _obscure = !_obscure),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Wave 13.2 — 记忆引擎子面板
// 对照主项目 src/components/settings/memory/ 下 5 个 tsx + 4 个 hook。
// hook 逻辑翻译为 ConsumerStatefulWidget 的 State 字段（不新建全局 Provider）。
// ═══════════════════════════════════════════════════════════════

/// 记忆子面板共用的外框容器 — 对照主项目 `rounded-2xl border border-border-light bg-white/70 px-4 py-4`。
class _MemoryPanelCard extends StatelessWidget {
  final List<Widget> children;
  const _MemoryPanelCard({required this.children});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(16),
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
        children: children,
      ),
    );
  }
}

/// 显示记忆面板操作的 toast（SnackBar）。对照主项目 showToast。
void _showMemoryToast(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message), duration: const Duration(seconds: 3)),
  );
}

/// 记忆子面板共用的角色选择下拉框。对照主项目 useMemoryManagementCharacters。
/// 返回当前选中的 characterId； onChanged 通知父级切换。
class _MemoryCharacterSelector extends ConsumerWidget {
  final String value;
  final ValueChanged<String> onChanged;
  const _MemoryCharacterSelector({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lang = ref.watch(localeProvider).languageCode;
    final characters = ref.watch(characterListProvider).valueOrNull ?? [];
    return SettingsRichSelect<String?>(
      value: value.isEmpty ? null : value,
      items: [
        SettingsRichSelectItem<String?>(
          value: null,
          label: I18n.t('settings.memoryManagementChooseCharacter', lang: lang),
        ),
        ...characters.map(
          (c) => SettingsRichSelectItem<String?>(
            value: c.id,
            label: c.name.isEmpty ? c.id : c.name,
          ),
        ),
      ],
      onChanged: (v) => onChanged(v ?? ''),
    );
  }
}

/// 统计单元格 — 对照主项目 `rounded-xl border border-border-light bg-white/60 px-3 py-2`。
class _MemoryStatTile extends StatelessWidget {
  final String label;
  final String value;
  const _MemoryStatTile({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 1. MemoryDiagnosticsPanel — 对照 MemoryDiagnosticsPanel.tsx（85 行，无 hook）
// 诊断数据由 IndexPanel 的 loadMemoryDiagnostics 产出，这里独立加载。
// ─────────────────────────────────────────────────────────────────

/// 记忆诊断快照。
class _MemoryDiagnostics {
  final int indexReady;
  final int indexTotal;
  final int tasksPending;
  final int tasksProcessing;
  final int tasksFailed;
  final int candidatesRepairable;
  final bool profileExists;
  final int profileFilledFields;
  final int archiveArchived;
  final int archiveSummarized;

  const _MemoryDiagnostics({
    this.indexReady = 0,
    this.indexTotal = 0,
    this.tasksPending = 0,
    this.tasksProcessing = 0,
    this.tasksFailed = 0,
    this.candidatesRepairable = 0,
    this.profileExists = false,
    this.profileFilledFields = 0,
    this.archiveArchived = 0,
    this.archiveSummarized = 0,
  });
}

class MemoryDiagnosticsPanel extends ConsumerStatefulWidget {
  final String? characterId;
  const MemoryDiagnosticsPanel({super.key, this.characterId});

  @override
  ConsumerState<MemoryDiagnosticsPanel> createState() =>
      _MemoryDiagnosticsPanelState();
}

class _MemoryDiagnosticsPanelState
    extends ConsumerState<MemoryDiagnosticsPanel> {
  _MemoryDiagnostics? _diagnostics;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 延迟一帧加载，避免在 build 周期中触发 setState
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void didUpdateWidget(MemoryDiagnosticsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) {
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final characterId = widget.characterId;

      // 索引状态
      final tasksService = MemoryEmbeddingTasksService(db);
      final status = await tasksService.getMemoryIndexStatus(
        characterId: characterId,
      );

      // 候选数
      final candidatesService = MemoryCandidatesService(
        db,
        MemoryEngine(db, ref.read(llmServiceProvider)),
      );
      final candidatesResult = characterId == null
          ? await candidatesService.listCandidates(limit: 1)
          : await candidatesService.listCandidates(
              characterId: characterId, limit: 1);

      // 画像
      var profileExists = false;
      var profileFilled = 0;
      if (characterId != null && characterId.isNotEmpty) {
        final profileService = MemoryProfileService(db, ref.read(llmServiceProvider));
        final profile = await profileService.readMemoryProfile(characterId);
        if (profile != null) {
          profileExists = true;
          if (profile.relationshipState.trim().isNotEmpty) profileFilled += 1;
          if (profile.recentStoryState.trim().isNotEmpty) profileFilled += 1;
          if (profile.emotionalBaseline.trim().isNotEmpty) profileFilled += 1;
          if (profile.openThreads.isNotEmpty) profileFilled += 1;
          if (profile.userProfileSummary.trim().isNotEmpty) profileFilled += 1;
          if (profile.pinnedSummary.trim().isNotEmpty) profileFilled += 1;
        }
      }

      // 归档计数：直接查 memories 表
      final archivedCount = _db.memories.id.count();
      final archivedQuery = _db.selectOnly(_db.memories)
        ..addColumns([archivedCount])
        ..where(_db.memories.status.equals('archived'));
      final summarizedCount = _db.memories.id.count();
      final summarizedQuery = _db.selectOnly(_db.memories)
        ..addColumns([summarizedCount])
        ..where(_db.memories.status.equals('summarized'));
      if (characterId != null && characterId.isNotEmpty) {
        archivedQuery.where(_db.memories.characterId.equals(characterId));
        summarizedQuery.where(_db.memories.characterId.equals(characterId));
      }
      final archivedRow = await archivedQuery.getSingle();
      final summarizedRow = await summarizedQuery.getSingle();

      if (!mounted) return;
      setState(() {
        _diagnostics = _MemoryDiagnostics(
          indexReady: status.ready,
          indexTotal: status.total,
          tasksPending: status.pending,
          tasksProcessing: status.processing,
          tasksFailed: status.failed,
          candidatesRepairable: candidatesResult.total,
          profileExists: profileExists,
          profileFilledFields: profileFilled,
          archiveArchived: archivedRow.read(archivedCount) ?? 0,
          archiveSummarized: summarizedRow.read(summarizedCount) ?? 0,
        );
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  AppDatabase get _db => ref.read(databaseProvider);

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final d = _diagnostics;
    return _MemoryPanelCard(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              I18n.t('settings.memoryDiagnosticsTitle', lang: lang),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: Theme.of(context).brightness == Brightness.dark
                    ? AppTheme.darkTextPrimary
                    : AppTheme.textPrimary,
              ),
            ),
            LumiSoftButton(
              label: _loading
                  ? I18n.t('common.loading', lang: lang)
                  : I18n.t('settings.memoryDiagnosticsRefresh', lang: lang),
              icon: Icons.refresh,
              kind: LumiSoftButtonKind.secondary,
              tiny: true,
              loading: _loading,
              onTap: _loading ? null : _load,
            ),
          ],
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (ctx, constraints) {
            final cols = constraints.maxWidth >= 640 ? 5 : 2;
            return _StatGrid(
              columns: cols,
              children: [
                _MemoryStatTile(
                  label: I18n.t('settings.memoryDiagnosticsIndex', lang: lang),
                  value: _loading
                      ? '...'
                      : '${d?.indexReady ?? 0}/${d?.indexTotal ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryDiagnosticsTasks', lang: lang),
                  value: _loading
                      ? '...'
                      : '${d?.tasksPending ?? 0}/${d?.tasksProcessing ?? 0}/${d?.tasksFailed ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryDiagnosticsCandidates', lang: lang),
                  value: _loading ? '...' : '${d?.candidatesRepairable ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryDiagnosticsProfile', lang: lang),
                  value: _loading
                      ? '...'
                      : (d?.profileExists ?? false)
                          ? '${d?.profileFilledFields ?? 0}/6'
                          : I18n.t('common.empty', lang: lang),
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryDiagnosticsArchive', lang: lang),
                  value: _loading
                      ? '...'
                      : ((d?.archiveSummarized ?? 0) > 0
                          ? '${d?.archiveArchived ?? 0}/${d?.archiveSummarized ?? 0}'
                          : '${d?.archiveArchived ?? 0}'),
                ),
              ],
            );
          },
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            '${I18n.t('common.loadFailed', lang: lang)}: $_error',
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
      ],
    );
  }
}

/// 统计网格 — 对照主项目 `grid grid-cols-2 sm:grid-cols-5 gap-2`。
class _StatGrid extends StatelessWidget {
  final int columns;
  final List<Widget> children;
  const _StatGrid({required this.columns, required this.children});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: children
          .map((c) => SizedBox(
                width: columns > 0
                    ? (MediaQuery.of(context).size.width / columns - 8 * (columns - 1) / columns)
                    : null,
                child: c,
              ))
          .toList(),
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. MemoryCandidatesPanel — 对照 MemoryCandidatesPanel.tsx + useMemoryCandidatesPanel.ts
// 候选修复管理：列出 repairable 候选 → accept / edit-accept / ignore / discard。
// ─────────────────────────────────────────────────────────────────

class MemoryCandidatesPanel extends ConsumerStatefulWidget {
  final String characterId;
  const MemoryCandidatesPanel({super.key, required this.characterId});

  @override
  ConsumerState<MemoryCandidatesPanel> createState() =>
      _MemoryCandidatesPanelState();
}

class _MemoryCandidatesPanelState extends ConsumerState<MemoryCandidatesPanel> {
  List<MemoryCandidateSummary> _candidates = const [];
  bool _loading = false;
  String? _error;
  int? _actionId; // 正在执行操作的 candidate id
  int? _editingId; // 正在编辑的 candidate id
  final Map<int, String> _edits = {}; // 编辑草稿（candidateId → content）

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void didUpdateWidget(MemoryCandidatesPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) {
      _edits.clear();
      _editingId = null;
      _load();
    }
  }

  Future<void> _load() async {
    final characterId = widget.characterId;
    if (characterId.isEmpty) {
      setState(() {
        _candidates = const [];
        _error = null;
        _loading = false;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryCandidatesService(db, MemoryEngine(db, ref.read(llmServiceProvider)));
      final result = await service.listCandidates(
        characterId: characterId,
        limit: 50,
      );
      if (!mounted) return;
      setState(() => _candidates = result.candidates);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _handleAction(
    MemoryCandidateSummary candidate,
    String action, // accept / edit-accept / ignore / discard
  ) async {
    final lang = ref.read(localeProvider).languageCode;
    if (action == 'edit-accept') {
      final content = (_edits[candidate.id] ?? _getCandidateText(candidate, 'content')).trim();
      if (content.isEmpty) {
        _showMemoryToast(
          context,
          I18n.t('settings.memoryCandidatesEmptyContent', lang: lang),
        );
        return;
      }
    }
    setState(() => _actionId = candidate.id);
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryCandidatesService(db, MemoryEngine(db, ref.read(llmServiceProvider)));
      if (action == 'accept' || action == 'edit-accept') {
        Map<String, dynamic>? override;
        if (action == 'edit-accept') {
          override = {
            'content': (_edits[candidate.id] ?? _getCandidateText(candidate, 'content')).trim(),
          };
        }
        final result = await service.acceptCandidate(
          candidateId: candidate.id,
          override: override,
        );
        if (!mounted) return;
        if (!result.accepted) {
          _showMemoryToast(
            context,
            '${I18n.t('settings.memoryCandidatesActionFailed', lang: lang)}: ${result.error ?? ''}',
          );
          return;
        }
      } else if (action == 'ignore') {
        await service.ignoreCandidate(candidate.id);
      } else if (action == 'discard') {
        await service.discardCandidate(candidate.id);
      }
      if (!mounted) return;
      _edits.remove(candidate.id);
      if (_editingId == candidate.id) _editingId = null;
      await _load();
    } catch (e) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryCandidatesActionFailed', lang: lang)}: $e',
      );
    } finally {
      if (mounted) setState(() => _actionId = null);
    }
  }

  String _getCandidateText(MemoryCandidateSummary candidate, String key) {
    final v = candidate.rawCandidate?[key];
    return v is String ? v : '';
  }

  String _getCandidateTags(MemoryCandidateSummary candidate) {
    final v = candidate.rawCandidate?['tags'];
    if (v is List) return v.whereType<String>().join(', ');
    return v is String ? v : '';
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return _MemoryPanelCard(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    I18n.t('settings.memoryCandidatesTitle', lang: lang),
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    I18n.t('settings.memoryCandidatesHint', lang: lang),
                    style: TextStyle(
                      fontSize: 12,
                      color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            LumiSoftButton(
              label: _loading
                  ? I18n.t('common.loading', lang: lang)
                  : I18n.t('settings.memoryCandidatesRefresh', lang: lang),
              icon: Icons.refresh,
              kind: LumiSoftButtonKind.secondary,
              tiny: true,
              loading: _loading,
              onTap: _loading ? null : _load,
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            '${I18n.t('common.loadFailed', lang: lang)}: $_error',
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
        const SizedBox(height: 12),
        if (_loading && _candidates.isEmpty)
          Text(
            I18n.t('common.loading', lang: lang),
            style: TextStyle(
              fontSize: 14,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          )
        else if (_candidates.isEmpty)
          Text(
            I18n.t('settings.memoryCandidatesEmpty', lang: lang),
            style: TextStyle(
              fontSize: 14,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          )
        else
          ..._candidates.map((c) => _buildCandidateCard(c, isDark, lang)),
      ],
    );
  }

  Widget _buildCandidateCard(
    MemoryCandidateSummary candidate,
    bool isDark,
    String lang,
  ) {
    final isEditing = _editingId == candidate.id;
    final isBusy = _actionId == candidate.id;
    final content = _getCandidateText(candidate, 'content');
    final category = _getCandidateText(candidate, 'category');
    final roleText = _getCandidateText(candidate, 'role');
    final role = roleText.isNotEmpty
        ? roleText
        : _getCandidateText(candidate, 'memory_kind');
    final tags = _getCandidateTags(candidate);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: AppTheme.accent.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  category.isEmpty ? I18n.t('common.empty', lang: lang) : category,
                  style: TextStyle(
                    fontSize: 11,
                    color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
                  ),
                ),
              ),
              Text(
                '${I18n.t('settings.memoryCandidatesRole', lang: lang)}: ${role.isEmpty ? I18n.t('common.empty', lang: lang) : role}',
                style: TextStyle(
                  fontSize: 11,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
              ),
              if (candidate.errorReason != null &&
                  candidate.errorReason!.isNotEmpty)
                Text(
                  '${I18n.t('settings.memoryCandidatesErrorReason', lang: lang)}: ${candidate.errorReason}',
                  style: TextStyle(
                    fontSize: 11,
                    color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          if (isEditing)
            TextFormField(
              initialValue: _edits[candidate.id] ?? content,
              maxLines: 3,
              decoration: InputDecoration(
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(
                    color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
                  ),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
              ),
              style: const TextStyle(fontSize: 13),
              onChanged: (v) => _edits[candidate.id] = v,
            )
          else
            Text(
              content.isEmpty ? I18n.t('common.empty', lang: lang) : content,
              style: TextStyle(
                fontSize: 13,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
            ),
          if (tags.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              '${I18n.t('settings.memoryCandidatesTags', lang: lang)}: $tags',
              style: TextStyle(
                fontSize: 11,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              LumiSoftButton(
                label: I18n.t('settings.memoryCandidateAccept', lang: lang),
                kind: LumiSoftButtonKind.primary,
                tiny: true,
                loading: isBusy,
                onTap: isBusy ? null : () => _handleAction(candidate, 'accept'),
              ),
              if (isEditing)
                LumiSoftButton(
                  label: I18n.t('settings.memoryCandidateEditAccept', lang: lang),
                  kind: LumiSoftButtonKind.primary,
                  tiny: true,
                  loading: isBusy,
                  onTap: isBusy
                      ? null
                      : () => _handleAction(candidate, 'edit-accept'),
                )
              else
                LumiSoftButton(
                  label: I18n.t('common.edit', lang: lang),
                  kind: LumiSoftButtonKind.secondary,
                  tiny: true,
                  onTap: isBusy
                      ? null
                      : () => setState(() {
                            _editingId = candidate.id;
                            _edits[candidate.id] = content;
                          }),
                ),
              LumiSoftButton(
                label: I18n.t('settings.memoryCandidateIgnore', lang: lang),
                kind: LumiSoftButtonKind.secondary,
                tiny: true,
                loading: isBusy,
                onTap: isBusy ? null : () => _handleAction(candidate, 'ignore'),
              ),
              LumiSoftButton(
                label: I18n.t('settings.memoryCandidateDiscard', lang: lang),
                kind: LumiSoftButtonKind.danger,
                tiny: true,
                loading: isBusy,
                onTap: isBusy ? null : () => _handleAction(candidate, 'discard'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. MemoryIndexPanel — 对照 MemoryIndexPanel.tsx + useMemoryIndexPanel.ts
// 索引管理：5 个操作按钮（retry/rebuild/indexUnindexed/clear/stopCurrent）
// + 状态展示 + blockedReason + latest_error。
// ─────────────────────────────────────────────────────────────────

class MemoryIndexPanel extends ConsumerStatefulWidget {
  final String characterId;
  const MemoryIndexPanel({super.key, required this.characterId});

  @override
  ConsumerState<MemoryIndexPanel> createState() => _MemoryIndexPanelState();
}

class _MemoryIndexPanelState extends ConsumerState<MemoryIndexPanel> {
  MemoryIndexStatus? _status;
  bool _loading = false;
  bool _rebuilding = false;
  bool _retrying = false;
  bool _indexingUnindexed = false;
  bool _clearing = false;
  bool _stopping = false;
  String? _error;
  Timer? _pollTimer;

  static const _pollInterval = Duration(seconds: 2);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadStatus());
  }

  @override
  void didUpdateWidget(MemoryIndexPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) {
      _loadStatus();
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  /// 计算当前阻塞原因 — 对照主项目 useMemoryIndexPanel 的
  /// status.processing_blocked_reason（后端判断）。Flutter service 不返回该字段，
  /// 故在 panel 内读 settings 按相同优先级判断。
  String? _blockedReason(String lang) {
    final engine = ref
        .read(settingsProvider)
        .valueOrNull
        ?.memoryEngine;
    if (engine == null) return null;
    if (!engine.enabled) {
      return I18n.t('settings.memoryIndexBlocked.memory_engine_disabled', lang: lang);
    }
    if (!engine.allowExternalMemoryPayloads) {
      return I18n.t(
          'settings.memoryIndexBlocked.external_memory_payloads_disabled', lang: lang);
    }
    if (!engine.embeddingEnabled) {
      return I18n.t('settings.memoryIndexBlocked.embedding_disabled', lang: lang);
    }
    if (engine.embeddingApiBase.trim().isEmpty) {
      return I18n.t('settings.memoryIndexBlocked.embedding_api_base_missing', lang: lang);
    }
    if (engine.embeddingModel.trim().isEmpty) {
      return I18n.t('settings.memoryIndexBlocked.embedding_model_missing', lang: lang);
    }
    return null;
  }

  void _updatePolling() {
    final shouldPoll = _rebuilding ||
        _retrying ||
        _indexingUnindexed ||
        (_status?.pending ?? 0) > 0 ||
        (_status?.processing ?? 0) > 0;
    if (shouldPoll && _pollTimer == null) {
      _pollTimer = Timer.periodic(_pollInterval, (_) {
        _loadStatus(silent: true);
      });
    } else if (!shouldPoll && _pollTimer != null) {
      _pollTimer?.cancel();
      _pollTimer = null;
    }
  }

  Future<void> _loadStatus({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      final characterId = widget.characterId;
      final status = await service.getMemoryIndexStatus(
        characterId: characterId.isEmpty ? null : characterId,
      );
      if (!mounted) return;
      setState(() => _status = status);
      _updatePolling();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  Future<void> _handleRebuild() async {
    final lang = ref.read(localeProvider).languageCode;
    setState(() {
      _rebuilding = true;
      _error = null;
    });
    _updatePolling();
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      final cid = widget.characterId;
      await service.enqueueRebuildMemoryEmbeddings(cid);
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryIndexRebuildQueued', lang: lang),
      );
      await _loadStatus(silent: true);
    } catch (e) {
      final lang = ref.read(localeProvider).languageCode;
      final msg = e.toString();
      if (!mounted) return;
      setState(() => _error = msg);
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryIndexRebuildFailed', lang: lang)}: $msg',
      );
    } finally {
      if (mounted) setState(() => _rebuilding = false);
      _updatePolling();
    }
  }

  Future<void> _handleRetryFailed() async {
    final lang = ref.read(localeProvider).languageCode;
    setState(() {
      _retrying = true;
      _error = null;
    });
    _updatePolling();
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      await service.retryFailedMemoryEmbeddings(
        characterId: widget.characterId.isEmpty ? null : widget.characterId,
      );
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryIndexRetryFailedQueued', lang: lang),
      );
      await _loadStatus(silent: true);
    } catch (e) {
      final lang = ref.read(localeProvider).languageCode;
      final msg = e.toString();
      if (!mounted) return;
      setState(() => _error = msg);
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryIndexRetryFailedError', lang: lang)}: $msg',
      );
    } finally {
      if (mounted) setState(() => _retrying = false);
      _updatePolling();
    }
  }

  Future<void> _handleIndexUnindexed() async {
    final lang = ref.read(localeProvider).languageCode;
    final engine = ref
        .read(settingsProvider)
        .valueOrNull
        ?.memoryEngine;
    if (engine == null) return;
    setState(() {
      _indexingUnindexed = true;
      _error = null;
    });
    _updatePolling();
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      await service.enqueueUnindexedMemoryEmbeddings(
        widget.characterId.isEmpty ? null : widget.characterId,
        provider: engine.embeddingApiBase,
        model: engine.embeddingModel,
        dimension: engine.embeddingDimension > 0
            ? engine.embeddingDimension
            : null,
      );
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryIndexIndexUnindexedQueued', lang: lang),
      );
      await _loadStatus(silent: true);
    } catch (e) {
      final lang = ref.read(localeProvider).languageCode;
      final msg = e.toString();
      if (!mounted) return;
      setState(() => _error = msg);
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryIndexIndexUnindexedFailed', lang: lang)}: $msg',
      );
    } finally {
      if (mounted) setState(() => _indexingUnindexed = false);
      _updatePolling();
    }
  }

  Future<void> _handleClear() async {
    final lang = ref.read(localeProvider).languageCode;
    setState(() {
      _clearing = true;
      _error = null;
    });
    _updatePolling();
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      await service.clearMemoryIndex(
        widget.characterId.isEmpty ? null : widget.characterId,
      );
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryIndexClearSuccess', lang: lang),
      );
      await _loadStatus(silent: true);
    } catch (e) {
      final lang = ref.read(localeProvider).languageCode;
      final msg = e.toString();
      if (!mounted) return;
      setState(() => _error = msg);
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryIndexClearFailed', lang: lang)}: $msg',
      );
    } finally {
      if (mounted) setState(() => _clearing = false);
      _updatePolling();
    }
  }

  Future<void> _handleStopCurrent() async {
    final lang = ref.read(localeProvider).languageCode;
    setState(() {
      _stopping = true;
      _error = null;
    });
    _updatePolling();
    try {
      final db = ref.read(databaseProvider);
      final service = MemoryEmbeddingTasksService(db);
      await service.stopCurrentMemoryIndexTasks(
        widget.characterId.isEmpty ? null : widget.characterId,
      );
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryIndexStopCurrentSuccess', lang: lang),
      );
      await _loadStatus(silent: true);
    } catch (e) {
      final lang = ref.read(localeProvider).languageCode;
      final msg = e.toString();
      if (!mounted) return;
      setState(() => _error = msg);
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryIndexStopCurrentFailed', lang: lang)}: $msg',
      );
    } finally {
      if (mounted) setState(() => _stopping = false);
      _updatePolling();
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final s = _status;
    final activeTasks = (s?.pending ?? 0) + (s?.processing ?? 0);
    final blockedReason = _blockedReason(lang);
    final engine = ref
        .watch(settingsProvider)
        .valueOrNull
        ?.memoryEngine;
    final embeddingModel = engine?.embeddingModel ?? '';

    return _MemoryPanelCard(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              I18n.t('settings.memoryIndexStatus', lang: lang),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
            ),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                LumiSoftButton(
                  label: _retrying
                      ? I18n.t('settings.memoryIndexRetrying', lang: lang)
                      : I18n.t('settings.memoryIndexRetryFailed', lang: lang),
                  icon: Icons.refresh,
                  kind: LumiSoftButtonKind.secondary,
                  tiny: true,
                  loading: _retrying,
                  onTap: (_retrying ||
                          _loading ||
                          _rebuilding ||
                          _indexingUnindexed ||
                          _clearing ||
                          _stopping ||
                          (s?.failed ?? 0) == 0)
                      ? null
                      : _handleRetryFailed,
                ),
                LumiSoftButton(
                  label: _rebuilding
                      ? I18n.t('settings.memoryIndexRebuilding', lang: lang)
                      : I18n.t('settings.memoryIndexRebuild', lang: lang),
                  icon: Icons.refresh,
                  kind: LumiSoftButtonKind.secondary,
                  tiny: true,
                  loading: _rebuilding,
                  onTap: (_rebuilding ||
                          _retrying ||
                          _indexingUnindexed ||
                          _loading ||
                          _clearing ||
                          _stopping)
                      ? null
                      : _handleRebuild,
                ),
                LumiSoftButton(
                  label: _indexingUnindexed
                      ? I18n.t('settings.memoryIndexIndexingUnindexed', lang: lang)
                      : I18n.t('settings.memoryIndexIndexUnindexed', lang: lang),
                  icon: Icons.refresh,
                  kind: LumiSoftButtonKind.secondary,
                  tiny: true,
                  loading: _indexingUnindexed,
                  onTap: (_indexingUnindexed ||
                          _rebuilding ||
                          _retrying ||
                          _loading ||
                          _clearing ||
                          _stopping ||
                          embeddingModel.trim().isEmpty)
                      ? null
                      : _handleIndexUnindexed,
                ),
                LumiSoftButton(
                  label: _clearing
                      ? I18n.t('settings.memoryIndexClearing', lang: lang)
                      : I18n.t('settings.memoryIndexClear', lang: lang),
                  icon: Icons.refresh,
                  kind: LumiSoftButtonKind.danger,
                  tiny: true,
                  loading: _clearing,
                  onTap: (_clearing ||
                          _stopping ||
                          _loading ||
                          _rebuilding ||
                          _retrying ||
                          _indexingUnindexed ||
                          (s?.total ?? 0) == 0)
                      ? null
                      : _handleClear,
                ),
                LumiSoftButton(
                  label: _stopping
                      ? I18n.t('settings.memoryIndexStopping', lang: lang)
                      : I18n.t('settings.memoryIndexStopCurrent', lang: lang),
                  icon: Icons.refresh,
                  kind: LumiSoftButtonKind.secondary,
                  tiny: true,
                  loading: _stopping,
                  onTap: (_stopping ||
                          _clearing ||
                          _loading ||
                          _rebuilding ||
                          _retrying ||
                          _indexingUnindexed ||
                          activeTasks == 0)
                      ? null
                      : _handleStopCurrent,
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (ctx, constraints) {
            final cols = constraints.maxWidth >= 640 ? 5 : 2;
            return _StatGrid(
              columns: cols,
              children: [
                _MemoryStatTile(
                  label: I18n.t('settings.memoryIndexIndexed', lang: lang),
                  value: _loading ? '...' : '${s?.ready ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryIndexTotal', lang: lang),
                  value: _loading ? '...' : '${s?.total ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryIndexFailed', lang: lang),
                  value: _loading ? '...' : '${s?.failed ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryIndexQueued', lang: lang),
                  value: _loading ? '...' : '${s?.pending ?? 0}',
                ),
                _MemoryStatTile(
                  label: I18n.t('settings.memoryIndexProcessing', lang: lang),
                  value: _loading ? '...' : '${s?.processing ?? 0}',
                ),
              ],
            );
          },
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            '${I18n.t('common.loadFailed', lang: lang)}: $_error',
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
        if (blockedReason != null) ...[
          const SizedBox(height: 12),
          Text(
            I18n.tArgs('settings.memoryIndexProcessingBlocked',
                {'reason': blockedReason}, lang: lang),
            style: const TextStyle(fontSize: 12, color: Colors.orange),
          ),
        ],
        if (s?.latestError != null && s!.latestError!.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            '${I18n.t('settings.memoryIndexLatestError', lang: lang)}: ${s.latestError}',
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. MemoryProfilePanel — 对照 MemoryProfilePanel.tsx + useMemoryProfilePanel.ts
// 画像管理：当前画像展示 / 编辑（patch）/ 回滚 / 删除版本 / 从记忆初始化。
// ─────────────────────────────────────────────────────────────────

class MemoryProfilePanel extends ConsumerStatefulWidget {
  final String characterId;
  const MemoryProfilePanel({super.key, required this.characterId});

  @override
  ConsumerState<MemoryProfilePanel> createState() =>
      _MemoryProfilePanelState();
}

class _MemoryProfilePanelState extends ConsumerState<MemoryProfilePanel> {
  MemoryProfile? _profile;
  List<MemoryProfileVersion> _versions = const [];
  bool _loading = false;
  bool _actionLoading = false;
  String? _error;
  bool _editing = false;
  // 反重入序列号 — 对照 useMemoryProfilePanel memoryProfileRequestSeqRef。
  int _requestSeq = 0;

  // 编辑模式 controller 缓存（避免每次 build 重建丢失光标）。
  final Map<String, TextEditingController> _controllers = {
    for (final k in const [
      'profile_name',
      'relationship_state',
      'recent_story_state',
      'emotional_baseline',
      'user_profile_summary',
      'pinned_summary',
      'open_threads',
    ])
      k: TextEditingController(),
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void didUpdateWidget(MemoryProfilePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) {
      _reset();
      _load();
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _reset() {
    _profile = null;
    _versions = const [];
    _error = null;
    _editing = false;
  }

  Future<void> _load() async {
    final cid = widget.characterId.trim();
    if (cid.isEmpty) {
      setState(() {
        _reset();
        _loading = false;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    _requestSeq += 1;
    final mySeq = _requestSeq;
    try {
      final db = ref.read(databaseProvider);
      final profileService =
          MemoryProfileService(db, ref.read(llmServiceProvider));
      final profile = await profileService.readMemoryProfile(cid);
      final versions = await profileService.getMemoryProfileVersions(cid);
      if (!mounted || mySeq != _requestSeq) return;
      setState(() {
        _profile = profile;
        _versions = versions;
      });
    } catch (e) {
      if (!mounted || mySeq != _requestSeq) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted && mySeq == _requestSeq) setState(() => _loading = false);
    }
  }

  /// 解析后台 LLM 配置 — 对照主项目 settings.memoryBackgroundModel + 主接口 fallback。
  /// 用于 triggerMemoryProfileQueue 触发后台画像 patch LLM 处理。
  MemoryProfilePatchConfig? _resolvePatchConfig() {
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return null;
    final apiBase = settings.apiBase;
    final apiKey = settings.apiKey;
    final model = settings.memoryBackgroundModel.isNotEmpty
        ? settings.memoryBackgroundModel
        : settings.model;
    if (apiBase.trim().isEmpty || model.trim().isEmpty) return null;
    return MemoryProfilePatchConfig(
      apiBase: apiBase,
      apiKey: apiKey,
      model: model,
      maxTokens: reasoningSafeMaxTokens,
    );
  }

  Future<void> _handleInitFromMemories() async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    if (cid.isEmpty) {
      setState(() =>
          _error = I18n.t('settings.memoryProfileCharacterRequired', lang: lang));
      return;
    }
    setState(() {
      _actionLoading = true;
      _error = null;
    });
    _showMemoryToast(
      context,
      I18n.t('settings.memoryProfileInitFromMemoriesStarted', lang: lang),
    );
    try {
      final db = ref.read(databaseProvider);
      // 读 active memories 拼接 sourceText — 对照主项目 init_from_memories 路由。
      final query = db.select(db.memories)
        ..where((t) => t.characterId.equals(cid) & t.status.equals('active'))
        ..orderBy([(t) => OrderingTerm.desc(t.createdAt)])
        ..limit(200);
      final rows = await query.get();
      if (!mounted) return;
      if (rows.isEmpty) {
        _showMemoryToast(
          context,
          I18n.t('settings.memoryProfileInitFromMemoriesNoMemories', lang: lang),
        );
        return;
      }
      final sourceText =
          rows.map((m) => '[${m.category}] ${m.content}').join('\n');
      final profileService =
          MemoryProfileService(db, ref.read(llmServiceProvider));
      await profileService.enqueueMemoryProfilePatchExtraction(
        cid,
        sourceText,
        reason: 'init_from_memories',
      );
      // 触发队列后台处理（内部 await LLM 调用，非 fire-and-forget chatCompletion）。
      final config = _resolvePatchConfig();
      if (config != null) {
        profileService.triggerMemoryProfileQueue(config: config);
      }
      await _load();
    } catch (e) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryProfileActionFailed', lang: lang)}: $e',
      );
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleRollback(int versionId) async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    if (cid.isEmpty) return;
    setState(() {
      _actionLoading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final profileService =
          MemoryProfileService(db, ref.read(llmServiceProvider));
      await profileService.rollbackMemoryProfile(cid, versionId);
      await _load();
    } catch (e) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryProfileActionFailed', lang: lang)}: $e',
      );
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleDeleteVersion(int versionId) async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    if (cid.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(I18n.t('settings.memoryProfileDeleteVersion', lang: lang)),
        content: Text(I18n.t(
            'settings.memoryProfileDeleteVersionConfirm', lang: lang)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(I18n.t('common.cancel', lang: lang)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(I18n.t('memory.delete', lang: lang)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _actionLoading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final profileService =
          MemoryProfileService(db, ref.read(llmServiceProvider));
      final ok = await profileService.deleteMemoryProfileVersion(cid, versionId);
      if (!mounted) return;
      if (ok) {
        _showMemoryToast(
          context,
          I18n.t('settings.memoryProfileVersionDeleted', lang: lang),
        );
      }
      await _load();
    } catch (e) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryProfileActionFailed', lang: lang)}: $e',
      );
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  void _startEditing() {
    final p = _profile;
    if (p == null) return;
    _controllers['profile_name']!.text = p.profileName;
    _controllers['relationship_state']!.text = p.relationshipState;
    _controllers['recent_story_state']!.text = p.recentStoryState;
    _controllers['emotional_baseline']!.text = p.emotionalBaseline;
    _controllers['user_profile_summary']!.text = p.userProfileSummary;
    _controllers['pinned_summary']!.text = p.pinnedSummary;
    _controllers['open_threads']!.text = p.openThreads.join('\n');
    setState(() => _editing = true);
  }

  void _cancelEditing() {
    setState(() => _editing = false);
  }

  Future<void> _saveEditing() async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    final current = _profile;
    if (cid.isEmpty || current == null) return;

    final patch = MemoryProfilePatch();
    final stringFields = <(String, String, void Function(String))>[
      ('profile_name', current.profileName, (v) => patch.profileName = v),
      ('relationship_state', current.relationshipState,
          (v) => patch.relationshipState = v),
      ('recent_story_state', current.recentStoryState,
          (v) => patch.recentStoryState = v),
      ('emotional_baseline', current.emotionalBaseline,
          (v) => patch.emotionalBaseline = v),
      ('user_profile_summary', current.userProfileSummary,
          (v) => patch.userProfileSummary = v),
      ('pinned_summary', current.pinnedSummary,
          (v) => patch.pinnedSummary = v),
    ];
    for (final (key, currentVal, setter) in stringFields) {
      final newVal = _controllers[key]!.text.trim();
      if (newVal != currentVal.trim()) {
        setter(newVal);
      }
    }
    final threads = _controllers['open_threads']!.text
        .split('\n')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    final currentThreads = current.openThreads;
    if (threads.join('\n') != currentThreads.join('\n')) {
      patch.openThreads = threads;
    }

    if (!hasPatchChanges(patch)) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryProfileEditNoChanges', lang: lang),
      );
      return;
    }

    setState(() {
      _actionLoading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final profileService =
          MemoryProfileService(db, ref.read(llmServiceProvider));
      // 入队已含 patch 的更新任务（reason: 'manual_edit'），对照主项目
      // useMemoryProfilePanel.saveEditingProfile 的 action=enqueue 分支。
      await profileService.enqueueMemoryProfileUpdate(
        cid,
        patch,
        reason: 'manual_edit',
      );
      final config = _resolvePatchConfig();
      if (config != null) {
        profileService.triggerMemoryProfileQueue(config: config);
      }
      setState(() => _editing = false);
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.t('settings.memoryProfileEditSaved', lang: lang),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryProfileActionFailed', lang: lang)}: $e',
      );
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cid = widget.characterId;
    return _MemoryPanelCard(
      children: [
        Text(
          I18n.t('settings.memoryProfileTitle', lang: lang),
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          I18n.t('settings.memoryProfileHint', lang: lang),
          style: TextStyle(
            fontSize: 12,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: LumiSoftButton(
                label: _loading
                    ? I18n.t('common.loading', lang: lang)
                    : I18n.t('settings.memoryCandidatesRefresh', lang: lang),
                icon: Icons.refresh,
                kind: LumiSoftButtonKind.secondary,
                tiny: true,
                loading: _loading,
                onTap: (_loading || cid.isEmpty) ? null : _load,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: LumiSoftButton(
                label: I18n.t(
                    'settings.memoryProfileInitFromMemories', lang: lang),
                kind: LumiSoftButtonKind.primary,
                tiny: true,
                loading: _actionLoading,
                onTap: (_actionLoading || cid.isEmpty)
                    ? null
                    : _handleInitFromMemories,
              ),
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            '${I18n.t('common.loadFailed', lang: lang)}: $_error',
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
        if (_profile != null && !_editing) ...[
          const SizedBox(height: 12),
          _buildCurrentProfileCard(isDark, lang),
          const SizedBox(height: 12),
          _buildVersionsList(isDark, lang),
        ],
        if (_profile != null && _editing) ...[
          const SizedBox(height: 12),
          _buildEditForm(isDark, lang),
        ],
      ],
    );
  }

  Widget _buildCurrentProfileCard(bool isDark, String lang) {
    final p = _profile!;
    final lines = <String>[];
    if (p.relationshipState.trim().isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayRelationship',
          {'value': p.relationshipState.trim()}, lang: lang));
    }
    if (p.recentStoryState.trim().isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayStory',
          {'value': p.recentStoryState.trim()}, lang: lang));
    }
    if (p.emotionalBaseline.trim().isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayEmotion',
          {'value': p.emotionalBaseline.trim()}, lang: lang));
    }
    if (p.openThreads.isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayThreads',
          {'value': p.openThreads.join('；')}, lang: lang));
    }
    if (p.userProfileSummary.trim().isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayUser',
          {'value': p.userProfileSummary.trim()}, lang: lang));
    }
    if (p.pinnedSummary.trim().isNotEmpty) {
      lines.add(I18n.tArgs('settings.memoryProfileDisplayPinned',
          {'value': p.pinnedSummary.trim()}, lang: lang));
    }
    final displayName =
        p.profileName.trim().isNotEmpty ? p.profileName.trim() : p.characterId;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      I18n.t('settings.memoryProfileCurrent', lang: lang),
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      displayName,
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
              LumiSoftButton(
                label: I18n.t('common.edit', lang: lang),
                kind: LumiSoftButtonKind.secondary,
                tiny: true,
                loading: _actionLoading,
                onTap: _actionLoading ? null : _startEditing,
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            lines.isEmpty
                ? I18n.t('settings.memoryProfileEmpty', lang: lang)
                : lines.join('\n'),
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildVersionsList(bool isDark, String lang) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: _versions.isEmpty
          ? Padding(
              padding: const EdgeInsets.all(8),
              child: Text(
                I18n.t('common.empty', lang: lang),
                style: TextStyle(
                  fontSize: 12,
                  color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
                ),
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: _versions
                  .map((v) => _buildVersionItem(v, isDark, lang))
                  .toList(),
            ),
    );
  }

  Widget _buildVersionItem(
      MemoryProfileVersion v, bool isDark, String lang) {
    final versionName = v.snapshot.profileName.trim();
    final versionLabel =
        versionName.isNotEmpty ? versionName : 'v${v.versionNumber}';
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.5)
            : Colors.white.withValues(alpha: 0.7),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: _actionLoading ? null : () => _handleRollback(v.id),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${I18n.t('settings.memoryProfileRollback', lang: lang)} $versionLabel',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: isDark
                            ? AppTheme.darkTextSecondary
                            : AppTheme.textSecondary,
                      ),
                    ),
                    Text(
                      versionName.isNotEmpty
                          ? 'v${v.versionNumber} · ${v.reason}'
                          : v.reason,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: isDark
                            ? AppTheme.darkTextMuted
                            : AppTheme.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: _actionLoading ? null : () => _handleDeleteVersion(v.id),
            child: Container(
              width: 32,
              padding: const EdgeInsets.symmetric(vertical: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(
                    color:
                        isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
                  ),
                ),
              ),
              child: Icon(
                Icons.delete_outline,
                size: 14,
                color: Colors.red.withValues(alpha: 0.7),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEditForm(bool isDark, String lang) {
    final fields = <(String, String, bool)>[
      ('profile_name',
          I18n.t('settings.memoryProfileFieldName', lang: lang), true),
      ('relationship_state',
          I18n.t('settings.memoryProfileFieldRelationship', lang: lang), false),
      ('recent_story_state',
          I18n.t('settings.memoryProfileFieldStory', lang: lang), false),
      ('emotional_baseline',
          I18n.t('settings.memoryProfileFieldEmotion', lang: lang), false),
      ('user_profile_summary',
          I18n.t('settings.memoryProfileFieldUser', lang: lang), false),
      ('pinned_summary',
          I18n.t('settings.memoryProfileFieldPinned', lang: lang), false),
      ('open_threads',
          I18n.t('settings.memoryProfileFieldThreads', lang: lang), false),
    ];
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isDark
            ? AppTheme.darkSurface.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.6),
        border: Border.all(
          color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                I18n.t('settings.memoryProfileEditTitle', lang: lang),
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
              ),
              Row(
                children: [
                  LumiSoftButton(
                    label: I18n.t('common.save', lang: lang),
                    kind: LumiSoftButtonKind.primary,
                    tiny: true,
                    loading: _actionLoading,
                    onTap: _actionLoading ? null : _saveEditing,
                  ),
                  const SizedBox(width: 8),
                  LumiSoftButton(
                    label: I18n.t('common.cancel', lang: lang),
                    kind: LumiSoftButtonKind.secondary,
                    tiny: true,
                    onTap: _actionLoading ? null : _cancelEditing,
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: fields.map((f) {
              final (key, label, singleLine) = f;
              final isWide = key == 'open_threads' || key == 'pinned_summary';
              final widthFactor = isWide ? 1.0 : 0.48;
              return FractionallySizedBox(
                widthFactor: widthFactor,
                child: _buildEditField(
                    key, label, singleLine, isDark),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }

  Widget _buildEditField(
      String key, String label, bool singleLine, bool isDark) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.7)
                : Colors.white.withValues(alpha: 0.8),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: TextField(
            controller: _controllers[key],
            maxLines: singleLine ? 1 : 3,
            minLines: singleLine ? 1 : 2,
            style: TextStyle(
              fontSize: 12,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
            decoration: const InputDecoration(
              border: InputBorder.none,
              contentPadding:
                  EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              isDense: true,
            ),
          ),
        ),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 5. MemoryArchivePanel — 对照 MemoryArchivePanel.tsx + useMemoryArchivePanel.ts
// 归档管理：列出可归档记忆 → 选择 → 写摘要 → 预览/执行/AI 归档/撤销。
// ─────────────────────────────────────────────────────────────────

class MemoryArchivePanel extends ConsumerStatefulWidget {
  final String characterId;
  const MemoryArchivePanel({super.key, required this.characterId});

  @override
  ConsumerState<MemoryArchivePanel> createState() =>
      _MemoryArchivePanelState();
}

class _MemoryArchivePanelState extends ConsumerState<MemoryArchivePanel> {
  List<Memory> _memories = const [];
  Set<String> _selectedIds = {};
  late final TextEditingController _summaryController;
  List<MemoryArchiveBatch> _batches = const [];
  String _selectedBatchId = '';
  MemoryArchivePlan? _plan;
  BatchDetailsResult? _batchDetail;
  bool _loading = false;
  bool _listLoading = false;
  bool _hasMore = false;
  int _total = 0;
  int _offset = 0;
  String? _error;
  bool _aiRunning = false;
  // AI 归档「软中断」flag：用户点停止后置 true，await 返回后跳过 UI 更新。
  // 真正中断 LLM 调用需要 service 层支持 CancelToken（暂未实现）。
  bool _aiAbortRequested = false;

  // 反重入序列号 — 对照 useMemoryArchivePanel 的 4 个 requestSeq ref。
  int _memRequestSeq = 0;
  int _batchRequestSeq = 0;
  int _actionRequestSeq = 0;
  int _detailRequestSeq = 0;

  static const _memLimit = 200;

  @override
  void initState() {
    super.initState();
    _summaryController = TextEditingController();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAll());
  }

  @override
  void didUpdateWidget(MemoryArchivePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.characterId != widget.characterId) {
      _resetForCharacterChange();
      _loadAll();
    }
  }

  @override
  void dispose() {
    _summaryController.dispose();
    super.dispose();
  }

  void _resetForCharacterChange() {
    _memRequestSeq += 1;
    _batchRequestSeq += 1;
    _actionRequestSeq += 1;
    _detailRequestSeq += 1;
    // _actionRequestSeq 自增已使任何在途 AI 请求结果失效（mySeq != _actionRequestSeq）。
    setState(() {
      _memories = const [];
      _selectedIds = {};
      _summaryController.clear();
      _batches = const [];
      _selectedBatchId = '';
      _plan = null;
      _batchDetail = null;
      _loading = false;
      _listLoading = false;
      _hasMore = false;
      _total = 0;
      _offset = 0;
      _error = null;
      _aiRunning = false;
    });
  }

  Future<void> _loadAll() async {
    final cid = widget.characterId.trim();
    if (cid.isEmpty) return;
    await Future.wait([
      _loadMemories(),
      _loadBatches(),
    ]);
  }

  /// 加载可归档记忆（active 且非 archive-summary）。
  /// 对照主项目 GET /api/memories?status=active&exclude_archive_summary=1。
  Future<void> _loadMemories({bool append = false, int offset = 0}) async {
    final cid = widget.characterId.trim();
    if (cid.isEmpty) {
      _memRequestSeq += 1;
      setState(() {
        _memories = const [];
        _selectedIds = {};
        _hasMore = false;
        _total = 0;
        _offset = 0;
        _plan = null;
        _error = null;
        _listLoading = false;
      });
      return;
    }
    _memRequestSeq += 1;
    final mySeq = _memRequestSeq;
    setState(() => _listLoading = true);
    try {
      final db = ref.read(databaseProvider);
      // 多加载一些以补偿 archive-summary 过滤的损耗。
      final query = db.select(db.memories)
        ..where((t) => t.characterId.equals(cid) & t.status.equals('active'))
        ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
        ..limit(_memLimit + 50, offset: offset);
      final rows = await query.get();
      if (!mounted || mySeq != _memRequestSeq) return;
      // 过滤掉归档摘要（metadata.archiveRole=='summary'）
      final filtered = rows.where((m) {
        try {
          if (m.metadata?.isEmpty ?? true) return true;
          final meta = jsonDecode(m.metadata!) as Map<String, dynamic>;
          return meta['archiveRole'] != 'summary';
        } catch (_) {
          return true;
        }
      }).take(_memLimit).toList();
      if (!mounted || mySeq != _memRequestSeq) return;
      setState(() {
        if (append) {
          _memories = [..._memories, ...filtered];
        } else {
          _memories = filtered;
        }
        _total = (append ? _memories.length : filtered.length) + offset;
        _offset = offset + filtered.length;
        _hasMore = filtered.length >= _memLimit;
      });
    } catch (e) {
      if (!mounted || mySeq != _memRequestSeq) return;
      setState(() {
        _error = e.toString();
        if (!append) {
          _memories = const [];
          _hasMore = false;
          _total = 0;
          _offset = 0;
        }
      });
    } finally {
      if (mounted && mySeq == _memRequestSeq) {
        setState(() => _listLoading = false);
      }
    }
  }

  Future<void> _loadBatches() async {
    final cid = widget.characterId.trim();
    if (cid.isEmpty) {
      _batchRequestSeq += 1;
      setState(() {
        _batches = const [];
        _selectedBatchId = '';
      });
      return;
    }
    _batchRequestSeq += 1;
    final mySeq = _batchRequestSeq;
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      final batches = await archiveService.listUndoableMemoryArchiveBatches(cid);
      if (!mounted || mySeq != _batchRequestSeq) return;
      // 保留当前选择（若仍存在）；否则选第一个。
      final stillExists =
          _selectedBatchId.isNotEmpty && batches.any((b) => b.batchId == _selectedBatchId);
      setState(() {
        _batches = batches;
        _selectedBatchId = stillExists
            ? _selectedBatchId
            : (batches.isNotEmpty ? batches.first.batchId : '');
      });
    } catch (e) {
      if (!mounted || mySeq != _batchRequestSeq) return;
      setState(() {
        _error = e.toString();
        _batches = const [];
        _selectedBatchId = '';
      });
    }
  }

  Future<void> _loadBatchDetail(String batchId) async {
    final cid = widget.characterId.trim();
    if (batchId.isEmpty || cid.isEmpty) {
      _detailRequestSeq += 1;
      setState(() => _batchDetail = null);
      return;
    }
    _detailRequestSeq += 1;
    final mySeq = _detailRequestSeq;
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      final detail = await archiveService.getBatchDetails(
        characterId: cid,
        batchId: batchId,
      );
      if (!mounted || mySeq != _detailRequestSeq) return;
      setState(() {
        _batchDetail = detail;
        if (detail?.summary?.content.isNotEmpty == true) {
          _summaryController.text = detail!.summary!.content;
        }
      });
    } catch (_) {
      if (!mounted || mySeq != _detailRequestSeq) return;
      setState(() => _batchDetail = null);
    }
  }

  void _toggleSelection(String memoryId) {
    setState(() {
      if (_selectedIds.contains(memoryId)) {
        _selectedIds = _selectedIds.where((id) => id != memoryId).toSet();
      } else {
        _selectedIds = {..._selectedIds, memoryId};
      }
      _plan = null;
    });
  }

  /// 构造归档请求体校验 — 对照 buildMemoryArchiveBody。
  bool _validateArchiveBody() {
    final cid = widget.characterId.trim();
    final summary = _summaryController.text.trim();
    if (cid.isEmpty || _selectedIds.isEmpty || summary.isEmpty) {
      final lang = ref.read(localeProvider).languageCode;
      setState(() => _error = I18n.t('settings.memoryArchiveRequired', lang: lang));
      return false;
    }
    return true;
  }

  Future<void> _handlePreview() async {
    if (!_validateArchiveBody()) return;
    final cid = widget.characterId.trim();
    final summaryContent = _summaryController.text.trim();
    final coveredIds = _selectedIds.toList();
    _actionRequestSeq += 1;
    final mySeq = _actionRequestSeq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      // 加载 covered 记忆用于构造 plan
      final sourceMemories = await archiveService.loadCoveredMemories(cid, coveredIds);
      if (!mounted || mySeq != _actionRequestSeq) return;
      if (sourceMemories == null) {
        setState(() => _error = 'covered memories not found');
        return;
      }
      final batchId = const Uuid().v4();
      final summaryMemoryId = const Uuid().v4();
      final now = DateTime.now();
      final plan = archiveService.planMemorySummaryArchive(
        batchId: batchId,
        characterId: cid,
        summaryMemoryId: summaryMemoryId,
        summaryContent: summaryContent,
        sourceMemories: sourceMemories,
        now: now,
      );
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() => _plan = plan);
    } catch (e) {
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted && mySeq == _actionRequestSeq) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _handleExecute() async {
    final lang = ref.read(localeProvider).languageCode;
    if (!_validateArchiveBody()) return;
    final cid = widget.characterId.trim();
    final summaryContent = _summaryController.text.trim();
    final coveredIds = _selectedIds.toList();
    _actionRequestSeq += 1;
    final mySeq = _actionRequestSeq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      final batchId = const Uuid().v4();
      final summaryMemoryId = const Uuid().v4();
      final now = DateTime.now();
      final plan = await archiveService.executeMemorySummaryArchive(
        batchId: batchId,
        characterId: cid,
        summaryMemoryId: summaryMemoryId,
        summaryContent: summaryContent,
        coveredMemoryIds: coveredIds,
        now: now,
      );
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() {
        _plan = plan;
        _selectedIds = {};
      });
      if (!mounted) return;
      _showMemoryToast(
        context,
        I18n.tArgs('settings.memoryArchivePlanResult', {
          'summary': plan.summaryMemory.id,
          'count': '${plan.coveredMemoryUpdates.length}',
        }, lang: lang),
      );
      // 重新加载列表与批次
      await Future.wait([
        _loadMemories(),
        _loadBatches(),
      ]);
    } catch (e) {
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted && mySeq == _actionRequestSeq) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _handleUndo() async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    final batchId = _selectedBatchId.trim();
    if (cid.isEmpty || batchId.isEmpty) {
      setState(() => _error =
          I18n.t('settings.memoryArchiveUndoRequired', lang: lang));
      return;
    }
    _actionRequestSeq += 1;
    final mySeq = _actionRequestSeq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      await archiveService.undoMemorySummaryArchiveBatch(
        batchId: batchId,
        characterId: cid,
        now: DateTime.now(),
      );
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() {
        _plan = null;
        _selectedBatchId = '';
        _batchDetail = null;
      });
      await Future.wait([
        _loadMemories(),
        _loadBatches(),
      ]);
    } catch (e) {
      if (!mounted || mySeq != _actionRequestSeq) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted && mySeq == _actionRequestSeq) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _handleAi() async {
    final lang = ref.read(localeProvider).languageCode;
    final cid = widget.characterId.trim();
    if (cid.isEmpty) {
      setState(() => _error =
          I18n.t('settings.memoryArchiveUndoRequired', lang: lang));
      return;
    }
    _actionRequestSeq += 1;
    final mySeq = _actionRequestSeq;
    final settings = ref.read(settingsProvider).valueOrNull;
    if (settings == null) return;
    setState(() {
      _aiRunning = true;
      _aiAbortRequested = false;
      _loading = true;
      _error = null;
      _plan = null;
    });
    try {
      final db = ref.read(databaseProvider);
      final archiveService = MemoryArchiveService(
        db,
        ref.read(llmServiceProvider),
      );
      // 构造 AI 归档用的 AppSettings — 用 memoryBackgroundModel 回退到主 model。
      final aiSettings = AppSettings(
        apiBase: settings.apiBase,
        apiKey: settings.apiKey,
        model: settings.memoryBackgroundModel.isNotEmpty
            ? settings.memoryBackgroundModel
            : settings.model,
        jsonMode: true,
        streaming: false,
        maxTokens: reasoningSafeMaxTokens,
      );
      final result = await archiveService.aiArchiveMemories(
        characterId: cid,
        settings: aiSettings,
      );
      if (!mounted || mySeq != _actionRequestSeq || _aiAbortRequested) return;
      if (!result.archived) {
        if (result.error == 'no_archivable_memories' ||
            result.error == 'no_archive_needed') {
          _showMemoryToast(
            context,
            I18n.t('settings.memoryArchiveAiNoArchiveNeeded', lang: lang),
          );
        } else {
          final msg = result.error ??
              I18n.t('settings.memoryArchiveAiFailed', lang: lang);
          _showMemoryToast(context, msg);
          setState(() => _error = msg);
        }
      } else {
        _showMemoryToast(
          context,
          I18n.tArgs('settings.memoryArchiveAiDone', {
            'count': '${result.archiveCount}',
          }, lang: lang),
        );
        if (result.summary.isNotEmpty) {
          _summaryController.text = result.summary;
        }
      }
      await Future.wait([
        _loadMemories(),
        _loadBatches(),
      ]);
    } catch (e) {
      if (!mounted || mySeq != _actionRequestSeq || _aiAbortRequested) return;
      final msg = e.toString();
      if (!mounted) return;
      _showMemoryToast(
        context,
        '${I18n.t('settings.memoryArchiveAiFailed', lang: lang)}: $msg',
      );
      setState(() => _error = msg);
    } finally {
      if (mounted && mySeq == _actionRequestSeq && !_aiAbortRequested) {
        setState(() {
          _aiRunning = false;
          _loading = false;
        });
      }
    }
  }

  void _handleStopAi() {
    final lang = ref.read(localeProvider).languageCode;
    // 真正中断 LLM 调用需要 service 层支持 CancelToken；这里只做软中断
    // （await 返回后跳过 UI 更新），与主项目 AbortController 行为对齐。
    _aiAbortRequested = true;
    _showMemoryToast(
      context,
      I18n.t('settings.memoryArchiveAiStopping', lang: lang),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cid = widget.characterId;
    final shownCount = _memories.length > _offset ? _memories.length : _offset;
    return _MemoryPanelCard(
      children: [
        Text(
          I18n.t('settings.memoryArchiveTitle', lang: lang),
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          I18n.t('settings.memoryArchiveHint', lang: lang),
          style: TextStyle(
            fontSize: 12,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
        const SizedBox(height: 12),
        // 选择记忆区
        Text(
          I18n.t('settings.memoryArchiveSelectMemories', lang: lang),
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          I18n.tArgs('settings.memoryArchiveShownCount', {
            'shown': '$shownCount',
            'total': '$_total',
          }, lang: lang),
          style: TextStyle(
            fontSize: 12,
            color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
          ),
        ),
        const SizedBox(height: 8),
        if (_memories.isEmpty)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: isDark
                  ? AppTheme.darkSurface.withValues(alpha: 0.4)
                  : Colors.white.withValues(alpha: 0.6),
              border: Border.all(
                color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
              ),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              cid.isEmpty
                  ? I18n.t('settings.memoryManagementChooseCharacter', lang: lang)
                  : I18n.t('settings.memoryArchiveNoMemories', lang: lang),
              style: TextStyle(
                fontSize: 12,
                color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
              ),
            ),
          )
        else
          Container(
            constraints: const BoxConstraints(maxHeight: 256),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: isDark
                  ? AppTheme.darkSurface.withValues(alpha: 0.4)
                  : Colors.white.withValues(alpha: 0.6),
              border: Border.all(
                color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
              ),
              borderRadius: BorderRadius.circular(12),
            ),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: _memories.length,
              itemBuilder: (ctx, i) => _buildMemoryItem(_memories[i], isDark, lang),
            ),
          ),
        if (_hasMore && cid.isNotEmpty) ...[
          const SizedBox(height: 8),
          LumiSoftButton(
            label: _listLoading
                ? I18n.t('common.loading', lang: lang)
                : I18n.t('settings.memoryArchiveLoadMore', lang: lang),
            icon: Icons.refresh,
            kind: LumiSoftButtonKind.secondary,
            tiny: true,
            loading: _listLoading,
            onTap: _listLoading
                ? null
                : () => _loadMemories(
                      append: true,
                      offset: _memories.length,
                    ),
          ),
        ],
        const SizedBox(height: 12),
        // 批次选择区
        Text(
          I18n.t('settings.memoryArchiveSelectBatch', lang: lang),
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 4),
        SettingsRichSelect<String>(
          value: _selectedBatchId,
          items: [
            SettingsRichSelectItem<String>(
              value: '',
              label: I18n.t('settings.memoryArchiveNoBatches', lang: lang),
            ),
            ..._batches.map(
              (b) {
                final summary = b.summaryContent.length > 60
                    ? '${b.summaryContent.substring(0, 60)}...'
                    : b.summaryContent;
                return SettingsRichSelectItem<String>(
                  value: b.batchId,
                  label: '${summary.isEmpty ? b.batchId : summary} (${b.coveredCount})',
                );
              },
            ),
          ],
          onChanged: (v) {
            setState(() => _selectedBatchId = v);
            _loadBatchDetail(v);
          },
        ),
        if (_batchDetail != null) ...[
          const SizedBox(height: 8),
          Container(
            constraints: const BoxConstraints(maxHeight: 128),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: isDark
                  ? AppTheme.darkSurface.withValues(alpha: 0.4)
                  : Colors.white.withValues(alpha: 0.6),
              border: Border.all(
                color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: ListView(
              shrinkWrap: true,
              children: [
                if (_batchDetail!.summary != null) ...[
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 4),
                    margin: const EdgeInsets.only(bottom: 8),
                    decoration: BoxDecoration(
                      color: isDark
                          ? AppTheme.darkSurface.withValues(alpha: 0.5)
                          : Colors.white.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      _batchDetail!.summary!.content,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: isDark
                            ? AppTheme.darkTextPrimary
                            : AppTheme.textPrimary,
                      ),
                    ),
                  ),
                ],
                ..._batchDetail!.covered.map(
                  (m) => Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '[${m.category}]',
                          style: TextStyle(
                            fontSize: 12,
                            color: isDark
                                ? AppTheme.darkTextMuted
                                : AppTheme.textMuted,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            m.content,
                            style: TextStyle(
                              fontSize: 12,
                              color: isDark
                                  ? AppTheme.darkTextSecondary
                                  : AppTheme.textSecondary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 12),
        // 摘要 textarea
        Container(
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.darkSurface.withValues(alpha: 0.7)
                : Colors.white.withValues(alpha: 0.8),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: TextField(
            controller: _summaryController,
            maxLines: 3,
            minLines: 2,
            style: TextStyle(
              fontSize: 13,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
            decoration: InputDecoration(
              hintText: I18n.t('settings.memoryArchiveSummary', lang: lang),
              hintStyle: TextStyle(
                fontSize: 13,
                color: (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted)
                    .withValues(alpha: 0.7),
              ),
              border: InputBorder.none,
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              isDense: true,
            ),
            onChanged: (_) => setState(() => _plan = null),
          ),
        ),
        const SizedBox(height: 12),
        // 操作按钮组
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            LumiSoftButton(
              label: _aiRunning
                  ? I18n.t('common.loading', lang: lang)
                  : I18n.t('settings.memoryArchiveAi', lang: lang),
              icon: Icons.auto_awesome,
              kind: LumiSoftButtonKind.primary,
              tiny: true,
              loading: _aiRunning,
              onTap: (_aiRunning || _loading || cid.isEmpty)
                  ? null
                  : _handleAi,
            ),
            if (_aiRunning)
              LumiSoftButton(
                label: I18n.t('settings.memoryArchiveAiStop', lang: lang),
                icon: Icons.stop,
                kind: LumiSoftButtonKind.danger,
                tiny: true,
                onTap: _handleStopAi,
              ),
            LumiSoftButton(
              label: I18n.t('settings.memoryArchivePreview', lang: lang),
              kind: LumiSoftButtonKind.secondary,
              tiny: true,
              loading: _loading,
              onTap: (_loading || cid.isEmpty) ? null : _handlePreview,
            ),
            LumiSoftButton(
              label: I18n.t('settings.memoryArchiveExecute', lang: lang),
              kind: LumiSoftButtonKind.secondary,
              tiny: true,
              loading: _loading,
              onTap: (_loading || cid.isEmpty) ? null : _handleExecute,
            ),
            LumiSoftButton(
              label: I18n.t('settings.memoryArchiveUndo', lang: lang),
              kind: LumiSoftButtonKind.danger,
              tiny: true,
              loading: _loading,
              onTap: (_loading || cid.isEmpty || _selectedBatchId.isEmpty)
                  ? null
                  : _handleUndo,
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: const TextStyle(fontSize: 12, color: Colors.red),
          ),
        ],
        if (_plan != null) ...[
          const SizedBox(height: 12),
          Text(
            I18n.tArgs('settings.memoryArchivePlanResult', {
              'summary': _plan!.summaryMemory.id,
              'count': '${_plan!.coveredMemoryUpdates.length}',
            }, lang: lang),
            style: TextStyle(
              fontSize: 12,
              color: isDark ? AppTheme.darkTextMuted : AppTheme.textMuted,
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildMemoryItem(Memory m, bool isDark, String lang) {
    final selected = _selectedIds.contains(m.id);
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => _toggleSelection(m.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 20,
              height: 20,
              child: Checkbox(
                value: selected,
                onChanged: (_) => _toggleSelection(m.id),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                visualDensity: VisualDensity.compact,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    m.pinned
                        ? '${m.category} · ${m.status} · ${I18n.t('common.current', lang: lang)}'
                        : '${m.category} · ${m.status}',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: isDark
                          ? AppTheme.darkTextPrimary
                          : AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    m.content,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      color: isDark
                          ? AppTheme.darkTextSecondary
                          : AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
