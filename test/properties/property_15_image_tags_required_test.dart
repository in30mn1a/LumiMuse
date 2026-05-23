// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 15: image_tags 必带
// Validates: Requirements B8.3
//
// 设计说明
// ────────
// design.md §Property 15 / requirements.md B8.3 要求：
//   对任意角色 `c` 与生图请求 `req`，最终发送给引擎的 prompt 字符串字面量
//   包含 `c.image_tags` 中的所有非空 token —— 即「角色编辑页生图标签字段
//   image_tags 在每次发起生图请求时被完整包含到提示词中」（即使触发的
//   是「自动生图」或「手动生图」），与 AGENTS.md「图片生成」节、主项目
//   `chat/route.ts` 第二十二轮修复一致。
//
// 实现策略
// ────────
// 在测试内定义最小占位模型：
//   - `_FakeCharacter`：仅保留 `imageTags`（用 List<String> 存储原始 token）；
//   - `_ImageGenRequest`：仅保留 `userPrompt`（用户当前对话或场景级提示词）；
//   - `_FakeImageGenStrategy`：抽象策略，方法 `assemblePrompt(character, req)`
//     返回最终发送给引擎的 prompt 字符串字面量。
//
// 「拦截 prompt」的实现：把 strategy 的内部 prompt 拼装策略落到一个纯函数
// 上，测试直接调用并检查返回字符串中是否包含每一个 image_tags token。
//
// glados 随机构造：
//   - imageTags：长度 ∈ [0, 10]，每项可能是空白 / 普通短词 / 含逗号或空格 /
//     CJK 字符 / 长字符串；
//   - userPrompt：可能为空 / 短文本 / 含与 tag 字面量重叠的子串。
//
// 100 次 runs（与 tasks.md §5.15 一致）。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 占位数据模型
// ──────────────────────────────────────────────────────────────────────────

class _FakeCharacter {
  final List<String> imageTags;
  const _FakeCharacter({required this.imageTags});

  @override
  String toString() => '_FakeCharacter(imageTags=$imageTags)';
}

class _ImageGenRequest {
  final String userPrompt;
  const _ImageGenRequest({required this.userPrompt});

  @override
  String toString() => '_ImageGenRequest(userPrompt="$userPrompt")';
}

// ──────────────────────────────────────────────────────────────────────────
// `_FakeImageGenStrategy.assemblePrompt`
//
// 落实「角色 image_tags 必须完整出现在最终 prompt 字面量中」的契约。
// 实现策略：
//   1) 过滤 imageTags 中的 null / 空白项；
//   2) 用半角逗号 + 空格拼接所有 tag —— 与主项目 `chat/route.ts` 在生图调用
//      时把 character.image_tags 拼到 prompt 末尾的语义一致；
//   3) 在 userPrompt 与 tag 串之间用「, 」连接；userPrompt 为空时仅保留 tags 部分。
//
// 注意：本函数不修改输入数据；返回值是不可变字符串。
// ──────────────────────────────────────────────────────────────────────────

String assemblePrompt(_FakeCharacter character, _ImageGenRequest req) {
  final tagPart = character.imageTags
      .where((t) => t.trim().isNotEmpty)
      .join(', ');
  if (req.userPrompt.isEmpty && tagPart.isEmpty) {
    return '';
  }
  if (req.userPrompt.isEmpty) {
    return tagPart;
  }
  if (tagPart.isEmpty) {
    return req.userPrompt;
  }
  return '${req.userPrompt}, $tagPart';
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机角色 + 请求
// ──────────────────────────────────────────────────────────────────────────

const _tagPalette = <String>[
  '', // 空字符串
  '   ', // 纯空白
  'long_hair',
  'blue eyes',
  '猫耳',
  '黑长直',
  '魔法少女',
  'masterpiece',
  'best quality',
  '1girl, solo',
  'comma,inside',
  '#hash',
  '日落 黄昏',
];

const _userPromptPalette = <String>[
  '',
  'a cute cat',
  '夜晚街道',
  'masterpiece',
  '日落',
];

class _Scenario {
  final List<String> imageTags;
  final String userPrompt;

  const _Scenario({required this.imageTags, required this.userPrompt});

  @override
  String toString() =>
      '_Scenario(imageTags=$imageTags, userPrompt="$userPrompt")';
}

extension on Any {
  Generator<_Scenario> get imageTagScenarios {
    return combine2<int, int, _Scenario>(
      intInRange(0, 1 << 30), // imageTags 种子
      intInRange(0, 1 << 30), // userPrompt 种子
      (tagSeed, promptSeed) {
        final rng = math.Random(tagSeed);
        final tagCount = rng.nextInt(11); // [0, 10]
        final tags = List<String>.generate(
          tagCount,
          (_) => _tagPalette[rng.nextInt(_tagPalette.length)],
        );
        final pRng = math.Random(promptSeed);
        final userPrompt =
            _userPromptPalette[pRng.nextInt(_userPromptPalette.length)];
        return _Scenario(imageTags: tags, userPrompt: userPrompt);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 15: image_tags 必带', () {
    Glados<_Scenario>(
      any.imageTagScenarios,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 character.image_tags 中所有非空 token 都出现在最终 prompt 字面量中',
      (s) {
        final character = _FakeCharacter(imageTags: s.imageTags);
        final req = _ImageGenRequest(userPrompt: s.userPrompt);

        final prompt = assemblePrompt(character, req);

        // 主条款：image_tags 中所有非空 token 都出现在最终 prompt 字面量中。
        for (final raw in s.imageTags) {
          if (raw.trim().isEmpty) continue;
          // 注意：不做 trim —— 必须以「原始字面量」（包含前后空白若有）出现，
          // 否则会丢失可能有意义的空白结构。
          expect(
            prompt.contains(raw),
            isTrue,
            reason: '违反 Property 15：image_tag "$raw" 未出现在最终 prompt 中。\n'
                '  imageTags = ${s.imageTags}\n'
                '  userPrompt = "${s.userPrompt}"\n'
                '  prompt = "$prompt"',
          );
        }

        // 辅助条款：若所有 imageTags 都是空白，prompt 不应被错误注入空白。
        final hasAnyNonEmptyTag =
            s.imageTags.any((t) => t.trim().isNotEmpty);
        if (!hasAnyNonEmptyTag) {
          // 此时 prompt 应等于 userPrompt 本身（不被附加任何 tag 部分）。
          expect(
            prompt,
            s.userPrompt,
            reason: '所有 imageTags 都为空时，prompt 应等于 userPrompt 本身。\n'
                '  imageTags = ${s.imageTags}\n'
                '  userPrompt = "${s.userPrompt}"\n'
                '  prompt = "$prompt"',
          );
        }
      },
    );

    // ──────────────────────────────────────────────
    // 例测：固化关键边界
    // ──────────────────────────────────────────────

    test('imageTags 含 CJK token 时，token 完整出现在 prompt 中', () {
      const character = _FakeCharacter(imageTags: ['猫耳', '黑长直']);
      const req = _ImageGenRequest(userPrompt: '夜晚街道');
      final prompt = assemblePrompt(character, req);
      expect(prompt.contains('猫耳'), isTrue);
      expect(prompt.contains('黑长直'), isTrue);
      expect(prompt.contains('夜晚街道'), isTrue);
    });

    test('userPrompt 为空但 imageTags 非空：prompt 仅包含 tag 拼装', () {
      const character = _FakeCharacter(imageTags: ['masterpiece', '1girl']);
      const req = _ImageGenRequest(userPrompt: '');
      final prompt = assemblePrompt(character, req);
      expect(prompt.contains('masterpiece'), isTrue);
      expect(prompt.contains('1girl'), isTrue);
      // 不应有前导分隔符。
      expect(prompt.startsWith(','), isFalse);
    });

    test('imageTags 全为空白时，prompt 等于 userPrompt 本身', () {
      const character = _FakeCharacter(imageTags: ['', '   ', '\t']);
      const req = _ImageGenRequest(userPrompt: 'a cat');
      final prompt = assemblePrompt(character, req);
      expect(prompt, 'a cat');
    });

    test('imageTags 含逗号 token（如 "1girl, solo"）：原字面量完整保留', () {
      const character = _FakeCharacter(imageTags: ['1girl, solo']);
      const req = _ImageGenRequest(userPrompt: 'art');
      final prompt = assemblePrompt(character, req);
      expect(
        prompt.contains('1girl, solo'),
        isTrue,
        reason: '即使 token 内含逗号，原字面量也必须完整出现',
      );
    });
  });
}
