// 自定义属性测试生成器 —— 集中放置 flutter-parity-completion 涉及的 glados 生成器。
//
// 设计目标（参见 tasks.md 1.4 与 design.md 「P1 / R17」）：
// - 复用一份生成器，避免每个属性测试重写一遍 List<Message> 构造逻辑。
// - 通过「先生成长度 + 唯一 id 上限」的组合策略，让 `uniqueById` 的去重路径
//   能被高概率覆盖（少量唯一 id × 较多消息 → 产生重复 id 的样本）。

import 'dart:math' as math;

import 'package:glados/glados.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';

import 'active_message_id_reducer.dart';
import 'launch_password_lock_reducer.dart';

/// flutter-parity-completion 专用 glados 生成器扩展。
extension ParityCompletionGenerators on Any {
  /// 生成 assistant 消息的 `memory_extracted` 预标记序列 —— 用于 R7 Property 14
  /// `resetExtraction round-trip` 测试。
  ///
  /// 生成策略：
  /// - 列表长度 `n ∈ [0, 12]`：覆盖空对话与中等规模对话。
  /// - 每个元素表示对应位置 assistant 消息是否预先带 `memory_extracted = true`。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  Generator<List<bool>> get assistantPreMarkedFlags {
    return combine2<int, int, List<bool>>(
      intInRange(0, 13), // 列表长度 [0, 12]
      intInRange(0, 1 << 30), // Random 种子
      (n, seed) {
        if (n == 0) return const <bool>[];
        final rng = math.Random(seed);
        return List<bool>.generate(n, (_) => rng.nextBool());
      },
    );
  }

  /// 生成 `toggleIgnoreMemory` 的布尔序列 —— 用于 R5 Property 10
  /// `ignore_memory 切换持久化` 测试。
  ///
  /// 生成策略：
  /// - 列表长度 `n ∈ [0, 12]`：覆盖空序列、单次 toggle 与中等规模序列。
  /// - 每个元素表示该步 toggle 的目标值（true / false）。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  ///
  /// 与 [assistantPreMarkedFlags] 在底层结构上等价，但语义不同：这里的
  /// 序列代表用户的开关动作时间线，而非消息预标记状态。
  Generator<List<bool>> get toggleFlagsSequence {
    return combine2<int, int, List<bool>>(
      intInRange(0, 13), // 序列长度 [0, 12]
      intInRange(0, 1 << 30), // Random 种子
      (n, seed) {
        if (n == 0) return const <bool>[];
        final rng = math.Random(seed);
        return List<bool>.generate(n, (_) => rng.nextBool());
      },
    );
  }

  /// 生成对话 ID —— 用于 R5 Property 10 `ignore_memory 切换持久化` 测试。
  ///
  /// 生成策略：
  /// - 池大小 8（`conv-0` 到 `conv-7`），每次测试独立内存数据库，因此
  ///   ID 重复也不会跨用例污染状态。
  /// - 限制在小池内可让 glados shrink 在失败时给出可读的最简反例。
  Generator<String> get conversationId {
    return intInRange(0, 8).map((i) => 'conv-$i');
  }

  /// 生成 `List<ActiveAction>` —— 用于 R9 `activeMessageId` 状态机不变量测试。
  ///
  /// 生成策略（参考 tasks.md 10.2 与 design.md 「P1 / R9」）：
  /// - `idPoolCap ∈ [1, 4]`：消息 id 池上限。狭小 id 池可让「点击同一 id 切回 null」
  ///   分支被高概率覆盖。
  /// - `seqLen ∈ [0, 16]`：操作序列长度，覆盖空序列与中等规模。
  /// - `seed`：用于在生成器内构造确定性 `Random`，保证 glados 失败重放可复现。
  /// - 每一步以 1/4 概率为 `clickBlank`，3/4 概率为 `toggle(id)`，
  ///   id 从 [`m-0`, `m-{idPoolCap-1}`] 等概率选取。
  Generator<List<ActiveAction>> get activeActionSequences {
    return combine3<int, int, int, List<ActiveAction>>(
      intInRange(1, 5), // idPoolCap 取值范围 [1, 4]
      intInRange(0, 17), // seqLen 取值范围 [0, 16]
      intInRange(0, 1 << 30), // 用于 Random 的 seed
      (idPoolCap, seqLen, seed) {
        if (seqLen == 0) return const <ActiveAction>[];
        final random = math.Random(seed);
        return List<ActiveAction>.generate(seqLen, (_) {
          // 1/4 概率点击空白；其余构造一次 toggle
          if (random.nextInt(4) == 0) {
            return const ActiveAction.clickBlank();
          }
          final idIndex = random.nextInt(idPoolCap);
          return ActiveAction.toggle('m-$idIndex');
        });
      },
    );
  }

  /// 生成合法的时间戳字面量 —— 用于 R15 Property 25
  /// `stripTimestampPrefix 不变量` 测试。
  ///
  /// 输出形如 `[YYYY-M-D HH:MM]` / `[YYYY/MM/DD HH:MM:SS]`，与 Node.js 端
  /// `stripTimestampPrefix` 等价正则 `\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]`
  /// 完全匹配。覆盖：
  /// - 月/日/时：1 位或 2 位写法（对齐 `\d{1,2}`）。
  /// - 分钟：始终 2 位（对齐 `\d{2}`）。
  /// - 分隔符：`-` 或 `/`。
  /// - 秒：可有可无（对齐 `(?::\d{2})?`）。
  Generator<String> get validTimestampLiteral {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final year = 1000 + rng.nextInt(9000); // 4 位年份
      final month = 1 + rng.nextInt(12);
      final day = 1 + rng.nextInt(28); // 1–28，避开月末越界
      final hour = rng.nextInt(24);
      final minute = rng.nextInt(60);
      final useSlash = rng.nextBool();
      final hasSec = rng.nextBool();
      // 月/日/时：值 < 10 时随机选 1 位或 2 位写法，覆盖 `\d{1,2}` 两种长度。
      String oneOrTwoDigits(int n) {
        if (n >= 10) return '$n';
        return rng.nextBool() ? '$n' : n.toString().padLeft(2, '0');
      }
      final sep = useSlash ? '/' : '-';
      final m = oneOrTwoDigits(month);
      final d = oneOrTwoDigits(day);
      final h = oneOrTwoDigits(hour);
      final mm = minute.toString().padLeft(2, '0');
      final base = '[$year$sep$m$sep$d $h:$mm';
      if (!hasSec) return '$base]';
      final sec = rng.nextInt(60);
      return '$base:${sec.toString().padLeft(2, '0')}]';
    });
  }

  /// 生成 0–4 个 ASCII 空白字符（空格 / 制表符 / 换行 / 回车）—— 用于 R15 Property 25。
  ///
  /// 与 Dart `RegExp` 默认 `\s` 字符类对齐：仅匹配 ASCII 空白，不包含全角空格。
  Generator<String> get asciiLeadingWhitespace {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final len = rng.nextInt(5); // 0–4 个空白字符
      if (len == 0) return '';
      const chars = [' ', '\t', '\n', '\r'];
      return List.generate(len, (_) => chars[rng.nextInt(chars.length)]).join();
    });
  }

  /// 生成不含 `[` 且不以 ASCII 空白开头的后续字符串 —— 用于 R15 Property 25。
  ///
  /// 约束目的：
  /// - 不含 `[`：避免 suffix 自身被识别为时间戳前缀而误剥离。
  /// - 不含 Dart `RegExp` 的 `\s` 字符类成员（含 ASCII 空白）：避免被
  ///   `stripTimestampPrefix` 末尾的 `\s*` 吞掉，保证整体 suffix 原样保留。
  ///   注意：Dart `\s` 默认遵循 ECMAScript 语义，**会**匹配全角空格 `U+3000`，
  ///   因此候选集中刻意不含全角空格；如需验证 15.5 全角空格保留语义，
  ///   请通过单独的例测断言（实现层面是否真的仅剥离 ASCII 空白存在
  ///   spec/impl 待对齐的问题，此处先稳态满足 25 号属性）。
  ///
  /// 候选字符包含中文、英文、数字、标点，覆盖典型的非 ASCII 起始字符场景。
  Generator<String> get suffixWithoutBracket {
    return intInRange(0, 1 << 30).map((seed) {
      final rng = math.Random(seed);
      final len = rng.nextInt(20);
      if (len == 0) return '';
      const candidates = [
        '你', '好', '呀', '世', '界',
        'a', 'b', 'X', 'Y',
        '1', '7', '!', '。', '，', '?', '#', ']',
      ];
      return List.generate(
        len,
        (_) => candidates[rng.nextInt(candidates.length)],
      ).join();
    });
  }

  /// 生成 `List<Message>`，可能包含重复 `id` —— 用于 R17 `uniqueById` 综合性质测试。
  ///
  /// 生成策略：
  /// - `listLen ∈ [0, 20]`：列表长度，覆盖空列表与小到中等规模。
  /// - `uniqueIdCap ∈ [1, 5]`：唯一 id 数上限，与 `listLen` 取较小值后作为
  ///   实际唯一 id 数。这样当 listLen > uniqueIdCap 时必然产生重复 id。
  /// - `seed`：用于在生成器内构造确定性 `Random`，保证 glados 失败重放可复现。
  ///
  /// 生成的 `Message` 中只填写 `uniqueById` 实际依赖的字段（`id` 与 `createdAt`），
  /// 其它字段（content / tokenCount / seq / metadata）取占位值。
  Generator<List<Message>> get messageListWithDuplicates {
    return combine3<int, int, int, List<Message>>(
      intInRange(0, 21), // listLen 取值范围 [0, 20]
      intInRange(1, 6), // uniqueIdCap 取值范围 [1, 5]
      intInRange(0, 1 << 30), // 用于 Random 的 seed
      (listLen, uniqueIdCap, seed) {
        if (listLen == 0) return const <Message>[];
        final random = math.Random(seed);
        final uniqueCount = math.min(uniqueIdCap, listLen);
        return List<Message>.generate(listLen, (i) {
          final idIndex = random.nextInt(uniqueCount);
          // createdAt 的取值空间故意压小：让相同 id 的多条记录有较高概率
          // 出现「不同 createdAt」与「相同 createdAt」两种情况。
          final createdMs = random.nextInt(50);
          return Message(
            id: 'id-$idIndex',
            conversationId: 'conv-1',
            role: 'user',
            content: 'msg-$i',
            tokenCount: 0,
            seq: i,
            createdAt: DateTime.fromMillisecondsSinceEpoch(createdMs),
            metadata: '{}',
          );
        });
      },
    );
  }

  /// 生成 `List<Message>`，其中 `metadata.isSummary == true` 的消息按指定概率分布 ——
  /// 用于 R4 Property 8 `summary 截断保持后续消息` 测试。
  ///
  /// 生成策略：
  /// - 列表长度 `n ∈ [0, 16]`：覆盖空列表、单 summary、多 summary 与全无 summary。
  /// - 每条消息以约 30% 概率生成 `isSummary` 标记，使「最后一条 summary」前后
  ///   都可能出现非 summary 消息，保证 `lastSummaryIdx` 截断行为被高概率覆盖。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  ///
  /// 生成的 `Message` 仅填写 `computeLastSummaryIdx` 实际依赖的字段
  /// （`id` / `metadata` 与必须的占位字段），对其它字段取占位值。
  Generator<List<Message>> get messageListWithSummaryFlags {
    return combine2<int, int, List<Message>>(
      intInRange(0, 17), // listLen ∈ [0, 16]
      intInRange(0, 1 << 30), // Random 种子
      (listLen, seed) {
        if (listLen == 0) return const <Message>[];
        final rng = math.Random(seed);
        return List<Message>.generate(listLen, (i) {
          // 约 30% 概率为 summary（rng.nextInt(10) < 3），其余为普通消息。
          // 同时也按 5% 概率混入「脏 metadata」，覆盖 _parseMetadata 容错路径
          // —— `computeLastSummaryIdx` 应把脏数据视为非 summary。
          final dice = rng.nextInt(20);
          final String metadata;
          if (dice == 0) {
            metadata = '<<not json>>';
          } else if (dice < 7) {
            metadata = '{"isSummary":true}';
          } else {
            metadata = '{}';
          }
          return Message(
            id: 'm-$i',
            conversationId: 'conv-1',
            role: i.isEven ? 'user' : 'assistant',
            content: 'c$i',
            tokenCount: 0,
            seq: i,
            createdAt: DateTime.fromMillisecondsSinceEpoch(i * 1000),
            metadata: metadata,
          );
        });
      },
    );
  }

  /// 生成 `List<ChatMessage>`，role 集中在 `system` / `user` / `assistant` —— 用于 R4
  /// Property 9 `相邻同 role 合并` 测试。
  ///
  /// 生成策略：
  /// - 列表长度 `n ∈ [0, 16]`：覆盖空列表与中等规模。
  /// - 每条消息以等概率从 `{system, user, assistant}` 中抽取 role，保证相邻
  ///   同 role 与跨 role 切换两种场景都被覆盖；并显式包含 `system` 以验证
  ///   合并逻辑「不合并 system」的不变量。
  /// - content 用短文本（`a` / `b` / `c` / `d`）便于 shrink 后给出可读反例。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  Generator<List<ChatMessage>> get chatMessageListForMerge {
    return combine2<int, int, List<ChatMessage>>(
      intInRange(0, 17), // listLen ∈ [0, 16]
      intInRange(0, 1 << 30), // Random 种子
      (listLen, seed) {
        if (listLen == 0) return const <ChatMessage>[];
        final rng = math.Random(seed);
        const roles = <String>['system', 'user', 'assistant'];
        const contents = <String>['a', 'b', 'c', 'd'];
        return List<ChatMessage>.generate(listLen, (_) {
          return ChatMessage(
            role: roles[rng.nextInt(roles.length)],
            content: contents[rng.nextInt(contents.length)],
          );
        });
      },
    );
  }
}


/// flutter-parity-completion / R13 启动密码 — 锁定状态机生成器。
extension LaunchPasswordLockGenerators on Any {
  /// 生成 `(timestamp, success | failure)` 尝试序列 — 用于 R13 Property 23。
  ///
  /// 生成策略（参考 tasks.md 16.6 与 design.md「P2 / R13」）：
  /// - `seqLen ∈ [0, 12]`：序列长度，覆盖空序列、单次尝试与中等规模。
  /// - 时间戳从基准 `2025-01-01T00:00:00Z` 起，每步累加 `delta ∈ [0, 12] s`，
  ///   保证序列非递减。`delta` 取值跨越 30s 锁定边界（含 0、< 30、=> 30），
  ///   让锁定期内忽略尝试与解锁后恢复尝试两条分支都被高概率覆盖。
  /// - 每步以 1/4 概率为 success，3/4 概率为 failure。
  ///   偏向 failure 是为让「累计 5 次 → 锁定」分支更频繁触发。
  /// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
  Generator<List<LockAction>> get lockAttemptSequences {
    return combine2<int, int, List<LockAction>>(
      intInRange(0, 13), // seqLen 取值范围 [0, 12]
      intInRange(0, 1 << 30), // 用于 Random 的 seed
      (seqLen, seed) {
        if (seqLen == 0) return const <LockAction>[];
        final rng = math.Random(seed);
        final base = DateTime.utc(2025, 1, 1);
        var cursor = base;
        return List<LockAction>.generate(seqLen, (_) {
          final deltaSec = rng.nextInt(13); // [0, 12]
          cursor = cursor.add(Duration(seconds: deltaSec));
          final isSuccess = rng.nextInt(4) == 0;
          return LockAction(
            cursor,
            isSuccess ? LockAttemptKind.success : LockAttemptKind.failure,
          );
        });
      },
    );
  }
}
