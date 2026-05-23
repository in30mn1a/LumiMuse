// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 19: UI 槽位顺序与基准等价
// Validates: Requirements A3.1.*, A3.2.*, A3.3.*, A3.4.*, A3.5.*, A7.1, A7.3, A7.5, A7.6, C2.2
//
// 设计说明
// ────────
// requirements.md §A3.1 ~ §A3.5 / §A7.* / §C2.2 与 design.md §正确性属性
// Property 19 要求：
//   五个核心页（HomePage / ChatView / CharacterEditPage / MemoryListPage /
//   SettingsPage）以及三个弹层（ExportDialog / ImportDialog / ChatLightbox）
//   的槽位声明必须与基准 JSON
//   `test/fixtures/page_regions_baseline.json` 完全一致：
//     · 每个 PageRegion 的 slots 数组按 order 严格递增、无重复；
//     · 每个 slot 的 (order, anchor, id) 三元组与基准逐字节相等；
//     · 任何对 slots 顺序 / 元素 / 标识的扰动都必须被本属性测试检测出。
//
// 测试策略
// ────────
// 1. 基准加载：直接用 dart:io 的 File 读取
//    `test/fixtures/page_regions_baseline.json`，避免与主 lib/ 代码耦合
//    （Property 19 只关心契约层不变量，不需要导入任何 widget）。
// 2. 验证函数：在测试文件内实现纯函数 `validateRegions(actual, baseline)
//    -> ValidationResult`，逐 region / 逐 slot 比对 (order, anchor, id) 三元组，
//    并断言每个 region 的 order 严格递增、无重复。
// 3. 生成器：
//    · 在「基准 actual」上随机做以下三类突变之一：
//        - swap(i, j)：交换两个 slot 的位置（order 字段保持不变 → 顺序错乱
//          仍能被检测出，因为基准要求 slots 数组顺序按 order 递增）；
//          为了让 swap 真正构成"偏离"，本测试对 swap 后的序列重新检查
//          序列等价性而非仅依赖 order 字段；具体见 _SequenceMutator；
//        - remove(i)：删除某个 slot；
//        - insertDuplicate(i)：插入一个 slot 的复制副本（造成 order 重复）；
//      每次只突变某个 region 的某个 slots 数组，其它 region 保持原样。
//    · 同时提供"零突变"分支（即直接返回基准）以验证 valid 路径返回 ok。
// 4. 断言：
//    · 突变路径：validateRegions 返回 isValid == false，且 errors 列表非空；
//    · 零突变路径：validateRegions 返回 isValid == true，errors 为空。
//
// 不引入主 lib/ 代码：基准 JSON 用 dart:io 直接读取，纯函数 validateRegions
// 在测试文件内实现，与 design §正确性属性 19 的"测试文件自带最小实现"约束一致。
//
// 100 次 runs（与 tasks.md §5.19 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 数据模型：与基准 JSON 中 (order, anchor, id) 三元组对齐
// ──────────────────────────────────────────────────────────────────────────

class _Slot {
  final int order;
  final String anchor;
  final String id;

  const _Slot({required this.order, required this.anchor, required this.id});

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'order': order, 'anchor': anchor, 'id': id};

  @override
  bool operator ==(Object other) =>
      other is _Slot &&
      other.order == order &&
      other.anchor == anchor &&
      other.id == id;

  @override
  int get hashCode => Object.hash(order, anchor, id);

  @override
  String toString() => '_Slot(order=$order, anchor=$anchor, id=$id)';
}

class _Region {
  final String name;
  final List<_Slot> slots;

  const _Region({required this.name, required this.slots});

  @override
  String toString() => '_Region(name=$name, slots=$slots)';
}

/// 单个页面 / 弹层的所有 region 集合（外层 key 为页面名，例如 "HomePage"）。
typedef _PageRegions = Map<String, List<_Region>>;

// ──────────────────────────────────────────────────────────────────────────
// 验证结果
// ──────────────────────────────────────────────────────────────────────────

class ValidationResult {
  final bool isValid;
  final List<String> errors;

  const ValidationResult({required this.isValid, required this.errors});

  @override
  String toString() =>
      'ValidationResult(isValid=$isValid, errors=$errors)';
}

// ──────────────────────────────────────────────────────────────────────────
// 验证函数：validateRegions(actual, baseline)
//
// 检查项：
//   1. 顶层 page 集合相同（key 集合一致）；
//   2. 每个 page 的 region 列表数量、name 顺序与基准一致；
//   3. 每个 region 的 slots 数组：长度相同、每个 slot 的 (order, anchor, id)
//      三元组逐字节等于基准；
//   4. 每个 region 的 slots 按 order 严格递增、无重复 order。
//
// 任何一处偏离都会向 errors 添加一条说明，并把 isValid 翻成 false。
// ──────────────────────────────────────────────────────────────────────────

ValidationResult validateRegions(
  _PageRegions actual,
  _PageRegions baseline,
) {
  final errors = <String>[];

  // 1. 顶层 page 集合相同
  final actualPages = actual.keys.toSet();
  final baselinePages = baseline.keys.toSet();
  final missingInActual = baselinePages.difference(actualPages);
  final extraInActual = actualPages.difference(baselinePages);
  if (missingInActual.isNotEmpty) {
    errors.add('缺少 page：${missingInActual.toList()..sort()}');
  }
  if (extraInActual.isNotEmpty) {
    errors.add('多出 page：${extraInActual.toList()..sort()}');
  }

  // 2 / 3 / 4：逐 page / 逐 region 对比
  for (final pageName in baselinePages) {
    final actualRegions = actual[pageName];
    final baselineRegions = baseline[pageName]!;
    if (actualRegions == null) {
      // 已在 missingInActual 中报告过，跳过细节
      continue;
    }
    if (actualRegions.length != baselineRegions.length) {
      errors.add(
        'page=$pageName 的 region 数量不一致：'
        'actual=${actualRegions.length}, baseline=${baselineRegions.length}',
      );
    }
    final commonLen = math.min(actualRegions.length, baselineRegions.length);
    for (var ri = 0; ri < commonLen; ri++) {
      final aRegion = actualRegions[ri];
      final bRegion = baselineRegions[ri];

      if (aRegion.name != bRegion.name) {
        errors.add(
          'page=$pageName 第 $ri 个 region 名称不一致：'
          'actual=${aRegion.name}, baseline=${bRegion.name}',
        );
      }

      // 4. order 严格递增、无重复
      for (var i = 1; i < aRegion.slots.length; i++) {
        final prev = aRegion.slots[i - 1].order;
        final curr = aRegion.slots[i].order;
        if (curr <= prev) {
          errors.add(
            'page=$pageName region=${aRegion.name} 第 $i 个 slot 的 order '
            '$curr 未严格大于前一个 $prev（违反严格递增）',
          );
        }
      }
      final orderSet = <int>{};
      for (final s in aRegion.slots) {
        if (!orderSet.add(s.order)) {
          errors.add(
            'page=$pageName region=${aRegion.name} 出现重复 order=${s.order}',
          );
        }
      }

      // 3. slots 长度相同
      if (aRegion.slots.length != bRegion.slots.length) {
        errors.add(
          'page=$pageName region=${aRegion.name} 的 slots 数量不一致：'
          'actual=${aRegion.slots.length}, baseline=${bRegion.slots.length}',
        );
      }
      final slotLen = math.min(aRegion.slots.length, bRegion.slots.length);
      for (var si = 0; si < slotLen; si++) {
        final aSlot = aRegion.slots[si];
        final bSlot = bRegion.slots[si];
        if (aSlot != bSlot) {
          errors.add(
            'page=$pageName region=${aRegion.name} 第 $si 个 slot 不一致：'
            'actual=$aSlot, baseline=$bSlot',
          );
        }
      }
    }
  }

  return ValidationResult(isValid: errors.isEmpty, errors: errors);
}

// ──────────────────────────────────────────────────────────────────────────
// 基准加载
// ──────────────────────────────────────────────────────────────────────────

_PageRegions _loadBaseline() {
  final raw = File('test/fixtures/page_regions_baseline.json')
      .readAsStringSync();
  final decoded = jsonDecode(raw) as Map<String, dynamic>;
  final result = <String, List<_Region>>{};
  for (final entry in decoded.entries) {
    if (entry.key.startsWith('_')) continue; // 跳过 _comment 等元字段
    final regionsJson = entry.value as List<dynamic>;
    final regions = regionsJson.map((rj) {
      final r = rj as Map<String, dynamic>;
      final slotsJson = r['slots'] as List<dynamic>;
      final slots = slotsJson
          .map((sj) {
            final s = sj as Map<String, dynamic>;
            return _Slot(
              order: s['order'] as int,
              anchor: s['anchor'] as String,
              id: s['id'] as String,
            );
          })
          .toList();
      return _Region(name: r['name'] as String, slots: slots);
    }).toList();
    result[entry.key] = regions;
  }
  return result;
}

/// 深拷贝基准（每次突变前都从基准复制一份，避免突变互相污染）。
_PageRegions _deepCopy(_PageRegions src) {
  return src.map((page, regions) {
    return MapEntry(
      page,
      regions
          .map(
            (r) => _Region(
              name: r.name,
              slots: r.slots
                  .map((s) =>
                      _Slot(order: s.order, anchor: s.anchor, id: s.id))
                  .toList(),
            ),
          )
          .toList(),
    );
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 突变描述：在哪个 page / 哪个 region 上做哪种操作
// ──────────────────────────────────────────────────────────────────────────

enum _MutationKind { none, swap, remove, insertDuplicate }

class _Mutation {
  final _MutationKind kind;
  final int seed;
  const _Mutation(this.kind, this.seed);

  @override
  String toString() => '_Mutation(kind=$kind, seed=$seed)';
}

/// 在基准上施加一次突变；如果 kind == none 直接返回深拷贝。
///
/// 注：突变只挑选「slots.length 足够」的 region 进行操作；若随机选到的
/// region 无法承载该突变（例如 swap 至少需要 2 个 slot），则退化为 none。
_PageRegions _applyMutation(_PageRegions baseline, _Mutation m) {
  final copy = _deepCopy(baseline);
  if (m.kind == _MutationKind.none) {
    return copy;
  }
  final rng = math.Random(m.seed);
  // 把所有 (page, regionIndex) 收集成扁平列表，然后随机挑一个。
  final allTargets = <List<dynamic>>[];
  for (final page in copy.keys) {
    final regions = copy[page]!;
    for (var i = 0; i < regions.length; i++) {
      allTargets.add(<dynamic>[page, i]);
    }
  }
  if (allTargets.isEmpty) return copy;

  // 选满足条件的 region；若全不满足则退化为 none（返回深拷贝）。
  final shuffled = List<List<dynamic>>.from(allTargets)..shuffle(rng);
  for (final tgt in shuffled) {
    final page = tgt[0] as String;
    final ri = tgt[1] as int;
    final region = copy[page]![ri];
    final slots = region.slots;
    switch (m.kind) {
      case _MutationKind.swap:
        if (slots.length >= 2) {
          final i = rng.nextInt(slots.length);
          var j = rng.nextInt(slots.length);
          if (j == i) j = (j + 1) % slots.length;
          final tmp = slots[i];
          slots[i] = slots[j];
          slots[j] = tmp;
          return copy;
        }
        break;
      case _MutationKind.remove:
        if (slots.isNotEmpty) {
          slots.removeAt(rng.nextInt(slots.length));
          return copy;
        }
        break;
      case _MutationKind.insertDuplicate:
        if (slots.isNotEmpty) {
          final i = rng.nextInt(slots.length);
          // 复制一份并插入到 i 之后；order 重复将被验证函数捕捉。
          final dup = _Slot(
            order: slots[i].order,
            anchor: slots[i].anchor,
            id: slots[i].id,
          );
          slots.insert(i + 1, dup);
          return copy;
        }
        break;
      case _MutationKind.none:
        return copy;
    }
  }
  return copy;
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机突变 + 偶尔的零突变
// ──────────────────────────────────────────────────────────────────────────

extension on Any {
  Generator<_Mutation> get baselineMutation {
    return combine2<int, int, _Mutation>(
      intInRange(0, 4), // 0=none, 1=swap, 2=remove, 3=insertDuplicate
      intInRange(0, 1 << 30),
      (kindIdx, seed) {
        final kind = switch (kindIdx) {
          1 => _MutationKind.swap,
          2 => _MutationKind.remove,
          3 => _MutationKind.insertDuplicate,
          _ => _MutationKind.none,
        };
        return _Mutation(kind, seed);
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 19: UI 槽位顺序与基准等价', () {
    final baseline = _loadBaseline();

    // 健壮性：基准本身必须 valid。
    test('基准 JSON 自身满足 validateRegions（健壮性自检）', () {
      final result = validateRegions(_deepCopy(baseline), baseline);
      expect(
        result.isValid,
        isTrue,
        reason:
            '基准 JSON 自身应该 valid，但 errors=${result.errors}。'
            '请检查 test/fixtures/page_regions_baseline.json 是否存在重复 order 或乱序。',
      );
    });

    Glados<_Mutation>(
      any.baselineMutation,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 swap/remove/insertDuplicate 突变都会被 validateRegions 检测出；零突变时通过',
      (mutation) {
        final mutated = _applyMutation(baseline, mutation);
        final result = validateRegions(mutated, baseline);

        if (mutation.kind == _MutationKind.none) {
          // 零突变：必须返回 ok。
          expect(
            result.isValid,
            isTrue,
            reason:
                '零突变路径下 validateRegions 必须返回 valid，'
                '但实际 errors=${result.errors}',
          );
          expect(
            result.errors,
            isEmpty,
            reason:
                '零突变路径下 errors 必须为空，但实际=${result.errors}',
          );
          return;
        }

        // 突变路径：应返回 invalid。
        // 注意：swap 在某些极端情况下（例如所有 region 都只有 1 个 slot）会
        // 退化为深拷贝；此时 validateRegions 仍然 valid 是合理的。我们用
        // _wasActuallyMutated 判断是否真的发生了突变。
        final actuallyMutated = !_isEquivalent(mutated, baseline);
        if (!actuallyMutated) {
          // 突变退化为零突变 → valid 是可接受的。
          expect(
            result.isValid,
            isTrue,
            reason:
                '突变退化（target region 无法承载该突变）后，'
                'validateRegions 应仍 valid，'
                '但实际 errors=${result.errors}（mutation=$mutation）',
          );
        } else {
          expect(
            result.isValid,
            isFalse,
            reason:
                '违反 Property 19：'
                '突变 $mutation 已偏离基准，但 validateRegions 仍判为 valid。\n'
                '突变后 = $mutated\n'
                '基准   = $baseline',
          );
          expect(
            result.errors,
            isNotEmpty,
            reason:
                '违反 Property 19：突变 $mutation 后 errors 必须非空，'
                '但实际为空。',
          );
        }
      },
    );
  });
}

/// 判断两个 _PageRegions 是否完全等价（page / region / slot 三元组逐字节相等）。
bool _isEquivalent(_PageRegions a, _PageRegions b) {
  if (a.length != b.length) return false;
  for (final page in a.keys) {
    if (!b.containsKey(page)) return false;
    final ar = a[page]!;
    final br = b[page]!;
    if (ar.length != br.length) return false;
    for (var i = 0; i < ar.length; i++) {
      if (ar[i].name != br[i].name) return false;
      if (ar[i].slots.length != br[i].slots.length) return false;
      for (var j = 0; j < ar[i].slots.length; j++) {
        if (ar[i].slots[j] != br[i].slots[j]) return false;
      }
    }
  }
  return true;
}
