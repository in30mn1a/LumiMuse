// Feature: flutter-parity-completion, Property 26: 示例对话冒号兼容解析
//
// **Validates: Requirements 16.1, 16.2, 16.3, 16.4**
//
// 通过 `package:glados` 生成 `(role ∈ {'user','char'}, colon ∈ {'：',':'}, content)`，
// 断言：
//   - 单行输入 `'{{${role}}}${colon} ${content}'` 经
//     [parseExampleDialogueForTesting] 解析后长度恒为 1，
//     第 0 条 role 为 `role == 'user' ? 'user' : 'assistant'`，content 等于原 `content`。
//   - 多行混合中英冒号输入解析后每行的归类与对应行使用的 colon 无关。
//
// 与 21.1 单元测试（`example_dialogue_parse_test.dart`）形成双层保护：
//   - 单元测试覆盖手写的关键样本与边界场景；
//   - 本属性测试覆盖随机组合空间，防止后续若把 `[：:]` 字符类误改为单一冒号
//     的回归。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/services/chat_engine.dart';

/// 「角色 / 冒号」选择枚举 —— 用 [int] 索引承载，方便 glados 生成与 shrink。
const _roleNames = <String>['user', 'char'];
const _colonChoices = <String>['：', ':'];

/// content 候选字符集（非首字符）：
/// - 覆盖中文、英文、数字、空白与常见标点；
/// - 故意不含换行符 `\n`，因为 [parseExampleDialogueForTesting] 是按行扫描的，
///   换行会改变语义，需要在多行场景里另行控制；
/// - 故意不含 `{` 与 `}`，避免随机生成出 `{{user}}` / `{{char}}` 字面量
///   导致 content 自身被识别为新角色行，干扰断言。
const _contentPalette = <String>[
  '你', '好', '呀', '世', '界',
  'a', 'b', 'X', 'Y',
  '1', '7',
  ' ', '\t',
  ',', '。', '!', '?', '：',
];

/// content 首字符候选集：
/// - 在 [_contentPalette] 基础上去掉所有 ASCII 空白；
/// - 这是 round-trip 性质的必要约束：[parseExampleDialogueForTesting] 的正则
///   尾部 `\s*(.+)` 会贪婪剥离冒号与首字符之间的 ASCII 空白（与 Node.js 端
///   `parseExampleDialogue` 等价行为，见 21.1 单元测试中
///   「保留原始内空格但 trim 前导空格」例测）。若 content 首字符是 ASCII 空白，
///   解析得到的 content 会缺少该字符，违反 round-trip 前提。
///   为让属性测试聚焦在「冒号兼容」语义上，把这一已知边界以「智能生成器」
///   的方式从输入空间剔除。
const _contentLeadPalette = <String>[
  '你', '好', '呀', '世', '界',
  'a', 'b', 'X', 'Y',
  '1', '7',
  ',', '。', '!', '?', '：',
];

/// 由整数种子拼装一段满足以下约束的非空字符串：
/// - 长度 ∈ [1, 12]；
/// - 不含换行 `\n` 与花括号 `{` / `}`；
/// - 首字符不是 ASCII 空白（避免被正则 `\s*` 吃掉）。
///
/// 使用线性同余推进伪随机序列，保证同种子始终产出同样字符串，
/// 便于 glados 失败重放可复现。生成长度 ≥ 1，避开「空 content」情形：
/// `parseExampleDialogueForTesting` 的正则尾部是 `(.+)`，content 必须至少
/// 包含一个字符才会成功匹配。
String _contentFromSeed(int seed) {
  final length = 1 + (seed.abs() % 12); // [1, 12]
  var s = seed.abs();
  final buf = StringBuffer();
  for (var i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    final palette = i == 0 ? _contentLeadPalette : _contentPalette;
    buf.write(palette[s % palette.length]);
  }
  return buf.toString();
}

/// 把单行 role 索引映射为 [parseExampleDialogueForTesting] 输出 role：
/// `{{user}}` → `user`，`{{char}}` → `assistant`。
String _expectedRoleFor(int roleIndex) =>
    _roleNames[roleIndex] == 'user' ? 'user' : 'assistant';

/// 判断给定 UTF-16 code unit 是否为 ASCII 空白（与 Dart `RegExp` 默认 `\s`
/// 字符类对齐的子集：空格 / 制表 / 换行 / 回车）。
bool _isAsciiWhitespace(int codeUnit) =>
    codeUnit == 0x20 || codeUnit == 0x09 ||
    codeUnit == 0x0A || codeUnit == 0x0D;

void main() {
  group('Property 26: 示例对话冒号兼容解析', () {
    // ─────────────────────────────────────────────
    // 性质一：单行输入 — 解析结果长度恒为 1，role 与 content 正确。
    // 覆盖 Requirements 16.1 / 16.2 / 16.3。
    // ─────────────────────────────────────────────
    Glados3<int, int, int>(
      any.intInRange(0, _roleNames.length), // role 索引：0=user, 1=char
      any.intInRange(0, _colonChoices.length), // 冒号索引：0=「：」, 1=「:」
      any.intInRange(0, 1 << 20), // content 种子
    ).test(
      '单行 {{role}}{colon} content → 长度 1，role/content 正确',
      (roleIndex, colonIndex, contentSeed) {
        final role = _roleNames[roleIndex];
        final colon = _colonChoices[colonIndex];
        final content = _contentFromSeed(contentSeed);

        // 前置不变量：content 不应包含换行 / 花括号，否则会破坏「单行」前提。
        expect(content.contains('\n'), isFalse);
        expect(content.contains('{'), isFalse);
        expect(content.contains('}'), isFalse);
        // 前置不变量：content 首字符不能是 ASCII 空白，否则会被解析正则
        // `\s*` 吃掉，违反 round-trip 前提（与 21.1 单元测试中
        // 「保留原始内空格但 trim 前导空格」例测对齐）。
        expect(_isAsciiWhitespace(content.codeUnitAt(0)), isFalse,
            reason: 'content 首字符必须非 ASCII 空白，实际 content=$content');

        final input = '{{$role}}$colon $content';
        final result = parseExampleDialogueForTesting(input);

        expect(result, hasLength(1),
            reason: '单行合法输入解析结果长度必须为 1，input=$input');
        expect(result[0].role, _expectedRoleFor(roleIndex),
            reason: '{{user}} → user，{{char}} → assistant，input=$input');
        expect(result[0].content, content,
            reason: 'content 必须等于冒号后保留的原文，input=$input');
      },
    );

    // ─────────────────────────────────────────────
    // 性质二：多行混合中英冒号 — 每行归类与对应 colon 无关。
    // 覆盖 Requirement 16.4（混用兼容性）。
    //
    // 通过同时生成两份 colon 选择（`colonAIndex` / `colonBIndex`），
    // 让两个版本的 input 仅冒号不同；断言两份解析结果完全一致，
    // 即可证明「归类与对应行的 colon 无关」。
    // ─────────────────────────────────────────────
    Glados3<int, int, int>(
      any.intInRange(0, 17), // 行数 ∈ [0, 16]
      any.intInRange(0, 1 << 20), // 行布局种子（决定每行 role 与 content）
      any.intInRange(0, 1 << 20), // 冒号布局种子（决定每行使用中文 / 英文冒号）
    ).test(
      '多行混合冒号：归类与每行 colon 选择无关',
      (lineCount, layoutSeed, colonSeed) {
        if (lineCount == 0) {
          // 空输入特殊处理：与 21.1 单元测试已覆盖的空字符串语义一致。
          expect(parseExampleDialogueForTesting(''), isEmpty);
          return;
        }

        final layoutRng = math.Random(layoutSeed);
        final colonRngA = math.Random(colonSeed);
        // 异或扰动种子保证两份 colon 选择独立分布，避免恰好两次都全选同一冒号
        // 时退化为「同质」对照。
        final colonRngB = math.Random(colonSeed ^ 0x5A5A5A5A);

        final lines = List<({int roleIndex, String content})>.generate(
          lineCount,
          (_) => (
            roleIndex: layoutRng.nextInt(_roleNames.length),
            content: _contentFromSeed(layoutRng.nextInt(1 << 20)),
          ),
        );

        String render(math.Random colonRng) {
          final buf = StringBuffer();
          for (var i = 0; i < lines.length; i++) {
            final line = lines[i];
            final role = _roleNames[line.roleIndex];
            final colon = _colonChoices[colonRng.nextInt(_colonChoices.length)];
            buf.write('{{$role}}$colon ${line.content}');
            if (i < lines.length - 1) buf.write('\n');
          }
          return buf.toString();
        }

        final inputA = render(colonRngA);
        final inputB = render(colonRngB);

        final resultA = parseExampleDialogueForTesting(inputA);
        final resultB = parseExampleDialogueForTesting(inputB);

        // 长度等于行数（每行都是合法 `{{role}}{colon} content`）。
        expect(resultA, hasLength(lineCount),
            reason: 'inputA 行数应等于解析结果长度，inputA=$inputA');
        expect(resultB, hasLength(lineCount),
            reason: 'inputB 行数应等于解析结果长度，inputB=$inputB');

        // 逐行比较 role 与 content：两份输入仅冒号不同，结果必须完全一致。
        for (var i = 0; i < lineCount; i++) {
          expect(resultA[i].role, _expectedRoleFor(lines[i].roleIndex),
              reason: '行 $i role 必须由 {{role}} 决定，与 colon 无关');
          expect(resultB[i].role, resultA[i].role,
              reason: '行 $i 在 inputA / inputB 下 role 应一致');
          expect(resultA[i].content, lines[i].content,
              reason: '行 $i content 必须等于原文，inputA');
          expect(resultB[i].content, resultA[i].content,
              reason: '行 $i content 在 inputA / inputB 下应一致');
        }
      },
    );

    // ─────────────────────────────────────────────
    // 例测：固定混合冒号样本，作为属性测试外的快速回归保护。
    // ─────────────────────────────────────────────
    test('混合冒号示例：四行依次 user/char/user/char 解析无误', () {
      const raw = '{{user}}：早安\n'
          '{{char}}: 你也是\n'
          '{{user}}: 今天天气真好\n'
          '{{char}}：嗯，温柔的一天';
      final result = parseExampleDialogueForTesting(raw);
      expect(result, hasLength(4));
      expect(result.map((m) => m.role).toList(),
          ['user', 'assistant', 'user', 'assistant']);
      expect(result.map((m) => m.content).toList(),
          ['早安', '你也是', '今天天气真好', '嗯，温柔的一天']);
    });
  });

  // 防御性 sanity check：确认本文件内的 content 生成器自身满足约束。
  group('内部生成器自检', () {
    test('_contentFromSeed 多种子均满足非空 / 无换行 / 无花括号 / 首字符非 ASCII 空白', () {
      final rng = math.Random(20260516);
      for (var i = 0; i < 200; i++) {
        final s = _contentFromSeed(rng.nextInt(1 << 20));
        expect(s.isNotEmpty, isTrue);
        expect(s.contains('\n'), isFalse);
        expect(s.contains('{'), isFalse);
        expect(s.contains('}'), isFalse);
        // 首字符不能是 ASCII 空白，否则会被解析正则 `\s*` 吃掉。
        final firstCode = s.codeUnitAt(0);
        expect(firstCode != 0x20 /* space */
                && firstCode != 0x09 /* tab */
                && firstCode != 0x0A /* LF */
                && firstCode != 0x0D /* CR */,
            isTrue,
            reason: '首字符不能是 ASCII 空白，实际首字符 codeUnit=$firstCode');
      }
    });
  });
}
