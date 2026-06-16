// Feature: flutter-parity-completion, Property 8: summary 截断保持后续消息
// Feature: flutter-parity-completion, Property 9: 相邻同 role 合并
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
//
// 直接对 `assemblePrompt` 内部抽出的两个纯函数做属性测试，跳过 LLM 调用 /
// AppDatabase / MemoryEngine 构造，避免引入无关复杂度（参见 tasks.md 6.3 末尾备注）：
//
// - `computeLastSummaryIdx(messages)`：对应 `assemblePrompt` 入口的 summary 截断扫描。
// - `mergeAdjacentSameRole(chatMessages)`：对应 `assemblePrompt` 末尾相邻同 role 合并循环。
//
// 两个纯函数通过 `@visibleForTesting` 暴露，`assemblePrompt` 内部直接调用同一实现，
// 保证「测试覆盖的逻辑」与「线上跑的逻辑」是同一份代码。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, setUp, tearDown, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/chat_engine.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

import '../../_helpers/generators.dart';

void main() {
  group('assemblePrompt 关键分支', () {
    late AppDatabase db;
    late ChatEngine engine;

    setUp(() {
      db = AppDatabase.forTesting(NativeDatabase.memory());
      final llm = LlmService();
      engine = ChatEngine(db, llm, MemoryEngine(db, llm));
    });

    tearDown(() async {
      await db.close();
    });

    test('maxTokens 超过上下文窗口时仍为最近消息保留预算', () {
      final previousDebugPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {};
      addTearDown(() {
        debugPrint = previousDebugPrint;
      });

      final prompt = engine.assemblePrompt(
        character: _makeCharacter(),
        settings: const AppSettings(
          contextWindow: 2000,
          maxTokens: 2000,
          exampleDialogue: false,
          memoryInject: false,
          showTimestamps: false,
        ),
        memories: const [],
        messages: [
          _makeMsg('old', content: '旧消息不应进入 prompt', tokenCount: 1200, seq: 1),
          _makeMsg(
            'recent',
            role: 'assistant',
            content: '最近消息应保留',
            tokenCount: 10,
            seq: 2,
          ),
        ],
      );

      final contents = prompt.map((m) => m.content).join('\n');
      expect(contents, contains('最近消息应保留'));
      expect(contents, isNot(contains('旧消息不应进入 prompt')));
    });

    test('memoryInject 开启时按编号注入记忆，关闭时不写入记忆区块', () {
      final character = _makeCharacter();
      final enabledPrompt = engine.assemblePrompt(
        character: character,
        settings: const AppSettings(
          exampleDialogue: false,
          memoryInject: true,
          showTimestamps: false,
        ),
        memories: const ['喜欢热茶', '怕雷雨'],
        messages: const [],
      );
      final enabledSystem = enabledPrompt.first.content as String;

      expect(enabledSystem, contains('## 你需要记住的事'));
      expect(enabledSystem, contains('1. 喜欢热茶'));
      expect(enabledSystem, contains('2. 怕雷雨'));

      final disabledPrompt = engine.assemblePrompt(
        character: character,
        settings: const AppSettings(
          exampleDialogue: false,
          memoryInject: false,
          showTimestamps: false,
        ),
        memories: const ['喜欢热茶'],
        messages: const [],
      );
      final disabledSystem = disabledPrompt.first.content as String;

      expect(disabledSystem, isNot(contains('## 你需要记住的事')));
      expect(disabledSystem, isNot(contains('喜欢热茶')));
    });

    test('示例对话支持中英文冒号并忽略无法解析的行', () {
      final prompt = engine.assemblePrompt(
        character: _makeCharacter(
          exampleDialogue: '''
{{user}}: hello
not a dialogue line
{{char}}： hi
{{user}}： next
{{char}}: ok
{{user}}
''',
        ),
        settings: const AppSettings(
          exampleDialogue: true,
          memoryInject: false,
          showTimestamps: false,
        ),
        memories: const [],
        messages: const [],
      );

      expect(prompt.length, 5);
      expect(prompt.skip(1).map((m) => m.role), [
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(prompt.skip(1).map((m) => m.content), [
        'hello',
        'hi',
        'next',
        'ok',
      ]);
    });
  });

  group('Property 8: summary 截断保持后续消息（4.1, 4.2, 4.3）', () {
    Glados<List<Message>>(any.messageListWithSummaryFlags).test(
      'lastSummaryIdx 满足设计规则不变量',
      (messages) {
        final idx = computeLastSummaryIdx(messages);

        // 不变量 A：idx == -1 当且仅当列表中没有任何 isSummary == true 的消息。
        // （脏 metadata 视为非 summary，与线上 `_parseMetadata` 容错语义一致。）
        final hasSummary = messages.any((m) => _isSummaryMeta(m.metadata));
        if (idx == -1) {
          expect(
            hasSummary,
            isFalse,
            reason: '不存在 summary 时 lastSummaryIdx 应为 -1',
          );
        } else {
          // 不变量 B：命中时 messages[idx] 必须是 summary。
          expect(
            _isSummaryMeta(messages[idx].metadata),
            isTrue,
            reason: 'lastSummaryIdx 指向的消息必须是 summary',
          );
          // 不变量 C：messages[idx+1..] 中没有任何 summary。
          for (int j = idx + 1; j < messages.length; j++) {
            expect(
              _isSummaryMeta(messages[j].metadata),
              isFalse,
              reason: 'lastSummaryIdx 之后不应再有 summary 消息',
            );
          }
        }
      },
    );

    Glados<List<Message>>(any.messageListWithSummaryFlags).test(
      '截断结果长度等于 messages.length - max(lastSummaryIdx, 0)',
      (messages) {
        final idx = computeLastSummaryIdx(messages);
        final effective = idx >= 0 ? messages.sublist(idx) : messages;

        // 与设计文档「assemblePrompt 喂入的截断结果长度」公式严格一致：
        //   未命中：长度 = messages.length - 0 = messages.length
        //   命中：  长度 = messages.length - idx
        final expectedLen = messages.length - (idx < 0 ? 0 : idx);
        expect(effective.length, expectedLen, reason: '截断结果长度公式不匹配');

        // 同时校验：命中时第 0 项就是 summary 自身（包含 summary）。
        if (idx >= 0) {
          expect(
            _isSummaryMeta(effective.first.metadata),
            isTrue,
            reason: '截断结果应包含 summary 自身',
          );
        }
      },
    );

    // 例测：边界场景显式断言，配合属性测试形成双层保护。
    test('空列表返回 -1 且不抛异常', () {
      expect(computeLastSummaryIdx(const <Message>[]), -1);
    });

    test('唯一一条 summary 时 idx 指向它', () {
      final m = _makeMsg('m1', metadata: '{"isSummary":true}');
      expect(computeLastSummaryIdx([m]), 0);
    });

    test('多条 summary 时 idx 指向最后一条', () {
      final messages = [
        _makeMsg('m0', metadata: '{"isSummary":true}'),
        _makeMsg('m1'),
        _makeMsg('m2', metadata: '{"isSummary":true}'),
        _makeMsg('m3'),
      ];
      expect(computeLastSummaryIdx(messages), 2);
    });

    test('脏 metadata 视为非 summary', () {
      final messages = [
        _makeMsg('m0', metadata: '<<not json>>'),
        _makeMsg('m1'),
      ];
      expect(computeLastSummaryIdx(messages), -1);
    });
  });

  group('Property 9: 相邻同 role 合并（4.4, 4.5）', () {
    Glados<List<ChatMessage>>(
      any.chatMessageListForMerge,
    ).test('合并后不存在相邻同 role 的非 system 消息', (chatMessages) {
      final merged = mergeAdjacentSameRole(chatMessages);
      for (int i = 0; i + 1 < merged.length; i++) {
        final same = merged[i].role == merged[i + 1].role;
        final nonSystem = merged[i].role != 'system';
        expect(same && nonSystem, isFalse, reason: '不应存在相邻同 role 的非 system 消息');
      }
    });

    Glados<List<ChatMessage>>(any.chatMessageListForMerge).test(
      '非合并段元素的 role 与原列表对应段一致，content 等于该段按 \\n\\n 拼接',
      (chatMessages) {
        final merged = mergeAdjacentSameRole(chatMessages);

        // 通过「再按相同规则把原列表自前向后分段」并与 merged 逐段比对，
        // 验证 content 是否等于该段按 `\n\n` 拼接。
        // 分段规则：从前向后扫描，遇到「与上一条 role 相同且都不是 system」就并入当前段，
        //          否则开启新段。
        final segments = <List<ChatMessage>>[];
        for (final msg in chatMessages) {
          if (segments.isNotEmpty) {
            final last = segments.last;
            final lastRole = last.last.role;
            if (lastRole == msg.role && lastRole != 'system') {
              last.add(msg);
              continue;
            }
          }
          segments.add(<ChatMessage>[msg]);
        }

        // 段数必须与 merged 长度一致。
        expect(merged.length, segments.length, reason: '合并段数应等于按规则分段的段数');

        for (int i = 0; i < merged.length; i++) {
          final seg = segments[i];
          // role 与该段第一条一致（合并保留前者 role）。
          expect(
            merged[i].role,
            seg.first.role,
            reason: '第 $i 段合并后 role 应与原段首条一致',
          );
          // content 等于该段内所有 content 按 `\n\n` 拼接。
          final expectedContent = seg
              .map((m) => m.content as String)
              .join('\n\n');
          expect(
            merged[i].content,
            expectedContent,
            reason: '第 $i 段合并后 content 应等于按 \\n\\n 拼接',
          );
        }
      },
    );

    Glados<List<ChatMessage>>(any.chatMessageListForMerge).test(
      '幂等：mergeAdjacentSameRole(mergeAdjacentSameRole(xs)) == mergeAdjacentSameRole(xs)',
      (chatMessages) {
        final once = mergeAdjacentSameRole(chatMessages);
        final twice = mergeAdjacentSameRole(once);
        expect(twice.length, once.length);
        for (int i = 0; i < once.length; i++) {
          expect(twice[i].role, once[i].role);
          expect(twice[i].content, once[i].content);
        }
      },
    );

    // 例测：边界场景与典型分支显式断言。
    test('空列表返回空列表', () {
      expect(mergeAdjacentSameRole(const <ChatMessage>[]), isEmpty);
    });

    test('两条相邻 user 合并为一条，content 用 \\n\\n 连接', () {
      final result = mergeAdjacentSameRole(const [
        ChatMessage(role: 'user', content: 'A'),
        ChatMessage(role: 'user', content: 'B'),
      ]);
      expect(result.length, 1);
      expect(result.first.role, 'user');
      expect(result.first.content, 'A\n\nB');
    });

    test('相邻 system 不合并', () {
      final result = mergeAdjacentSameRole(const [
        ChatMessage(role: 'system', content: 'S1'),
        ChatMessage(role: 'system', content: 'S2'),
      ]);
      expect(result.length, 2);
      expect(result[0].content, 'S1');
      expect(result[1].content, 'S2');
    });

    test('user → assistant → user 不合并', () {
      final result = mergeAdjacentSameRole(const [
        ChatMessage(role: 'user', content: 'A'),
        ChatMessage(role: 'assistant', content: 'B'),
        ChatMessage(role: 'user', content: 'C'),
      ]);
      expect(result.length, 3);
      expect(result.map((m) => m.role).toList(), ['user', 'assistant', 'user']);
      expect(result.map((m) => m.content).toList(), ['A', 'B', 'C']);
    });

    test('三条相邻 assistant 合并为一条', () {
      final result = mergeAdjacentSameRole(const [
        ChatMessage(role: 'assistant', content: 'X'),
        ChatMessage(role: 'assistant', content: 'Y'),
        ChatMessage(role: 'assistant', content: 'Z'),
      ]);
      expect(result.length, 1);
      expect(result.first.content, 'X\n\nY\n\nZ');
    });
  });
}

/// 与 ChatEngine 内部 `_parseMetadata` 容错语义一致的轻量判定：
/// 仅对合法 JSON 中的 `isSummary == true` 返回 true；脏数据或缺失字段返回 false。
bool _isSummaryMeta(String metadata) {
  try {
    final m = jsonDecode(metadata) as Map<String, dynamic>;
    return m['isSummary'] == true;
  } catch (_) {
    return false;
  }
}

/// 构造一条占位 [Message]，仅用于本文件的例测。
Message _makeMsg(
  String id, {
  String role = 'user',
  String? content,
  int tokenCount = 0,
  int seq = 0,
  DateTime? createdAt,
  String metadata = '{}',
}) {
  return Message(
    id: id,
    conversationId: 'conv-1',
    role: role,
    content: content ?? id,
    tokenCount: tokenCount,
    seq: seq,
    createdAt: createdAt ?? DateTime.fromMillisecondsSinceEpoch(0),
    metadata: metadata,
  );
}

/// 构造一张最小角色卡，供 assemblePrompt 例测使用。
Character _makeCharacter({String exampleDialogue = ''}) {
  final now = DateTime.fromMillisecondsSinceEpoch(0);
  return Character(
    id: 'char-1',
    name: '测试角色',
    personality: '',
    scenario: '',
    greeting: '',
    exampleDialogue: exampleDialogue,
    systemPrompt: '你是测试角色。',
    basicInfo: '',
    otherInfo: '',
    imageTags: '',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  );
}
