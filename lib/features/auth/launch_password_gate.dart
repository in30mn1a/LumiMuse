import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_provider.dart';
import '../../core/providers/settings_provider.dart';
import '../../core/services/launch_password_service.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';

/// 启动密码服务 Provider — 复用 [databaseProvider] 构造单例
///
/// 设计来自 design.md「P2 / R13」：未启用时闸门完全透传，
/// 不影响首屏冷启动；启用时由 [LaunchPasswordGate] 拦截。
final launchPasswordServiceProvider = Provider<LaunchPasswordService>((ref) {
  return LaunchPasswordService(ref.watch(databaseProvider));
});

/// 启动密码启用状态 Provider — 让设置页与顶层 Gate 共享同一状态
final launchPasswordEnabledProvider = StateProvider<bool?>((ref) => null);

/// 启动闸门 — 在 MaterialApp 之上挂载，包裹真实 child
///
/// 行为概要（详见 design.md「P2 / R13」与 requirements 13.3 / 13.4）：
/// - 启用且未解锁：拦截显示密码输入页
/// - 未启用 / 已解锁：原样透传 child
/// - 累计 5 次失败 → `_lockUntil = now + 30s` 并把 `_failureCount` 重置为 0
/// - 锁定期间提交按钮置灰，展示「请在 N 秒后再试」倒计时
/// - 解锁后允许下一次尝试，`_failureCount` 自然从 0 起累加
class LaunchPasswordGate extends ConsumerStatefulWidget {
  /// 真实的应用主体，默认会被透传渲染
  final Widget child;

  /// 测试专用 — 覆盖默认 30 秒锁定时长，仅用于 widget 测试场景，
  /// 让锁定 / 解锁迁移可在合理时间内完成。生产代码不应使用此参数。
  ///
  /// 为空时走默认 [_LaunchPasswordGateState._kLockDuration]（30 秒）。
  @visibleForTesting
  final Duration? lockDurationOverride;

  const LaunchPasswordGate({
    super.key,
    required this.child,
    this.lockDurationOverride,
  });

  @override
  ConsumerState<LaunchPasswordGate> createState() => _LaunchPasswordGateState();
}

class _LaunchPasswordGateState extends ConsumerState<LaunchPasswordGate>
    with WidgetsBindingObserver {
  /// 是否仍在判定「是否启用启动密码」
  bool _initializing = true;

  /// 启动密码功能是否启用
  bool _enabled = false;

  /// 是否已通过验证 — 启用时才有意义
  bool _unlocked = false;

  /// 当前轮失败次数（达到 5 触发锁定后重置为 0）
  int _failureCount = 0;

  /// 锁定截止时间；为 null 时未锁定
  DateTime? _lockUntil;

  /// 锁定期间每秒刷新一次的计时器
  Timer? _lockTicker;

  /// 提交校验中标志，避免重复点击导致并发计数错乱
  bool _submitting = false;

  /// 上一次错误提示（仅用于在密码错误未达上限时展示）
  String? _errorText;

  /// 密码输入控制器
  final TextEditingController _passwordController = TextEditingController();

  /// 密码输入焦点 — 显示界面时自动聚焦
  final FocusNode _focusNode = FocusNode();

  /// 单次锁定时长 — 与 design.md 一致
  static const Duration _kLockDuration = Duration(seconds: 30);

  /// 单轮允许的最大失败次数
  static const int _kMaxFailures = 5;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ref.listenManual<bool?>(launchPasswordEnabledProvider, (previous, next) {
      if (next == null || !mounted || next == _enabled) return;
      setState(() {
        _enabled = next;
        _unlocked = next;
        _failureCount = 0;
        _lockUntil = null;
        _submitting = false;
        _errorText = null;
      });
      _passwordController.clear();
      _lockTicker?.cancel();
    });
    _checkEnabled();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _lockTicker?.cancel();
    _passwordController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if ((state == AppLifecycleState.paused ||
            state == AppLifecycleState.inactive) &&
        _enabled) {
      setState(() {
        _unlocked = false;
      });
      _passwordController.clear();
    }
  }

  /// 启动时查询启用状态；服务对存储读取失败有兜底，所以无需 try/catch
  Future<void> _checkEnabled() async {
    final service = ref.read(launchPasswordServiceProvider);
    final enabled = await service.isEnabled();
    if (!mounted) return;
    setState(() {
      _enabled = enabled;
      _initializing = false;
    });
    ref.read(launchPasswordEnabledProvider.notifier).state = enabled;
    if (enabled) {
      // 进入闸门后自动聚焦密码框，移动端会自动弹出键盘
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _focusNode.requestFocus();
      });
    }
  }

  /// 计算当前是否在锁定期内
  bool get _isLocked {
    final until = _lockUntil;
    if (until == null) return false;
    return DateTime.now().isBefore(until);
  }

  /// 锁定剩余秒数（向上取整，最小 0）
  int get _lockRemainingSeconds {
    final until = _lockUntil;
    if (until == null) return 0;
    final diff = until.difference(DateTime.now()).inMilliseconds;
    if (diff <= 0) return 0;
    return (diff / 1000).ceil();
  }

  /// 启动每秒刷新的倒计时
  void _startLockTicker() {
    _lockTicker?.cancel();
    _lockTicker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (!_isLocked) {
        timer.cancel();
        setState(() {
          _lockUntil = null;
        });
        return;
      }
      // 锁定期间每秒强制刷新让倒计时数字更新
      setState(() {});
    });
  }

  /// 提交密码 — 锁定期间或正在校验中直接忽略
  Future<void> _submit() async {
    if (_submitting) return;
    if (_isLocked) return;
    final password = _passwordController.text;
    if (password.isEmpty) {
      setState(() {
        // TODO(parity): 主项目缺失 'auth.passwordRequired' 键，硬编码兜底
        _errorText = '请输入密码';
      });
      return;
    }
    setState(() {
      _submitting = true;
      _errorText = null;
    });
    final service = ref.read(launchPasswordServiceProvider);
    final ok = await service.verifyPassword(password);
    if (!mounted) return;
    if (ok) {
      // 验证通过 — 切换到 child；不必清理 _failureCount，State 即将不再展示输入界面
      setState(() {
        _unlocked = true;
        _submitting = false;
        _errorText = null;
      });
      _passwordController.clear();
      _lockTicker?.cancel();
      return;
    }
    // 失败累计 — 达到上限触发 30s 锁定并把计数器归零
    final nextCount = _failureCount + 1;
    if (nextCount >= _kMaxFailures) {
      setState(() {
        _failureCount = 0;
        _lockUntil = DateTime.now().add(
          widget.lockDurationOverride ?? _kLockDuration,
        );
        _submitting = false;
        _errorText = null;
      });
      _passwordController.clear();
      _startLockTicker();
    } else {
      setState(() {
        _failureCount = nextCount;
        _submitting = false;
        // TODO(parity): 主项目缺失 'auth.passwordWrong' 键，硬编码兜底
        _errorText = '密码不正确，已尝试 $nextCount / $_kMaxFailures 次';
      });
      _passwordController.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    // 启动初始化阶段：不渲染 child 也不渲染输入框，仅留一个轻量的 loading 占位，
    // 避免在首帧短暂闪烁主界面后再切到密码界面。
    if (_initializing) {
      return const _GateLoading();
    }
    if (!_enabled || _unlocked) {
      return widget.child;
    }
    return _LockScreen(
      passwordController: _passwordController,
      focusNode: _focusNode,
      isLocked: _isLocked,
      lockRemainingSeconds: _lockRemainingSeconds,
      submitting: _submitting,
      errorText: _errorText,
      onSubmit: _submit,
    );
  }
}

/// 初始化阶段的占位画面 — 透明背景由 AppShell 提供
class _GateLoading extends StatelessWidget {
  const _GateLoading();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: Colors.transparent,
      body: SizedBox.expand(),
    );
  }
}

/// 解锁界面 — 沿用 AppSurfaces.panel 与 AppSurfaces.buttonPrimary 体系
class _LockScreen extends ConsumerWidget {
  final TextEditingController passwordController;
  final FocusNode focusNode;
  final bool isLocked;
  final int lockRemainingSeconds;
  final bool submitting;
  final String? errorText;
  final VoidCallback onSubmit;

  const _LockScreen({
    required this.passwordController,
    required this.focusNode,
    required this.isLocked,
    required this.lockRemainingSeconds,
    required this.submitting,
    required this.errorText,
    required this.onSubmit,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // 任务 6.5：i18n 接线 — 本闸门绝大多数文案在主项目无对照键，目前全部
    // 使用硬编码兜底 + TODO(parity) 注释；这里仍 watch 一次 localeProvider，
    // 以便未来主项目补键后只需替换硬编码即可生效（语言切换时整树会自动重建）。
    ref.watch(localeProvider);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accent = isDark ? AppTheme.darkAccent : AppTheme.accent;
    final textPrimary = isDark
        ? AppTheme.darkTextPrimary
        : AppTheme.textPrimary;
    final textMuted = isDark ? AppTheme.darkTextMuted : AppTheme.textMuted;

    // TODO(parity): 主项目缺失 'auth.lockHint' 键，硬编码兜底（含 {seconds} 占位）
    final lockHint = isLocked ? '请在 $lockRemainingSeconds 秒后再试' : null;
    final canSubmit = !isLocked && !submitting;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Container(
                decoration: AppSurfaces.panel(isDark: isDark),
                padding: const EdgeInsets.fromLTRB(28, 32, 28, 28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // 顶部图标 — 用 hero 渐变小章
                    Center(
                      child: Container(
                        width: 56,
                        height: 56,
                        decoration: AppSurfaces.hero(isDark: isDark),
                        alignment: Alignment.center,
                        child: Icon(
                          Icons.lock_outline_rounded,
                          size: 24,
                          color: accent,
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(
                      // TODO(parity): 主项目缺失 'auth.gateTitle' 键，硬编码兜底
                      '请输入启动密码',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: textPrimary,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      // TODO(parity): 主项目缺失 'auth.gateBody' 键，硬编码兜底
                      '本应用已开启启动密码保护，输入正确后才会进入主界面',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: textMuted),
                    ),
                    const SizedBox(height: 22),
                    TextField(
                      controller: passwordController,
                      focusNode: focusNode,
                      obscureText: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      enabled: canSubmit,
                      textInputAction: TextInputAction.done,
                      inputFormatters: [
                        // 防止用户粘贴多行内容到密码框
                        FilteringTextInputFormatter.deny(RegExp(r'[\r\n]')),
                      ],
                      decoration: const InputDecoration(
                        // TODO(parity): 主项目缺失 'auth.launchPassword' 键，硬编码兜底
                        labelText: '启动密码',
                        // TODO(parity): 主项目缺失 'auth.placeholder' 键，硬编码兜底；
                        // 任务 6.5 要求该键启用时切换为 I18n.t('auth.placeholder')，
                        // 待主项目登记后再补
                        hintText: '请输入解锁密码',
                      ),
                      onSubmitted: (_) {
                        if (canSubmit) onSubmit();
                      },
                    ),
                    if (lockHint != null) ...[
                      const SizedBox(height: 12),
                      _HintRow(
                        icon: Icons.timer_outlined,
                        color: accent,
                        text: lockHint,
                      ),
                    ] else if (errorText != null) ...[
                      const SizedBox(height: 12),
                      _HintRow(
                        icon: Icons.error_outline_rounded,
                        color: Colors.redAccent.withValues(alpha: 0.85),
                        text: errorText!,
                      ),
                    ],
                    const SizedBox(height: 22),
                    _PrimaryButton(
                      // TODO(parity): 主项目缺失 'auth.verifying' / 'auth.unlock' 键，硬编码兜底
                      label: submitting ? '正在校验…' : '解锁',
                      enabled: canSubmit,
                      onPressed: canSubmit ? onSubmit : null,
                      isDark: isDark,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 错误 / 倒计时提示行
class _HintRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;

  const _HintRow({required this.icon, required this.color, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 12,
              color: color,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ],
    );
  }
}

/// 主按钮 — 沿用 AppSurfaces.buttonPrimary 渐变填充
class _PrimaryButton extends StatelessWidget {
  final String label;
  final bool enabled;
  final VoidCallback? onPressed;
  final bool isDark;

  const _PrimaryButton({
    required this.label,
    required this.enabled,
    required this.onPressed,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final decoration = enabled
        ? AppSurfaces.buttonPrimary(isDark: isDark)
        : BoxDecoration(
            color: (isDark ? AppTheme.darkAccent : AppTheme.accent).withValues(
              alpha: 0.18,
            ),
            borderRadius: BorderRadius.circular(16),
          );
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTap: onPressed,
        child: Container(
          height: 48,
          decoration: decoration,
          alignment: Alignment.center,
          child: Text(
            label,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: enabled
                  ? Colors.white
                  : (isDark ? AppTheme.darkTextMuted : AppTheme.textMuted),
            ),
          ),
        ),
      ),
    );
  }
}
