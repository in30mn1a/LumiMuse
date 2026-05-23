// Feature: flutter-parity-completion, Property 27: uniqueById 综合性质
// **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5**
//
// 通过 `package:glados` 生成 `List<Message>`（含重复 id）覆盖以下五条性质：
// - 17.1 顺序保持：输出按原列表整体顺序排列。
// - 17.2 保留最早：同 id 仅保留 `created_at` 最早的一条；同时间则保留首次出现。
// - 17.3 长度等于不同 id 数：输出长度等于输入的不同 id 数。
// - 17.4 空列表返回空列表：不抛异常。
// - 17.5 幂等：`uniqueById(uniqueById(xs)) == uniqueById(xs)`。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/utils/message_utils.dart';

import '../../_helpers/generators.dart';

void main() {
  group('Property 27: uniqueById 综合性质', () {
    Glados<List<Message>>(any.messageListWithDuplicates).test(
      '空列表返回空列表（17.4）',
      (messages) {
        if (messages.isEmpty) {
          final result = uniqueById(messages);
          expect(result, isEmpty);
        }
      },
    );

    Glados<List<Message>>(any.messageListWithDuplicates).test(
      '输出长度等于输入的不同 id 数（17.3）',
      (messages) {
        final result = uniqueById(messages);
        final distinctIds = messages.map((m) => m.id).toSet();
        expect(result.length, distinctIds.length);
      },
    );

    Glados<List<Message>>(any.messageListWithDuplicates).test(
      '同一 id 仅保留 createdAt 最早的一条（17.2）',
      (messages) {
        final result = uniqueById(messages);
        // 计算每个 id 在输入中的最早 createdAt
        final earliest = <String, DateTime>{};
        for (final m in messages) {
          final cur = earliest[m.id];
          if (cur == null || m.createdAt.isBefore(cur)) {
            earliest[m.id] = m.createdAt;
          }
        }
        // 输出中每条消息的 createdAt 必须等于该 id 的最早 createdAt
        for (final m in result) {
          expect(m.createdAt, earliest[m.id]);
        }
      },
    );

    Glados<List<Message>>(any.messageListWithDuplicates).test(
      '保持原列表整体顺序（17.1）',
      (messages) {
        final result = uniqueById(messages);
        // 输出元素必须按其在原输入中的相对位置排列。
        // 取 result 中每条消息在原 messages 中的索引（按对象引用比对），
        // 这些索引序列必须严格递增。
        final indices = <int>[];
        for (final m in result) {
          // identical(...) 保证拿到的是同一个 Message 实例，而非另一个内容相同的副本。
          final idx = messages.indexWhere((x) => identical(x, m));
          expect(idx, isNonNegative,
              reason: 'uniqueById 输出应来自原列表，不应构造新实例');
          indices.add(idx);
        }
        for (var i = 1; i < indices.length; i++) {
          expect(indices[i] > indices[i - 1], isTrue,
              reason: 'uniqueById 输出顺序必须严格递增（保持原列表顺序）');
        }
      },
    );

    Glados<List<Message>>(any.messageListWithDuplicates).test(
      '幂等：uniqueById(uniqueById(xs)) == uniqueById(xs)（17.5）',
      (messages) {
        final once = uniqueById(messages);
        final twice = uniqueById(once);
        expect(twice.length, once.length);
        for (var i = 0; i < once.length; i++) {
          expect(identical(twice[i], once[i]), isTrue,
              reason: '幂等调用应返回完全相同的实例引用');
        }
      },
    );

    // 例测：边界场景显式断言，配合属性测试形成双层保护。
    test('空列表显式返回空列表', () {
      expect(uniqueById(const <Message>[]), isEmpty);
    });

    test('两条同 id 不同 createdAt 时保留较早一条', () {
      final earlier = Message(
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'A',
        tokenCount: 0,
        seq: 0,
        createdAt: DateTime(2026, 1, 1, 10, 0),
        metadata: '{}',
      );
      final later = Message(
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'B',
        tokenCount: 0,
        seq: 1,
        createdAt: DateTime(2026, 1, 1, 11, 0),
        metadata: '{}',
      );
      // 较早的在后：依然保留较早的那条，但顺序按其在原列表的位置。
      final result = uniqueById([later, earlier]);
      expect(result.length, 1);
      expect(identical(result.first, earlier), isTrue);
      expect(result.first.content, 'A');
    });

    test('全部唯一 id 时返回原列表（零拷贝快返）', () {
      final messages = [
        Message(
          id: 'a',
          conversationId: 'c1',
          role: 'user',
          content: '1',
          tokenCount: 0,
          seq: 0,
          createdAt: DateTime(2026, 1, 1),
          metadata: '{}',
        ),
        Message(
          id: 'b',
          conversationId: 'c1',
          role: 'user',
          content: '2',
          tokenCount: 0,
          seq: 1,
          createdAt: DateTime(2026, 1, 2),
          metadata: '{}',
        ),
      ];
      final result = uniqueById(messages);
      expect(identical(result, messages), isTrue,
          reason: '无重复 id 时应零拷贝快返原列表');
    });
  });
}
