// Feature: 剩余 P0 同步 Wave 3，C2：时间戳 token 开销 + 当前消息优先
//
// 对 chat_provider.dart 抽出的 @visibleForTesting 纯函数 fillHistoryWithinBudget
// 做单元测试，验证与主项目 src/lib/chat-engine.ts assemblePrompt 历史填充循环对齐：
//   - 时间戳开销：showTimestamps 开启时每条消息额外计入 5 token。
//   - 当前消息优先：系统提示 + 记忆逼近预算时，最新一条有效消息仍进 history。

import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/chat_provider.dart';
import 'package:lumimuse/core/utils/token_counter.dart';

Message _msg(
  String id, {
  String role = 'user',
  required String content,
  int tokenCount = 0,
  int seq = 0,
}) {
  return Message(
    id: id,
    conversationId: 'conv-1',
    role: role,
    content: content,
    tokenCount: tokenCount,
    seq: seq,
    createdAt: DateTime(2026, 5, 15, 14, 30),
    metadata: '{}',
  );
}

void main() {
  group('C2: fillHistoryWithinBudget', () {
    test('当前消息优先：预算已被系统提示占满时最新一条仍进 history', () {
      final messages = [
        _msg('old', content: '较旧的一条消息', tokenCount: 50, seq: 1),
        _msg('latest', role: 'user', content: '最新的用户输入', tokenCount: 50, seq: 2),
      ];

      // availableBudget 远小于 usedTokens：history 为空时不应 break，最新一条必进。
      final history = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: false),
        usedTokens: 1000,
        availableBudget: 10,
      );

      expect(history.length, 1, reason: '预算耗尽时只保留最新一条');
      expect(history.first.content, '最新的用户输入');
    });

    test('当前消息优先后，较旧消息仍按预算被截断', () {
      final messages = [
        _msg('older', content: '更旧消息', tokenCount: 50, seq: 1),
        _msg('old', content: '旧消息', tokenCount: 50, seq: 2),
        _msg('latest', content: '最新消息', tokenCount: 50, seq: 3),
      ];

      final history = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: false),
        usedTokens: 0,
        availableBudget: 50, // 仅够最新一条（50），第二条进入即超预算
      );

      expect(history.map((m) => m.content), ['最新消息']);
    });

    test('showTimestamps 开启时每条额外计入 5 token', () {
      // 一条 tokenCount=0、内容估算 t 的消息：
      //   关闭时间戳 → 占 t；开启 → 占 t + 5。
      // 用「恰好卡住第二条」的预算来反向验证 5 token 开销被计入。
      const content = 'hello'; // 英文，estimateTokens 较小
      final base = estimateTokens(content);
      final messages = [
        _msg('m1', content: content, seq: 1),
        _msg('m2', content: content, seq: 2),
      ];

      // 预算 = base*2 + 5：关闭时间戳时两条共 base*2 <= 预算 → 两条都进。
      final noTs = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: false),
        usedTokens: 0,
        availableBudget: base * 2 + 5,
      );
      expect(noTs.length, 2, reason: '无时间戳开销时两条都在预算内');

      // 开启时间戳：每条 base+5，两条共 base*2+10 > base*2+5 → 第二条被截断，
      // 但最新一条（m2）必进。
      final withTs = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: true),
        usedTokens: 0,
        availableBudget: base * 2 + 5,
      );
      expect(withTs.length, 1, reason: '时间戳 +5/条 使第二条超预算被截断');
      // 内容带时间戳前缀
      expect(
        withTs.first.content,
        '[2026-05-15 14:30] $content',
      );
    });

    test('空内容消息被跳过、非 summary 的 system 消息被跳过', () {
      final messages = [
        _msg('empty', content: '', seq: 1),
        _msg('sys', role: 'system', content: '系统噪声', seq: 2),
        _msg('user', role: 'user', content: '真实输入', seq: 3),
      ];

      final history = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: false),
        usedTokens: 0,
        availableBudget: 100000,
      );

      expect(history.map((m) => m.content), ['真实输入']);
    });

    test('tokenCount 与 estimateTokens 取较大值（对齐主项目 baseTokens）', () {
      // 给一条很大的 tokenCount，使其单独就超预算 → 但作为最新一条仍进。
      final messages = [
        _msg('latest', content: '短', tokenCount: 99999, seq: 1),
      ];
      final history = fillHistoryWithinBudget(
        messages: messages,
        settings: const AppSettings(showTimestamps: false),
        usedTokens: 0,
        availableBudget: 10,
      );
      // 最新一条优先：即便 baseTokens 巨大，history 为空时不 break。
      expect(history.length, 1);
      expect(history.first.content, '短');
    });
  });
}
