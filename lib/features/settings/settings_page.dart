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

enum _SaveState { idle, saving, saved }

class _SettingsPageState extends ConsumerState<SettingsPage> {
  _SaveState _saveState = _SaveState.idle;

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    final String lang = ref.watch(localeProvider).languageCode;

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
        return Scaffold(
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
                    children: [
                      _buildHeader(lang),
                      const SizedBox(height: AppSpacing.lg),
                      const ProviderManageSection(),
                      const SizedBox(height: AppSpacing.lg),
                      const ApiSection(),
                      const SizedBox(height: AppSpacing.lg),
                      const ModelSection(),
                      const SizedBox(height: AppSpacing.lg),
                      const ChatBehaviorSection(),
                      const SizedBox(height: AppSpacing.lg),
                      const MemorySection(),
                      const SizedBox(height: AppSpacing.lg),
                      const DisplaySection(),
                      const SizedBox(height: AppSpacing.lg),
                      LumiSectionPanel(
                        title: I18n.t('settings.imageGen', lang: lang),
                        child: const ImageGenSettingsSection(),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      const LumiSectionPanel(
                        title: '启动密码',
                        child: LaunchPasswordSection(),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      LumiSectionPanel(
                        title: '数据备份与恢复',
                        child: _ImportExportSection(ref: ref),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      const MaintenanceSection(),
                      const SizedBox(height: AppSpacing.lg),
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

class _ImportExportSection extends StatefulWidget {
  final WidgetRef ref;
  const _ImportExportSection({required this.ref});

  @override
  State<_ImportExportSection> createState() => _ImportExportSectionState();
}

class _ImportExportSectionState extends State<_ImportExportSection> {
  bool _isExporting = false;
  bool _isImporting = false;

  bool get _isBusy => _isExporting || _isImporting;

  Future<void> _handleExport() async {
    final String lang = widget.ref.read(localeProvider).languageCode;
    setState(() => _isExporting = true);
    try {
      final db = widget.ref.read(databaseProvider);
      final service = BackupService(db);
      final jsonStr = await service.exportToJson();
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

      final db = widget.ref.read(databaseProvider);
      final service = BackupService(db);
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
    final String lang = widget.ref.watch(localeProvider).languageCode;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
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
