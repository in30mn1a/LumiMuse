// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 16: 搜索分页正确性
// Validates: Requirements B9.3
//
// 设计说明
// ────────
// design.md §Property 16 / requirements.md B9.3 要求：
//   对任意结果集大小 `N` 与页码 `i ≥ 0`，
//     SearchService.search(offset = i * pageSize, limit = pageSize)
//   返回的结果数 == min(pageSize, max(0, N - offset))，且
//     hasMore == (offset + pageSize < N)。
//
// 主项目第二十三轮已落实「分页 + 加载更多」语义（每页多取 1 条判断 hasMore），
// 这里把该契约抽到一个最小纯函数 `paginate(items, pageSize, offset)` 上，
// 用 glados 随机构造消息列表 + 分页参数序列，验证四条不变量：
//
//   ① 全部页拼接 == 一次性全量结果（顺序与内容不变）；
//   ② hasMore 当且仅当还有未取页（offset + pageSize < items.length）；
//   ③ 同一 offset 多次请求返回相同切片（幂等）；
//   ④ offset 超出总数返回空切片，hasMore == false。
//
// 100 次 runs（与 tasks.md §5.16 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 数据模型：消息列表分页结果
//
// 用最小占位 `_Message` 模拟搜索结果（仅保留稳定 ID 与 createdAt）。
// `_PageResult` 封装一次分页查询的返回。
// ──────────────────────────────────────────────────────────────────────────

class _Message {
  final String id;
  final int createdAt; // 只用作排序键
  const _Message({required this.id, required this.createdAt});

  @override
  String toString() => '_Message(id=$id, createdAt=$createdAt)';
}

class _PageResult {
  final List<_Message> results;
  final bool hasMore;
  const _PageResult({required this.results, required this.hasMore});

  @override
  String toString() =>
      '_PageResult(results=${results.length}, hasMore=$hasMore)';
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：paginate
//
// 落实 design §Property 16 与 requirements §B9.3 的契约：
//   - 返回 items[offset .. offset + pageSize)（越界部分截断）；
//   - hasMore 当且仅当后面还有未取项（offset + 切片实际长度 < items.length）。
//
// 注意边界：
//   - offset < 0 视为 0；
//   - pageSize <= 0 视为返回空切片，hasMore = (offset < items.length)；
//   - offset >= items.length 时返回空切片，hasMore = false。
// ──────────────────────────────────────────────────────────────────────────

_PageResult paginate(List<_Message> items, int pageSize, int offset) {
  if (pageSize <= 0) {
    return _PageResult(
      results: const <_Message>[],
      hasMore: offset < items.length,
    );
  }
  final from = offset < 0 ? 0 : offset;
  if (from >= items.length) {
    return const _PageResult(results: <_Message>[], hasMore: false);
  }
  final to = math.min(from + pageSize, items.length);
  final slice = items.sublist(from, to);
  return _PageResult(results: slice, hasMore: to < items.length);
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机消息列表 + 分页参数序列
//
// 设计策略：
// - itemCount ∈ [0, 60]：覆盖空、单条、整页、跨多页；
// - 分页参数序列长度 ∈ [1, 8]，每步独立随机 pageSize ∈ [1, 30] 与 offset
//   ∈ [0, itemCount + 5]（故意制造越界）；
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

class _Scenario {
  final int itemCount;
  final int paramSeed;
  final int paramSeqLen;

  const _Scenario({
    required this.itemCount,
    required this.paramSeed,
    required this.paramSeqLen,
  });

  @override
  String toString() => '_Scenario('
      'itemCount=$itemCount, paramSeqLen=$paramSeqLen, seed=$paramSeed)';
}

extension on Any {
  Generator<_Scenario> get paginationScenarios {
    return combine3<int, int, int, _Scenario>(
      intInRange(0, 61), // itemCount [0, 60]
      intInRange(0, 1 << 30), // 参数序列种子
      intInRange(1, 9), // 序列长度 [1, 8]
      (n, seed, len) => _Scenario(
        itemCount: n,
        paramSeed: seed,
        paramSeqLen: len,
      ),
    );
  }
}

List<_Message> _buildItems(int n) {
  return List<_Message>.generate(
    n,
    (i) => _Message(id: 'msg-$i', createdAt: 1_000_000 - i),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 16: 搜索分页正确性', () {
    Glados<_Scenario>(
      any.paginationScenarios,
      ExploreConfig(numRuns: 100),
    ).test(
      '随机消息列表与随机 pageSize/offset 序列：全量拼接相等、hasMore 充要、幂等、越界返回空',
      (s) {
        final items = _buildItems(s.itemCount);
        final n = items.length;
        final rng = math.Random(s.paramSeed);

        // ── 不变量 ④：offset 超出总数返回空切片，hasMore == false ──
        // 用一个明确越界的 offset（n + 1）抽样验证。
        {
          final pageSize = 1 + rng.nextInt(30);
          final overflowOffset = n + 1 + rng.nextInt(10);
          final r = paginate(items, pageSize, overflowOffset);
          expect(
            r.results,
            isEmpty,
            reason: 'offset=$overflowOffset 已超出总数 $n，应返回空切片',
          );
          expect(
            r.hasMore,
            isFalse,
            reason: 'offset=$overflowOffset 已超出总数 $n，hasMore 必为 false',
          );
        }

        // ── 不变量 ③：同一 (pageSize, offset) 多次请求返回相同切片（幂等） ──
        {
          final pageSize = 1 + rng.nextInt(15);
          final offset = rng.nextInt(n + 5);
          final r1 = paginate(items, pageSize, offset);
          final r2 = paginate(items, pageSize, offset);
          expect(
            r1.results.map((m) => m.id).toList(),
            r2.results.map((m) => m.id).toList(),
            reason: '同一 (pageSize=$pageSize, offset=$offset) 多次请求结果不一致',
          );
          expect(
            r1.hasMore,
            r2.hasMore,
            reason: '同一 (pageSize=$pageSize, offset=$offset) 多次请求 hasMore 不一致',
          );
        }

        // ── 不变量 ②：hasMore ⟺ offset + 切片长度 < N（充要） ──
        // 对参数序列每一步独立断言。
        for (var step = 0; step < s.paramSeqLen; step++) {
          final pageSize = 1 + rng.nextInt(30);
          final offset = rng.nextInt(n + 5);
          final r = paginate(items, pageSize, offset);

          final expectedLen = math.min(pageSize, math.max(0, n - offset));
          expect(
            r.results.length,
            expectedLen,
            reason: 'step=$step pageSize=$pageSize offset=$offset：'
                '切片长度应为 $expectedLen，实际 ${r.results.length}',
          );

          final expectedHasMore = (offset + expectedLen) < n;
          expect(
            r.hasMore,
            expectedHasMore,
            reason: 'step=$step pageSize=$pageSize offset=$offset：'
                'hasMore 应为 $expectedHasMore，实际 ${r.hasMore}',
          );

          // 切片元素必须严格匹配 items[offset .. offset + len)。
          for (var i = 0; i < r.results.length; i++) {
            expect(
              r.results[i].id,
              items[offset + i].id,
              reason: 'step=$step：切片第 $i 项应为 items[${offset + i}]，'
                  '实际 ${r.results[i].id}',
            );
          }
        }

        // ── 不变量 ①：用同一 pageSize 顺序取所有页拼接 == 全量 items ──
        {
          final pageSize = 1 + rng.nextInt(15);
          final concat = <_Message>[];
          var offset = 0;
          var safetyGuard = 0;
          while (true) {
            safetyGuard++;
            // 防御性兜底：理论上至多 ceil(n / pageSize) + 1 步必终止。
            expect(
              safetyGuard < 10000,
              isTrue,
              reason: '分页拼接出现死循环：n=$n pageSize=$pageSize',
            );
            final r = paginate(items, pageSize, offset);
            concat.addAll(r.results);
            if (!r.hasMore) break;
            offset += pageSize;
          }
          expect(
            concat.map((m) => m.id).toList(),
            items.map((m) => m.id).toList(),
            reason: 'pageSize=$pageSize 全量拼接结果与一次性全量不一致',
          );
        }
      },
    );

    // ──────────────────────────────────────────────
    // 例测：固化关键边界
    // ──────────────────────────────────────────────

    test('空列表：任何 offset 都返回空切片，hasMore=false', () {
      final r = paginate(<_Message>[], 30, 0);
      expect(r.results, isEmpty);
      expect(r.hasMore, isFalse);
    });

    test('恰好一页：N == pageSize，offset=0 时 hasMore=false', () {
      final items = _buildItems(30);
      final r = paginate(items, 30, 0);
      expect(r.results.length, 30);
      expect(r.hasMore, isFalse);
    });

    test('两页边界：N=31 / pageSize=30：第 0 页 hasMore=true，第 1 页 hasMore=false', () {
      final items = _buildItems(31);
      final r0 = paginate(items, 30, 0);
      final r1 = paginate(items, 30, 30);
      expect(r0.results.length, 30);
      expect(r0.hasMore, isTrue);
      expect(r1.results.length, 1);
      expect(r1.hasMore, isFalse);
    });

    test('offset 超出总数：返回空切片，hasMore=false', () {
      final items = _buildItems(5);
      final r = paginate(items, 30, 100);
      expect(r.results, isEmpty);
      expect(r.hasMore, isFalse);
    });
  });
}
