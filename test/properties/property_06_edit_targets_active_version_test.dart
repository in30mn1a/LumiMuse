// Feature: flutter-pixel-perfect-parity, Property 6: 编辑同步到当前展示版本
// Validates: Requirements B4.6, C5.1
//
// 设计说明
// ────────
// design.md §3.3 / 需求 B4.6 / 需求 C5.1：
//   多版本 AI 消息被编辑时，新的文本必须落到「当前展示版本」
//   （`metadata.versions[metadata.activeVersion]`），其他版本的 content
//   保持不变；本次编辑不改变 versions 的长度，也不改变 activeVersion。
//
// 本属性测试用纯函数 `editMessageContent(metadata, newContent)` 表达上述
// 行为契约 —— 不依赖 ChatProvider / Drift / token_counter 等上层模块，
// 只关心 `metadata.versions[activeVersion].content` 这一字段的同步规则：
//
//   1. versions[activeVersion].content == newContent
//   2. versions[i].content（i != activeVersion）== 编辑前的旧值
//   3. versions.length 不变
//   4. activeVersion 不变
//
// 用 glados 随机生成「合法 metadata + 任意 newContent」，runs 100。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：editMessageContent
//
// 把 newContent 写到 versions[activeVersion].content，其他版本保持原值。
// 实现刻意做防御性深拷贝（versions 列表与单个版本的 Map 都新建实例），
// 避免外部修改返回值时反向影响入参；这与主项目 `serializeMessage` 的
// 「Map 出口必须可独立持有」语义一致（INV-7）。
// ──────────────────────────────────────────────────────────────────────────

Map<String, dynamic> editMessageContent(
  Map<String, dynamic> metadata,
  String newContent,
) {
  final result = Map<String, dynamic>.from(metadata);
  final rawVersions = metadata['versions'] as List<dynamic>;
  final activeVersion = metadata['activeVersion'] as int;

  // 深拷贝 versions：每个 version Map 也新建实例，避免共享可变引用。
  final newVersions = <Map<String, dynamic>>[
    for (final v in rawVersions) Map<String, dynamic>.from(v as Map),
  ];

  newVersions[activeVersion] = {
    ...newVersions[activeVersion],
    'content': newContent,
  };

  result['versions'] = newVersions;
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器：合法 metadata + 任意 newContent
//
// 设计要点：
// - versions 长度 ∈ [1, 5]；每个版本的 content 由独立种子拼装，覆盖 ASCII
//   / CJK / 标点 / 空白；
// - activeVersion 由独立种子取模到 [0, versions.length)，避免越界；
// - newContent 由独立种子拼装，长度 ∈ [0, 16]，可能与某个旧版本重合，
//   也可能为空字符串（空字符串场景同样必须满足契约）。
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

/// 用整数三元组 + newContent 种子构造一个测试用例。
class _EditCase {
  final Map<String, dynamic> metadata;
  final String newContent;
  final int activeVersion;
  final List<String> originalContents;
  const _EditCase({
    required this.metadata,
    required this.newContent,
    required this.activeVersion,
    required this.originalContents,
  });
}

_EditCase _buildCase({
  required int versionsSeed,
  required int activeSeed,
  required int newContentSeed,
}) {
  final length = (versionsSeed.abs() % 5) + 1; // [1, 5]
  final originalContents = <String>[
    for (var i = 0; i < length; i++) _contentFromSeed(versionsSeed + i * 97),
  ];
  final versions = <Map<String, dynamic>>[
    for (var i = 0; i < length; i++)
      <String, dynamic>{
        'content': originalContents[i],
        // 故意带一个无关字段，确保 editMessageContent 只动 content。
        'created_at': '2026-01-${(i % 9) + 1}T00:00:00Z',
      },
  ];
  final activeVersion = activeSeed.abs() % length;
  final newContent = _contentFromSeed(newContentSeed);

  final metadata = <String, dynamic>{
    'versions': versions,
    'activeVersion': activeVersion,
    // 模拟其它无关字段：编辑后必须原样保留。
    'isSummary': false,
  };

  return _EditCase(
    metadata: metadata,
    newContent: newContent,
    activeVersion: activeVersion,
    originalContents: originalContents,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 6: 编辑同步到当前展示版本', () {
    Glados3<int, int, int>(
      any.intInRange(0, 1 << 20), // versions 内容种子
      any.intInRange(0, 1 << 20), // activeVersion 选择种子
      any.intInRange(0, 1 << 20), // newContent 种子
      ExploreConfig(numRuns: 100),
    ).test(
      '编辑后 versions[active].content == newContent，其他版本与长度、activeVersion 不变',
      (versionsSeed, activeSeed, newContentSeed) {
        final c = _buildCase(
          versionsSeed: versionsSeed,
          activeSeed: activeSeed,
          newContentSeed: newContentSeed,
        );

        final updated = editMessageContent(c.metadata, c.newContent);
        final updatedVersions =
            (updated['versions'] as List).cast<Map<String, dynamic>>();

        // ① versions[active].content == newContent
        expect(
          updatedVersions[c.activeVersion]['content'],
          c.newContent,
          reason: '活跃版本的 content 必须被替换为 newContent',
        );

        // ② 其他版本 content 保持原值
        for (var i = 0; i < updatedVersions.length; i++) {
          if (i == c.activeVersion) continue;
          expect(
            updatedVersions[i]['content'],
            c.originalContents[i],
            reason: '非活跃版本 v$i 的 content 不应被编辑波及',
          );
        }

        // ③ versions.length 不变
        expect(
          updatedVersions.length,
          c.originalContents.length,
          reason: '编辑不应改变 versions 数量',
        );

        // ④ activeVersion 不变
        expect(
          updated['activeVersion'],
          c.activeVersion,
          reason: '编辑不应改变 activeVersion 索引',
        );

        // 附加保护：原 metadata 不被原地修改（防止可变引用泄漏）。
        final originalVersions =
            (c.metadata['versions'] as List).cast<Map<String, dynamic>>();
        expect(
          originalVersions[c.activeVersion]['content'],
          c.originalContents[c.activeVersion],
          reason: 'editMessageContent 不应原地修改入参 metadata',
        );
      },
    );

    // 例测：单版本消息（最简边界，作双层保护）。
    test('单版本消息：activeVersion=0，编辑后 v0.content 同步、长度与索引不变', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': '原文', 'created_at': '2026-01-01T00:00:00Z'},
        ],
        'activeVersion': 0,
      };

      final updated = editMessageContent(metadata, '新内容 hello 喵');
      final versions = (updated['versions'] as List).cast<Map>();

      expect(versions.length, 1);
      expect(updated['activeVersion'], 0);
      expect(versions[0]['content'], '新内容 hello 喵');
      // 入参不被破坏。
      expect(
        ((metadata['versions'] as List)[0] as Map)['content'],
        '原文',
      );
    });

    // 例测：多版本消息，活跃版本在中间，验证邻近版本不被波及。
    test('多版本消息：activeVersion=1，仅 v1 同步、v0 / v2 保持原值', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0 旧', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': 'v1 旧', 'created_at': '2026-01-02T00:00:00Z'},
          {'content': 'v2 旧', 'created_at': '2026-01-03T00:00:00Z'},
        ],
        'activeVersion': 1,
      };

      final updated = editMessageContent(metadata, '改写后的中段');
      final versions = (updated['versions'] as List).cast<Map>();

      expect(versions.length, 3);
      expect(updated['activeVersion'], 1);
      expect(versions[0]['content'], 'v0 旧');
      expect(versions[1]['content'], '改写后的中段');
      expect(versions[2]['content'], 'v2 旧');
    });

    // 例测：newContent 为空字符串，仍必须满足契约。
    test('空字符串 newContent：活跃版本被设为空、其他版本保持原值', () {
      final metadata = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': '保留', 'created_at': '2026-01-01T00:00:00Z'},
          {'content': '将清空', 'created_at': '2026-01-02T00:00:00Z'},
        ],
        'activeVersion': 1,
      };

      final updated = editMessageContent(metadata, '');
      final versions = (updated['versions'] as List).cast<Map>();
      expect(versions[0]['content'], '保留');
      expect(versions[1]['content'], '');
      expect(updated['activeVersion'], 1);
      expect(versions.length, 2);
    });
  });
}
