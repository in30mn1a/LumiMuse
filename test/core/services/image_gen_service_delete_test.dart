// Feature: flutter-platform-polish, Property 1, 2, 3
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.5**
//
// 对 `ImageGenService.deleteImage` 的三条核心属性做属性测试：
// - Property 1: 非本地资产短路 — null / 空 / 全空白 / http(s):// / data: 路径
//   不触发底层 `scanAndDeleteOrphanFiles`。
// - Property 2: 本地资产精确委托 — `isLocalAssetPath(p) == true` 时恰好委托
//   一次，入参等于单元素集合 `{p}`。
// - Property 3: 异常吞噬 — 底层抛任意异常时 `deleteImage` 仍正常 complete。
//
// 设计原则：
// - 用 `class _SpyImagesActions extends Fake implements CharacterImagesActions`
//   做替身，避免 Drift 数据库依赖；`Fake` 来自 `package:flutter_test/flutter_test.dart`，
//   未实现的成员命中 `noSuchMethod` 抛 `UnimplementedError`，恰好暴露任何
//   非 `scanAndDeleteOrphanFiles` 的误调用。
// - 默认 100 次迭代（glados `ExploreConfig` 默认值），与同目录已有 PBT 一致。

import 'dart:io' show FileSystemException;
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart'
    hide expect, group, test, setUp, tearDown, expectLater;
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';
import 'package:lumimuse/core/utils/local_asset_utils.dart';

// ──────────────────────────────────────────────────────────────────────────
// Spy：仅实现 `scanAndDeleteOrphanFiles`，记录调用次数与入参；可注入异常。
//
// 用 `Fake implements CharacterImagesActions`：
// - `Fake` 提供 `noSuchMethod` 兜底，未覆写的成员命中即抛 `UnimplementedError`，
//   保证测试只允许 `deleteImage` 委托到 `scanAndDeleteOrphanFiles` 这一条路径。
// - `implements` 而非 `extends`：免去构造 `AppDatabase` 的代价。
// ──────────────────────────────────────────────────────────────────────────

class _SpyImagesActions extends Fake implements CharacterImagesActions {
  int callCount = 0;
  final List<Set<String>> recordedArgs = <Set<String>>[];

  /// 注入异常：非 null 时 `scanAndDeleteOrphanFiles` 在记录调用后抛出。
  Object? throwError;

  @override
  Future<void> scanAndDeleteOrphanFiles(Set<String> deletedPaths) async {
    callCount++;
    recordedArgs.add(deletedPaths);
    if (throwError != null) {
      throw throwError!;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 输入候选集（非本地资产 / 本地资产）
// ──────────────────────────────────────────────────────────────────────────

/// 非本地资产候选模板：使用 `seed` 派生稳定后缀，覆盖 design.md 列出的所有
/// 「短路」分支：空串、全空白、http(s)://（含大小写变体）、data:。
List<String> _nonLocalCandidates(int seed) {
  final rng = math.Random(seed);
  final tail = rng.nextInt(1 << 20);
  // 用 `\t\n` / 全角空格等组合制造「全空白」字符串
  final whitespaceVariants = <String>['', ' ', '   ', '\t', '\n', ' \t \n '];
  return <String>[
    whitespaceVariants[rng.nextInt(whitespaceVariants.length)],
    'http://example.com/$tail.png',
    'https://cdn.example.com/path/$tail/img.png',
    'HTTP://CAPS.example.com/$tail',
    'HtTpS://Mixed.example.com/$tail',
    'data:image/png;base64,iVBOR$tail',
    'DATA:image/jpeg;base64,/9j/$tail',
  ];
}

/// 本地资产候选模板：构造一组 `isLocalAssetPath(p) == true` 的字符串。
///
/// 选用「Unix 绝对路径 / Windows 绝对路径 / 相对路径 / 含中文文件名」覆盖典型
/// 形态；测试在使用前再次调用 `isLocalAssetPath` 兜底校验，避免任何路径不慎
/// 落入「非本地资产」分支后产生伪通过。
List<String> _localCandidates(int seed) {
  final rng = math.Random(seed);
  final tail = rng.nextInt(1 << 20);
  return <String>[
    '/some/local/path/$tail.png',
    '/usr/local/lumimuse/generated/$tail.jpg',
    'C:\\Users\\Test\\Documents\\LumiMuse\\generated\\$tail.png',
    'D:/photos/$tail.webp',
    'relative/path/$tail.png',
    './generated/$tail.png',
    '/var/folders/x/y/$tail-生图.png',
  ];
}

void main() {
  late ImageGenService service;

  setUp(() {
    service = ImageGenService();
  });

  tearDown(() {
    service.dispose();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Property 1: 非本地资产短路（Validates: Requirements 1.1, 1.5）
  // ──────────────────────────────────────────────────────────────────────

  group('Property 1: 非本地资产短路（1.1, 1.5）', () {
    Glados<int>(any.intInRange(0, 1 << 20)).test(
      '空白 / http(s):// / data: 输入下 scanAndDeleteOrphanFiles 调用次数为 0',
      (seed) async {
        final rng = math.Random(seed);
        final candidates = _nonLocalCandidates(seed);
        final input = candidates[rng.nextInt(candidates.length)];

        // 兜底前置条件：所选输入必须是 design.md 定义的「非本地资产」
        // （否则用例本身写错，会以伪通过掩盖回归）
        expect(
          isLocalAssetPath(input),
          isFalse,
          reason: '输入「$input」应被视为非本地资产，否则该 case 不应进入 Property 1',
        );

        final spy = _SpyImagesActions();
        await service.deleteImage(input, imagesActions: spy);

        expect(
          spy.callCount,
          0,
          reason: '非本地资产输入「$input」不应触发 scanAndDeleteOrphanFiles',
        );
        expect(spy.recordedArgs, isEmpty);
      },
    );

    // 例测：null 输入（glados 生成器无法直接产出 null，单独覆盖）
    test('null 输入直接返回，不调用 scanAndDeleteOrphanFiles', () async {
      final spy = _SpyImagesActions();
      await service.deleteImage(null, imagesActions: spy);
      expect(spy.callCount, 0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Property 2: 本地资产精确委托（Validates: Requirements 1.2）
  // ──────────────────────────────────────────────────────────────────────

  group('Property 2: 本地资产精确委托（1.2）', () {
    Glados<int>(any.intInRange(0, 1 << 20)).test(
      '本地路径恰好委托一次，入参等于 {path}',
      (seed) async {
        final rng = math.Random(seed);
        final candidates = _localCandidates(seed);
        final p = candidates[rng.nextInt(candidates.length)];

        // 兜底前置条件：所选输入必须是本地资产
        expect(
          isLocalAssetPath(p),
          isTrue,
          reason: '输入「$p」应被视为本地资产，否则该 case 不应进入 Property 2',
        );

        final spy = _SpyImagesActions();
        await service.deleteImage(p, imagesActions: spy);

        expect(
          spy.callCount,
          1,
          reason: '本地资产输入「$p」应恰好触发一次 scanAndDeleteOrphanFiles',
        );
        expect(
          spy.recordedArgs.single,
          equals(<String>{p}),
          reason: 'scanAndDeleteOrphanFiles 入参必须等于单元素集合 {path}',
        );
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Property 3: 异常吞噬（Validates: Requirements 1.3）
  // ──────────────────────────────────────────────────────────────────────

  group('Property 3: 异常吞噬（1.3）', () {
    /// 异常候选：覆盖 `Exception` / `StateError` / `FileSystemException` /
    /// `ArgumentError` / 任意非 `Error` 对象，保证「任何抛出物」都被吞噬。
    List<Object> errorCandidates(int seed) {
      return <Object>[
        Exception('boom-$seed'),
        StateError('state-$seed'),
        FileSystemException('fs-$seed', '/path/$seed'),
        ArgumentError('arg-$seed'),
        'plain-string-thrown-$seed',
      ];
    }

    Glados<int>(any.intInRange(0, 1 << 20)).test(
      '底层抛任意异常时 deleteImage future 仍正常 complete',
      (seed) async {
        final rng = math.Random(seed);
        final p = _localCandidates(seed).first; // 选一条稳定本地路径
        final errors = errorCandidates(seed);
        final err = errors[rng.nextInt(errors.length)];

        final spy = _SpyImagesActions()..throwError = err;

        // 关键断言：deleteImage 必须以「正常完成」收尾，不向外重抛
        await expectLater(
          service.deleteImage(p, imagesActions: spy),
          completes,
          reason: 'scanAndDeleteOrphanFiles 抛 ${err.runtimeType} '
              '时 deleteImage 不应回抛',
        );

        // 二次校验：spy 确实被调用过一次（说明异常发生在底层、被 try/catch 吞掉）
        expect(spy.callCount, 1);
      },
    );
  });
}
