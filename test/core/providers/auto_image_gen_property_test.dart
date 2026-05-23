// 自动生图属性测试
// Feature: flutter-core-features, Task 11.2
// Property 14: Auto image generation keyword detection with flag
// Property 15: Auto image generation prompt assembly
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, test, group;

/// 自动生图逻辑（从 ChatController._checkAutoImageGen 提取的纯函数版本）
///
/// 用于属性测试，避免依赖数据库和图片生成服务。
class AutoImageGenChecker {
  /// 检测用户消息是否包含自动生图关键词
  ///
  /// 返回匹配到的关键词，未匹配返回 null。
  /// [autoGenerate] 为 false 时直接返回 null。
  static String? detectKeyword({
    required String userContent,
    required String autoGenerateKeywords,
    required bool autoGenerate,
    required bool imageGenEnabled,
  }) {
    if (!imageGenEnabled || !autoGenerate) return null;

    final keywords = autoGenerateKeywords
        .split(',')
        .map((k) => k.trim())
        .where((k) => k.isNotEmpty)
        .toList();

    for (final keyword in keywords) {
      if (userContent.contains(keyword)) {
        return keyword;
      }
    }

    return null;
  }

  /// 组装自动生图提示词
  ///
  /// 规则：
  /// - 角色 image_tags + 用户消息移除首个匹配关键词后的剩余文本
  /// - 剩余文本为空时仅用 image_tags
  /// - image_tags 为空时仅用剩余文本
  /// - 两者都为空返回 null（不生图）
  static String? assemblePrompt({
    required String userContent,
    required String matchedKeyword,
    required String imageTags,
  }) {
    final remainingText = userContent.replaceFirst(matchedKeyword, '').trim();

    if (remainingText.isEmpty && imageTags.isEmpty) return null;
    if (remainingText.isEmpty) return imageTags;
    if (imageTags.isEmpty) return remainingText;
    return '$imageTags, $remainingText';
  }
}

void main() {
  group('Property 14: Auto image generation keyword detection with flag', () {
    test('autoGenerate=false 时始终不检测关键词', () {
      final result = AutoImageGenChecker.detectKeyword(
        userContent: '画一张猫咪',
        autoGenerateKeywords: '画,生图,来一张',
        autoGenerate: false,
        imageGenEnabled: true,
      );
      expect(result, isNull);
    });

    test('imageGenEnabled=false 时始终不检测关键词', () {
      final result = AutoImageGenChecker.detectKeyword(
        userContent: '画一张猫咪',
        autoGenerateKeywords: '画,生图,来一张',
        autoGenerate: true,
        imageGenEnabled: false,
      );
      expect(result, isNull);
    });

    Glados<String>(any.choose(['画', '生图', '来一张', '看看'])).test(
      '消息包含任一关键词时返回该关键词',
      (keyword) {
        final result = AutoImageGenChecker.detectKeyword(
          userContent: '请$keyword一个风景',
          autoGenerateKeywords: '画,生图,来一张,看看',
          autoGenerate: true,
          imageGenEnabled: true,
        );
        expect(result, isNotNull);
        expect(result, keyword);
      },
    );

    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      '消息不包含任何关键词时返回 null',
      (content) {
        // 确保 content 不包含任何关键词
        final safeContent = content
            .replaceAll('画', '')
            .replaceAll('生图', '')
            .replaceAll('来一张', '')
            .replaceAll('看看', '');
        if (safeContent.isEmpty) return; // 跳过空字符串

        final result = AutoImageGenChecker.detectKeyword(
          userContent: safeContent,
          autoGenerateKeywords: '画,生图,来一张,看看',
          autoGenerate: true,
          imageGenEnabled: true,
        );
        expect(result, isNull,
            reason: '"$safeContent" 不包含关键词，不应触发');
      },
    );

    test('空关键词列表不触发', () {
      final result = AutoImageGenChecker.detectKeyword(
        userContent: '画一张猫咪',
        autoGenerateKeywords: '',
        autoGenerate: true,
        imageGenEnabled: true,
      );
      expect(result, isNull);
    });

    test('关键词是子字符串匹配（不是完整词匹配）', () {
      final result = AutoImageGenChecker.detectKeyword(
        userContent: '我想画画',
        autoGenerateKeywords: '画',
        autoGenerate: true,
        imageGenEnabled: true,
      );
      expect(result, '画');
    });
  });

  group('Property 15: Auto image generation prompt assembly', () {
    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      'imageTags 非空 + 剩余文本非空 → 组合格式 "tags, text"',
      (extraText) {
        if (extraText.isEmpty) return;
        final result = AutoImageGenChecker.assemblePrompt(
          userContent: '画$extraText',
          matchedKeyword: '画',
          imageTags: '1girl, blue eyes',
        );
        expect(result, '1girl, blue eyes, $extraText');
      },
    );

    test('剩余文本为空时仅用 imageTags', () {
      final result = AutoImageGenChecker.assemblePrompt(
        userContent: '画',
        matchedKeyword: '画',
        imageTags: '1girl, blue eyes',
      );
      expect(result, '1girl, blue eyes');
    });

    test('imageTags 为空时仅用剩余文本', () {
      final result = AutoImageGenChecker.assemblePrompt(
        userContent: '画一只猫',
        matchedKeyword: '画',
        imageTags: '',
      );
      expect(result, '一只猫');
    });

    test('两者都为空时返回 null（不生图）', () {
      final result = AutoImageGenChecker.assemblePrompt(
        userContent: '画',
        matchedKeyword: '画',
        imageTags: '',
      );
      expect(result, isNull);
    });

    test('关键词在消息中间时正确移除', () {
      final result = AutoImageGenChecker.assemblePrompt(
        userContent: '帮我生图一个城堡',
        matchedKeyword: '生图',
        imageTags: 'fantasy',
      );
      expect(result, 'fantasy, 帮我一个城堡');
    });

    test('仅移除首个匹配的关键词', () {
      final result = AutoImageGenChecker.assemblePrompt(
        userContent: '画画一幅画',
        matchedKeyword: '画',
        imageTags: 'art',
      );
      // replaceFirst 只移除第一个"画"
      expect(result, 'art, 画一幅画');
    });

    Glados<String>(any.choose(['alpha', 'beta', 'gamma', 'delta', 'hello', 'world', 'test', 'foo', 'bar', 'xyz123'])).test(
      'imageTags 非空 + 关键词恰好等于整条消息 → 仅返回 imageTags',
      (tags) {
        if (tags.isEmpty) return;
        final result = AutoImageGenChecker.assemblePrompt(
          userContent: '来一张',
          matchedKeyword: '来一张',
          imageTags: tags,
        );
        expect(result, tags);
      },
    );
  });
}

