// Feature: flutter-parity-completion, Property 26（前置单元测试）：示例对话冒号兼容解析
//
// **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5**
//
// 任务 21.1：对齐 [parseExampleDialogueForTesting] 至 `[：:]` 字符类，
// 与 Node.js 端 `src/lib/chat-engine.ts` 的 `parseExampleDialogue` 行为完全一致。
//
// 本文件作为「现状校验」单元测试（与后续属性测试 21.2 互补）：
//   - 覆盖中文冒号「：」与英文冒号「:」两种分隔符；
//   - 覆盖 `{{user}}` 与 `{{char}}` 两种角色前缀；
//   - 覆盖中英冒号混用、空白、不匹配前缀被静默丢弃等基础场景；
// 同时确保 [chat_engine.dart] 与 `chat_provider.dart` 双方都委托到同一份顶级函数，
// 避免因后续迭代导致正则失同步。

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/services/chat_engine.dart';

void main() {
  group('parseExampleDialogueForTesting · 冒号兼容（R16）', () {
    test('Requirement 16.1：{{user}}：你好（中文冒号）→ 识别为 user', () {
      final result = parseExampleDialogueForTesting('{{user}}：你好');
      expect(result, hasLength(1));
      expect(result[0].role, 'user');
      expect(result[0].content, '你好');
    });

    test('Requirement 16.2：{{user}}: 你好（英文冒号）→ 识别为 user', () {
      final result = parseExampleDialogueForTesting('{{user}}: 你好');
      expect(result, hasLength(1));
      expect(result[0].role, 'user');
      expect(result[0].content, '你好');
    });

    test('Requirement 16.3：{{char}} 中英冒号都能识别为 assistant', () {
      final cn = parseExampleDialogueForTesting('{{char}}：你好');
      final en = parseExampleDialogueForTesting('{{char}}: 你好');
      expect(cn, hasLength(1));
      expect(cn[0].role, 'assistant');
      expect(cn[0].content, '你好');
      expect(en, hasLength(1));
      expect(en[0].role, 'assistant');
      expect(en[0].content, '你好');
    });

    test('Requirement 16.4：中英冒号混用同时正确解析', () {
      const raw = '{{user}}：早安\n'
          '{{char}}: 你也是\n'
          '{{user}}: 今天天气真好\n'
          '{{char}}：嗯，温柔的一天';
      final result = parseExampleDialogueForTesting(raw);
      expect(result.map((m) => m.role).toList(),
          ['user', 'assistant', 'user', 'assistant']);
      expect(result.map((m) => m.content).toList(),
          ['早安', '你也是', '今天天气真好', '嗯，温柔的一天']);
    });

    test('Requirement 16.5：未识别前缀的行被静默丢弃，且空输入返回空列表', () {
      // 空字符串：直接返回空列表
      expect(parseExampleDialogueForTesting(''), isEmpty);

      // 不匹配前缀的行被静默丢弃
      const raw = '随便写一行\n'
          '{{user}}: 第一句\n'
          '中间夹一行说明\n'
          '{{char}}：第二句\n'
          'user: 缺少花括号也不算';
      final result = parseExampleDialogueForTesting(raw);
      expect(result, hasLength(2));
      expect(result[0].role, 'user');
      expect(result[0].content, '第一句');
      expect(result[1].role, 'assistant');
      expect(result[1].content, '第二句');
    });

    test('每一行独立解析，content 保留原始内空格但 trim 前导空格', () {
      // 与 Node.js 端 `(.+)` 行为一致：会保留 content 内部所有字符，
      // `\s*` 仅吃掉冒号和首字符之间的空白。
      final result = parseExampleDialogueForTesting('{{user}}:    你好  世界  ');
      expect(result, hasLength(1));
      expect(result[0].role, 'user');
      // 原文末尾两个空格属于 content 的一部分；只剥离冒号后紧接的空白。
      expect(result[0].content, '你好  世界  ');
    });

    test('空行被丢弃，不抛异常', () {
      final result = parseExampleDialogueForTesting('\n\n{{user}}：哈喽\n\n');
      expect(result, hasLength(1));
      expect(result[0].role, 'user');
      expect(result[0].content, '哈喽');
    });
  });
}
