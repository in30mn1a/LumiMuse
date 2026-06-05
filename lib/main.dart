import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app.dart';

void main() {
  // FIX: 全局错误兜底（M1）—— 避免 Drift / SharedPreferences 等平台通道
  // 异常或异步未捕获错误直接红屏，统一收敛到 debugPrint，release 模式下
  // 留出接入 sentry / firebase crashlytics 的位置（TODO）。
  runZonedGuarded(() {
    // 注意：必须先初始化 binding，再访问 PlatformDispatcher / runApp，
    // 顺序敏感，不能把 ensureInitialized 移出 zone。
    WidgetsFlutterBinding.ensureInitialized();

    // FIX: Flutter framework 异常（build/layout/paint 阶段抛出的同步异常）
    FlutterError.onError = (FlutterErrorDetails details) {
      // 保留默认输出（红屏 / 控制台堆栈），便于本地开发定位
      FlutterError.presentError(details);
      debugPrint('[FlutterError] ${details.exceptionAsString()}');
      // TODO(crash-reporting): 接入 sentry / firebase crashlytics 后在此上报
    };

    // FIX: 平台通道 / 引擎层异常（onError 返回 true 表示已处理，避免崩溃）
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      debugPrint('[PlatformDispatcher] $error\n$stack');
      // TODO(crash-reporting): 同上，release 上报
      return true;
    };

    runApp(const ProviderScope(child: LumiMuseApp()));
  }, (Object error, StackTrace stack) {
    // FIX: zone 内未捕获的异步错误（如 await 后抛出且无 try/catch）
    debugPrint('[runZonedGuarded] $error\n$stack');
    // TODO(crash-reporting): 同上，release 上报
  });
}
