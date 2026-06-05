// Feature: flutter-parity-completion, Property 21: POSITIVE/NEGATIVE 解析 round-trip
//
// **Validates: Requirements 12.4, 12.5**
//
// 通过 `package:glados` 生成不含 `POSITIVE:` / `NEGATIVE:` 字面量的 `(pos, neg)`，
// 调用 `ImagePromptService.parsePromptResponseForTesting`（`@visibleForTesting`
// 暴露的 `_parsePromptResponse` 别名）后断言：
// - 拼成 `'POSITIVE: ${pos}\nNEGATIVE: ${neg}'` → `(pos.trim(), neg.trim())`
// - 输入文本不含 `POSITIVE:` / `NEGATIVE:` 标记 → `(input.trim(), '')`
//
// 对应设计文档 R12.4 / R12.5：LLM 同时输出双段时分别提取，否则整段作为
// `positive`，`negative` 置空。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/image_prompt_service.dart';

/// 用于生成「不含 POSITIVE: / NEGATIVE: 字面量」的字符串的字符候选集。
///
/// 故意不引入字面量 `POSITIVE`、`NEGATIVE`、`POS`、`NEG`，避免随机生成产生
/// 与正则冲突的子串；同时覆盖中英文、数字、空白、标点，确保 trim 行为
/// 在多种空白前缀 / 后缀下都能被覆盖。
const _palette = <String>[
  'a', 'B', 'c', 'X', 'z',
  '1', '7',
  '猫', '光', '夜', '茶', '镜',
  ' ', '\t', '\n',
  ',', '.', '!', '：',
];

/// 由整数种子拼装一段不含 `POSITIVE:` / `NEGATIVE:` 字面量的字符串。
///
/// 使用线性同余推进伪随机序列，保证同种子始终产出同样字符串，
/// 便于 glados 失败重放可复现。
String _safeStringFromSeed(int seed) {
  final length = seed.abs() % 24; // [0, 23]
  if (length == 0) return '';
  final buf = StringBuffer();
  var s = seed.abs();
  for (var i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf.write(_palette[s % _palette.length]);
  }
  final out = buf.toString();
  // 兜底再扫一遍：若意外组合出关键字面量，替换为安全占位（极不可能但保险）。
  if (out.contains('POSITIVE:') || out.contains('NEGATIVE:')) {
    return out
        .replaceAll('POSITIVE:', 'pos-')
        .replaceAll('NEGATIVE:', 'neg-');
  }
  return out;
}

/// 由整数种子拼装一段「不含 `POSITIVE:` / `NEGATIVE:` 标记」的纯文本，
/// 用于覆盖 R12.5「无标记 → 整段作为 positive，negative 为空」分支。
///
/// 这里允许任意非关键字面量字符，包括前后空白，确保 `trim` 也被覆盖。
String _markerFreeFromSeed(int seed) => _safeStringFromSeed(seed ^ 0x5A5A);

void main() {
  group('Property 21: POSITIVE/NEGATIVE 解析 round-trip', () {
    Glados2<int, int>(
      any.intInRange(0, 1 << 20), // pos 内容种子
      any.intInRange(0, 1 << 20), // neg 内容种子
    ).test(
      '双段标记输入：parsePromptResponseForTesting 返回 (pos.trim(), neg.trim())',
      (posSeed, negSeed) {
        final pos = _safeStringFromSeed(posSeed);
        final neg = _safeStringFromSeed(negSeed);

        // 前置不变量：生成的两段字符串都不含关键字面量，避免污染解析。
        expect(pos.contains('POSITIVE:'), isFalse);
        expect(pos.contains('NEGATIVE:'), isFalse);
        expect(neg.contains('POSITIVE:'), isFalse);
        expect(neg.contains('NEGATIVE:'), isFalse);

        final input = 'POSITIVE: $pos\nNEGATIVE: $neg';
        final result =
            ImagePromptService.parsePromptResponseForTesting(input);

        expect(result.positive, pos.trim(),
            reason: 'positive 段必须等于 pos.trim()');
        expect(result.negative, neg.trim(),
            reason: 'negative 段必须等于 neg.trim()');
      },
    );

    Glados<int>(
      any.intInRange(0, 1 << 20), // 无标记输入种子
    ).test(
      '无标记输入：返回 (input.trim(), \'\')',
      (seed) {
        final input = _markerFreeFromSeed(seed);

        // 前置不变量：保证不含双段标记，命中「无标记」分支。
        expect(input.contains('POSITIVE:'), isFalse);
        expect(input.contains('NEGATIVE:'), isFalse);

        final result =
            ImagePromptService.parsePromptResponseForTesting(input);
        expect(result.positive, input.trim(),
            reason: 'positive 应等于整段输入的 trim 结果');
        expect(result.negative, '',
            reason: '无标记时 negative 应为空字符串');
      },
    );

    Glados<int>(
      any.intInRange(0, 1 << 20),
    ).test(
      '仅含 POSITIVE: 标记（缺 NEGATIVE:）：应正确提取并剥离 POSITIVE: 前缀',
      (seed) {
        // 与主项目行为对齐：即便缺少 NEGATIVE: 标记，也应成功剥离 POSITIVE: 前缀
        final tail = _safeStringFromSeed(seed);
        final input = 'POSITIVE: $tail';
        final result =
            ImagePromptService.parsePromptResponseForTesting(input);
        expect(result.positive, tail.trim());
        expect(result.negative, '');
      },
    );

    // ───────── 边界例测：与属性测试形成双层保护 ─────────

    test('双段输入末尾 / 中间含多余空白：trim 后两段均无前后空白', () {
      const input = 'POSITIVE:    girl,  cat ears   \nNEGATIVE:   blurry, watermark   ';
      final result =
          ImagePromptService.parsePromptResponseForTesting(input);
      expect(result.positive, 'girl,  cat ears');
      expect(result.negative, 'blurry, watermark');
    });

    test('双段输入 negative 段含换行：贪婪吃到末尾，trim 内部换行保留', () {
      const input = 'POSITIVE: girl\nNEGATIVE: bad\nworse\nworst';
      final result =
          ImagePromptService.parsePromptResponseForTesting(input);
      expect(result.positive, 'girl');
      // negative 段贪婪吃到末尾，内部换行保留；trim 仅去首尾空白
      expect(result.negative, 'bad\nworse\nworst');
    });

    test('空字符串：positive 与 negative 均为空', () {
      final result =
          ImagePromptService.parsePromptResponseForTesting('');
      expect(result.positive, '');
      expect(result.negative, '');
    });

    test('仅 NEGATIVE 标记（缺 POSITIVE:）：应正确提取并剥离 NEGATIVE:，positive 为空', () {
      const input = 'NEGATIVE: blurry';
      final result =
          ImagePromptService.parsePromptResponseForTesting(input);
      expect(result.positive, '');
      expect(result.negative, 'blurry');
    });

    test('双段输入 positive 段为空白：trim 后 positive 为空字符串', () {
      const input = 'POSITIVE:    \nNEGATIVE: blurry';
      final result =
          ImagePromptService.parsePromptResponseForTesting(input);
      expect(result.positive, '');
      expect(result.negative, 'blurry');
    });
  });

  // 防御性 sanity check：确认生成器辅助函数自身不会偶发输出关键字面量。
  group('内部生成器自检', () {
    test('_safeStringFromSeed 多种子均不含 POSITIVE: / NEGATIVE:', () {
      final rng = math.Random(20260516);
      for (var i = 0; i < 200; i++) {
        final s = _safeStringFromSeed(rng.nextInt(1 << 20));
        expect(s.contains('POSITIVE:'), isFalse);
        expect(s.contains('NEGATIVE:'), isFalse);
      }
    });
  });
}
