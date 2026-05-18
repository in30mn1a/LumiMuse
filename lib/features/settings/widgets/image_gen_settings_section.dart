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
    super.dispose();
  }

  /// 将设置值同步到控制器（每次 build 均同步，确保外部更新回填）
  void _initControllers(ImageGenSettings s) {
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
  }

  /// 更新图片生成设置并持久化
  Future<void> _updateImageGen(ImageGenSettings Function(ImageGenSettings) updater) async {
    final current = ref.read(settingsProvider).valueOrNull ?? const AppSettings();
    final newImageGen = updater(current.imageGen);
    // P3-14: 校验引擎 URL 非空
    if (newImageGen.enabled) {
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
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('请先填写 URL 地址')),
          );
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
        _initControllers(ig);

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
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
                  onChanged: (v) => _updateImageGen((s) => s.copyWith(enabled: v)),
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
                    onChanged: (v) => _updateImageGen((s) => s.copyWith(engine: v)),
                  ),
                  const SizedBox(height: 8),
                  _buildTextField(
                    label: I18n.t('settings.imageGenQuality', lang: lang),
                    controller: _qualityTagsCtrl,
                    maxLength: 500,
                    maxLines: 2,
                    onChanged: (v) => _updateImageGen((s) => s.copyWith(qualityTags: v)),
                  ),
                ],
              ],
            ),

            // 启用后才显示引擎专属参数 + 自动生图区块
            if (ig.enabled) ...[
              const SizedBox(height: 16),
              if (ig.engine == 'sd') _buildSdParams(ig, isDark, lang),
              if (ig.engine == 'nai') _buildNaiParams(ig, isDark, lang),
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
                    onChanged: (v) => _updateImageGen((s) => s.copyWith(autoGenerate: v)),
                  ),
                  if (ig.autoGenerate) ...[
                    const SizedBox(height: 8),
                    _buildTextField(
                      label: I18n.t('settings.imageGenAutoKeywords', lang: lang),
                      controller: _autoKeywordsCtrl,
                      maxLength: 500,
                      onChanged: (v) => _updateImageGen((s) => s.copyWith(autoGenerateKeywords: v)),
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
          value: ig.sdSteps.toDouble(),
          min: 1,
          max: 150,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdSteps: v.toInt())),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDCfg', lang: lang),
          value: ig.sdCfgScale,
          min: 1,
          max: 30,
          step: 0.5,
          decimals: 1,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdCfgScale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDWidth', lang: lang),
          value: ig.sdWidth.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdWidth: (v / 64).round() * 64)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenSDHeight', lang: lang),
          value: ig.sdHeight.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdHeight: (v / 64).round() * 64)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenSDNeg', lang: lang),
          controller: _sdNegativeCtrl,
          maxLines: 3,
          maxLength: 2000,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(sdNegativePrompt: v)),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // NovelAI 参数
  // ═══════════════════════════════════════════════════════════════

  Widget _buildNaiParams(ImageGenSettings ig, bool isDark, String lang) {
    return _buildSection(
      isDark: isDark,
      // TODO(parity): 主项目缺失 'settings.imageGenNAIParams' 键，硬编码兜底
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
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiNoiseSchedule: v)),
        ),
        const SizedBox(height: 8),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAISteps', lang: lang),
          value: ig.naiSteps.toDouble(),
          min: 1,
          max: 50,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiSteps: v.toInt())),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIScale', lang: lang),
          value: ig.naiScale,
          min: 0,
          max: 25,
          step: 0.1,
          decimals: 1,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiScale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAICfgRescale', lang: lang),
          value: ig.naiCfgRescale,
          min: 0,
          max: 1,
          step: 0.01,
          decimals: 2,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiCfgRescale: v)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIWidth', lang: lang),
          value: ig.naiWidth.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiWidth: (v / 64).round() * 64)),
        ),
        _buildNumberInput(
          title: I18n.t('settings.imageGenNAIHeight', lang: lang),
          value: ig.naiHeight.toDouble(),
          min: 256,
          max: 2048,
          step: 64,
          isInt: true,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiHeight: (v / 64).round() * 64)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAINeg', lang: lang),
          controller: _naiNegativeCtrl,
          maxLines: 3,
          maxLength: 2000,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiNegativePrompt: v)),
        ),
        const SizedBox(height: 8),
        _buildTextField(
          label: I18n.t('settings.imageGenNAIArtist', lang: lang),
          controller: _naiArtistCtrl,
          maxLength: 500,
          onChanged: (v) => _updateImageGen((s) => s.copyWith(naiArtistTags: v)),
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
          onChanged: (v) => _updateImageGen((s) => s.copyWith(comfyuiWorkflow: v)),
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
        children: [
          Row(children: [
            Icon(icon, size: 18, color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark),
            const SizedBox(width: 8),
            Text(title, style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            )),
          ]),
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
          Switch(value: value, onChanged: onChanged, activeThumbColor: AppTheme.primaryLight),
        ],
      ),
    );
  }

  Widget _buildNumberInput({
    required String title,
    required double value,
    required double min,
    required double max,
    double step = 1,
    int decimals = 0,
    bool isInt = false,
    required ValueChanged<double> onChanged,
  }) {
    final ctrl = TextEditingController(text: isInt ? value.toInt().toString() : value.toStringAsFixed(decimals));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Text(title, style: Theme.of(context).textTheme.bodyMedium),
          const Spacer(),
          SizedBox(
            width: 100,
            child: TextField(
              controller: ctrl,
              keyboardType: TextInputType.numberWithOptions(decimal: !isInt),
              textAlign: TextAlign.center,
              decoration: InputDecoration(
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
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
                final snapped = step > 0 ? (clamped / step).round() * step : clamped;
                final finalVal = isInt ? snapped.roundToDouble() : double.parse(snapped.toStringAsFixed(decimals));
                ctrl.text = isInt ? finalVal.toInt().toString() : finalVal.toStringAsFixed(decimals);
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
                .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
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
