// Feature: flutter-pixel-perfect-parity, Property 4: 重新生成版本严格递增（含首次归档版本 0）
// Validates: Requirements B4.1, B4.2 (INV-2)
//
// 设计说明
// ────────
// design.md §3.3 / 需求 B4.1 / 需求 B4.2 / INV-2：
//   - 首次重新生成必须先把当前 content 归档为 versions[0]，再追加新版本；
//   - 后续重新生成只追加新版本，不再重复归档；
//   - 每次重新生成后 versions.length 必须严格递增；
//   - activeVersion 始终指向 versions 的最后一项（最新版本）。
//
// 这是 INV-2 关键不变量，runs ≥ 500（与 design.md「关键不变量 INV-2 / INV-3
// / INV-5 对应的 Property 4 / 5 / 21 必须 runs ≥ 500」对齐）。
//
// 本属性测试用纯函数 `regenerateMetadata(metadata, currentContent, newContent, now)`
// 表达上述行为契约 —— 不依赖 ChatProvider / Drift / token_counter 等上层模块，
// 只关心 `metadata.versions` 数组与 `metadata.activeVersion` 索引的演化规则。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：regenerateMetadata
//
// 落实主项目 ChatProvider 在「重新生成」时对 metadata 的处理：
//   1. 取 versions；若不存在 / null / 空：先把 currentContent 归档为
//      versions[0]，再追加 newContent 作为 versions[1]；
//   2. 否则只追加 versions.add({'content': newContent, ...})；
//   3. 设置 activeVersion = versions.length - 1；
//   4. 返回深拷贝后的新 Map，避免外部修改污染入参。
// ──────────────────────────────────────────────────────────────────────────

Map<String, dynamic> regenerateMetadata(
  Map<String, dynamic> metadata,
  String currentContent,
  String newContent,
  DateTime now,
) {
  final result = Map<String, dynamic>.from(metadata);
  final raw = metadata['versions'];
  final isoNow = now.toUtc().toIso8601String();

  // 深拷贝旧 versions（若有），保证返回值与入参互不影响。
  final newVersions = <Map<String, dynamic>>[];
  if (raw is List && raw.isNotEmpty) {
    for (final v in raw) {
      newVersions.add(Map<String, dynamic>.from(v as Map));
    }
  } else {
    // 首次归档：把 currentContent 写入 versions[0]。
    newVersions.add(<String, dynamic>{
      'content': currentContent,
      'created_at': isoNow,
    });
  }

  // 追加新版本。
  newVersions.add(<String, dynamic>{
    'content': newContent,
    'created_at': isoNow,
  });

  result['versions'] = newVersions;
  result['activeVersion'] = newVersions.length - 1;
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// 生成器
//
// 设计策略：
// - 初始 metadata 两种形态：
//   * 不含 versions（模拟旧消息，从未归档过）；
//   * 已含 m ∈ [1, 4] 个 versions（模拟已经多次重新生成过）；
// - n ∈ [1, 5]：连续重新生成次数；
// - 内容种子用确定性 Random，覆盖 ASCII / CJK / 标点 / 空白；
// - 时间戳由起点 + 偏移构造，保证可复现。
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

/// 测试输入用例：
/// - hasInitialVersions：是否预置 versions 数组；
/// - initialCount：若预置，初始 versions 的数量 m ∈ [1, 4]；
/// - regenerateTimes：连续 regenerate 次数 n ∈ [1, 5]；
/// - currentContent：未归档时第一次需要保留的旧内容；
/// - contentSeed：用于派生每次 regenerate 的 newContent。
class _RegenerateCase {
  final bool hasInitialVersions;
  final int initialCount;
  final int regenerateTimes;
  final String currentContent;
  final int contentSeed;

  const _RegenerateCase({
    required this.hasInitialVersions,
    required this.initialCount,
    required this.regenerateTimes,
    required this.currentContent,
    required this.contentSeed,
  });

  @override
  String toString() => '_RegenerateCase('
      'hasInitial=$hasInitialVersions, '
      'initialCount=$initialCount, '
      'n=$regenerateTimes, '
      'currentLen=${currentContent.length})';
}

extension on Any {
  Generator<_RegenerateCase> get regenerateCases {
    // 用 4 维种子打包：bool 种子 / 初始 m / n / 内容种子。
    return combine4<int, int, int, int, _RegenerateCase>(
      intInRange(0, 1 << 20), // hasInitial 种子（取末位）+ initialCount 种子
      intInRange(1, 6), // n ∈ [1, 5]
      intInRange(0, 1 << 20), // currentContent 种子
      intInRange(0, 1 << 20), // newContent 派生种子
      (mixed, n, currentSeed, newSeed) {
        // 末位决定是否预置 versions；高位决定 initialCount 的取值。
        final hasInitial = (mixed & 1) == 1;
        final initialCount = ((mixed >> 1) % 4) + 1; // [1, 4]
        return _RegenerateCase(
          hasInitialVersions: hasInitial,
          initialCount: initialCount,
          regenerateTimes: n,
          currentContent: _contentFromSeed(currentSeed),
          contentSeed: newSeed,
        );
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 工具：构造初始 metadata
// ──────────────────────────────────────────────────────────────────────────

Map<String, dynamic> _buildInitialMetadata(_RegenerateCase c) {
  if (!c.hasInitialVersions) {
    // 旧消息：完全没有 versions / activeVersion 字段，模拟首次 regenerate
    // 前的真实形态。
    return <String, dynamic>{
      // 故意带一个无关字段，确保 regenerateMetadata 不会丢失它。
      'isSummary': false,
    };
  }
  final versions = <Map<String, dynamic>>[
    for (var i = 0; i < c.initialCount; i++)
      <String, dynamic>{
        'content': 'preset-v$i',
        'created_at': '2024-01-01T00:00:0$i',
      },
  ];
  return <String, dynamic>{
    'versions': versions,
    'activeVersion': versions.length - 1,
    'isSummary': false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 4: 重新生成版本严格递增（含首次归档版本 0）', () {
    Glados<_RegenerateCase>(
      any.regenerateCases,
      ExploreConfig(numRuns: 500), // 关键不变量 INV-2
    ).test(
      'n 次 regenerate 后 versions.length 严格递增、activeVersion 始终指向最后一项',
      (c) {
        final rng = math.Random(c.contentSeed);
        Map<String, dynamic> meta = _buildInitialMetadata(c);

        // 记录初始 versions 数（用于最终长度断言）。
        final initialLen = (meta['versions'] as List?)?.length ?? 0;

        // 首次 regenerate 应保留的「当前 content」—— 即旧消息正文，
        // 仅在首次归档分支被使用。
        final currentContent = c.currentContent;

        // 顺序执行 n 次 regenerate，每一步都断言 versions.length 严格递增。
        var prevLen = initialLen;
        for (var step = 0; step < c.regenerateTimes; step++) {
          final newContent = _contentFromSeed(c.contentSeed + step * 131);
          final now = DateTime.utc(2026, 1, 1).add(Duration(minutes: step));

          final updated = regenerateMetadata(meta, currentContent, newContent, now);
          final versions = (updated['versions'] as List).cast<Map>();

          // ① versions.length 严格递增（INV-2 主条款）。
          expect(
            versions.length,
            greaterThan(prevLen),
            reason: 'step=$step：每次 regenerate 后 versions.length 必须严格递增 '
                '(prev=$prevLen, current=${versions.length})',
          );

          // ② activeVersion == versions.length - 1（始终指向最新版本）。
          expect(
            updated['activeVersion'],
            versions.length - 1,
            reason: 'step=$step：activeVersion 必须指向 versions 末项',
          );

          // ③ 最末一项的 content == 本次 newContent。
          expect(
            versions.last['content'],
            newContent,
            reason: 'step=$step：versions 末项的 content 必须是本次 newContent',
          );

          // ④ 首次 regenerate 时（且初始没有 versions），versions[0].content
          //    必须是被归档的旧 content（INV-2 首次归档子条款）。
          if (step == 0 && !c.hasInitialVersions) {
            expect(
              versions[0]['content'],
              currentContent,
              reason: '首次归档：versions[0] 必须为旧 currentContent',
            );
            expect(
              versions.length,
              2,
              reason: '首次归档：旧 content + 新 content 共两项',
            );
          }

          prevLen = versions.length;
          meta = updated;
          // 用未使用的 rng 跳过几步，使 glados shrink 时仍保持随机性可复现。
          rng.nextInt(1 << 16);
        }

        // 最终长度断言：
        // - 若初始无 versions，n 次后总长度 == n + 1（首次归档 +1，每次追加 +1）；
        // - 若初始已有 m 个 versions，n 次后总长度 == m + n。
        final finalVersions = (meta['versions'] as List).cast<Map>();
        if (!c.hasInitialVersions) {
          expect(
            finalVersions.length,
            c.regenerateTimes + 1,
            reason: '初始无 versions：n 次 regenerate 后长度应为 n+1',
          );
        } else {
          expect(
            finalVersions.length,
            c.initialCount + c.regenerateTimes,
            reason: '初始有 m 个 versions：n 次 regenerate 后长度应为 m+n',
          );
        }

        // 形态断言：activeVersion 始终在合法范围内。
        final active = meta['activeVersion'] as int;
        expect(active, greaterThanOrEqualTo(0));
        expect(active, lessThan(finalVersions.length));

        // 形态断言：无关字段保留。
        expect(meta['isSummary'], false,
            reason: 'regenerateMetadata 不应丢弃 metadata 的无关字段');
      },
    );

    // ──────────────────────────────────────────────
    // 例测：把契约的关键边界用具体输入再固化一次（双层保护）
    // ──────────────────────────────────────────────

    test('首次 regenerate（无 versions）：归档旧 content 为 v0，新内容为 v1，active=1', () {
      final meta = <String, dynamic>{
        'isSummary': false,
      };
      final updated = regenerateMetadata(
        meta,
        '旧内容 hello',
        '新内容 world',
        DateTime.utc(2026, 5, 13, 14, 30),
      );
      final versions = (updated['versions'] as List).cast<Map>();
      expect(versions.length, 2);
      expect(versions[0]['content'], '旧内容 hello');
      expect(versions[1]['content'], '新内容 world');
      expect(updated['activeVersion'], 1);
      // 入参不被原地修改。
      expect(meta.containsKey('versions'), false);
    });

    test('后续 regenerate（已有 versions）：仅追加，不再归档', () {
      final meta = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0 旧', 'created_at': '2024-01-01T00:00:00Z'},
          {'content': 'v1 旧', 'created_at': '2024-01-02T00:00:00Z'},
        ],
        'activeVersion': 1,
      };
      final updated = regenerateMetadata(
        meta,
        '此参数应被忽略',
        '新版本 v2',
        DateTime.utc(2026, 5, 13, 15, 0),
      );
      final versions = (updated['versions'] as List).cast<Map>();
      expect(versions.length, 3);
      expect(versions[0]['content'], 'v0 旧');
      expect(versions[1]['content'], 'v1 旧');
      expect(versions[2]['content'], '新版本 v2');
      expect(updated['activeVersion'], 2);
    });

    test('连续 3 次 regenerate（无 versions 起点）：长度从 0 → 2 → 3 → 4，activeVersion 跟随末项', () {
      Map<String, dynamic> meta = <String, dynamic>{};
      meta = regenerateMetadata(meta, '原文', 'v1', DateTime.utc(2026, 1, 1));
      expect((meta['versions'] as List).length, 2);
      expect(meta['activeVersion'], 1);

      meta = regenerateMetadata(meta, '此值应被忽略', 'v2', DateTime.utc(2026, 1, 2));
      expect((meta['versions'] as List).length, 3);
      expect(meta['activeVersion'], 2);

      meta = regenerateMetadata(meta, '此值应被忽略', 'v3', DateTime.utc(2026, 1, 3));
      final versions = (meta['versions'] as List).cast<Map>();
      expect(versions.length, 4);
      expect(versions[0]['content'], '原文');
      expect(versions[1]['content'], 'v1');
      expect(versions[2]['content'], 'v2');
      expect(versions[3]['content'], 'v3');
      expect(meta['activeVersion'], 3);
    });

    test('空字符串 newContent：仍被追加为合法版本，activeVersion 指向它', () {
      final meta = <String, dynamic>{};
      final updated = regenerateMetadata(meta, '原文', '', DateTime.utc(2026, 1, 1));
      final versions = (updated['versions'] as List).cast<Map>();
      expect(versions.length, 2);
      expect(versions[0]['content'], '原文');
      expect(versions[1]['content'], '');
      expect(updated['activeVersion'], 1);
    });
  });
}
