// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 17: 日期搜索五种格式等价
// Validates: Requirements B9.2
//
// 设计说明
// ────────
// design.md §Property 17 / requirements.md B9.2 要求：
//   对任意合法三元组 `(y, m, d)`，下列五种字符串作为搜索 query 时解析得到
//   的日期区间 [startOfDay, endOfDay) 完全相同：
//     1) "y-MM-dd"   （如 2026-04-01）
//     2) "y/M/d"     （如 2026/4/1）
//     3) "y.M.d"     （如 2026.4.1）
//     4) "y年M月d日" （如 2026年4月1日）
//     5) "y年M月d"   （如 2026年4月1）
//
// 这一不变量对应主项目第二十三轮「中文日期搜索兼容」修复，五种写法行为等价。
//
// 实现策略
// ────────
// 在测试文件内定义最小纯函数 `parseSearchDate(String): DateTimeRange?`：
//   - 命中任一格式 → 返回 [startOfDay, endOfDay) 区间；
//   - 不命中 → 返回 null（用于负向断言：非日期字符串不会被误解析）。
//
// 中文「年月日」直接用字符串字面量写出，不允许 \uXXXX 转义（与 AGENTS.md
// 「编码防护」一致）。
//
// 100 次 runs（与 tasks.md §5.17 一致）。

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// `DateTimeRange` 占位（避免引入 Flutter 的 widgets/Material 依赖）
// ──────────────────────────────────────────────────────────────────────────

class _DateRange {
  final DateTime start; // 含
  final DateTime end; // 不含（exclusive）

  const _DateRange({required this.start, required this.end});

  @override
  bool operator ==(Object other) =>
      other is _DateRange && other.start == start && other.end == end;

  @override
  int get hashCode => Object.hash(start, end);

  @override
  String toString() => '_DateRange(start=$start, end=$end)';
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：parseSearchDate
//
// 落实主项目第二十三轮的「五种日期格式等价」契约：
//   - 五种字符串都解析为同一个 [startOfDay, endOfDay) 区间；
//   - 不命中任一格式 → 返回 null；
//   - 不允许把含有「年月日」字面量的中文字符串部分误解析（必须严格匹配
//     完整格式）。
//
// 注：本测试不引入 RegExp 中文 Unicode 转义，直接用 `年` `月` `日` 字面量。
// ──────────────────────────────────────────────────────────────────────────

_DateRange? parseSearchDate(String input) {
  final s = input.trim();
  if (s.isEmpty) return null;

  // 五种格式各自的最小正则（按 design §Property 17 顺序排列）：
  //   1) y-MM-dd   严格 4-2-2 数字（与主项目 ISO 形态一致）；
  //   2) y/M/d     允许 1~2 位月与日；
  //   3) y.M.d     允许 1~2 位月与日；
  //   4) y年M月d日 中文「日」结尾；
  //   5) y年M月d   中文「月」与数字结尾，无「日」字面量。
  final patterns = <RegExp>[
    RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})$'),
    RegExp(r'^(\d{4})/(\d{1,2})/(\d{1,2})$'),
    RegExp(r'^(\d{4})\.(\d{1,2})\.(\d{1,2})$'),
    RegExp(r'^(\d{4})年(\d{1,2})月(\d{1,2})日$'),
    RegExp(r'^(\d{4})年(\d{1,2})月(\d{1,2})$'),
  ];

  for (final re in patterns) {
    final m = re.firstMatch(s);
    if (m == null) continue;
    final y = int.parse(m.group(1)!);
    final mo = int.parse(m.group(2)!);
    final d = int.parse(m.group(3)!);
    if (!_isValidYmd(y, mo, d)) return null;
    final start = DateTime(y, mo, d);
    final end = DateTime(y, mo, d + 1); // DateTime 自动处理跨月
    return _DateRange(start: start, end: end);
  }
  return null;
}

bool _isValidYmd(int y, int m, int d) {
  if (y < 1 || y > 9999) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1) return false;
  // 用 DateTime 自身的「合法性回弹」判定：构造后比较各字段是否被自动归一化。
  final t = DateTime(y, m, d);
  return t.year == y && t.month == m && t.day == d;
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：合法三元组 (y, m, d)
//
// 设计策略：
// - y ∈ [1970, 2100]：覆盖近代到将来日期；
// - m ∈ [1, 12]；
// - d ∈ [1, 28]：取所有月份都合法的 28 天上界，避免 2 月 30 日等非法日期；
// - 用 `seed` 派生确定性三元组，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

class _Ymd {
  final int y;
  final int m;
  final int d;
  const _Ymd({required this.y, required this.m, required this.d});

  @override
  String toString() => '_Ymd($y-$m-$d)';
}

extension on Any {
  Generator<_Ymd> get validYmd {
    return combine3<int, int, int, _Ymd>(
      intInRange(1970, 2101), // y
      intInRange(1, 13), // m
      intInRange(1, 29), // d ∈ [1, 28]
      (y, m, d) => _Ymd(y: y, m: m, d: d),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 工具：把 (y, m, d) 渲染成五种字符串
//
// 注意：这里直接写中文「年」「月」「日」字面量，不允许 \u 转义。
// ──────────────────────────────────────────────────────────────────────────

String _formatDash(_Ymd v) =>
    '${v.y.toString().padLeft(4, '0')}-${v.m.toString().padLeft(2, '0')}-${v.d.toString().padLeft(2, '0')}';
String _formatSlash(_Ymd v) => '${v.y}/${v.m}/${v.d}';
String _formatDot(_Ymd v) => '${v.y}.${v.m}.${v.d}';
String _formatChineseFull(_Ymd v) => '${v.y}年${v.m}月${v.d}日';
String _formatChineseShort(_Ymd v) => '${v.y}年${v.m}月${v.d}';

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 17: 日期搜索五种格式等价', () {
    Glados<_Ymd>(
      any.validYmd,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意合法 (y, m, d)：五种字符串 parseSearchDate 得到的 [startOfDay, endOfDay) 完全相同',
      (v) {
        final s1 = _formatDash(v);
        final s2 = _formatSlash(v);
        final s3 = _formatDot(v);
        final s4 = _formatChineseFull(v);
        final s5 = _formatChineseShort(v);

        final r1 = parseSearchDate(s1);
        final r2 = parseSearchDate(s2);
        final r3 = parseSearchDate(s3);
        final r4 = parseSearchDate(s4);
        final r5 = parseSearchDate(s5);

        // ① 五种格式都必须成功解析（none of them is null）。
        expect(r1, isNotNull,
            reason: '"$s1" 应解析为合法日期区间，但返回 null');
        expect(r2, isNotNull,
            reason: '"$s2" 应解析为合法日期区间，但返回 null');
        expect(r3, isNotNull,
            reason: '"$s3" 应解析为合法日期区间，但返回 null');
        expect(r4, isNotNull,
            reason: '"$s4" 应解析为合法日期区间，但返回 null');
        expect(r5, isNotNull,
            reason: '"$s5" 应解析为合法日期区间，但返回 null');

        // ② 五种格式得到的 [startOfDay, endOfDay) 区间完全相同。
        expect(r2, r1,
            reason: '"$s2" 与 "$s1" 应等价，实际不同：$r2 vs $r1');
        expect(r3, r1,
            reason: '"$s3" 与 "$s1" 应等价，实际不同：$r3 vs $r1');
        expect(r4, r1,
            reason: '"$s4" 与 "$s1" 应等价，实际不同：$r4 vs $r1');
        expect(r5, r1,
            reason: '"$s5" 与 "$s1" 应等价，实际不同：$r5 vs $r1');

        // ③ 区间正确性：start = (y, m, d, 00:00:00.000)；
        //              end   = start + 1 天。
        expect(r1!.start, DateTime(v.y, v.m, v.d),
            reason: 'start 应为当日零点');
        expect(
          r1.end.difference(r1.start),
          const Duration(days: 1),
          reason: '[startOfDay, endOfDay) 区间长度应为 1 天',
        );
      },
    );

    // ──────────────────────────────────────────────
    // 例测：固化关键边界（与 design §Property 17 示例一致）
    // ──────────────────────────────────────────────

    test('2026 年 4 月 1 日五种格式：解析结果完全相同', () {
      final inputs = <String>[
        '2026-04-01',
        '2026/4/1',
        '2026.4.1',
        '2026年4月1日',
        '2026年4月1',
      ];
      final results = inputs.map(parseSearchDate).toList();
      final expected = _DateRange(
        start: DateTime(2026, 4, 1),
        end: DateTime(2026, 4, 2),
      );
      for (final r in results) {
        expect(r, expected, reason: '应解析为 $expected');
      }
    });

    test('非日期字符串：返回 null', () {
      expect(parseSearchDate(''), isNull);
      expect(parseSearchDate('abc'), isNull);
      expect(parseSearchDate('hello world'), isNull);
      expect(parseSearchDate('2026年4月'), isNull);
      expect(parseSearchDate('2026-13-01'), isNull, reason: '非法月份');
      expect(parseSearchDate('2026-02-30'), isNull, reason: '非法日 (2 月 30)');
    });

    test('跨月 / 跨年边界：end 自动滚到下一天', () {
      // 1 月 31 → 2 月 1
      final r = parseSearchDate('2026-01-31');
      expect(r!.end, DateTime(2026, 2, 1));
      // 12 月 31 → 1 月 1（次年）
      final r2 = parseSearchDate('2026-12-31');
      expect(r2!.end, DateTime(2027, 1, 1));
    });

    test('y/M/d 与 y.M.d 接受 1 位月与日', () {
      final r1 = parseSearchDate('2026/4/1');
      final r2 = parseSearchDate('2026.4.1');
      expect(r1!.start, DateTime(2026, 4, 1));
      expect(r2!.start, DateTime(2026, 4, 1));
    });
  });
}
