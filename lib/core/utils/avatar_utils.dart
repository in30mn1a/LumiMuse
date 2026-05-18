// ignore_for_file: depend_on_referenced_packages

import 'package:characters/characters.dart';

/// 头像工具模块 — 提供默认头像文本推导功能
///
/// 用于角色头像上传组件中，当用户未设置自定义头像时，
/// 根据角色名称推导出默认显示的文本。
class AvatarUtils {
  /// 从角色名称推导默认头像文本
  ///
  /// 规则：
  /// - 名称非空时，返回名称的第一个字素簇（grapheme cluster）
  /// - 名称为空（空字符串或仅含空白字符）时，返回 null 表示应显示人物图标
  ///
  /// 支持 CJK 字符、emoji、ASCII 等各种 Unicode 字符。
  /// 使用 Dart 的 Characters API 正确处理多码点字素簇（如 emoji）。
  static String? deriveAvatarText(String name) {
    // 去除首尾空白
    final trimmed = name.trim();

    // 空字符串 → 显示人物图标
    if (trimmed.isEmpty) {
      return null;
    }

    // 使用 Characters API 获取第一个字素簇
    // 这能正确处理 emoji（如 👨‍👩‍👧‍👦）和组合字符
    final characters = trimmed.characters;
    return characters.first;
  }
}
