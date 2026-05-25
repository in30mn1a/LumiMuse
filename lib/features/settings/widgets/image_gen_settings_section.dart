import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/models/app_settings.dart';
import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';

/// 图片生成设置区域 — 包含引擎选择和各引擎参数配置
///
/// 复用 SettingsPage 的 _SectionCard / _SwitchTile / _SliderTile 组件模式，
/// 但因为跨文件无法直接复用私有组件，这里重新定义同风格的内部组件。
class ImageGenSettingsSection extends ConsumerStatefulWidget {
  const ImageGenSettingsSection({super.key});

  @override
  ConsumerState<ImageGenSettingsSection> createState() =>
      _ImageGenSettingsSectionState();
}

class _ImageGenSettingsSectionState
    extends ConsumerState<ImageGenSettingsSection> {
  // 各引擎文本控制器 — 保持用户输入不丢失
  // SD WebUI
  final _sdUrlCtrl = TextEditingController();
  final _sdModelCtrl = TextEditingController();
  final _sdSamplerCtrl = TextEditingController();
  final _sdNegativeCtrl = TextEditingController();
  // NovelAI
  final _naiApiKeyCtrl = TextEditingController();
  final _naiModelCtrl = TextEditingController();
  final _naiSamplerCtrl = TextEditingController();
  final _naiNoiseCtrl = TextEditingController();
  final _naiNegativeCtrl = TextEditingController();
  final _naiArtistCtrl = TextEditingController();
  // ComfyUI
  final _comfyUrlCtrl = TextEditingController();
  final _comfyWorkflowCtrl = TextEditingController();
  // 自定义 API
  final _customUrlCtrl = TextEditingController();
  final _customApiKeyCtrl = TextEditingController();
  final _customModelCtrl = TextEditingController();
  final _customSizeCtrl = TextEditingController();
  // 通用
  final _qualityTagsCtrl = TextEditingController();
  final _autoKeywordsCtrl = TextEditingController();

  // 画师串管理预设状态
  String? _selectedPresetId;
  final _presetNameCtrl = TextEditingController();

  // 数字输入控制器（P0-5：避免 build 中重复创建）
  // SD
  final _sdStepsCtrl = TextEditingController();
  final _sdCfgCtrl = TextEditingController();
  final _sdWidthCtrl = TextEditingController();
  final _sdHeightCtrl = TextEditingController();
  // NAI
  final _naiStepsCtrl = TextEditingController();
  final _naiScaleCtrl = TextEditingController();
  final _naiCfgRescaleCtrl = TextEditingController();
  final _naiWidthCtrl = TextEditingController();
  final _naiHeightCtrl = TextEditingController();

  // P1-12：仅首次加载同步控制器，后续由 ref.listen 处理外部变化
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    // 监听 settings 变化，按需更新 controller（避免覆盖光标）
    ref.listenManual<AsyncValue<AppSettings>>(settingsProvider, (prev, next) {
      final newSettings = next.valueOrNull;
      if (newSettings == null) return;
      _syncControllersFromSettings(newSettings.imageGen, force: false);
    });
  }

  @override
  void dispose() {
    _sdUrlCtrl.dispose();
    _sdModelCtrl.dispose();
    _sdSamplerCtrl.dispose();
    _sdNegativeCtrl.dispose();
    _naiApiKeyCtrl.dispose();
    _naiModelCtrl.dispose();
    _naiSamplerCtrl.dispose();
    _naiNoiseCtrl.dispose();
    _naiNegativeCtrl.dispose();
    _naiArtistCtrl.dispose();
    _comfyUrlCtrl.dispose();
    _comfyWorkflowCtrl.dispose();
    _customUrlCtrl.dispose();
    _customApiKeyCtrl.dispose();
    _customModelCtrl.dispose();
    _customSizeCtrl.dispose();
    _qualityTagsCtrl.dispose();
    _autoKeywordsCtrl.dispose();
    _sdStepsCtrl.dispose();
    _sdCfgCtrl.dispose();
    _sdWidthCtrl.dispose();
    _sdHeightCtrl.dispose();
    _naiStepsCtrl.dispose();
    _naiScaleCtrl.dispose();
    _naiCfgRescaleCtrl.dispose();
    _naiWidthCtrl.dispose();
    _naiHeightCtrl.dispose();
    _presetNameCtrl.dispose();
    super.dispose();
  }

  /// 设置 controller 文本，仅当当前文本与目标不同（避免光标跳动）
  void _setIfChanged(TextEditingController ctrl, String value) {
    if (ctrl.text != value) {
      ctrl.text = value;
    }
  }

  /// 将设置值同步到控制器
  ///
  /// - force=true: 首次加载，无条件赋值
  /// - force=false: 仅在控制器与设置不一致时才更新（避免覆盖正在输入的光标）
  void _syncControllersFromSettings(ImageGenSettings s, {required bool force}) {
    if (force) {
      _sdUrlCtrl.text = s.sdUrl;
      _sdModelCtrl.text = s.sdModel;
      _sdSamplerCtrl.text = s.sdSampler;
      _sdNegativeCtrl.text = s.sdNegativePrompt;
      _naiApiKeyCtrl.text = s.naiApiKey;
      _naiModelCtrl.text = s.naiModel;
      _naiSamplerCtrl.text = s.naiSampler;
      _naiNoiseCtrl.text = s.naiNoiseSchedule;
      _naiNegativeCtrl.text = s.naiNegativePrompt;
      _naiArtistCtrl.text = s.naiArtistTags;
      _comfyUrlCtrl.text = s.comfyuiUrl;
      _comfyWorkflowCtrl.text = s.comfyuiWorkflow;
      _customUrlCtrl.text = s.customUrl;
      _customApiKeyCtrl.text = s.customApiKey;
      _customModelCtrl.text = s.customModel;
      _customSizeCtrl.text = s.customSize;
      _qualityTagsCtrl.text = s.qualityTags;
      _autoKeywordsCtrl.text = s.autoGenerateKeywords;
      _sdStepsCtrl.text = s.sdSteps.toString();
      _sdCfgCtrl.text = s.sdCfgScale.toStringAsFixed(1);
      _sdWidthCtrl.text = s.sdWidth.toString();
      _sdHeightCtrl.text = s.sdHeight.toString();
      _naiStepsCtrl.text = s.naiSteps.toString();
      _naiScaleCtrl.text = s.naiScale.toStringAsFixed(1);
      _naiCfgRescaleCtrl.text = s.naiCfgRescale.toStringAsFixed(2);
      _naiWidthCtrl.text = s.naiWidth.toString();
      _naiHeightCtrl.text = s.naiHeight.toString();
      return;
    }
    _setIfChanged(_sdUrlCtrl, s.sdUrl);
    _setIfChanged(_sdModelCtrl, s.sdModel);
    _setIfChanged(_sdSamplerCtrl, s.sdSampler);
    _setIfChanged(_sdNegativeCtrl, s.sdNegativePrompt);
    _setIfChanged(_naiApiKeyCtrl, s.naiApiKey);
    _setIfChanged(_naiModelCtrl, s.naiModel);
    _setIfChanged(_naiSamplerCtrl, s.naiSampler);
    _setIfChanged(_naiNoiseCtrl, s.naiNoiseSchedule);
    _setIfChanged(_naiNegativeCtrl, s.naiNegativePrompt);
    _setIfChanged(_naiArtistCtrl, s.naiArtistTags);
    _setIfChanged(_comfyUrlCtrl, s.comfyuiUrl);
    _setIfChanged(_comfyWorkflowCtrl, s.comfyuiWorkflow);
    _setIfChanged(_customUrlCtrl, s.customUrl);
    _setIfChanged(_customApiKeyCtrl, s.customApiKey);
    _setIfChanged(_customModelCtrl, s.customModel);
    _setIfChanged(_customSizeCtrl, s.customSize);
    _setIfChanged(_qualityTagsCtrl, s.qualityTags);
    _setIfChanged(_autoKeywordsCtrl, s.autoGenerateKeywords);
    _setIfChanged(_sdStepsCtrl, s.sdSteps.toString());
    _setIfChanged(_sdCfgCtrl, s.sdCfgScale.toStringAsFixed(1));
    _setIfChanged(_sdWidthCtrl, s.sdWidth.toString());
    _setIfChanged(_sdHeightCtrl, s.sdHeight.toString());
    _setIfChanged(_naiStepsCtrl, s.naiSteps.toString());
    _setIfChanged(_naiScaleCtrl, s.naiScale.toStringAsFixed(1));
    _setIfChanged(_naiCfgRescaleCtrl, s.naiCfgRescale.toStringAsFixed(2));
    _setIfChanged(_naiWidthCtrl, s.naiWidth.toString());
    _setIfChanged(_naiHeightCtrl, s.naiHeight.toString());
  }

  /// 更新图片生成设置并持久化
  Future<void> _updateImageGen(
    ImageGenSettings Function(ImageGenSettings) updater,
  ) async {
    final current =
        ref.read(settingsProvider).valueOrNull ?? const AppSettings();
    final newImageGen = updater(current.imageGen);
    // 允许先启用再填写 URL；已启用后的保存仍校验当前引擎 URL。
    if (newImageGen.enabled && current.imageGen.enabled) {
      String? urlField;
      if (newImageGen.engine == 'sd') {
        urlField = newImageGen.sdUrl;
      } else if (newImageGen.engine == 'comfyui') {
        urlField = newImageGen.comfyuiUrl;
      } else if (newImageGen.engine == 'custom') {
        urlField = newImageGen.customUrl;
      }
      if (urlField != null && urlField.trim().isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('请先填写 URL 地址')));
        }
        return;
      }
    }
    final newSettings = current.copyWith(imageGen: newImageGen);
    try {
      await ref.read(settingsProvider.notifier).updateSettings(newSettings);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          // TODO(parity): 主项目缺失 'imageGen.saveFailed' 键，硬编码兜底
          SnackBar(content: Text('保存失败: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    // 任务 6.5：i18n 接线 — 顶层取一次语言码分发到各分区
    final String lang = ref.watch(localeProvider).languageCode;

    return settingsAsync.when(
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (settings) {
        final ig = settings.imageGen;
        if (!_loaded) {
          _syncControllersFromSettings(ig, force: true);
          _loaded = true;
        }

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // 通用设置（启用开关 + 品质标签）
            _buildSection(
              isDark: isDark,
              title: I18n.t('settings.imageGen', lang: lang),
              icon: Icons.image_outlined,
              children: [
                _buildSwitch(
                  title: I18n.t('settings.imageGenEnabled', lang: lang),
                  value: ig.enabled,
                  onChanged: (v) =>
                      _updateImageGen((s) => s.copyWith(enabled: v)),
                ),
                // 主项目 ChatView/Settings 对照：未启用时仅显示开关，
                // 引擎/品质标签/参数/自动生图都隐藏，避免无效配置占据空间
                if (ig.enabled) ...[
                  const SizedBox(height: 8),
                  _buildDropdown(
                    title: I18n.t('settings.imageGenEngine', lang: lang),
                    value: ig.engine,
                    items: {
                      'sd': I18n.t('settings.imageGenSD', lang: lang),
                      'nai': I18n.t('settings.imageGenNAI', lang: lang),
                      'comfyui': I18n.t('settings.imageGenComfyUI', lang: lang),
                      'custom': I18n.t('settings.imageGenCustom', lang: lang),
                    },
                    onChanged: (v) =>
                        _updateImageGen((s) => s.copyWith(engine: v)),
                  ),
                  const SizedBox(height: 8),
                  _buildTextField(
                    label: I18n.t('settings.imageGenQuality', lang: lang),
                    controller: _qualityTagsCtrl,
                    maxLength: 500,
                    maxLines: 2,
                    onChanged: (v) =>
                        _updateImageGen((s) => s.copyWith(qualityTags: v)),
                  ),
                ],
              ],
            ),

            // 启用后才显示引擎专属参数 + 自动生图区块
            if (ig.enabled) ...[
              const SizedBox(height: 16),
              if (ig.engine == 'sd') _buildSdParams(ig, isDark, lang),
              if (ig.engine == 'nai')
                _buildNaiParams(settings, ig, isDark, lang),
              if (ig.engine == 'comfyui') _buildComfyParams(ig, isDark, lang),
              if (ig.engine == 'custom') _buildCustomParams(ig, isDark, lang),

              const SizedBox(height: 16),

              // 自动生图设置
              _buildSection(
                isDark: isDark,
                title: I18n.t('settings.imageGenAuto', lang: lang),
                icon: Icons.auto_awesome,
                children: [
                  _buildSwitch(
                    title: I18n.t('settings.imageGenAuto', lang: lang),
                    value: ig.autoGenerate,
                    onChanged: (v) =>
                        _updateImageGen((s) => s.copyWith(autoGenerate: v)),
                  ),
                  if (ig.autoGenerate) ...[
                    const SizedBox(height: 8),
                    _buildTextField(
                      label: I18n.t(
                        'settings.imageGenAutoKeywords',
                        lang: lang,
                      ),
                      controller: _autoKeywordsCtrl,
                      maxLength: 500,
                      onChanged: (v) => _updateImageGen(
                        (s) => s.copyWith(autoGenerateKeywords: v),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ],
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SD WebUI 参数
  // ═══════════════════════════════════════════════════════════════

  Widget _buildSdParams(ImageGenSettings ig, bool isDark, String lang) {
    return _buildSection(
      isDark: isDark,
      // TODO(parity): 主项目缺失 'settings.imageGenSDParams' 键，硬编码兜底
      title: 'SD WebUI 参数',
      icon: Icons.settings_applications,
      children: [
        _buildTextField(
          label: I18n.t('settings.imageGenSDUrl', lang: lang),
          controller: _sdUrlCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdUrl: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenSDModel', lang: lang),
          controller: _sdModelCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdModel: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenSDSampler', lang: lang),
          controller: _sdSamplerCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdSampler: v)),
        ),
        const SizedBox(height: 8),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDSteps', lang: lang),
          controller: _sdStepsCtrl,
          value: ig.sdSteps.toDouble(),
          min: 1,
          max: 150,
          isInt: true,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(sdSteps: v.toInt())),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDCfg', lang: lang),
          controller: _sdCfgCtrl,
          value: ig.sdCfgScale,
          min: 1,
          max: 30,
          step: 0.5,
          decimals: 1,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdCfgScale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDWidth', lang: lang),
          controller: _sdWidthCtrl,
          value: ig.sdWidth.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen(
            (s) => s.copyWith(sdWidth: (v / 64).round() * 64),
          ),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDHeight', lang: lang),
          controller: _sdHeightCtrl,
          value: ig.sdHeight.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen(
            (s) => s.copyWith(sdHeight: (v / 64).round() * 64),
          ),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenSDNeg', lang: lang),
          controller: _sdNegativeCtrl,
          maxLines: 3,
          maxLength: 2000,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(sdNegativePrompt: v)),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // NovelAI 参数
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // 画师串管理预设业务逻辑
  // ═══════════════════════════════════════════════════════════════

  Future<void> _handleSaveAsPreset(AppSettings settings) async {
    final name = _presetNameCtrl.text.trim();
    final tags = _naiArtistCtrl.text.trim();
    if (name.isEmpty || tags.isEmpty) return;

    final newPreset = ArtistString(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      name: name,
      tags: tags,
    );

    final newArtistStrings = [...settings.artistStrings, newPreset];
    final newSettings = settings.copyWith(artistStrings: newArtistStrings);
    await ref.read(settingsProvider.notifier).updateSettings(newSettings);

    setState(() {
      _selectedPresetId = newPreset.id;
      _presetNameCtrl.clear();
    });
  }

  Future<void> _handleUpdatePreset(AppSettings settings) async {
    if (_selectedPresetId == null) return;
    final tags = _naiArtistCtrl.text.trim();

    final newArtistStrings = settings.artistStrings.map((a) {
      if (a.id == _selectedPresetId) {
        return a.copyWith(tags: tags);
      }
      return a;
    }).toList();

    final newSettings = settings.copyWith(artistStrings: newArtistStrings);
    await ref.read(settingsProvider.notifier).updateSettings(newSettings);
  }

  Future<void> _handleDeletePreset(AppSettings settings, String lang) async {
    if (_selectedPresetId == null) return;

    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(I18n.t('settings.artistStringsDelete', lang: lang)),
        content: Text(
          I18n.t('settings.artistStringsDeleteConfirm', lang: lang),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(I18n.t('common.cancel', lang: lang)),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              I18n.t('common.delete', lang: lang),
              style: const TextStyle(color: Colors.red),
            ),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    final newArtistStrings = settings.artistStrings
        .where((a) => a.id != _selectedPresetId)
        .toList();

    final newSettings = settings.copyWith(artistStrings: newArtistStrings);
    await ref.read(settingsProvider.notifier).updateSettings(newSettings);

    setState(() {
      _selectedPresetId = null;
    });
  }

  void _handleSelectPreset(AppSettings settings, String? id) {
    if (id == null || id.isEmpty) {
      setState(() {
        _selectedPresetId = null;
      });
      return;
    }

    final preset = settings.artistStrings.firstWhere((a) => a.id == id);
    _setIfChanged(_naiArtistCtrl, preset.tags);
    _updateImageGen((s) => s.copyWith(naiArtistTags: preset.tags));

    setState(() {
      _selectedPresetId = id;
    });
  }

  void _handleArtistTagsChange(String tags) {
    _updateImageGen((s) => s.copyWith(naiArtistTags: tags));
  }

  // ═══════════════════════════════════════════════════════════════
  // NovelAI 参数
  // ═══════════════════════════════════════════════════════════════

  Widget _buildNaiParams(
    AppSettings settings,
    ImageGenSettings ig,
    bool isDark,
    String lang,
  ) {
    return _buildSection(
      isDark: isDark,
      title: 'NovelAI 参数',
      icon: Icons.brush_outlined,
      children: [
        _buildTextField(
          label: I18n.t('settings.imageGenNAIKey', lang: lang),
          controller: _naiApiKeyCtrl,
          obscure: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiApiKey: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAIModel', lang: lang),
          controller: _naiModelCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiModel: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAISampler', lang: lang),
          controller: _naiSamplerCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiSampler: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAINoiseSchedule', lang: lang),
          controller: _naiNoiseCtrl,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(naiNoiseSchedule: v)),
        ),
        const SizedBox(height: 8),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAISteps', lang: lang),
          controller: _naiStepsCtrl,
          value: ig.naiSteps.toDouble(),
          min: 1,
          max: 50,
          isInt: true,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(naiSteps: v.toInt())),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIScale', lang: lang),
          controller: _naiScaleCtrl,
          value: ig.naiScale,
          min: 0,
          max: 25,
          step: 0.1,
          decimals: 1,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiScale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAICfgRescale', lang: lang),
          controller: _naiCfgRescaleCtrl,
          value: ig.naiCfgRescale,
          min: 0,
          max: 1,
          step: 0.01,
          decimals: 2,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(naiCfgRescale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIWidth', lang: lang),
          controller: _naiWidthCtrl,
          value: ig.naiWidth.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen(
            (s) => s.copyWith(naiWidth: (v / 64).round() * 64),
          ),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIHeight', lang: lang),
          controller: _naiHeightCtrl,
          value: ig.naiHeight.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen(
            (s) => s.copyWith(naiHeight: (v / 64).round() * 64),
          ),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAINeg', lang: lang),
          controller: _naiNegativeCtrl,
          maxLines: 3,
          maxLength: 2000,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(naiNegativePrompt: v)),
        ),
        const SizedBox(height: 16),

        // === 画师串管理预设 UI ===
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              I18n.t('settings.artistStringsManage', lang: lang),
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              // ignore: deprecated_member_use
              value: _selectedPresetId,
              decoration: InputDecoration(
                labelText: I18n.t('settings.artistStringsSelect', lang: lang),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
              items: [
                DropdownMenuItem<String>(
                  value: null,
                  child: Text(
                    I18n.t('settings.artistStringsCustom', lang: lang),
                  ),
                ),
                ...settings.artistStrings.map(
                  (a) => DropdownMenuItem<String>(
                    value: a.id,
                    child: Text(a.name),
                  ),
                ),
              ],
              onChanged: (v) => _handleSelectPreset(settings, v),
            ),
            const SizedBox(height: 8),
            _buildTextField(
              label: I18n.t('settings.imageGenNAIArtist', lang: lang),
              controller: _naiArtistCtrl,
              maxLength: 500,
              maxLines: 2,
              onChanged: _handleArtistTagsChange,
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _presetNameCtrl,
                    style: const TextStyle(fontSize: 13),
                    decoration: InputDecoration(
                      hintText: I18n.t(
                        'settings.artistStringsNamePrompt',
                        lang: lang,
                      ),
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 10,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                TextButton(
                  onPressed: _naiArtistCtrl.text.trim().isEmpty
                      ? null
                      : () => _handleSaveAsPreset(settings),
                  style: TextButton.styleFrom(
                    backgroundColor: AppTheme.accent.withValues(alpha: 0.12),
                    foregroundColor: AppTheme.accentDark,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                  ),
                  child: Text(
                    I18n.t('settings.artistStringsSaveAs', lang: lang),
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (_selectedPresetId != null) ...[
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => _handleUpdatePreset(settings),
                    style: TextButton.styleFrom(
                      backgroundColor: Colors.blue.withValues(alpha: 0.1),
                      foregroundColor: Colors.blue[700],
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                    ),
                    child: Text(
                      I18n.t('settings.artistStringsUpdate', lang: lang),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: () => _handleDeletePreset(settings, lang),
                    style: TextButton.styleFrom(
                      backgroundColor: Colors.red.withValues(alpha: 0.1),
                      foregroundColor: Colors.red[700],
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                    ),
                    child: Text(
                      I18n.t('settings.artistStringsDelete', lang: lang),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ComfyUI 参数
  // ═══════════════════════════════════════════════════════════════

  Widget _buildComfyParams(ImageGenSettings ig, bool isDark, String lang) {
    return _buildSection(
      isDark: isDark,
      // TODO(parity): 主项目缺失 'settings.imageGenComfyParams' 键，硬编码兜底
      title: 'ComfyUI 参数',
      icon: Icons.account_tree_outlined,
      children: [
        _buildTextField(
          label: I18n.t('settings.imageGenComfyUrl', lang: lang),
          controller: _comfyUrlCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(comfyuiUrl: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenComfyWorkflow', lang: lang),
          controller: _comfyWorkflowCtrl,
          maxLines: 6,
          onChanged: (v) =>
              _updateImageGen((s) => s.copyWith(comfyuiWorkflow: v)),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 自定义 API 参数
  // ═══════════════════════════════════════════════════════════════

  Widget _buildCustomParams(ImageGenSettings ig, bool isDark, String lang) {
    return _buildSection(
      isDark: isDark,
      // TODO(parity): 主项目缺失 'settings.imageGenCustomParams' 键，硬编码兜底
      title: '自定义 API 参数',
      icon: Icons.code,
      children: [
        _buildTextField(
          label: I18n.t('settings.imageGenCustomUrl', lang: lang),
          controller: _customUrlCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(customUrl: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenCustomKey', lang: lang),
          controller: _customApiKeyCtrl,
          obscure: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(customApiKey: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenCustomModel', lang: lang),
          controller: _customModelCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(customModel: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenCustomSize', lang: lang),
          controller: _customSizeCtrl,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(customSize: v)),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 通用构建方法
  // ═══════════════════════════════════════════════════════════════

  Widget _buildSection({
    required bool isDark,
    required String title,
    required IconData icon,
    required List<Widget> children,
  }) {
    return Container(
      decoration: AppSurfaces.panelQuiet(isDark: isDark),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(
                icon,
                size: 18,
                color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
              ),
              const SizedBox(width: 8),
              Text(
                title,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }

  Widget _buildSwitch({
    required String title,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(title, style: Theme.of(context).textTheme.bodyMedium),
          Switch(
            value: value,
            onChanged: onChanged,
            activeThumbColor: AppTheme.primaryLight,
          ),
        ],
      ),
    );
  }

  Widget _buildNumberInput({
    required String title,
    required TextEditingController controller,
    required double value,
    required double min,
    required double max,
    double step = 1,
    int decimals = 0,
    bool isInt = false,
    required ValueChanged<double> onChanged,
  }) {
    // P0-5：controller 由外部 State 字段管理，避免每次 build 重新创建
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Text(title, style: Theme.of(context).textTheme.bodyMedium),
          const Spacer(),
          SizedBox(
            width: 100,
            child: TextField(
              controller: controller,
              keyboardType: TextInputType.numberWithOptions(decimal: !isInt),
              textAlign: TextAlign.center,
              decoration: InputDecoration(
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 6,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: Theme.of(context).dividerColor),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: Theme.of(context).dividerColor),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AppTheme.primaryLight),
                ),
              ),
              style: Theme.of(context).textTheme.bodySmall,
              onSubmitted: (v) {
                final parsed = double.tryParse(v);
                if (parsed == null) return;
                final clamped = parsed.clamp(min, max);
                final snapped = step > 0
                    ? (clamped / step).round() * step
                    : clamped;
                final finalVal = isInt
                    ? snapped.roundToDouble()
                    : double.parse(snapped.toStringAsFixed(decimals));
                controller.text = isInt
                    ? finalVal.toInt().toString()
                    : finalVal.toStringAsFixed(decimals);
                onChanged(finalVal);
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDropdown({
    required String title,
    required String value,
    required Map<String, String> items,
    required ValueChanged<String> onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(title, style: Theme.of(context).textTheme.bodyMedium),
          DropdownButton<String>(
            value: items.containsKey(value) ? value : items.keys.first,
            items: items.entries
                .map(
                  (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                )
                .toList(),
            onChanged: (v) {
              if (v != null) onChanged(v);
            },
            underline: const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }

  Widget _buildTextField({
    required String label,
    required TextEditingController controller,
    bool obscure = false,
    int maxLines = 1,
    int? maxLength,
    required ValueChanged<String> onChanged,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      maxLines: maxLines,
      maxLength: maxLength,
      decoration: InputDecoration(
        labelText: label,
        isDense: true,
        counterText: '', // 隐藏字符计数器
      ),
      onChanged: onChanged, // 实时保存
    );
  }
}
