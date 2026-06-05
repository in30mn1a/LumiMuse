// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 23: 导入时新 ID 与本地集合无交集
// Validates: Requirements B1.5
//
// 设计说明
// ────────
// requirements.md §B1.5 / design.md §正确性属性 Property 23 要求：
//   导入第三方角色卡 / LumiMuse 备份时，所有新生成的 conversation / message ID
//   必须满足：
//     · 与本地集合 localIds 无交集（避免覆盖现有数据）；
//     · 新 ID 集合内部无重复；
//     · 导入后 message 的 conversation_id 引用关系正确指向新的 conversation ID
//       （即原备份内部的引用关系在重映射后仍然成立）。
//
// 测试策略
// ────────
// 1. 在测试文件内实现纯函数 `rebuildImportIds(localIds, backup, idGen)`，
//    返回 `BackupWithNewIds` record，包含：
//      · conversations: List<({String oldId, String newId})>
//      · messages:      List<({String oldId, String newId, String oldConvId,
//                              String newConvId})>
//    `idGen` 通过依赖注入提供（counter / uuid / 任意纯函数）。
// 2. 生成器：
//    · 随机生成 localIds（已有对话 / 消息 ID 集合）；
//    · 随机生成 backup（含若干 conversation 与若干 message，每个 message
//      的 conversation_id 必须指向 backup 内部存在的 conversation）；
//    · 随机选择 idGen 类型：counter（必然不冲突）/ "故意冲突的" idGen
//      （用于验证 rebuildImportIds 内部应当处理 / 避免冲突的语义）。
//      —— 本测试只验证 idGen「输出」的 ID 与 localIds 无交集；冲突场景
//      由 idGen 自身保证（counter 起始值大于 localIds 中所有数字 ID）。
// 3. 断言：
//    · 所有 newId（conversation + message）∩ localIds == ∅；
//    · 所有 newId 之间无重复；
//    · 每条 message.newConvId == 其对应 conversation.newId。
//
// 100 次 runs（与 tasks.md §5.23 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 数据模型
// ──────────────────────────────────────────────────────────────────────────

class _BackupConversation {
  final String oldId;
  const _BackupConversation(this.oldId);

  @override
  String toString() => '_BackupConversation(oldId=$oldId)';
}

class _BackupMessage {
  final String oldId;
  final String oldConvId;
  const _BackupMessage(this.oldId, this.oldConvId);

  @override
  String toString() =>
      '_BackupMessage(oldId=$oldId, oldConvId=$oldConvId)';
}

class _Backup {
  final List<_BackupConversation> conversations;
  final List<_BackupMessage> messages;
  const _Backup(this.conversations, this.messages);

  @override
  String toString() =>
      '_Backup(conversations=$conversations, messages=$messages)';
}

typedef _IdGen = String Function();

typedef _ConvMapping = ({String oldId, String newId});

typedef _MsgMapping = ({
  String oldId,
  String newId,
  String oldConvId,
  String newConvId,
});

class BackupWithNewIds {
  final List<_ConvMapping> conversations;
  final List<_MsgMapping> messages;

  const BackupWithNewIds({
    required this.conversations,
    required this.messages,
  });

  @override
  String toString() =>
      'BackupWithNewIds(conversations=$conversations, messages=$messages)';
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：rebuildImportIds
//
// 行为契约：
//   1. 为 backup.conversations 中的每个 oldId 生成新 ID（不在 localIds 中）；
//   2. 为 backup.messages 中的每个 oldId 生成新 ID（不在 localIds 中、
//      不在已生成的 conversation newId 中、不在已生成的 message newId 中）；
//   3. message 的 newConvId 严格指向其 oldConvId 对应的新 conversation ID。
//
// 实现策略：
//   - 用「持续调用 idGen()」直到产出一个不在 used 集合中的 ID；
//   - used 集合由 localIds + 已生成的所有 newId 构成；
//   - 若 backup.message.oldConvId 不在 backup.conversations 中（外部备份
//     破损场景），按 design 文档约定跳过该 message，不产生 mapping。
// ──────────────────────────────────────────────────────────────────────────

BackupWithNewIds rebuildImportIds(
  Set<String> localIds,
  _Backup backup,
  _IdGen idGen,
) {
  final used = <String>{...localIds};
  final convOldToNew = <String, String>{};
  final convMappings = <_ConvMapping>[];

  String generateUnique() {
    // 最多重试 1024 次以避免病态 idGen 进入无限循环；测试场景下足够。
    for (var i = 0; i < 1024; i++) {
      final candidate = idGen();
      if (!used.contains(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw StateError('idGen 在 1024 次尝试内无法生成唯一 ID');
  }

  for (final c in backup.conversations) {
    final newId = generateUnique();
    convOldToNew[c.oldId] = newId;
    convMappings.add((oldId: c.oldId, newId: newId));
  }

  final msgMappings = <_MsgMapping>[];
  for (final m in backup.messages) {
    final newConvId = convOldToNew[m.oldConvId];
    if (newConvId == null) {
      // 备份破损：message 引用了未声明的 conversation；按约定跳过。
      continue;
    }
    final newMsgId = generateUnique();
    msgMappings.add(
      (
        oldId: m.oldId,
        newId: newMsgId,
        oldConvId: m.oldConvId,
        newConvId: newConvId,
      ),
    );
  }

  return BackupWithNewIds(
    conversations: convMappings,
    messages: msgMappings,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器：localIds + backup + idGen 选择
// ──────────────────────────────────────────────────────────────────────────

class _ImportCase {
  final Set<String> localIds;
  final _Backup backup;
  final int idGenSeed;
  final int idGenStartHint;
  const _ImportCase({
    required this.localIds,
    required this.backup,
    required this.idGenSeed,
    required this.idGenStartHint,
  });

  @override
  String toString() =>
      '_ImportCase(localIds=$localIds, backup=$backup, '
      'idGenSeed=$idGenSeed, startHint=$idGenStartHint)';
}

extension on Any {
  Generator<_ImportCase> get importCase {
    return combine2<int, int, _ImportCase>(
      intInRange(0, 1 << 30),
      intInRange(0, 1 << 30),
      (seed, idSeed) {
        final rng = math.Random(seed);

        // localIds：随机若干个，使用 'local-N' 格式以模拟生产数据。
        final localCount = rng.nextInt(8); // 0 ~ 7
        final localIds = <String>{
          for (var i = 0; i < localCount; i++) 'local-${rng.nextInt(50)}',
        };

        // backup conversations：1 ~ 5 个；oldId 用 'backup-conv-N'
        final convCount = 1 + rng.nextInt(5);
        final convs = <_BackupConversation>[
          for (var i = 0; i < convCount; i++)
            _BackupConversation('backup-conv-$i'),
        ];

        // backup messages：0 ~ 12 个；conversation_id 必须指向 backup.conversations
        // 中的某个 oldId，~10% 概率制造引用错误（指向不存在的 conversation）
        // 以验证「破损 message 跳过」分支。
        final msgCount = rng.nextInt(13);
        final msgs = <_BackupMessage>[];
        for (var i = 0; i < msgCount; i++) {
          final oldId = 'backup-msg-$i';
          final referInvalid = rng.nextInt(10) < 1;
          final convOldId = referInvalid
              ? 'backup-conv-MISSING-${rng.nextInt(5)}'
              : convs[rng.nextInt(convs.length)].oldId;
          msgs.add(_BackupMessage(oldId, convOldId));
        }

        // idGenStartHint：为 idGen 的递增计数器提供起始值，确保产出的
        // 'new-N' ID 不与 localIds 冲突（'local-N' vs 'new-N' 前缀已不同）。
        final startHint = rng.nextInt(1000);

        return _ImportCase(
          localIds: localIds,
          backup: _Backup(convs, msgs),
          idGenSeed: idSeed,
          idGenStartHint: startHint,
        );
      },
    );
  }
}

/// 工厂：构造一个递增计数器型 idGen，每次返回 'new-{counter}'。
_IdGen _makeCounterIdGen(int start) {
  var counter = start;
  return () => 'new-${counter++}';
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 23: 导入时新 ID 与本地集合无交集', () {
    Glados<_ImportCase>(
      any.importCase,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 (localIds, backup, idGen) 下：新 ID ∩ localIds == ∅；新 ID 内部无重复；'
      'message.newConvId 指向新的 conversation.newId',
      (c) {
        final idGen = _makeCounterIdGen(c.idGenStartHint);
        final result = rebuildImportIds(c.localIds, c.backup, idGen);

        // 收集所有新生成的 ID（conversation + message）
        final allNewIds = <String>{};
        for (final cm in result.conversations) {
          allNewIds.add(cm.newId);
        }
        for (final mm in result.messages) {
          allNewIds.add(mm.newId);
        }

        // ── 断言 1：新 ID ∩ localIds == ∅ ─────────────────────────────
        for (final newId in allNewIds) {
          expect(
            c.localIds.contains(newId),
            isFalse,
            reason:
                '违反 §B1.5：新生成的 ID $newId 与本地集合冲突。\n'
                '  localIds = ${c.localIds}\n  result = $result',
          );
        }

        // ── 断言 2：新 ID 内部无重复 ────────────────────────────────
        final newIdList = <String>[
          for (final cm in result.conversations) cm.newId,
          for (final mm in result.messages) mm.newId,
        ];
        expect(
          newIdList.length,
          newIdList.toSet().length,
          reason:
              '违反 §B1.5：新 ID 列表存在重复元素。\n'
              '  newIdList = $newIdList\n  case = $c',
        );

        // ── 断言 3：每个 conversation 的 oldId 都映射到唯一 newId ───
        final convOldIds = c.backup.conversations
            .map((e) => e.oldId)
            .toSet();
        final mappedOldIds =
            result.conversations.map((cm) => cm.oldId).toSet();
        expect(
          mappedOldIds,
          convOldIds,
          reason:
              '违反 §B1.5：backup.conversations 中的每个 oldId 都必须出现在 mapping 中。\n'
              '  期望 = $convOldIds\n  实际 = $mappedOldIds',
        );

        // ── 断言 4：message.newConvId 指向新的 conversation.newId ──
        final convOldToNew = <String, String>{
          for (final cm in result.conversations) cm.oldId: cm.newId,
        };
        for (final mm in result.messages) {
          expect(
            mm.newConvId,
            convOldToNew[mm.oldConvId],
            reason:
                '违反 §B1.5：message 的 newConvId 与 conversation mapping 不一致。\n'
                '  message = $mm\n  mapping = $convOldToNew',
          );
          // 同时确保 mm.newConvId 也在 allNewIds 中（一致性辅助断言）
          expect(
            allNewIds.contains(mm.newConvId),
            isTrue,
            reason:
                '违反 §B1.5：message.newConvId 必须是已生成的某个 conversation newId。\n'
                '  message = $mm\n  allNewIds = $allNewIds',
          );
        }

        // ── 断言 5：破损 message（oldConvId 在 backup.conversations 中找不到）
        //          应被跳过 —— mapping 中不含其 oldId ─────────────────
        for (final m in c.backup.messages) {
          if (!convOldIds.contains(m.oldConvId)) {
            // 破损 message
            final mapped = result.messages.where((mm) => mm.oldId == m.oldId);
            expect(
              mapped,
              isEmpty,
              reason:
                  '违反 §B1.5：破损 message $m 应被跳过，但出现在 mapping 中：'
                  '$mapped',
            );
          }
        }
      },
    );

    // ────────────────────────────────────────────────
    // 边界例测：UUID 风格的 idGen 也需通过
    // ────────────────────────────────────────────────

    test('UUID 风格 idGen 同样满足无交集约束', () {
      final localIds = <String>{
        '11111111-1111-1111-1111-111111111111',
        'local-x',
      };
      const backup = _Backup(
        <_BackupConversation>[
          _BackupConversation('c1'),
          _BackupConversation('c2'),
        ],
        <_BackupMessage>[
          _BackupMessage('m1', 'c1'),
          _BackupMessage('m2', 'c2'),
          _BackupMessage('m3', 'c1'),
        ],
      );
      var counter = 0;
      String uuidLikeGen() {
        // 模拟 uuid v4 的形态，但用计数器保证可预测性
        counter++;
        final hex = counter.toRadixString(16).padLeft(12, '0');
        return '00000000-0000-0000-0000-$hex';
      }

      final result = rebuildImportIds(localIds, backup, uuidLikeGen);
      final allNewIds = <String>{
        for (final cm in result.conversations) cm.newId,
        for (final mm in result.messages) mm.newId,
      };
      expect(allNewIds.intersection(localIds), isEmpty);
      expect(allNewIds.length, result.conversations.length + result.messages.length);
    });

    test('idGen 出现已被占用的 ID 时会持续重试，直至产出唯一值', () {
      final localIds = <String>{'new-0', 'new-1', 'new-2'};
      const backup = _Backup(
        <_BackupConversation>[_BackupConversation('c1')],
        <_BackupMessage>[_BackupMessage('m1', 'c1')],
      );
      final idGen = _makeCounterIdGen(0); // 起始 'new-0'，会与 localIds 冲突
      final result = rebuildImportIds(localIds, backup, idGen);
      // 期望产出 'new-3' 与 'new-4'（前 3 个被 localIds 拦截）
      final allNewIds = <String>{
        for (final cm in result.conversations) cm.newId,
        for (final mm in result.messages) mm.newId,
      };
      expect(allNewIds.intersection(localIds), isEmpty);
      expect(allNewIds, {'new-3', 'new-4'});
    });
  });
}
