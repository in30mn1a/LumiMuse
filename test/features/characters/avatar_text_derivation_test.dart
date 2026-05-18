// ignore_for_file: depend_on_referenced_packages

// 默认头像文本推导属性测试
// Feature: flutter-visual-polish, Property 6: Default avatar text derivation
// Validates: Requirements 8.7, 8.8

import 'package:characters/characters.dart';
import 'package:glados/glados.dart';
import 'package:lumimuse/core/utils/avatar_utils.dart';

/// CJK 字符范围样本（中日韩统一表意文字）
const _cjkSamples = [
  '你', '好', '世', '界', '猫', '花', '月', '星',
  '愛', '夢', '光', '風', '雨', '雪', '山', '海',
  '東', '京', '大', '阪', '漢', '字', '書', '画',
];

/// Emoji 样本（包含单码点和多码点组合）
const _emojiSamples = [
  '😀', '🎉', '❤️', '🌸', '🐱', '🌙', '⭐', '🎵',
  '👨‍👩‍👧‍👦', '🏳️‍🌈', '👩‍💻', '🧑‍🎨',
];

/// 空白字符串样本（应被视为空）
const _blankSamples = [
  '', ' ', '  ', '\t', '\n', ' \t\n ', '   ',
];

void main() {
  // Tag: Feature: flutter-visual-polish, Property 6: Default avatar text derivation
  group('Property 6: Default avatar text derivation', tags: [
    'flutter-visual-polish',
    'avatar-text-derivation',
  ], () {
    // ─────────────────────────────────────────────
    // 属性测试：非空名称返回第一个字素簇
    // 对任意非空字符串，deriveAvatarText 应返回非 null 值
    // ─────────────────────────────────────────────

    Glados(any.nonEmptyLetterOrDigits, ExploreConfig(numRuns: 100)).test(
      '非空 ASCII 名称始终返回非 null 的头像文本',
      (name) {
        final result = AvatarUtils.deriveAvatarText(name);

        // 非空名称应返回非 null
        expect(result, isNotNull,
            reason: '非空名称 "$name" 应返回头像文本，不应为 null');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：返回值为名称的第一个字素簇
    // ─────────────────────────────────────────────

    Glados(any.nonEmptyLetterOrDigits, ExploreConfig(numRuns: 100)).test(
      '返回值是名称去除首尾空白后的第一个字符',
      (name) {
        final result = AvatarUtils.deriveAvatarText(name);
        final trimmed = name.trim();

        if (trimmed.isNotEmpty) {
          // 返回值应等于第一个字素簇
          final expectedFirst = trimmed.characters.first;
          expect(result, equals(expectedFirst),
              reason:
                  '名称 "$name" 的头像文本应为 "$expectedFirst"，实际为 "$result"');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：返回值长度为单个字素簇
    // ─────────────────────────────────────────────

    Glados(any.nonEmptyLetterOrDigits, ExploreConfig(numRuns: 100)).test(
      '返回值长度为单个字素簇（1 个 Characters 长度）',
      (name) {
        final result = AvatarUtils.deriveAvatarText(name);

        if (result != null) {
          // 返回值应为恰好一个字素簇
          expect(result.characters.length, equals(1),
              reason:
                  '头像文本应为单个字素簇，实际为 "$result" (${result.characters.length} 个字素簇)');
        }
      },
    );

    // ─────────────────────────────────────────────
    // CJK 字符测试：中日韩字符正确提取首字符
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _cjkSamples.length - 1),
        ExploreConfig(numRuns: 50)).test(
      'CJK 字符名称正确提取首字符',
      (index) {
        final cjkChar = _cjkSamples[index];
        // 构造以 CJK 字符开头的名称
        final name = '$cjkChar测试角色';
        final result = AvatarUtils.deriveAvatarText(name);

        expect(result, equals(cjkChar),
            reason: 'CJK 名称 "$name" 的头像文本应为 "$cjkChar"');
      },
    );

    // ─────────────────────────────────────────────
    // Emoji 测试：emoji 字符正确提取（含多码点组合）
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _emojiSamples.length - 1),
        ExploreConfig(numRuns: 50)).test(
      'Emoji 名称正确提取首个 emoji 字素簇',
      (index) {
        final emoji = _emojiSamples[index];
        // 构造以 emoji 开头的名称
        final name = '${emoji}TestName';
        final result = AvatarUtils.deriveAvatarText(name);

        expect(result, equals(emoji),
            reason: 'Emoji 名称 "$name" 的头像文本应为 "$emoji"');
      },
    );

    // ─────────────────────────────────────────────
    // 空字符串测试：空名称返回 null（显示人物图标）
    // ─────────────────────────────────────────────

    Glados(any.intInRange(0, _blankSamples.length - 1),
        ExploreConfig(numRuns: 20)).test(
      '空白名称返回 null（应显示人物图标）',
      (index) {
        final blankName = _blankSamples[index];
        final result = AvatarUtils.deriveAvatarText(blankName);

        expect(result, isNull,
            reason:
                '空白名称 "${blankName.replaceAll('\n', '\\n').replaceAll('\t', '\\t')}" 应返回 null');
      },
    );

    // ─────────────────────────────────────────────
    // 属性测试：前导空白不影响结果
    // ─────────────────────────────────────────────

    Glados(any.nonEmptyLetterOrDigits, ExploreConfig(numRuns: 50)).test(
      '前导空白被忽略，结果与 trim 后一致',
      (name) {
        // 添加前导空白
        final paddedName = '   $name   ';
        final resultPadded = AvatarUtils.deriveAvatarText(paddedName);
        final resultDirect = AvatarUtils.deriveAvatarText(name);

        expect(resultPadded, equals(resultDirect),
            reason: '前导/尾随空白不应影响头像文本推导结果');
      },
    );

    // ─────────────────────────────────────────────
    // 边界值测试
    // ─────────────────────────────────────────────

    test('边界值：单字符名称返回该字符', () {
      expect(AvatarUtils.deriveAvatarText('A'), equals('A'));
      expect(AvatarUtils.deriveAvatarText('猫'), equals('猫'));
      expect(AvatarUtils.deriveAvatarText('🐱'), equals('🐱'));
    });

    test('边界值：空字符串返回 null', () {
      expect(AvatarUtils.deriveAvatarText(''), isNull);
    });

    test('边界值：纯空白字符串返回 null', () {
      expect(AvatarUtils.deriveAvatarText('   '), isNull);
      expect(AvatarUtils.deriveAvatarText('\t\n'), isNull);
    });

    test('边界值：多码点 emoji 作为首字符正确提取', () {
      // 家庭 emoji（由多个码点组成的单个字素簇）
      expect(
          AvatarUtils.deriveAvatarText('👨‍👩‍👧‍👦家庭'), equals('👨‍👩‍👧‍👦'));
      // 女程序员 emoji
      expect(AvatarUtils.deriveAvatarText('👩‍💻程序员'), equals('👩‍💻'));
    });

    test('边界值：CJK 字符作为首字符', () {
      expect(AvatarUtils.deriveAvatarText('你好世界'), equals('你'));
      expect(AvatarUtils.deriveAvatarText('東京タワー'), equals('東'));
    });
  });
}
