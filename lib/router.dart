import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'features/home/home_page.dart';
import 'features/characters/character_edit_page.dart';
import 'features/characters/character_images_page.dart';
import 'features/memories/memory_list_page.dart';
import 'features/settings/settings_page.dart';

/// 应用路由配置
///
/// 与原版 Next.js 一致：
/// - 主屏 `/` 为「侧栏 + ChatView」常驻布局，不再用 ShellRoute 嵌套子路由
/// - 角色编辑、记忆管理、设置为独立全屏页面
/// - 全局搜索是叠在主屏上的弹窗（`showGlobalSearchDialog`），不再走独立路由

// FIX: M3 路由参数校验 —— 合法 ID 格式（兼容短 ID 与完整 UUID）
//   * 长度 8 ~ 36
//   * 仅由 [A-Za-z0-9_-] 构成
// 不合法的 ID 不再让子页面进 Drift 才报错，而是在 redirect 阶段直接打回主页。
final RegExp _idPattern = RegExp(r'^[A-Za-z0-9_-]+$');

bool _isValidId(String? raw) {
  if (raw == null) return false;
  if (raw.length < 8 || raw.length > 36) return false;
  return _idPattern.hasMatch(raw);
}

final appRouter = GoRouter(
  initialLocation: '/',
  errorBuilder: (context, state) => Scaffold(
    backgroundColor: Colors.transparent,
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, size: 48, color: Colors.grey),
          const SizedBox(height: 16),
          Text('页面未找到: ${state.error?.message ?? state.uri.toString()}'),
        ],
      ),
    ),
  ),
  routes: [
    // 主屏（侧栏 + 聊天视图）
    GoRoute(
      path: '/',
      builder: (context, state) => const HomePage(),
    ),
    // 角色编辑
    GoRoute(
      path: '/characters/:id/edit',
      // FIX: M3 redirect 校验 —— 非法 id 直接重定向回主页，避免子页面崩溃
      redirect: (context, state) {
        final id = state.pathParameters['id'];
        if (!_isValidId(id)) return '/';
        return null;
      },
      builder: (context, state) => CharacterEditPage(
        characterId: state.pathParameters['id']!,
      ),
    ),
    // 角色图片管理（R11 / Task 12.5）
    GoRoute(
      path: '/characters/:id/images',
      // FIX: M3 redirect 校验
      redirect: (context, state) {
        final id = state.pathParameters['id'];
        if (!_isValidId(id)) return '/';
        return null;
      },
      pageBuilder: (context, state) => NoTransitionPage(
        child: CharacterImagesPage(characterId: state.pathParameters['id']!),
      ),
    ),
    // 记忆管理
    GoRoute(
      path: '/memories/:id',
      // FIX: M3 redirect 校验
      redirect: (context, state) {
        final id = state.pathParameters['id'];
        if (!_isValidId(id)) return '/';
        return null;
      },
      builder: (context, state) => MemoryListPage(
        characterId: state.pathParameters['id']!,
      ),
    ),
    // 设置
    GoRoute(
      path: '/settings',
      builder: (context, state) => const SettingsPage(),
    ),
  ],
);
