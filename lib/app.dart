import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/providers/settings_provider.dart';
import 'features/auth/launch_password_gate.dart';
import 'router.dart';
import 'theme/app_shell.dart';
import 'theme/app_theme.dart';

/// LumiMuse 应用根组件
class LumiMuseApp extends ConsumerWidget {
  const LumiMuseApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeProvider);
    final locale = ref.watch(localeProvider);

    return MaterialApp.router(
      title: 'LumiMuse',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: themeMode,
      // 主题切换平滑过渡：500ms 内完成，不重启应用、不重建路由栈
      themeAnimationDuration: const Duration(milliseconds: 500),
      themeAnimationCurve: Curves.easeInOut,
      // 任务 4.4：注入语言 + 本地化委托
      // - locale 由 localeProvider 顶层 watch，切换语言时整树重建
      // - supportedLocales 与 localeProvider 默认值（zh）保持一致
      // - 三个 GlobalXxxLocalizations.delegate 提供 Material/Widgets/Cupertino
      //   的内建中英文翻译（DatePicker、SelectableText 长按菜单等）
      locale: locale,
      supportedLocales: const [Locale('zh'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: appRouter,
      builder: (context, child) {
        // 用 AppShell 包裹所有路由：渐变 + 网格底纹 + 内边距细紫框
        // 再在 AppShell 内套一层 LaunchPasswordGate：
        // - 默认未启用启动密码时直接透传 child，零开销
        // - 启用时由闸门接管首屏，解锁后再渲染真实路由
        // 放在 AppShell 之内是为了让闸门画面也能享有暖光渐变背景（_LockScreen
        // 与 _GateLoading 都使用透明 Scaffold，依赖 AppShell 提供底色）。
        return AppShell(
          child: LaunchPasswordGate(child: child ?? const SizedBox.shrink()),
        );
      },
    );
  }
}
