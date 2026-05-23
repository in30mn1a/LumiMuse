// ignore_for_file: library_private_types_in_public_api

// Feature: flutter-pixel-perfect-parity, Property 14: 图片重生版本归档与稳定 ID
// Validates: Requirements B8.2, C2.4
//
// 设计说明
// ────────
// design.md §Property 14 / requirements.md B8.2 / C2.4 要求：
//   对任意一组「图片版本组」（image group）`g`，触发若干次重生（regenerate）
//   后必须满足：
//     ① 每次重生后 `g.versions.length` 严格 +1（单调不减）；
//     ② 每次重生后 `g.activeVersion` 等于新版本下标（始终指向当前展示项）；
//     ③ 图片的稳定 ID `g.id` 在多轮 regenerate 之后保持不变；
//     ④ 即使中途删除某一版本，剩余版本的拼装顺序保留，`g.id` 也不变。
//
// 这一不变量对应主项目第二十二轮「图片管理批量删除聚合」与「Lightbox 删除按钮」
// 的修复要点：图片卡片的稳定 `image.id` 不会因为删除某个版本或重生新版本
// 而被覆写；只有 `versions[]`、`activeVersion` 在变。
//
// 本测试不依赖 Drift / ImageGenService 真实实现，把契约层落到一个最小纯
// reducer `reduceImageVersions(group, op)` 上：
//   - `RegenerateOp(content)`：把新版本追加到 versions[]，activeVersion
//      指向最新一项，id 不变；
//   - `DeleteVersionOp(versionId)`：从 versions[] 中精确移除该版本（若仅
//      剩 1 项则禁止删除），activeVersion 切换到剩余版本中的最近一项，id 不变。
//
// glados 随机构造长度 ∈ [1, 10] 的操作序列（混合 regenerate 与
// delete-version），对每一步断言：
//   - versions.length 不减；
//   - activeVersion ∈ [0, versions.length)；
//   - id 与初始一致；
//   - regenerate 后 versions.length 严格 +1，activeVersion == 末项下标；
//   - delete 后剩余版本顺序保留，且不含被删 versionId。
//
// 100 次 runs（与 tasks.md §5.14 一致）。失败时 glados 会自动 shrink 到最小反例。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

// ──────────────────────────────────────────────────────────────────────────
// 数据模型：最小占位 ImageVersion / ImageGroup
//
// 与主项目 `metadata.image_versions[].versions[]` 形态对齐：
//   - `ImageGroup.id`：图片卡片的稳定 ID（image.id），跨 regenerate / delete
//      永不改变。
//   - `ImageGroup.versions`：版本数组（按时间从老到新追加）。
//   - `ImageGroup.activeVersion`：当前展示版本的下标（始终在合法范围内）。
//   - `ImageVersion.id`：版本自身的 ID（每次 regenerate 唯一生成）。
//   - `ImageVersion.content`：版本内容占位（这里用任意字符串代表 base64/url）。
// ──────────────────────────────────────────────────────────────────────────

class _ImageVersion {
  final String id;
  final String content;

  const _ImageVersion({required this.id, required this.content});

  @override
  String toString() => '_ImageVersion(id=$id, content=$content)';
}

class _ImageGroup {
  final String id;
  final List<_ImageVersion> versions;
  final int activeVersion;

  const _ImageGroup({
    required this.id,
    required this.versions,
    required this.activeVersion,
  });

  _ImageGroup copyWith({
    List<_ImageVersion>? versions,
    int? activeVersion,
  }) {
    return _ImageGroup(
      id: id,
      versions: versions ?? this.versions,
      activeVersion: activeVersion ?? this.activeVersion,
    );
  }

  @override
  String toString() =>
      '_ImageGroup(id=$id, versions=$versions, activeVersion=$activeVersion)';
}

// ──────────────────────────────────────────────────────────────────────────
// 操作模型
//
// 两种操作：
//   - `_RegenerateOp(newVersionId, content)`：追加新版本；
//   - `_DeleteVersionOp(targetIndex)`：删除当前 versions[targetIndex]
//     （若 versions.length <= 1 则跳过，对应主项目「至少保留一张」语义）。
// ──────────────────────────────────────────────────────────────────────────

abstract class _Op {
  const _Op();
}

class _RegenerateOp extends _Op {
  final String newVersionId;
  final String content;
  const _RegenerateOp({required this.newVersionId, required this.content});

  @override
  String toString() =>
      '_RegenerateOp(id=$newVersionId, content=$content)';
}

class _DeleteVersionOp extends _Op {
  /// 删除时要 target 的下标（在「执行那一刻」的 versions 上取模，保证合法）。
  final int targetIndex;
  const _DeleteVersionOp({required this.targetIndex});

  @override
  String toString() => '_DeleteVersionOp(targetIndex=$targetIndex)';
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数：reduceImageVersions
//
// 落实 design §Property 14 的契约：
//   - regenerate：在 versions[] 末尾追加新版本，activeVersion = 末项下标，
//     id 不变；
//   - deleteVersion：当 versions.length > 1 时，移除目标版本；剩余版本按原
//     顺序拼装（保持稳定）；activeVersion 切换到剩余版本中的「最近一张」
//     —— 若被删项是当前激活项，activeVersion 切到「被删项之前的那一张」
//     （或 0），否则按需调整下标使其继续指向同一个版本对象。
// ──────────────────────────────────────────────────────────────────────────

_ImageGroup reduceImageVersions(_ImageGroup group, _Op op) {
  if (op is _RegenerateOp) {
    final next = List<_ImageVersion>.from(group.versions)
      ..add(_ImageVersion(id: op.newVersionId, content: op.content));
    return group.copyWith(
      versions: next,
      activeVersion: next.length - 1,
    );
  }
  if (op is _DeleteVersionOp) {
    if (group.versions.length <= 1) {
      // 至少保留一张 —— 跳过删除（与主项目「单版本图片不允许删版本」一致）。
      return group;
    }
    final idx = op.targetIndex.abs() % group.versions.length;
    final next = List<_ImageVersion>.from(group.versions)..removeAt(idx);
    int newActive;
    if (idx == group.activeVersion) {
      // 被删的就是当前激活项 —— 切到剩余版本中的「最近一张」。
      newActive = idx > 0 ? idx - 1 : 0;
    } else if (idx < group.activeVersion) {
      // 被删项在当前激活项之前 —— activeVersion 下标 -1，仍指向同一版本。
      newActive = group.activeVersion - 1;
    } else {
      // 被删项在当前激活项之后 —— 下标不变。
      newActive = group.activeVersion;
    }
    return group.copyWith(versions: next, activeVersion: newActive);
  }
  throw StateError('未知操作类型：$op');
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机操作序列
//
// 设计策略：
// - 序列长度 ∈ [1, 10]；
// - 每步以 ~70% 概率为 regenerate（追加新版本，确保 versions 至少够 delete
//   分支被频繁覆盖），30% 概率为 deleteVersion；
// - newVersionId 用「v-步序」确保步内唯一；
// - 用 `seed` 构造确定性 `Random`，保证 glados 失败重放可复现。
// ──────────────────────────────────────────────────────────────────────────

class _Scenario {
  final int seqLen;
  final int seed;
  const _Scenario({required this.seqLen, required this.seed});

  @override
  String toString() => '_Scenario(seqLen=$seqLen, seed=$seed)';
}

extension on Any {
  Generator<_Scenario> get imageVersionScenarios {
    return combine2<int, int, _Scenario>(
      intInRange(1, 11), // 序列长度 [1, 10]
      intInRange(0, 1 << 30), // Random 种子
      (seqLen, seed) => _Scenario(seqLen: seqLen, seed: seed),
    );
  }
}

List<_Op> _buildOpSequence(_Scenario s) {
  final rng = math.Random(s.seed);
  return List<_Op>.generate(s.seqLen, (step) {
    final dice = rng.nextInt(10);
    if (dice < 7) {
      // 70% regenerate
      return _RegenerateOp(
        newVersionId: 'v-$step',
        content: 'content-$step-${rng.nextInt(1 << 16)}',
      );
    }
    return _DeleteVersionOp(targetIndex: rng.nextInt(1 << 16));
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 14: 图片重生版本归档与稳定 ID', () {
    Glados<_Scenario>(
      any.imageVersionScenarios,
      ExploreConfig(numRuns: 100),
    ).test(
      '任意 (regenerate | deleteVersion) 操作序列下：稳定 ID 不变、versions 单调不减（仅 regenerate）、activeVersion 始终合法且指向当前展示项',
      (scenario) {
        // 初始 group：含 1 个版本（与主项目「首次生图」语义对齐）。
        const initialId = 'image-stable-id-001';
        var group = const _ImageGroup(
          id: initialId,
          versions: <_ImageVersion>[
            _ImageVersion(id: 'v-init', content: 'initial-content'),
          ],
          activeVersion: 0,
        );

        final ops = _buildOpSequence(scenario);

        for (var step = 0; step < ops.length; step++) {
          final op = ops[step];
          final before = group;
          final updated = reduceImageVersions(group, op);

          // 不变量 ①：稳定 ID 永远不变。
          expect(
            updated.id,
            initialId,
            reason: 'step=$step op=$op：稳定 ID 必须保持 $initialId，'
                '实际变为 ${updated.id}\n'
                '  before=$before\n  after=$updated',
          );

          // 不变量 ②：activeVersion 始终在合法范围内。
          expect(
            updated.activeVersion,
            greaterThanOrEqualTo(0),
            reason: 'step=$step op=$op：activeVersion 必须 ≥ 0\n'
                '  before=$before\n  after=$updated',
          );
          expect(
            updated.activeVersion,
            lessThan(updated.versions.length),
            reason: 'step=$step op=$op：activeVersion 必须 < versions.length\n'
                '  before=$before\n  after=$updated',
          );

          // 不变量 ③：versions 永远不为空（至少保留一张）。
          expect(
            updated.versions,
            isNotEmpty,
            reason: 'step=$step op=$op：versions 不允许为空\n'
                '  before=$before\n  after=$updated',
          );

          if (op is _RegenerateOp) {
            // regenerate 子条款 1：versions.length 严格 +1（单调不减且严格递增）。
            expect(
              updated.versions.length,
              before.versions.length + 1,
              reason: 'step=$step op=$op：regenerate 后 versions.length '
                  '应严格 +1（${before.versions.length} → '
                  '${updated.versions.length}）',
            );
            // regenerate 子条款 2：activeVersion 指向最新一项（末项下标）。
            expect(
              updated.activeVersion,
              updated.versions.length - 1,
              reason: 'step=$step op=$op：regenerate 后 activeVersion 必须 '
                  '指向末项（应为 ${updated.versions.length - 1}，'
                  '实际 ${updated.activeVersion}）',
            );
            // regenerate 子条款 3：末项即新追加的 ImageVersion。
            expect(
              updated.versions.last.id,
              op.newVersionId,
              reason: 'step=$step op=$op：末项 versionId 应为 '
                  '${op.newVersionId}，实际 ${updated.versions.last.id}',
            );
          } else if (op is _DeleteVersionOp) {
            // delete 子条款：若 before.versions.length <= 1，操作 no-op。
            if (before.versions.length <= 1) {
              expect(
                updated.versions.length,
                before.versions.length,
                reason: 'step=$step op=$op：单版本时 deleteVersion 应为 '
                    'no-op，但 versions.length 从 ${before.versions.length} '
                    '变为 ${updated.versions.length}',
              );
            } else {
              // 否则 versions.length 严格 -1。
              expect(
                updated.versions.length,
                before.versions.length - 1,
                reason: 'step=$step op=$op：deleteVersion 后 versions.length '
                    '应严格 -1（${before.versions.length} → '
                    '${updated.versions.length}）',
              );
              // 剩余版本顺序保留：updated.versions 是 before.versions 删除一个
              // 元素后的子序列。
              final idx = op.targetIndex.abs() % before.versions.length;
              final expectedRemaining =
                  List<_ImageVersion>.from(before.versions)..removeAt(idx);
              expect(
                updated.versions.map((v) => v.id).toList(),
                expectedRemaining.map((v) => v.id).toList(),
                reason: 'step=$step op=$op：deleteVersion 后剩余版本顺序应保留',
              );
              // 剩余版本中不含被删 versionId。
              final removedId = before.versions[idx].id;
              expect(
                updated.versions.any((v) => v.id == removedId),
                isFalse,
                reason: 'step=$step op=$op：deleteVersion 后不应残留 '
                    'versionId=$removedId',
              );
            }
          }

          group = updated;
        }

        // 终态总不变量
        expect(group.id, initialId, reason: '终态稳定 ID 必须不变');
      },
    );
  });
}
