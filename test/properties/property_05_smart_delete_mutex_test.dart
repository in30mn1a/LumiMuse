// Feature: flutter-pixel-perfect-parity, Property 5: 智能删除互斥结果
// Validates: Requirements B4.4 (INV-3)
//
// 设计说明
// ────────
// design.md §3.3 / 需求 B4.4 / INV-3：
//   智能删除（smartDelete）在多版本消息上必须只删「当前展示版本」，仅当
//   消息只剩一个版本（或没有 versions 字段）时，才删除整条消息。两种结
//   局严格互斥：DeleteOutcome.removedMessage 与 DeleteOutcome.removedVersion
//   必须有且仅有一种发生。
//
// 这是 INV-3 关键不变量，runs ≥ 500（与 design.md「关键不变量 INV-2 /
// INV-3 / INV-5 对应的 Property 4 / 5 / 21 必须 runs ≥ 500」对齐）。
//
// 本属性测试用纯函数 `smartDelete(metadata)` 表达上述行为契约 —— 不依赖
// ChatProvider / Drift / Lightbox 等上层模块，只关心 `metadata.versions`
// 数组与 `metadata.activeVersion` 索引在「智能删除」语义下的演化规则。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/providers/chat_provider_contract.dart'
    show DeleteOutcome;

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：smartDelete
//
// 落实主项目 ChatProvider 在「智能删除」时对 metadata 的处理：
//   1. 取 versions（List<Map>）与 activeVersion；
//   2. 若 versions.length <= 1（含没有 versions 字段、空数组、单版本）：
//      返回 (outcome=removedMessage, updatedMetadata=null,
//             messageRemoved=true)，由调用方负责把整条消息删掉；
//   3. 否则：从 versions 中 removeAt(activeVersion)；新 activeVersion =
//      (oldActive - 1).clamp(0, versions.length - 1)；返回
//      (outcome=removedVersion, updatedMetadata=新 metadata,
//       messageRemoved=false)；
//   4. 入参 metadata 深拷贝，避免外部反向影响。
// ──────────────────────────────────────────────────────────────────────────

class SmartDeleteResult {
  final DeleteOutcome outcome;
  final Map<String, dynamic>? updatedMetadata;
  final bool messageRemoved;
  const SmartDeleteResult({
    required this.outcome,
    required this.updatedMetadata,
    required this.messageRemoved,
  });
}

SmartDeleteResult smartDelete(Map<String, dynamic> metadata) {
  // 取 versions（容忍缺失 / null / 非 List 形态，统一视为「空」）。
  final rawVersions = metadata['versions'];
  final versionsList = <Map<String, dynamic>>[];
  if (rawVersions is List) {
    for (final v in rawVersions) {
      if (v is Map) {
        versionsList.add(Map<String, dynamic>.from(v));
      }
    }
  }

  // versions ≤ 1：删除整条消息。
  if (versionsList.length <= 1) {
    return const SmartDeleteResult(
      outcome: DeleteOutcome.removedMessage,
      updatedMetadata: null,
      messageRemoved: true,
    );
  }

  // 取 activeVersion；非法 / 越界时 clamp 到合法范围，避免崩溃。
  final rawActive = metadata['activeVersion'];
  final oldActive = rawActive is int
      ? rawActive.clamp(0, versionsList.length - 1)
      : versionsList.length - 1;

  // 删除当前展示版本。
  versionsList.removeAt(oldActive);

  // 新的 activeVersion：(oldActive - 1).clamp(0, newLen - 1)
  // 这样 oldActive == 0 时仍指向新数组首项；oldActive > 0 时回退一项。
  final newActive = (oldActive - 1).clamp(0, versionsList.length - 1);

  // 深拷贝其它无关字段。
  final newMeta = Map<String, dynamic>.from(metadata);
  newMeta['versions'] = versionsList;
  newMeta['activeVersion'] = newActive;

  return SmartDeleteResult(
    outcome: DeleteOutcome.removedVersion,
    updatedMetadata: newMeta,
    messageRemoved: false,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器
//
// 设计策略：
// - versions 长度 ∈ [0, 5]，覆盖三种情形：
//     * length == 0：无 versions 字段（旧消息）→ removedMessage；
//     * length == 1：单版本                       → removedMessage；
//     * length >= 2：多版本                       → removedVersion。
// - activeVersion 由独立种子取模到 [0, length)（length == 0 时不写）；
// - 每个版本的 content 由独立种子拼装，覆盖 ASCII / CJK / 标点 / 空白。
// ──────────────────────────────────────────────────────────────────────────

const _charPalette = <String>[
  'a', 'B', '7', ' ', '\n',
  '猫', '光', '星', '夜', '茶',
  '。', '：', ',', '!', '?',
];

String _contentFromSeed(int seed) {
  final length = seed.abs() % 17; // [0, 16]
  if (length == 0) return '';
  final buf = StringBuffer();
  var s = seed.abs();
  for (var i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf.write(_charPalette[s % _charPalette.length]);
  }
  return buf.toString();
}

/// 测试输入：
/// - lengthSeed：versions 长度种子（取模到 [0, 5]）；
/// - activeSeed：activeVersion 选择种子（length > 0 时取模到 [0, length)）；
/// - contentSeed：版本内容拼装种子。
class _DeleteCase {
  final Map<String, dynamic> metadata;
  final int originalLength;
  final int? originalActive; // length == 0 时为 null
  final List<String> originalContents;
  const _DeleteCase({
    required this.metadata,
    required this.originalLength,
    required this.originalActive,
    required this.originalContents,
  });

  @override
  String toString() => '_DeleteCase('
      'len=$originalLength, '
      'active=$originalActive)';
}

_DeleteCase _buildCase({
  required int lengthSeed,
  required int activeSeed,
  required int contentSeed,
}) {
  final length = lengthSeed.abs() % 6; // [0, 5]
  final originalContents = <String>[
    for (var i = 0; i < length; i++) _contentFromSeed(contentSeed + i * 97),
  ];

  // 入参 metadata：故意带一个无关字段，确保 smartDelete 不会丢失它。
  final metadata = <String, dynamic>{
    'isSummary': false,
  };

  int? originalActive;
  if (length > 0) {
    final versions = <Map<String, dynamic>>[
      for (var i = 0; i < length; i++)
        <String, dynamic>{
          'content': originalContents[i],
          'created_at': '2026-01-${(i % 9) + 1}T00:00:00Z',
        },
    ];
    originalActive = activeSeed.abs() % length;
    metadata['versions'] = versions;
    metadata['activeVersion'] = originalActive;
  }

  return _DeleteCase(
    metadata: metadata,
    originalLength: length,
    originalActive: originalActive,
    originalContents: originalContents,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 5: 智能删除互斥结果', () {
    Glados3<int, int, int>(
      any.intInRange(0, 1 << 20), // versions 长度种子
      any.intInRange(0, 1 << 20), // activeVersion 选择种子
      any.intInRange(0, 1 << 20), // 内容拼装种子
      ExploreConfig(numRuns: 500), // 关键不变量 INV-3
    ).test(
      'smartDelete 返回 removedMessage 与 removedVersion 严格互斥，且形态自洽',
      (lengthSeed, activeSeed, contentSeed) {
        final c = _buildCase(
          lengthSeed: lengthSeed,
          activeSeed: activeSeed,
          contentSeed: contentSeed,
        );

        final result = smartDelete(c.metadata);

        // ① outcome 取值必为枚举两值之一（互斥的前提）。
        expect(
          result.outcome == DeleteOutcome.removedMessage ||
              result.outcome == DeleteOutcome.removedVersion,
          true,
          reason: 'outcome 必须落在 {removedMessage, removedVersion} 之内',
        );

        if (result.outcome == DeleteOutcome.removedMessage) {
          // ② removedMessage 分支：原 versions ≤ 1。
          expect(
            c.originalLength <= 1,
            true,
            reason: 'removedMessage 仅在原 versions.length ≤ 1 时发生 '
                '(originalLength=${c.originalLength})',
          );
          // ③ messageRemoved == true 且 updatedMetadata == null。
          expect(result.messageRemoved, true,
              reason: 'removedMessage 分支必须 messageRemoved=true');
          expect(result.updatedMetadata, isNull,
              reason: 'removedMessage 分支必须 updatedMetadata=null');
        } else {
          // ② removedVersion 分支：原 versions > 1。
          expect(
            c.originalLength > 1,
            true,
            reason: 'removedVersion 仅在原 versions.length > 1 时发生 '
                '(originalLength=${c.originalLength})',
          );
          // ③ messageRemoved == false 且 updatedMetadata != null。
          expect(result.messageRemoved, false,
              reason: 'removedVersion 分支必须 messageRemoved=false');
          expect(result.updatedMetadata, isNotNull,
              reason: 'removedVersion 分支必须 updatedMetadata 非空');

          // ④ 新 versions.length == 原 length - 1。
          final newVersions = (result.updatedMetadata!['versions'] as List)
              .cast<Map<String, dynamic>>();
          expect(
            newVersions.length,
            c.originalLength - 1,
            reason: 'removedVersion 分支后新 versions 长度应为旧长度 - 1',
          );

          // ⑤ 新 activeVersion 在合法范围内。
          final newActive = result.updatedMetadata!['activeVersion'] as int;
          expect(newActive, greaterThanOrEqualTo(0));
          expect(newActive, lessThan(newVersions.length));

          // ⑥ 新 versions 中不再含有原活跃版本的 content（按下标剔除）。
          //    构造剩余的预期内容序列：原内容去掉 activeVersion 那一项。
          final expectedRemaining = <String>[
            for (var i = 0; i < c.originalContents.length; i++)
              if (i != c.originalActive) c.originalContents[i],
          ];
          final actualRemaining = <String>[
            for (final v in newVersions) v['content'] as String,
          ];
          expect(
            actualRemaining,
            expectedRemaining,
            reason: '剩余版本顺序应为「原序列剔除 activeVersion 项」后的序列',
          );

          // ⑦ 无关字段（isSummary）保留。
          expect(
            result.updatedMetadata!['isSummary'],
            false,
            reason: 'smartDelete 不应丢弃 metadata 的无关字段',
          );
        }

        // ⑧ 入参不被原地修改（防止可变引用泄漏）。
        if (c.originalLength > 0) {
          final originalVersions =
              (c.metadata['versions'] as List).cast<Map>();
          expect(
            originalVersions.length,
            c.originalLength,
            reason: 'smartDelete 不应原地修改入参 metadata.versions',
          );
          expect(
            c.metadata['activeVersion'],
            c.originalActive,
            reason: 'smartDelete 不应原地修改入参 metadata.activeVersion',
          );
        }
      },
    );

    // ──────────────────────────────────────────────
    // 例测：把契约的关键边界用具体输入再固化一次（双层保护）
    // ──────────────────────────────────────────────

    test('无 versions 字段（旧消息）：返回 removedMessage', () {
      final metadata = <String, dynamic>{'isSummary': false};
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedMessage);
      expect(result.messageRemoved, true);
      expect(result.updatedMetadata, isNull);
    });

    test('单版本消息：返回 removedMessage', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': '唯一版本', 'created_at': '2026-01-01T00:00:00Z'},
        ],
        'activeVersion': 0,
      };
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedMessage);
      expect(result.messageRemoved, true);
      expect(result.updatedMetadata, isNull);
    });

    test('多版本消息（active=0）：删 v0，新 active=0', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': 'v1', 'created_at': '2026-01-02T00:00:00Z'},
          {'content': 'v2', 'created_at': '2026-01-03T00:00:00Z'},
        ],
        'activeVersion': 0,
      };
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedVersion);
      expect(result.messageRemoved, false);
      final versions =
          (result.updatedMetadata!['versions'] as List).cast<Map>();
      expect(versions.length, 2);
      expect(versions[0]['content'], 'v1');
      expect(versions[1]['content'], 'v2');
      expect(result.updatedMetadata!['activeVersion'], 0);
      // 入参不被破坏。
      expect((metadata['versions'] as List).length, 3);
    });

    test('多版本消息（active=中间）：删 v1，新 active 回退到 0', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': 'v1', 'created_at': '2026-01-02T00:00:00Z'},
          {'content': 'v2', 'created_at': '2026-01-03T00:00:00Z'},
        ],
        'activeVersion': 1,
      };
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedVersion);
      final versions =
          (result.updatedMetadata!['versions'] as List).cast<Map>();
      expect(versions.length, 2);
      expect(versions[0]['content'], 'v0');
      expect(versions[1]['content'], 'v2');
      expect(result.updatedMetadata!['activeVersion'], 0);
    });

    test('多版本消息（active=末项）：删 v2，新 active 回退到 1', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': 'v1', 'created_at': '2026-01-02T00:00:00Z'},
          {'content': 'v2', 'created_at': '2026-01-03T00:00:00Z'},
        ],
        'activeVersion': 2,
      };
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedVersion);
      final versions =
          (result.updatedMetadata!['versions'] as List).cast<Map>();
      expect(versions.length, 2);
      expect(versions[0]['content'], 'v0');
      expect(versions[1]['content'], 'v1');
      expect(result.updatedMetadata!['activeVersion'], 1);
    });

    test('两版本消息（active=0）：删 v0，剩 v1，新 active=0', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': 'v1', 'created_at': '2026-01-02T00:00:00Z'},
        ],
        'activeVersion': 0,
      };
      final result = smartDelete(metadata);
      expect(result.outcome, DeleteOutcome.removedVersion);
      final versions =
          (result.updatedMetadata!['versions'] as List).cast<Map>();
      expect(versions.length, 1);
      expect(versions[0]['content'], 'v1');
      expect(result.updatedMetadata!['activeVersion'], 0);
    });
  });
}
