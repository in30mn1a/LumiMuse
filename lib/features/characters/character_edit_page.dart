// 编辑角色页（CharacterEditPage）槽位基准声明 —— UI 布局唯一基准（任务 2.2）
//
// 本文件除 [CharacterEditPage] 现有渲染逻辑外，还以 `static List<PageRegion>
// get baselineRegions` 暴露与 requirements.md §A3.3 完全对齐的槽位基准列表
// （headerLeft / headerActions / aiGeneratorPanel / mainGroup* /
// advancedSettings / previewSidebar）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由各
// 子 widget 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/models/app_settings.dart';
import '../../core/providers/character_provider.dart';
import '../../core/providers/conversation_provider.dart';
import '../../core/providers/database_provider.dart';
import '../../core/providers/memory_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/services/backup_service.dart';
import '../../core/services/character_gen_service.dart';
import '../../core/utils/character_card_parser.dart';
import '../../core/utils/i18n.dart';
import '../../theme/app_spacing.dart';
import '../../theme/app_theme.dart';
import '../../theme/app_widgets.dart';
import '../../theme/page_region.dart';
import '../../theme/surfaces.dart';
import '../chat/widgets/chat_dialogs.dart';
import 'widgets/character_form_sections.dart';
import 'widgets/character_preview_sidebar.dart';
import 'widgets/export_dialog.dart';
import 'widgets/import_dialog.dart';

/// 角色编辑页面 — 与主屏视觉一致
class CharacterEditPage extends ConsumerStatefulWidget {
  final String characterId;

  const CharacterEditPage({super.key, required this.characterId});

  /// 槽位基准 —— 与 requirements.md §A3.3 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A3.3.1 头部左半区（返回 + 装饰方块 + 标题）
        PageRegion(
          name: 'headerLeft',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'back',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.start,
              id: 'decoration',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 3,
              anchor: SlotAnchor.start,
              id: 'title',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.1 头部右半区操作按钮组（6 枚按钮顺序锁定）
        PageRegion(
          name: 'headerActions',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.end,
              id: 'aiGenerate',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.end,
              id: 'duplicate',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 3,
              anchor: SlotAnchor.end,
              id: 'deleteCharacter',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 4,
              anchor: SlotAnchor.end,
              id: 'import',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 5,
              anchor: SlotAnchor.end,
              id: 'export',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 6,
              anchor: SlotAnchor.end,
              id: 'save',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.2 AI 生成面板（条件渲染，showAiGenerator === true 时出现）
        PageRegion(
          name: 'aiGeneratorPanel',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'requirementInput',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.end,
              id: 'applyButton',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 1：身份信息（头像 + 角色名）
        PageRegion(
          name: 'mainGroupIdentity',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'avatar',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.start,
              id: 'name',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 2：基本信息（单一 textarea）
        PageRegion(
          name: 'mainGroupBasicInfo',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'basicInfoTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 3：性格（单一 textarea）
        PageRegion(
          name: 'mainGroupPersonality',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'personalityTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 4：场景 / 世界观（单一 textarea）
        PageRegion(
          name: 'mainGroupScenario',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'scenarioTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 5：开场白（单一 textarea）
        PageRegion(
          name: 'mainGroupGreeting',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'greetingTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 6：其他（other_info 单一 textarea）
        PageRegion(
          name: 'mainGroupOther',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'otherInfoTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.3 分组 7：示例对话（单一 textarea，等宽字体）
        PageRegion(
          name: 'mainGroupExampleDialogue',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'exampleDialogueTextarea',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.4 高级设置折叠区（系统提示词 + 生图标签）
        PageRegion(
          name: 'advancedSettings',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'systemPrompt',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.start,
              id: 'imageTags',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.3.5 右侧预览栏（桌面端 sticky top-4，20rem 列）
        PageRegion(
          name: 'previewSidebar',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              id: 'stickyDesktop',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
      ];

  @override
  ConsumerState<CharacterEditPage> createState() => _CharacterEditPageState();
}

class _CharacterEditPageState extends ConsumerState<CharacterEditPage> {
  final _nameController = TextEditingController();
  final _basicInfoController = TextEditingController();
  final _otherInfoController = TextEditingController();
  final _personalityController = TextEditingController();
  final _scenarioController = TextEditingController();
  final _greetingController = TextEditingController();
  final _exampleDialogueController = TextEditingController();
  final _systemPromptController = TextEditingController();
  final _imageTagsController = TextEditingController();
  bool _loaded = false;

  /// 当前头像路径（本地文件路径或网络 URL）
  String? _avatarPath;

  bool _showAiGenPanel = false;
  bool _isAiGenerating = false;
  bool _advancedExpanded = false;
  bool _saving = false;
  bool _duplicating = false;

  /// 五个长任务互斥锁（保存 / AI生成 / 删除 / 复制 / 导入）
  bool get _busy => _saving || _isAiGenerating || _duplicating;
  String _aiError = '';
  _ImportMsg? _importMsg;
  final _aiRequirementController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _nameController.addListener(_repaint);
    _greetingController.addListener(_repaint);
    _systemPromptController.addListener(_repaint);
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _nameController.removeListener(_repaint);
    _greetingController.removeListener(_repaint);
    _systemPromptController.removeListener(_repaint);
    _nameController.dispose();
    _basicInfoController.dispose();
    _otherInfoController.dispose();
    _personalityController.dispose();
    _scenarioController.dispose();
    _greetingController.dispose();
    _exampleDialogueController.dispose();
    _systemPromptController.dispose();
    _imageTagsController.dispose();
    _aiRequirementController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final characterAsync = ref.watch(characterProvider(widget.characterId));
    final lang = ref.watch(localeProvider).languageCode;

    ref.listen(characterProvider(widget.characterId), (prev, next) {
      final prevValue = prev?.valueOrNull;
      if (prevValue != null && next is AsyncData && next.value == null && mounted) {
        context.go('/');
      }
    });

    return characterAsync.when(
      loading: () => const Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: Text('加载失败: $e'),
        ),
      ),
      data: (character) {
        if (character == null) {
          return Scaffold(
            backgroundColor: Colors.transparent,
            body: Center(
              child: Text(I18n.t('editor.loading', lang: lang)),
            ),
          );
        }

        if (!_loaded) {
          _nameController.text = character.name;
          _basicInfoController.text = character.basicInfo;
          _personalityController.text = character.personality;
          _scenarioController.text = character.scenario;
          _greetingController.text = character.greeting;
          _exampleDialogueController.text = character.exampleDialogue;
          _otherInfoController.text = character.otherInfo;
          _systemPromptController.text = character.systemPrompt;
          _imageTagsController.text = character.imageTags;
          _avatarPath = character.avatarUrl;
          _loaded = true;
        }

        return Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.lg),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1280),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _buildHeader(lang),
                      const SizedBox(height: AppSpacing.lg),
                      _buildBody(lang),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildHeader(String lang) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      decoration: AppSurfaces.hero(isDark: isDark),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl, vertical: AppSpacing.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LayoutBuilder(
            builder: (ctx, constraints) {
              final wide = constraints.maxWidth >= 900;
              final left = _buildHeaderLeft(lang, isDark);
              final actions = _buildHeaderActions(lang);

              if (wide) {
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Flexible(child: left),
                    actions,
                  ],
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  left,
                  const SizedBox(height: AppSpacing.lg),
                  actions,
                ],
              );
            },
          ),
          if (_importMsg != null) ...[
            const SizedBox(height: AppSpacing.lg),
            _buildImportBanner(isDark),
          ],
          if (_showAiGenPanel) ...[
            const SizedBox(height: AppSpacing.lg),
            _buildAiPanel(lang, isDark),
          ],
        ],
      ),
    );
  }

  Widget _buildHeaderLeft(String lang, bool isDark) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        LumiSoftButton(
          label: I18n.t('editor.cancel', lang: lang),
          icon: Icons.arrow_back_rounded,
          kind: LumiSoftButtonKind.secondary,
          onTap: _returnToSidebar,
        ),
        const SizedBox(width: AppSpacing.lg),
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: AppTheme.accent.withValues(alpha: 0.12),
            borderRadius: AppRadius.mdBorder,
          ),
          child: Icon(
            Icons.edit_outlined,
            size: 20,
            color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
          ),
        ),
        const SizedBox(width: AppSpacing.lg),
        Flexible(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                I18n.t('editor.title', lang: lang),
                style: TextStyle(
                  fontSize: 24,
                  height: 1.18,
                  fontWeight: FontWeight.w600,
                  color: isDark
                      ? AppTheme.darkTextPrimary
                      : AppTheme.textPrimary,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(
                I18n.t('editor.previewSubtitle', lang: lang),
                style: TextStyle(
                  fontSize: 13,
                  height: 1.65,
                  color: isDark
                      ? AppTheme.darkTextSecondary
                      : AppTheme.textSecondary,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildHeaderActions(String lang) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        LumiSoftButton(
          label: I18n.t('editor.aiGenerate', lang: lang),
          icon: Icons.auto_awesome,
          kind: LumiSoftButtonKind.secondary,
          onTap: () => setState(() => _showAiGenPanel = !_showAiGenPanel),
        ),
        LumiSoftButton(
          label: _duplicating
              ? I18n.t('editor.duplicating', lang: lang)
              : I18n.t('editor.duplicate', lang: lang),
          icon: Icons.auto_awesome,
          kind: LumiSoftButtonKind.secondary,
          onTap: _duplicating ? null : _handleDuplicate,
        ),
        LumiSoftButton(
          label: I18n.t('editor.delete', lang: lang),
          icon: Icons.delete_outline,
          kind: LumiSoftButtonKind.danger,
          onTap: _busy ? null : _handleDelete,
        ),
        LumiSoftButton(
          label: I18n.t('editor.importTitle', lang: lang),
          icon: null,
          kind: LumiSoftButtonKind.secondary,
          onTap: _busy ? null : _handleImport,
        ),
        LumiSoftButton(
          label: I18n.t('editor.export', lang: lang),
          icon: null,
          kind: LumiSoftButtonKind.secondary,
          onTap: _showExportDialog,
        ),
        LumiSoftButton(
          label: _saving
              ? I18n.t('editor.saving', lang: lang)
              : I18n.t('editor.save', lang: lang),
          icon: Icons.auto_awesome,
          kind: LumiSoftButtonKind.primary,
          onTap: _saving ? null : _save,
        ),
      ],
    );
  }

  Widget _buildImportBanner(bool isDark) {
    final isErr = _importMsg!.isError;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
      decoration: BoxDecoration(
        color: isErr
            ? const Color(0xFFFEF2F2)
            : const Color(0xFFF0FDF4),
        borderRadius: AppRadius.mdBorder,
      ),
      child: Text(
        _importMsg!.text,
        style: TextStyle(
          fontSize: 14,
          color: isErr
              ? const Color(0xFFB91C1C)
              : const Color(0xFF15803D),
        ),
      ),
    );
  }

  Widget _buildAiPanel(String lang, bool isDark) {
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 608),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.70),
            border: Border.all(
              color: isDark ? AppTheme.darkBorderLight : AppTheme.borderLight,
            ),
            borderRadius: AppRadius.mdBorder,
            boxShadow: const [AppSurfaces.softCardShadow],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              LayoutBuilder(
                builder: (ctx, constraints) {
                  final wide = constraints.maxWidth >= 480;
                  final input = _buildAiInput(lang, isDark);
                  final apply = LumiSoftButton(
                    label: _isAiGenerating
                        ? I18n.t('editor.aiGenerating', lang: lang)
                        : I18n.t('editor.aiApplyHint', lang: lang),
                    icon: null,
                    kind: LumiSoftButtonKind.primary,
                    onTap: (_busy || _isAiGenerating ||
                            _aiRequirementController.text.trim().isEmpty)
                        ? null
                        : _aiGenerate,
                  );
                  if (wide) {
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(child: input),
                        const SizedBox(width: AppSpacing.sm),
                        apply,
                      ],
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      input,
                      const SizedBox(height: AppSpacing.sm),
                      Align(alignment: Alignment.centerRight, child: apply),
                    ],
                  );
                },
              ),
              if (_aiError.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  _aiError,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFFA33375),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildAiInput(String lang, bool isDark) {
    final textColor =
        isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary;
    final mutedColor =
        isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;
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
        controller: _aiRequirementController,
        enabled: !_isAiGenerating,
        textInputAction: TextInputAction.send,
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) {
          if (!_isAiGenerating &&
              _aiRequirementController.text.trim().isNotEmpty) {
            _aiGenerate();
          }
        },
        style: TextStyle(fontSize: 15, color: textColor, height: 1.5),
        decoration: InputDecoration(
          hintText: I18n.t('editor.aiRequirementPlaceholder', lang: lang),
          hintStyle: TextStyle(fontSize: 14, color: mutedColor),
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 15,
            vertical: AppSpacing.md,
          ),
          isDense: false,
        ),
      ),
    );
  }

  Widget _buildBody(String lang) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final wide = constraints.maxWidth >= 1024;
        final main = _buildMain(lang, isDark);
        final aside = _buildAside(lang, isDark);
        if (wide) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: main),
              const SizedBox(width: AppSpacing.lg),
              SizedBox(width: 320, child: aside),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            main,
            const SizedBox(height: AppSpacing.lg),
            aside,
          ],
        );
      },
    );
  }

  Widget _buildMain(String lang, bool isDark) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        IdentitySection(
          nameController: _nameController,
          avatarPath: _avatarPath,
          onAvatarChanged: _handleAvatarChanged,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        BasicInfoSection(
          controller: _basicInfoController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        PersonalitySection(
          controller: _personalityController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        ScenarioSection(
          controller: _scenarioController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        GreetingSection(
          controller: _greetingController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        OtherInfoSection(
          controller: _otherInfoController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        ExampleDialogueSection(
          controller: _exampleDialogueController,
          lang: lang,
          isDark: isDark,
        ),
        const SizedBox(height: AppSpacing.lg),
        AdvancedSettingsSection(
          systemPromptController: _systemPromptController,
          imageTagsController: _imageTagsController,
          isExpanded: _advancedExpanded,
          onToggle: () => setState(() => _advancedExpanded = !_advancedExpanded),
          lang: lang,
          isDark: isDark,
        ),
      ],
    );
  }



  Widget _buildAside(String lang, bool isDark) {
    return CharacterPreviewSidebar(
      name: _nameController.text,
      avatarPath: _avatarPath,
      greeting: _greetingController.text,
      systemPrompt: _systemPromptController.text,
      lang: lang,
      isDark: isDark,
    );
  }

  Future<void> _handleAvatarChanged(String? newPath) async {
    setState(() => _avatarPath = newPath);
    final actions = ref.read(characterActionsProvider);
    try {
      await actions.update(widget.characterId, avatarUrl: newPath);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存头像失败: $e')),
      );
    }
  }



  Future<void> _aiGenerate() async {
    if (_busy) return;
    final requirement = _aiRequirementController.text.trim();
    if (requirement.isEmpty) {
      setState(() {
        _aiError = '请输入角色描述';
      });
      return;
    }

    setState(() {
      _isAiGenerating = true;
      _aiError = '';
    });
    final lang = ref.read(localeProvider).languageCode;
    final service = CharacterGenService();
    try {
      final settingsAsync = ref.read(settingsProvider);
      final settings = settingsAsync.valueOrNull ?? const AppSettings();
      if (settings.apiBase.isEmpty || settings.apiKey.isEmpty) {
        throw Exception('请先在设置中配置 API');
      }
      final result = await service.generateCharacter(settings, requirement);

      setState(() {
        if (result['name']?.isNotEmpty == true) {
          _nameController.text = result['name']!;
        }
        if (result['basic_info']?.isNotEmpty == true) {
          _basicInfoController.text = result['basic_info']!;
        }
        if (result['personality']?.isNotEmpty == true) {
          _personalityController.text = result['personality']!;
        }
        if (result['scenario']?.isNotEmpty == true) {
          _scenarioController.text = result['scenario']!;
        }
        if (result['greeting']?.isNotEmpty == true) {
          _greetingController.text = result['greeting']!;
        }
        if (result['example_dialogue']?.isNotEmpty == true) {
          _exampleDialogueController.text = result['example_dialogue']!;
        }
        if (result['other_info']?.isNotEmpty == true) {
          _otherInfoController.text = result['other_info']!;
        }
        if (result['system_prompt']?.isNotEmpty == true) {
          _systemPromptController.text = result['system_prompt']!;
        }
        if (result['image_tags']?.isNotEmpty == true) {
          _imageTagsController.text = result['image_tags']!;
        }
        _showAiGenPanel = false;
        _importMsg = const _ImportMsg(
          isError: false,
          text: 'AI 生成完成，请检查后保存',
        );
      });
      Future.delayed(const Duration(seconds: 5), () {
        if (mounted) setState(() => _importMsg = null);
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _aiError = '${I18n.t('editor.aiGenerateError', lang: lang)}: $e';
        });
      }
    } finally {
      service.dispose();
      if (mounted) setState(() => _isAiGenerating = false);
    }
  }

  Future<void> _save() async {
    if (_busy) return;
    setState(() => _saving = true);
    final lang = ref.read(localeProvider).languageCode;
    final actions = ref.read(characterActionsProvider);
    try {
      await actions.update(
        widget.characterId,
        name: _nameController.text.trim().isEmpty
            ? I18n.t('char.newCharacterName', lang: lang)
            : _nameController.text.trim(),
        avatarUrl: _avatarPath,
        basicInfo: _basicInfoController.text,
        personality: _personalityController.text,
        scenario: _scenarioController.text,
        greeting: _greetingController.text,
        otherInfo: _otherInfoController.text,
        exampleDialogue: _exampleDialogueController.text,
        systemPrompt: _systemPromptController.text,
        imageTags: _imageTagsController.text,
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败: $e')),
      );
      return;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
    if (!mounted) return;
    _returnToSidebar();
  }

  void _returnToSidebar() {
    if (Navigator.of(context).canPop()) {
      Navigator.of(context).pop();
    } else {
      context.go('/');
    }
  }

  Future<void> _handleDelete() async {
    if (_busy) return;
    final lang = ref.read(localeProvider).languageCode;
    final confirmed = await showDeleteConversationDialog(
      context,
      title: I18n.t('editor.delete', lang: lang),
      body: I18n.t('editor.deleteConfirm', lang: lang),
      confirmLabel: I18n.t('editor.delete', lang: lang),
      cancelLabel: I18n.t('common.cancel', lang: lang),
    );
    if (confirmed != true) return;

    final actions = ref.read(characterActionsProvider);
    await actions.delete(widget.characterId);
    if (!mounted) return;
    context.go('/');
  }

  Future<void> _handleDuplicate() async {
    if (_busy) return;
    final lang = ref.read(localeProvider).languageCode;
    final confirmed = await showDeleteConversationDialog(
      context,
      title: I18n.t('editor.duplicate', lang: lang),
      body: I18n.t('editor.duplicateConfirm', lang: lang),
      confirmLabel: I18n.t('editor.duplicate', lang: lang),
      cancelLabel: I18n.t('common.cancel', lang: lang),
    );
    if (confirmed != true) return;

    setState(() => _duplicating = true);
    try {
      final actions = ref.read(characterActionsProvider);
      final newId = await actions.duplicate(widget.characterId);
      if (!mounted) return;
      context.go('/characters/$newId/edit');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _importMsg = _ImportMsg(
          isError: true,
          text: '${I18n.t('editor.duplicateError', lang: lang)}: $e',
        );
      });
      Future.delayed(const Duration(seconds: 5), () {
        if (mounted) setState(() => _importMsg = null);
      });
    } finally {
      if (mounted) setState(() => _duplicating = false);
    }
  }

  void _showExportDialog() {
    showDialog(
      context: context,
      builder: (ctx) => ExportDialog(
        characterId: widget.characterId,
        characterName: _nameController.text,
        onClose: () => Navigator.pop(ctx),
        onExport: (options) async {
          final service = BackupService(ref.read(databaseProvider));
          // 主项目对照（src/app/api/export/route.ts）：先生成 JSON，
          // 再让平台原生入口决定落盘位置。
          // 桌面端 (Windows / Linux / macOS) 的 share_plus 不能直接处理
          // 文件分享 / Windows-Linux 直接抛 MissingPluginException，因此走
          // FilePicker.saveFile 让用户选保存位置；移动端走 Share.shareXFiles。
          final jsonMap = await service.exportCharacterToJson(
            widget.characterId,
            options: options,
          );
          final jsonStr = jsonEncode(jsonMap);

          final now = DateTime.now();
          final dateStr =
              '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
          final safeName = _nameController.text
              .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
          final defaultFileName = 'lumimuse-$safeName-$dateStr.json';

          final isDesktop = !kIsWeb &&
              (Platform.isWindows ||
                  Platform.isLinux ||
                  Platform.isMacOS);

          if (isDesktop) {
            // 桌面端：让用户选保存位置
            String? savePath;
            try {
              savePath = await FilePicker.platform.saveFile(
                dialogTitle: '导出角色备份',
                fileName: defaultFileName,
                type: FileType.custom,
                allowedExtensions: ['json'],
              );
            } catch (_) {
              savePath = null;
            }
            if (savePath == null) {
              if (ctx.mounted) Navigator.pop(ctx);
              return;
            }
            await service.writeJsonToPath(jsonStr, savePath);
            if (ctx.mounted) Navigator.pop(ctx);
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('已导出角色备份'),
                  duration: Duration(seconds: 3),
                ),
              );
            }
          } else {
            // 移动端 (Android / iOS)：先写到应用目录，再走 Share
            final filePath = await service.exportCharacter(
              widget.characterId,
              options: options,
            );
            if (ctx.mounted) Navigator.pop(ctx);
            await Share.shareXFiles([XFile(filePath)]);
          }
        },
      ),
    );
  }

  Future<void> _handleImport() async {
    if (_busy) return;
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['json'],
    );
    if (result == null || result.files.isEmpty) return;

    final filePath = result.files.single.path;
    if (filePath == null) return;

    final file = File(filePath);
    final jsonStr = await file.readAsString();
    final lang = ref.read(localeProvider).languageCode;

    final dynamic parsed;
    try {
      parsed = jsonDecode(jsonStr);
    } catch (e) {
      _showImportMsg(
        text: I18n.t('editor.importError', lang: lang),
        isError: true,
      );
      return;
    }

    if (parsed is! Map<String, dynamic>) {
      _showImportMsg(
        text: I18n.t('editor.importError', lang: lang),
        isError: true,
      );
      return;
    }

    final data = parsed;

    if (CharacterCardParser.isLumiMuseBackup(data)) {
      if (mounted) {
        _showImportDialog(result.files.single.name, jsonStr);
      }
    } else {
      final fields = CharacterCardParser.normalize(data);
      if (fields != null) {
        _applyCharacterCardFields(fields);
        _showImportMsg(
          text: I18n.t('editor.importDraftSuccess', lang: lang),
          isError: false,
        );
      } else {
        _showImportMsg(
          text: I18n.t('editor.importError', lang: lang),
          isError: true,
        );
      }
    }
  }

  void _showImportDialog(String fileName, String jsonStr) {
    showDialog(
      context: context,
      builder: (ctx) => ImportDialog(
        fileName: fileName,
        onCancel: () => Navigator.pop(ctx),
        onConfirm: (options) async {
          Navigator.pop(ctx);
          await _executeImport(jsonStr, options);
        },
      ),
    );
  }

  Future<void> _executeImport(String jsonStr, ImportOptions options) async {
    final lang = ref.read(localeProvider).languageCode;
    try {
      // 主项目对照（src/app/characters/[id]/page.tsx applyPendingImport）：
      // - 角色字段：只填到当前编辑表单，不在数据库新建角色，主人按"保存"才落库
      // - 记忆 / 对话：把 character_id 改写成当前编辑角色的 id，挂到当前角色
      //
      // 之前 Flutter 端把整个 jsonStr 丢给 importWithOptions，并在服务里
      // 同时启用 includeCharacter（按名称去重）会新建一个角色，导致角色字段
      // 落到新角色 / 记忆与对话又挂到当前角色的诡异分裂。

      // 1) 角色字段 → 只填表单
      if (options.includeCharacter) {
        final payload = jsonDecode(jsonStr) as Map<String, dynamic>;
        final fields = CharacterCardParser.normalize(payload);
        if (fields != null) {
          _applyCharacterCardFields(fields);
        }
      }

      // 2) 记忆 / 对话 → 服务层强制 includeCharacter: false，全部挂到当前角色
      final hasExtras = options.includeMemories || options.includeConversations;
      int memoriesImported = 0;
      int conversationsImported = 0;
      if (hasExtras) {
        final service = BackupService(ref.read(databaseProvider));
        final result = await service.importWithOptions(
          jsonStr,
          options: ImportOptions(
            includeCharacter: false,
            includeMemories: options.includeMemories,
            includeConversations: options.includeConversations,
          ),
          targetCharacterId: widget.characterId,
        );
        memoriesImported = result.memoriesImported;
        conversationsImported = result.conversationsImported;
      }

      // 提示文案：与主项目 applyPendingImport 一致
      // - 仅勾选角色字段：editor.importDraftSuccess（"已填入角色资料草稿"）
      // - 含记忆 / 对话：import.characterSuccess（带 {memories} {conversations}）
      if (!hasExtras) {
        _showImportMsg(
          text: I18n.t('editor.importDraftSuccess', lang: lang),
          isError: false,
        );
      } else {
        // 关键：导入完成后必须 invalidate 相关 provider，
        // 让记忆管理页 / 聊天侧栏 / 当前对话能立刻看到新条目。
        // 之前漏 invalidate 导致：
        // - 记忆管理"全部分类"显示空（缓存的旧结果），切到具体分类才会
        //   触发新 family params + 新查询；
        // - 聊天侧"对话快捷面板"也不会出现导入的对话。
        ref.invalidate(memoryListProvider);
        ref.invalidate(conversationListProvider(widget.characterId));

        _showImportMsg(
          text: I18n.tArgs(
            'import.characterSuccess',
            {
              'memories': memoriesImported,
              'conversations': conversationsImported,
            },
            lang: lang,
          ),
          isError: false,
        );
      }
    } catch (e) {
      _showImportMsg(
        text: '${I18n.t('editor.importError', lang: lang)}: $e',
        isError: true,
      );
    }
  }

  void _showImportMsg({required String text, required bool isError}) {
    if (!mounted) return;
    setState(() => _importMsg = _ImportMsg(text: text, isError: isError));
    Future.delayed(const Duration(seconds: 5), () {
      if (mounted) setState(() => _importMsg = null);
    });
  }

  void _applyCharacterCardFields(Map<String, String> fields) {
    setState(() {
      if (fields['name']?.isNotEmpty == true) {
        _nameController.text = fields['name']!;
      }
      if (fields['basic_info']?.isNotEmpty == true) {
        _basicInfoController.text = fields['basic_info']!;
      }
      if (fields['personality']?.isNotEmpty == true) {
        _personalityController.text = fields['personality']!;
      }
      if (fields['scenario']?.isNotEmpty == true) {
        _scenarioController.text = fields['scenario']!;
      }
      if (fields['greeting']?.isNotEmpty == true) {
        _greetingController.text = fields['greeting']!;
      }
      if (fields['example_dialogue']?.isNotEmpty == true) {
        _exampleDialogueController.text = fields['example_dialogue']!;
      }
      if (fields['other_info']?.isNotEmpty == true) {
        _otherInfoController.text = fields['other_info']!;
      }
      if (fields['system_prompt']?.isNotEmpty == true) {
        _systemPromptController.text = fields['system_prompt']!;
      }
      if (fields['image_tags']?.isNotEmpty == true) {
        _imageTagsController.text = fields['image_tags']!;
      }
      if (fields['avatar_url'] != null) {
        _avatarPath = fields['avatar_url']!.isEmpty ? null : fields['avatar_url']!;
      }
    });
  }
}


class _ImportMsg {
  final String text;
  final bool isError;
  const _ImportMsg({required this.text, required this.isError});
}
