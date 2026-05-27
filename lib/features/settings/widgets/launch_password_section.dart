import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/settings_provider.dart';
import '../../../core/utils/i18n.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/surfaces.dart';
import '../../auth/launch_password_gate.dart';

/// 启动密码区域 — 设置页内的「启用 / 禁用 / 修改密码」入口
///
/// 设计要点（详见 design.md「P2 / R13」与 requirements 13.1 / 13.5 / 13.6）：
/// - 启用时：弹窗要求设置初始密码（长度 ≥ 4），调用 [LaunchPasswordService.setPassword]。
/// - 禁用时：弹窗要求输入当前密码验证，验证通过调用 [LaunchPasswordService.disable]。
/// - 修改密码：先验证当前密码，再设置新密码（长度 ≥ 4）。
///
/// 视觉沿用「数据维护」等区块的 `_SectionCard` 风格 + `AppSurfaces.panelQuiet`，
/// 通过 [launchPasswordServiceProvider] 复用 `launch_password_gate.dart` 顶层暴露的服务。
class LaunchPasswordSection extends ConsumerStatefulWidget {
  const LaunchPasswordSection({super.key});

  @override
  ConsumerState<LaunchPasswordSection> createState() =>
      _LaunchPasswordSectionState();
}

class _LaunchPasswordSectionState extends ConsumerState<LaunchPasswordSection> {
  /// 是否已启用启动密码 — 初始 null 表示尚未读取
  bool? _enabled;

  /// 当前是否在执行后台校验 / 写入操作（启用 / 禁用 / 修改）
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _refreshEnabled();
  }

  /// 重新读取启用状态 — 用于初始化以及任意操作完成后刷新
  Future<void> _refreshEnabled() async {
    try {
      final service = ref.read(launchPasswordServiceProvider);
      final enabled = await service.isEnabled();
      if (!mounted) return;
      setState(() => _enabled = enabled);
      ref.read(launchPasswordEnabledProvider.notifier).state = enabled;
    } catch (e) {
      // 读取失败按未启用处理，避免阻塞 UI
      // ignore: avoid_print
      print('[settings] LaunchPasswordSection.isEnabled 失败: $e');
      if (!mounted) return;
      setState(() => _enabled = false);
      ref.read(launchPasswordEnabledProvider.notifier).state = false;
    }
  }

  /// 处理开关切换 — 由当前状态决定走启用 / 禁用流程
  Future<void> _handleSwitch(bool next) async {
    if (_busy) return;
    if (next) {
      await _enableFlow();
    } else {
      await _disableFlow();
    }
  }

  /// 启用流程 — 弹窗设置初始密码
  Future<void> _enableFlow() async {
    final input = await _promptPasswords(
      // TODO(parity): 主项目缺失 'auth.setTitle' 键，硬编码兜底
      title: '设置启动密码',
      // TODO(parity): 主项目缺失 'auth.setDescription' 键，硬编码兜底
      description: '启用后，下次启动应用需要先输入此密码才能进入主界面。',
      requireConfirm: true,
      // TODO(parity): 主项目缺失 'auth.enable' 键，硬编码兜底
      submitLabel: '启用',
    );
    if (input == null) return;

    setState(() => _busy = true);
    try {
      await ref
          .read(launchPasswordServiceProvider)
          .setPassword(input.newPassword);
      await _refreshEnabled();
      // TODO(parity): 主项目缺失 'auth.enabledToast' 键，硬编码兜底
      _showSnack('启动密码已启用');
    } catch (e) {
      // TODO(parity): 主项目缺失 'auth.setFailed' 键，硬编码兜底
      _showSnack('设置失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 禁用流程 — 弹窗输入当前密码验证后清空
  Future<void> _disableFlow() async {
    final current = await _promptCurrentPassword(
      // TODO(parity): 主项目缺失 'auth.disableTitle' 键，硬编码兜底
      title: '禁用启动密码',
      // TODO(parity): 主项目缺失 'auth.disableDescription' 键，硬编码兜底
      description: '禁用前请先输入当前密码完成验证。',
      // TODO(parity): 主项目缺失 'auth.disable' 键，硬编码兜底
      submitLabel: '禁用',
    );
    if (current == null) return;

    setState(() => _busy = true);
    try {
      await ref.read(launchPasswordServiceProvider).disable(current);
      await _refreshEnabled();
      // TODO(parity): 主项目缺失 'auth.disabledToast' 键，硬编码兜底
      _showSnack('启动密码已禁用');
    } on StateError {
      // TODO(parity): 主项目缺失 'auth.currentPasswordWrong' 键，硬编码兜底
      _showSnack('当前密码不正确');
    } catch (e) {
      // TODO(parity): 主项目缺失 'auth.disableFailed' 键，硬编码兜底
      _showSnack('禁用失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 修改密码 — 先验证当前密码，再设置新密码
  Future<void> _changePasswordFlow() async {
    if (_busy) return;
    final input = await _promptPasswords(
      // TODO(parity): 主项目缺失 'auth.changeTitle' 键，硬编码兜底
      title: '修改启动密码',
      // TODO(parity): 主项目缺失 'auth.changeDescription' 键，硬编码兜底
      description: '请输入当前密码，并设置一个新的启动密码。',
      requireCurrent: true,
      requireConfirm: true,
      // TODO(parity): 主项目缺失 'auth.changeSubmit' 键，硬编码兜底（与 'common.save' 语义相近，但保留与产品文案一致）
      submitLabel: '保存',
    );
    if (input == null) return;

    setState(() => _busy = true);
    try {
      final service = ref.read(launchPasswordServiceProvider);
      final currentOk = await service.verifyPassword(input.currentPassword);
      if (!currentOk) {
        // TODO(parity): 主项目缺失 'auth.currentPasswordWrong' 键，硬编码兜底
        _showSnack('当前密码不正确');
        return;
      }
      await service.setPassword(input.newPassword);
      // TODO(parity): 主项目缺失 'auth.changedToast' 键，硬编码兜底
      _showSnack('启动密码已更新');
    } catch (e) {
      // TODO(parity): 主项目缺失 'auth.changeFailed' 键，硬编码兜底
      _showSnack('修改失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 弹出输入当前密码的对话框（仅一个字段）
  Future<String?> _promptCurrentPassword({
    required String title,
    required String description,
    required String submitLabel,
  }) async {
    return showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _CurrentPasswordDialog(
        title: title,
        description: description,
        submitLabel: submitLabel,
      ),
    );
  }

  /// 弹出输入新密码（含可选当前密码 / 确认密码）的对话框
  Future<_PasswordInputResult?> _promptPasswords({
    required String title,
    required String description,
    bool requireCurrent = false,
    bool requireConfirm = false,
    required String submitLabel,
  }) async {
    return showDialog<_PasswordInputResult>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _PasswordInputDialog(
        title: title,
        description: description,
        requireCurrent: requireCurrent,
        requireConfirm: requireConfirm,
        submitLabel: submitLabel,
      ),
    );
  }

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentDark = isDark ? AppTheme.darkAccentDark : AppTheme.accentDark;
    final textPrimary = isDark
        ? AppTheme.darkTextPrimary
        : AppTheme.textPrimary;
    final textSecondary = isDark
        ? AppTheme.darkTextSecondary
        : AppTheme.textSecondary;

    final enabled = _enabled;
    return Container(
      decoration: AppSurfaces.panelQuiet(isDark: isDark),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // 顶部标题行 — 与其它 _SectionCard 一致的图标 + 标题样式
          Row(
            children: [
              Icon(Icons.lock_outline_rounded, size: 18, color: accentDark),
              const SizedBox(width: 8),
              Text(
                // TODO(parity): 主项目缺失 'auth.launchPassword' 键，硬编码兜底
                '启动密码',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // 状态尚未读取时的占位
          if (enabled == null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    // TODO(parity): 主项目缺失 'auth.statusLoading' 键，硬编码兜底
                    '正在读取启动密码状态…',
                    style: TextStyle(fontSize: 13, color: textSecondary),
                  ),
                ],
              ),
            )
          else ...[
            // 主开关行
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        // TODO(parity): 主项目缺失 'auth.enableTitle' 键，硬编码兜底
                        '启用启动密码',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        enabled
                            // TODO(parity): 主项目缺失 'auth.enabledHint' / 'auth.disabledHint' 键，硬编码兜底
                            ? '冷启动时需要输入密码才能进入主界面'
                            : '默认关闭，启用后可在他人代用设备时保护隐私',
                        style: TextStyle(fontSize: 12, color: textSecondary),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Opacity(
                  opacity: _busy ? 0.4 : 1.0,
                  child: Switch(
                    value: enabled,
                    onChanged: _busy ? null : _handleSwitch,
                    activeThumbColor: AppTheme.primaryLight,
                  ),
                ),
              ],
            ),
            // 启用态下显示「修改密码」按钮
            if (enabled) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : _changePasswordFlow,
                  icon: const Icon(Icons.key_rounded, size: 18),
                  // TODO(parity): 主项目缺失 'auth.changePassword' 键，硬编码兜底
                  label: const Text('修改密码'),
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }
}

/// 当前密码输入弹窗 — 仅一个密码字段，用于禁用流程
class _CurrentPasswordDialog extends ConsumerStatefulWidget {
  final String title;
  final String description;
  final String submitLabel;

  const _CurrentPasswordDialog({
    required this.title,
    required this.description,
    required this.submitLabel,
  });

  @override
  ConsumerState<_CurrentPasswordDialog> createState() =>
      _CurrentPasswordDialogState();
}

class _CurrentPasswordDialogState
    extends ConsumerState<_CurrentPasswordDialog> {
  final TextEditingController _ctrl = TextEditingController();
  String? _errorText;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _ctrl.text;
    if (text.isEmpty) {
      // TODO(parity): 主项目缺失 'auth.currentPasswordRequired' 键，硬编码兜底
      setState(() => _errorText = '请输入当前密码');
      return;
    }
    Navigator.of(context).pop(text);
  }

  @override
  Widget build(BuildContext context) {
    // 任务 6.5：i18n 接线 — 弹窗内文案大多无主项目对照键，仅 `common.cancel` 走 i18n
    final String lang = ref.watch(localeProvider).languageCode;
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.description,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _ctrl,
            obscureText: true,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: [
              FilteringTextInputFormatter.deny(RegExp(r'[\r\n]')),
            ],
            decoration: InputDecoration(
              // TODO(parity): 主项目缺失 'auth.currentPassword' 键，硬编码兜底
              labelText: '当前密码',
              // TODO(parity): 主项目缺失 'auth.currentPasswordHint' 键，硬编码兜底
              hintText: '请输入当前启动密码',
              errorText: _errorText,
            ),
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(I18n.t('common.cancel', lang: lang)),
        ),
        TextButton(onPressed: _submit, child: Text(widget.submitLabel)),
      ],
    );
  }
}

/// 新密码输入弹窗 — 支持「当前密码（可选） + 新密码 + 确认新密码（可选）」
class _PasswordInputDialog extends ConsumerStatefulWidget {
  final String title;
  final String description;
  final bool requireCurrent;
  final bool requireConfirm;
  final String submitLabel;

  const _PasswordInputDialog({
    required this.title,
    required this.description,
    required this.requireCurrent,
    required this.requireConfirm,
    required this.submitLabel,
  });

  @override
  ConsumerState<_PasswordInputDialog> createState() =>
      _PasswordInputDialogState();
}

class _PasswordInputDialogState extends ConsumerState<_PasswordInputDialog> {
  /// 启动密码最低长度 — 与 design.md 13.1 一致
  static const int _kMinLength = 4;

  final TextEditingController _currentCtrl = TextEditingController();
  final TextEditingController _newCtrl = TextEditingController();
  final TextEditingController _confirmCtrl = TextEditingController();

  String? _currentError;
  String? _newError;
  String? _confirmError;

  // 三个密码输入框共用一个显隐开关。
  bool _obscure = true;

  // TODO(parity): i18n —— tooltip 待接入 i18n
  Widget _eyeSuffix() {
    return IconButton(
      tooltip: _obscure ? '显示' : '隐藏',
      icon: Icon(
        _obscure ? Icons.visibility : Icons.visibility_off,
        size: 18,
      ),
      onPressed: () => setState(() => _obscure = !_obscure),
    );
  }

  @override
  void dispose() {
    _currentCtrl.dispose();
    _newCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final current = _currentCtrl.text;
    final next = _newCtrl.text;
    final confirm = _confirmCtrl.text;

    String? curErr;
    String? newErr;
    String? confirmErr;

    if (widget.requireCurrent && current.isEmpty) {
      // TODO(parity): 主项目缺失 'auth.currentPasswordRequired' 键，硬编码兜底
      curErr = '请输入当前密码';
    }
    if (next.length < _kMinLength) {
      // TODO(parity): 主项目缺失 'auth.newPasswordMinLength' 键，硬编码兜底
      newErr = '新密码长度至少 $_kMinLength 位';
    }
    if (widget.requireConfirm && confirm != next) {
      // TODO(parity): 主项目缺失 'auth.passwordMismatch' 键，硬编码兜底
      confirmErr = '两次输入不一致';
    }

    if (curErr != null || newErr != null || confirmErr != null) {
      setState(() {
        _currentError = curErr;
        _newError = newErr;
        _confirmError = confirmErr;
      });
      return;
    }
    Navigator.of(
      context,
    ).pop(_PasswordInputResult(currentPassword: current, newPassword: next));
  }

  @override
  Widget build(BuildContext context) {
    final String lang = ref.watch(localeProvider).languageCode;
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.description,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (widget.requireCurrent) ...[
              TextField(
                controller: _currentCtrl,
                obscureText: _obscure,
                autofocus: true,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.next,
                inputFormatters: [
                  FilteringTextInputFormatter.deny(RegExp(r'[\r\n]')),
                ],
                decoration: InputDecoration(
                  // TODO(parity): 主项目缺失 'auth.currentPassword' 键，硬编码兜底
                  labelText: '当前密码',
                  // TODO(parity): 主项目缺失 'auth.currentPasswordHint' 键，硬编码兜底
                  hintText: '请输入当前启动密码',
                  errorText: _currentError,
                  suffixIcon: _eyeSuffix(),
                ),
                onSubmitted: (_) => FocusScope.of(context).nextFocus(),
              ),
              const SizedBox(height: 12),
            ],
            TextField(
              controller: _newCtrl,
              obscureText: _obscure,
              autofocus: !widget.requireCurrent,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: widget.requireConfirm
                  ? TextInputAction.next
                  : TextInputAction.done,
              inputFormatters: [
                FilteringTextInputFormatter.deny(RegExp(r'[\r\n]')),
              ],
              decoration: InputDecoration(
                // TODO(parity): 主项目缺失 'auth.newPassword' 键，硬编码兜底
                labelText: '新密码',
                // TODO(parity): 主项目缺失 'auth.newPasswordHint' 键，硬编码兜底
                hintText: '长度至少 $_kMinLength 位',
                errorText: _newError,
                suffixIcon: _eyeSuffix(),
              ),
              onSubmitted: (_) {
                if (widget.requireConfirm) {
                  FocusScope.of(context).nextFocus();
                } else {
                  _submit();
                }
              },
            ),
            if (widget.requireConfirm) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _confirmCtrl,
                obscureText: _obscure,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.done,
                inputFormatters: [
                  FilteringTextInputFormatter.deny(RegExp(r'[\r\n]')),
                ],
                decoration: InputDecoration(
                  // TODO(parity): 主项目缺失 'auth.confirmPassword' 键，硬编码兜底
                  labelText: '确认新密码',
                  // TODO(parity): 主项目缺失 'auth.confirmPasswordHint' 键，硬编码兜底
                  hintText: '请再次输入新密码',
                  errorText: _confirmError,
                  suffixIcon: _eyeSuffix(),
                ),
                onSubmitted: (_) => _submit(),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(I18n.t('common.cancel', lang: lang)),
        ),
        TextButton(onPressed: _submit, child: Text(widget.submitLabel)),
      ],
    );
  }
}

/// 新密码弹窗的返回结构 — 同时携带当前密码（仅修改密码场景使用）
class _PasswordInputResult {
  final String currentPassword;
  final String newPassword;

  const _PasswordInputResult({
    required this.currentPassword,
    required this.newPassword,
  });
}
