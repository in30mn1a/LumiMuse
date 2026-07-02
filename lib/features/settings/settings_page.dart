// 设置页（SettingsPage）槽位基准声明 —— UI 布局唯一基准（任务 2.2）
//
// 本文件除 [SettingsPage] 现有渲染逻辑外，还以 `static List<PageRegion> get
// baselineRegions` 暴露与 requirements.md §A3.5 完全对齐的槽位基准列表
// （headerLeft / headerRight / sectionOverview / sectionApi /
// sectionModelParams / sectionChatBehavior / sectionMemoryEngine /
// sectionDisplay / sectionImageGen / sectionMaintenance）。
//
// 子 spec 修改 widget 内部时不得改变 [PageSlot.order]、[PageSlot.anchor]、
// [PageSlot.id] 三者中的任意一项；仅允许调整 [PageSlot.build] 闭包内部细节。
// 任何破坏槽位顺序与锚点的改动都会被回归脚本 RC-11 立即扫出。
//
// 当前 build 闭包返回 [SizedBox.shrink] 占位，仅作骨架声明；具体子树由各
// 子 widget 自行渲染，本字段不参与运行期 UI 布局。

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers/database_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/services/backup_service.dart';
import '../../core/utils/i18n.dart';
import '../../theme/app_spacing.dart';
import '../../theme/app_theme.dart';
import '../../theme/app_widgets.dart';
import '../../theme/page_region.dart';
import '../../theme/surfaces.dart';
import '../../theme/app_shell.dart';
import 'widgets/image_gen_settings_section.dart';
import 'widgets/launch_password_section.dart';
import 'widgets/settings_sections.dart';

/// 设置页面 — 严格 1:1 对照 src/app/settings/page.tsx
class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  /// 槽位基准 —— 与 requirements.md §A3.5 严格对齐，禁止重排或省略。
  ///
  /// 子 spec 修改 widget 内部时不得改变 order/anchor/id；仅允许调整 build 闭包
  /// 返回的子树细节。任何破坏不变量的改动都会被回归脚本 RC-11 立即扫出。
  static List<PageRegion> get baselineRegions => [
        // §A3.5.1 头部左半区（返回 + 装饰方块 + 标题）
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
        // §A3.5.1 头部右半区（条件渲染 logout + 必显 saveButton）
        PageRegion(
          name: 'headerRight',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.end,
              id: 'logout',
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.end,
              id: 'saveButton',
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        // §A3.5.2 区块 1：概览（4 stat-tiles）
        PageRegion(
          name: 'sectionOverview',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'apiStatus', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'themeStatus', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'languageStatus', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.start, id: 'memoryStatus', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 2：API 配置
        PageRegion(
          name: 'sectionApi',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'apiBase', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'apiKey', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'modelRow', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.start, id: 'jsonMode', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 3：模型参数（temperature / max_tokens / context_window）
        PageRegion(
          name: 'sectionModelParams',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'temperature', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'maxTokens', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'contextWindow', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 4：聊天行为（流式 / 示例对话 / 时间戳）
        PageRegion(
          name: 'sectionChatBehavior',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'streaming', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'exampleDialogue', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'showTimestamps', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 5：记忆引擎（三模式独立开关 + 注入控制，9 项顺序锁定）
        PageRegion(
          name: 'sectionMemoryEngine',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'triggerInterval', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'memoryInterval', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'triggerTime', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.start, id: 'memoryTriggerTimeHours', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 5, anchor: SlotAnchor.start, id: 'triggerKeyword', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 6, anchor: SlotAnchor.start, id: 'memoryTriggerKeywords', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 7, anchor: SlotAnchor.start, id: 'memoryInject', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 8, anchor: SlotAnchor.start, id: 'limitInject', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 9, anchor: SlotAnchor.start, id: 'memoryMaxInject', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 6：显示（主题 + 语言 + 字体三按钮）
        PageRegion(
          name: 'sectionDisplay',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'themeSelect', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'languageSelect', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'fontWenkai', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.start, id: 'fontSystem', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 5, anchor: SlotAnchor.start, id: 'fontSerif', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 7：图片生成
        PageRegion(
          name: 'sectionImageGen',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'enableSwitch', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'engineSelect', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'engineParams', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 4, anchor: SlotAnchor.start, id: 'qualityTags', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 5, anchor: SlotAnchor.start, id: 'autoGenerate', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 6, anchor: SlotAnchor.start, id: 'autoGenerateKeywords', build: (_) => const SizedBox.shrink()),
          ],
        ),
        // §A3.5.2 区块 8：维护（预览 → 条件确认 → 状态消息）
        PageRegion(
          name: 'sectionMaintenance',
          slots: [
            PageSlot(order: 1, anchor: SlotAnchor.start, id: 'previewButton', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 2, anchor: SlotAnchor.start, id: 'confirmCleanButton', build: (_) => const SizedBox.shrink()),
            PageSlot(order: 3, anchor: SlotAnchor.start, id: 'statusMessage', build: (_) => const SizedBox.shrink()),
          ],
        ),
      ];

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

enum _SettingTab { api, generation, memory, advanced }

enum _SaveState { idle, saving, saved }

class _SettingsPageState extends ConsumerState<SettingsPage> {
  _SaveState _saveState = _SaveState.idle;
  _SettingTab _activeTab = _SettingTab.api;
  // 已访问过的 Tab 集合（lazy mount + keep-alive）：
  // - 未在集合内的 Tab：完全不构建子树，避免无谓的 Stateful Section
  //   （含 DatabaseStatsView FutureBuilder、provider list 解析等）初始化；
  // - 在集合内但当前未激活的 Tab：仍保留在 widget tree 中（offstage=true），
  //   切回时保留滚动位置 / 输入控制器 / 子 state，符合"切换不重建"契约。
  // 首屏默认 mount Tab 0（api），与 _activeTab 初值对齐。
  final Set<_SettingTab> _mountedTabs = {_SettingTab.api};

  void _switchTab(_SettingTab tab) {
    setState(() {
      _activeTab = tab;
      _mountedTabs.add(tab);
    });
  }

  Widget _buildTabNav(String lang, bool isDark) {
    const tabs = _SettingTab.values;
    return AppSurfaces.panelBox(
      context: context,
      isDark: isDark,
      padding: const EdgeInsets.all(6),
      child: Row(
        children: tabs.map((tab) {
          final active = _activeTab == tab;
          final String labelText;
          switch (tab) {
            case _SettingTab.api:
              labelText = I18n.t('settings.tabApi', lang: lang);
              break;
            case _SettingTab.generation:
              labelText = I18n.t('settings.tabGeneration', lang: lang);
              break;
            case _SettingTab.memory:
              labelText = I18n.t('settings.tabMemory', lang: lang);
              break;
            case _SettingTab.advanced:
              labelText = I18n.t('settings.tabAdvanced', lang: lang);
              break;
          }

          final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
          final activeBg = accent.withValues(alpha: 0.15);
          final activeBorder = accent.withValues(alpha: 0.3);
          final hoverBg = (isDark ? AppTheme.darkWarm100 : AppTheme.warm100)
              .withValues(alpha: 0.6);
          final textColor = active
              ? (isDark ? AppTheme.darkAccentDark : AppTheme.accentDark)
              : (isDark
                    ? AppTheme.darkTextSecondary
                    : AppTheme.textSecondary);

          return Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: GestureDetector(
                onTap: () => _switchTab(tab),
                child: HoverBuilder(
                  builder: (isHovering) {
                    final finalBg = active
                        ? activeBg
                        : (isHovering ? hoverBg : Colors.transparent);

                    return AnimatedContainer(
                      duration: const Duration(milliseconds: 150),
                      curve: Curves.easeOut,
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      decoration: BoxDecoration(
                        color: finalBg,
                        border: active
                            ? Border.all(color: activeBorder)
                            : null,
                        borderRadius: BorderRadius.circular(AppRadius.md),
                        boxShadow: active
                            ? [
                                BoxShadow(
                                  color: accent.withValues(alpha: 0.08),
                                  blurRadius: 4,
                                  offset: const Offset(0, 2),
                                ),
                              ]
                            : null,
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        labelText,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: active
                              ? FontWeight.w600
                              : FontWeight.w500,
                          color: textColor,
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    final String lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return settingsAsync.when(
      loading: () => const Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(child: Text('$e')),
      ),
      data: (settings) {
        return AppShell(
          child: Scaffold(
            backgroundColor: Colors.transparent,
            body: SafeArea(
              child: SingleChildScrollView(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 1280),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _buildHeader(lang),
                        const SizedBox(height: AppSpacing.md),
                        _buildTabNav(lang, isDark),
                        const SizedBox(height: AppSpacing.lg),
                        // 用 Stack + Offstage 而非条件渲染：未激活的 Tab 仍保留在
                        // widget tree 中，子 Section（多为 Stateful，含输入控制器、
                        // 滚动位置等）切换 Tab 后状态不会被销毁重建。
                        // 使用 Offstage 代替 IndexedStack，以避免因其他长 Tab 的高度
                        // 撑开 Stack，导致短 Tab 底部出现多余滑动空间的问题。
                        // 性能优化：结合 _mountedTabs 实现 lazy mount —— 未访问过的
                        // Tab 不构建子树（占位 SizedBox.shrink），访问过的 Tab 切回去
                        // 仍保留 state（offstage 模式 keep-alive）。
                        Stack(
                          fit: StackFit.loose,
                          children: [
                            Offstage(
                              offstage: _activeTab != _SettingTab.api,
                              child: _mountedTabs.contains(_SettingTab.api)
                                  ? const Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        ProviderManageSection(),
                                        SizedBox(height: AppSpacing.lg),
                                        ApiSection(),
                                      ],
                                    )
                                  : const SizedBox.shrink(),
                            ),
                            Offstage(
                              offstage: _activeTab != _SettingTab.generation,
                              child:
                                  _mountedTabs.contains(_SettingTab.generation)
                                  ? const Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        ModelSection(),
                                        SizedBox(height: AppSpacing.lg),
                                        ChatBehaviorSection(),
                                      ],
                                    )
                                  : const SizedBox.shrink(),
                            ),
                            Offstage(
                              offstage: _activeTab != _SettingTab.memory,
                              child: _mountedTabs.contains(_SettingTab.memory)
                                  ? const Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        MemoryEngineSection(),
                                        SizedBox(height: AppSpacing.lg),
                                        MemorySection(),
                                        SizedBox(height: AppSpacing.lg),
                                        DisplaySection(),
                                      ],
                                    )
                                  : const SizedBox.shrink(),
                            ),
                            Offstage(
                              offstage: _activeTab != _SettingTab.advanced,
                              child: _mountedTabs.contains(_SettingTab.advanced)
                                  ? Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        LumiSectionPanel(
                                          title: I18n.t('settings.imageGen',
                                              lang: lang),
                                          child:
                                              const ImageGenSettingsSection(),
                                        ),
                                        const SizedBox(height: AppSpacing.lg),
                                        const LumiSectionPanel(
                                          title: '启动密码',
                                          child: LaunchPasswordSection(),
                                        ),
                                        const SizedBox(height: AppSpacing.lg),
                                        const LumiSectionPanel(
                                          title: '数据备份与恢复',
                                          child: _ImportExportSection(),
                                        ),
                                        const SizedBox(height: AppSpacing.lg),
                                        const MaintenanceSection(),
                                      ],
                                    )
                                  : const SizedBox.shrink(),
                            ),
                          ],
                        ),
                        const SizedBox(height: AppSpacing.lg),
                      ],
                    ),
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
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      child: LayoutBuilder(
        builder: (ctx, constraints) {
          final left = _buildHeaderLeft(lang, isDark);
          final right = _buildHeaderRight(lang, isDark);
          return Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [Flexible(child: left), right],
          );
        },
      ),
    );
  }

  Widget _buildHeaderLeft(String lang, bool isDark) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      mainAxisAlignment: MainAxisAlignment.start,
      children: [
        LumiSoftButton(
          label: I18n.t('settings.back', lang: lang),
          icon: Icons.arrow_back_rounded,
          kind: LumiSoftButtonKind.secondary,
          onTap: () {
            if (Navigator.of(context).canPop()) {
              Navigator.of(context).pop();
            } else {
              context.go('/');
            }
          },
        ),
        const SizedBox(width: 16),
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: AppTheme.accent.withValues(alpha: 0.12),
            borderRadius: AppRadius.mdBorder,
          ),
          child: Icon(
            Icons.settings_outlined,
            size: 20,
            color: isDark ? AppTheme.darkAccentDark : AppTheme.accentDark,
          ),
        ),
        const SizedBox(width: 16),
        Flexible(
          child: Text(
            I18n.t('settings.title', lang: lang),
            style: TextStyle(
              fontSize: 24,
              height: 1.18,
              fontWeight: FontWeight.w600,
              color: isDark ? AppTheme.darkTextPrimary : AppTheme.textPrimary,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  Widget _buildHeaderRight(String lang, bool isDark) {
    final saving = _saveState != _SaveState.idle;
    String saveLabel;
    switch (_saveState) {
      case _SaveState.saving:
        saveLabel = I18n.t('settings.saving', lang: lang);
        break;
      case _SaveState.saved:
        saveLabel = I18n.t('settings.saved', lang: lang);
        break;
      case _SaveState.idle:
        saveLabel = I18n.t('settings.save', lang: lang);
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        LumiSoftButton(
          label: saveLabel,
          icon: Icons.auto_awesome,
          kind: LumiSoftButtonKind.primary,
          onTap: saving ? null : _saveAll,
        ),
      ],
    );
  }

  Future<void> _saveAll() async {
    ref.invalidate(settingsProvider);
    setState(() => _saveState = _SaveState.saving);
    // 各 Section 的 onChanged 已实时通过 updateSetting 持久化到数据库，
    // 此处仅展示保存动画，不再从控制器重新同步（控制器已移至各 Section 内部管理）
    if (!mounted) return;
    setState(() => _saveState = _SaveState.saved);
    Future.delayed(const Duration(milliseconds: 1200), () {
      if (mounted) setState(() => _saveState = _SaveState.idle);
    });
  }
}


// ═══════════════════════════════════════════════════════════════
// 数据备份/恢复（Flutter 端补充：TSX 把它放在 sidebar 弹窗）
// ═══════════════════════════════════════════════════════════════

class _ImportExportSection extends ConsumerStatefulWidget {
  const _ImportExportSection();

  @override
  ConsumerState<_ImportExportSection> createState() =>
      _ImportExportSectionState();
}

class _ImportExportSectionState extends ConsumerState<_ImportExportSection> {
  bool _isExporting = false;
  bool _isImporting = false;

  bool get _isBusy => _isExporting || _isImporting;

  Future<void> _handleExport() async {
    final String lang = ref.read(localeProvider).languageCode;
    // FIX(security)：导出整库会包含 settings 表中的 API Key / NovelAI / 自定义 API
    // token 等敏感凭据，必须让用户显式确认是否包含。默认不包含。
    final includeSecrets = await _showExportDialog();
    if (!mounted) return;
    if (includeSecrets == null) return; // 用户取消
    setState(() => _isExporting = true);
    try {
      final db = ref.read(databaseProvider);
      final service = BackupService(db);
      // 全量导出不传 options：使用 ExportOptions 默认值（includeProfiles=true,
      // includeEmbeddings=false），与主项目 include_profiles=1 / include_embeddings=0
      // 默认一致（角色画像默认含；向量索引可重建且体积大，默认不含）
      final jsonStr = await service.exportToJson(includeSecrets: includeSecrets);
      final isMobileExport = Platform.isAndroid || Platform.isIOS;
      final exportBytes = Uint8List.fromList(utf8.encode(jsonStr));

      final timestamp = DateTime.now()
          .toIso8601String()
          .replaceAll(':', '-')
          .split('.')
          .first;

      if (isMobileExport) {
        final result = await FilePicker.platform.saveFile(
          dialogTitle: I18n.t('export.title', lang: lang),
          fileName: 'lumimuse_backup_$timestamp.json',
          type: FileType.custom,
          allowedExtensions: ['json'],
          bytes: exportBytes,
        );
        if (result == null) return;
      } else {
        final result = await FilePicker.platform.saveFile(
          dialogTitle: I18n.t('export.title', lang: lang),
          fileName: 'lumimuse_backup_$timestamp.json',
          type: FileType.custom,
          allowedExtensions: ['json'],
        );
        if (result == null) return;
        final file = File(result);
        await file.writeAsString(jsonStr);
      }

      final data = jsonDecode(jsonStr) as Map<String, dynamic>;
      final totalRecords = (data['characters'] as List?)?.length ?? 0;
      final conversationCount = (data['conversations'] as List?)?.length ?? 0;
      final messageCount = (data['messages'] as List?)?.length ?? 0;
      final memoryCount = (data['memories'] as List?)?.length ?? 0;
      final total =
          totalRecords + conversationCount + messageCount + memoryCount;

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('导出成功，共 $total 条记录'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('导出失败：$e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isExporting = false);
    }
  }

  /// FIX(security)：导出前确认对话框。返回值含义：
  /// - null  → 用户取消
  /// - false → 不包含敏感凭据（默认，可安全分享）
  /// - true  → 包含 API Key 等敏感凭据（备份可还原所有 API 配置）
  Future<bool?> _showExportDialog() async {
    bool includeSecrets = false;
    final lang = ref.read(localeProvider).languageCode;
    return showDialog<bool>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setLocal) {
            return AlertDialog(
              title: Text(I18n.t('export.dialog.title', lang: lang)),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(I18n.t('export.dialog.body', lang: lang)),
                  const SizedBox(height: 12),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    value: includeSecrets,
                    onChanged: (v) => setLocal(() => includeSecrets = v ?? false),
                    title: Text(I18n.t('export.dialog.includeSecrets', lang: lang)),
                    subtitle: Text(
                      I18n.t('export.dialog.includeSecretsHint', lang: lang),
                      style: const TextStyle(
                        color: Color(0xFFB91C1C),
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx, null),
                  child: Text(I18n.t('export.dialog.cancel', lang: lang)),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(ctx, includeSecrets),
                  child: Text(I18n.t('export.dialog.confirm', lang: lang)),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<void> _handleImport() async {
    setState(() => _isImporting = true);
    try {
      final result = await FilePicker.platform.pickFiles(
        dialogTitle: '导入数据',
        type: FileType.custom,
        allowedExtensions: ['json'],
      );
      if (result == null || result.files.isEmpty) return;

      final pickedFile = result.files.first;
      final filePath = pickedFile.path;
      if (filePath == null) {
        throw Exception('无法获取文件路径');
      }

      final file = File(filePath);
      final fileSize = await file.length();
      final sizeError = BackupService.checkFileSize(fileSize);
      if (sizeError != null) throw Exception(sizeError);

      final jsonStr = await file.readAsString();
      final validation = BackupService.validateBackupJson(jsonStr);
      if (!validation.isValid) {
        throw Exception(validation.errorMessage ?? '数据格式无效');
      }

      final db = ref.read(databaseProvider);
      final service = BackupService(db);
      // 全量导入不传 options：使用 ImportOptions 默认值（includeProfiles=true,
      // includeEmbeddings=false），与主项目默认一致
      final importResult = await service.importFromJson(jsonStr);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '导入成功：新增 ${importResult.addedCount} 条，跳过 ${importResult.skippedCount} 条',
            ),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('导入失败：$e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isImporting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final String lang = ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          I18n.t('export.hint', lang: lang),
          style: TextStyle(
            fontSize: 13,
            color:
                isDark ? AppTheme.darkTextSecondary : AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            LumiSoftButton(
              label: I18n.t('export.download', lang: lang),
              icon: Icons.upload_rounded,
              kind: LumiSoftButtonKind.secondary,
              onTap: _isBusy ? null : _handleExport,
            ),
            LumiSoftButton(
              label: I18n.t('import.apply', lang: lang),
              icon: Icons.download_rounded,
              kind: LumiSoftButtonKind.secondary,
              onTap: _isBusy ? null : _handleImport,
            ),
            if (_isExporting || _isImporting)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
          ],
        ),
      ],
    );
  }
}
