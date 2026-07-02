// Feature: flutter-parity-completion, Wave 5 E2: inline image prompt 工具
//
// **Validates: 主项目 `src/lib/inline-image-prompt.ts` 的三函数行为**
//
// 断言：
// - buildInlinePromptInstruction：含固定文案段；imageTags/userImageTags 非空时
//   追加对应固定外貌标签段；空时省略。
// - extractInlinePrompt：匹配 [IMG]...[/IMG] 提取 group1.trim()；未匹配返回 ''；
//   大小写不敏感；跨行。
// - stripInlinePrompt：剥离闭合块；剥离后仍残留未闭合 [IMG... 尾巴时一并去掉；
//   去尾空白；无块原样返回。

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/utils/inline_image_prompt.dart';

void main() {
  group('E2: buildInlinePromptInstruction', () {
    test('包含核心固定文案段', () {
      final s = buildInlinePromptInstruction();
      expect(s, contains('系统附加要求'));
      expect(s, contains('不算跳出角色'));
      expect(s, contains('[IMG]'));
      expect(s, contains('[/IMG]'));
      expect(s, contains('不少于 35 个标签'));
      expect(s, contains('danbooru'));
    });

    test('imageTags 非空时追加固定外貌标签段', () {
      final s = buildInlinePromptInstruction(imageTags: 'blue hair, red eyes');
      expect(s, contains('必须含固定外貌标签：blue hair, red eyes'));
    });

    test('imageTags 为空/空白时不追加固定外貌标签段', () {
      final s1 = buildInlinePromptInstruction(imageTags: '');
      expect(s1, isNot(contains('必须含固定外貌标签')));

      final s2 = buildInlinePromptInstruction(imageTags: '   ');
      expect(s2, isNot(contains('必须含固定外貌标签')));
    });

    test('userImageTags 非空时追加用户外貌标签段', () {
      final s = buildInlinePromptInstruction(userImageTags: 'black hair, 1boy');
      expect(s, contains('用户外貌标签：black hair, 1boy'));
      expect(s, contains('用户未出场则忽略'));
    });

    test('userImageTags 为空/空白时不追加用户外貌标签段', () {
      final s1 = buildInlinePromptInstruction(userImageTags: '');
      expect(s1, isNot(contains('用户外貌标签')));

      final s2 = buildInlinePromptInstruction(userImageTags: '   ');
      expect(s2, isNot(contains('用户外貌标签')));
    });
  });

  group('E2: extractInlinePrompt', () {
    test('匹配单个闭合块返回 group1.trim()', () {
      const text = '你好\n[IMG]1girl, blue hair, smile[/IMG]';
      expect(extractInlinePrompt(text), '1girl, blue hair, smile');
    });

    test('未匹配返回空串', () {
      const text = '纯正文，没有 IMG 块';
      expect(extractInlinePrompt(text), '');
    });

    test('大小写不敏感', () {
      const text = '正文\n[img]tag1, tag2[/IMG]';
      expect(extractInlinePrompt(text), 'tag1, tag2');

      const text2 = '正文\n[IMG]tagA[/img]';
      expect(extractInlinePrompt(text2), 'tagA');
    });

    test('跨行匹配（标签串含换行）', () {
      const text = '正文\n[IMG]tag1,\ntag2,\ntag3[/IMG]';
      expect(extractInlinePrompt(text), 'tag1,\ntag2,\ntag3');
    });

    test('多个块只取第一个', () {
      const text = '[IMG]first[/IMG] 中间 [IMG]second[/IMG]';
      expect(extractInlinePrompt(text), 'first');
    });

    test('trim 提取内容两侧空白', () {
      const text = '[IMG]   tag1, tag2   [/IMG]';
      expect(extractInlinePrompt(text), 'tag1, tag2');
    });
  });

  group('E2: stripInlinePrompt', () {
    test('剥离闭合块', () {
      const text = '你好\n[IMG]1girl, blue hair[/IMG]\n明天见';
      expect(stripInlinePrompt(text), '你好\n\n明天见');
    });

    test('剥离未闭合尾巴（流式中间态）', () {
      // 只有开头 [IMG，尚未闭合：整段尾巴应被去掉
      const text = '你好\n[IMG tag1, tag2,';
      expect(stripInlinePrompt(text), '你好');
    });

    test('去尾空白', () {
      const text = '正文\n[IMG]tags[/IMG]\n\n\n';
      expect(stripInlinePrompt(text), '正文');
    });

    test('无块原样返回（仅可能去尾空白）', () {
      const text = '纯正文，没有 IMG 块';
      expect(stripInlinePrompt(text), '纯正文，没有 IMG 块');
    });

    test('大小写不敏感剥离', () {
      const text = '正文\n[img]tags[/IMG] 尾巴';
      expect(stripInlinePrompt(text), '正文\n 尾巴');
    });

    test('正文中有 [IMG 字样但未成块时不误删正文', () {
      // [IMG 后无 \b 边界（紧跟字母）不应匹配 open tail；
      // 这里 [IMGx 不以 [IMG 单词边界开头，不应被当未闭合尾巴
      const text = '讨论 [IMGx 标签格式';
      // 不含闭合块也不含 [IMG\b 前缀 → 原样（仅去尾空白）
      expect(stripInlinePrompt(text), '讨论 [IMGx 标签格式');
    });
  });
}
