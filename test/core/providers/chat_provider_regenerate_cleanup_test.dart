// Feature: flutter-platform-polish, Property 6
// Property 6: regenerateImage 差集驱动清理
//
// **Validates: Requirements 1.8**
//
// 用内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）+ 注入
// `_SpyImageGenService` 替换 `ImageGenService`，glados 随机生成任意
// `(beforeMeta, currentImagePath, newPath)` 输入，调用 `regenerateImage` 后断言：
//
//   set(spy.deleteCalls) == extractLocalPaths(beforeMeta) - extractLocalPaths(afterMeta)
//
// 即「事务后 mock deleteImage 调用入参集合恰好等于事务前后本地路径的差集」。
//
// 注入策略（最小侵入）：
// - `ChatController.regenerateImage` 已开放一个 `@visibleForTesting` 命名参数
//   `imageGenServiceFactory`，默认行为(null)与生产代码完全一致；测试传入返回
//   同一份 spy 的工厂，从而同时拦截「主生成路径」与「差集清理路径」。
// - `_SpyImageGenService` 用 `Fake implements ImageGenService` 模式，
//   `generate` 返回固定 `newPath`、`deleteImage` 仅记录入参、`dispose` 为空操作。
//   `Fake` 来自 `package:flutter_test`，未覆写的成员命中 `noSuchMethod` 抛
//   `UnimplementedError`，确保 regenerateImage 仅走我们关心的两条路径。
//
// 默认 100 次迭代（与同目录其它 PBT 一致）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/providers/chat_provider.dart';
import 'package:lumimuse/core/providers/database_provider.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';
import 'package:lumimuse/core/utils/local_asset_utils.dart';

const _convId = 'conv-regen-cleanup';
const _charId = 'char-regen-cleanup';
const _msgId = 'amsg-regen-cleanup';

/// 创建内存数据库 — 与同目录其它属性测试保持一致
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

// ──────────────────────────────────────────────────────────────────────────
// Spy：实现 ImageGenService 接口，覆写 `generate` / `deleteImage` / `dispose`
// 以拦截 `regenerateImage` 的两条 IO 路径（主生成 + 差集清理）。
//
// - `Fake implements ImageGenService`：避免构造真实 `Dio`；未覆写成员命中
//   `noSuchMethod` 抛 `UnimplementedError`，恰好暴露非预期路径的调用。
// - 同一份 spy 在「主生成路径」与「差集清理路径」之间共享：测试中工厂始终
//   返回同一个实例，`deleteCalls` 累加记录、`dispose` 为空操作。
// ──────────────────────────────────────────────────────────────────────────

class _SpyImageGenService extends Fake implements ImageGenService {
  /// 主生成路径下 `generate` 返回的固定新路径
  final String newPath;

  /// `deleteImage` 的全部调用入参，按顺序记录（含潜在重复）
  final List<String> deleteCalls = <String>[];

  /// `generate` 收到的正向提示词，按调用顺序记录。
  final List<String> generatePrompts = <String>[];

  _SpyImageGenService({required this.newPath});

  @override
  Future<String> generate({
    required String prompt,
    String negativePrompt = '',
    required ImageGenSettings settings,
  }) async {
    generatePrompts.add(prompt);
    return newPath;
  }

  @override
  Future<void> deleteImage(
    String? localPath, {
    required CharacterImagesActions imagesActions,
  }) async {
    // 仅在 localPath 非 null 时记录:与真实 ImageGenService.deleteImage 在
    // null/空白时静默返回的语义一致(差集元素本身就不会是 null)
    if (localPath != null) {
      deleteCalls.add(localPath);
    }
  }

  @override
  void dispose() {
    // 无副作用:spy 不持有 Dio 等需要释放的资源
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 随机 beforeMeta 生成
//
// 由 `seed` 派生确定性随机：
// - `generatedImages`: 0..3 张 image，每张随机带 `path` / `url` / `versions[]` 字段
// - 部分 image 的 `path` 字段 == `currentImagePath`（触发 regenerateImage 的
//   「path 匹配 → 整条替换为 {path: newPath, prompt}」分支，会让该 image 的
//   `url` 字段在事务后从 metadata 中消失，构成非空差集）
// - 每个 version 随机选择写 `url` 或 `path`(only `url` 字段会被
//   `extractLocalPaths` 提取,这两种分支都对差集计算有意义)
// - `image_versions`: 0..3 条顶层版本(同上随机选 url/path)
//
// 路径模板使用 `seed` + 索引保证全局唯一,避免不同位置的 url 冲突导致
// 测试失真(同一 url 出现多处时,删一处不会让它从 afterPaths 中消失)。
// ──────────────────────────────────────────────────────────────────────────

Map<String, dynamic> _buildBeforeMeta(int seed, String currentImagePath) {
  final rng = math.Random(seed);
  final imgCount = rng.nextInt(4); // 0..3

  final images = <Map<String, dynamic>>[];
  for (var i = 0; i < imgCount; i++) {
    final item = <String, dynamic>{'id': 'img-$seed-$i'};

    // 1/3 概率让本 image 的 path 命中 currentImagePath
    final matchCurrentPath = rng.nextInt(3) == 0;
    if (matchCurrentPath) {
      item['path'] = currentImagePath;
    } else if (rng.nextBool()) {
      // 否则一半概率随机写一个不匹配的 path 字段
      item['path'] = '/local/seed-$seed/img-$i-otherpath.png';
    }

    // 一半概率写顶层 url(被 extractLocalPaths 提取)
    if (rng.nextBool()) {
      item['url'] = '/local/seed-$seed/img-$i-toplevel.png';
    }

    // 0..3 个 versions 子项
    final verCount = rng.nextInt(4);
    if (verCount > 0) {
      final versions = <Map<String, dynamic>>[];
      for (var v = 0; v < verCount; v++) {
        final entry = <String, dynamic>{'id': 'img-$seed-$i-v-$v'};
        // 一半概率用 url(被提取),一半概率用 path(不被提取)
        final base = '/local/seed-$seed/img-$i-v-$v.png';
        if (rng.nextBool()) {
          entry['url'] = base;
        } else {
          entry['path'] = base;
        }
        versions.add(entry);
      }
      item['versions'] = versions;
    }

    images.add(item);
  }

  // image_versions 顶层数组:0..3 条
  final ivCount = rng.nextInt(4);
  final imageVersions = <Map<String, dynamic>>[];
  for (var i = 0; i < ivCount; i++) {
    final entry = <String, dynamic>{'id': 'iv-$seed-$i'};
    final base = '/local/seed-$seed/iv-$i.png';
    if (rng.nextBool()) {
      entry['url'] = base;
    } else {
      entry['path'] = base;
    }
    imageVersions.add(entry);
  }

  return <String, dynamic>{
    'generatedImages': images,
    'image_versions': imageVersions,
  };
}

/// 写入「角色 + 对话 + 一条 assistant 消息(承载 beforeMeta)」到 db
Future<void> _seedScenario(
  AppDatabase db,
  Map<String, dynamic> beforeMeta,
) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('regen 清理测试角色'),
        ),
      );
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('regen 清理测试对话'),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: _msgId,
          conversationId: _convId,
          role: 'assistant',
          content: const Value('AI 回复'),
          seq: const Value(1),
          createdAt: Value(DateTime(2026, 1, 1, 10, 0, 0)),
          metadata: Value(jsonEncode(beforeMeta)),
        ),
      );
}

void main() {
  group('Property 6: regenerateImage 差集驱动清理（Requirements 1.8）', () {
    Glados<int>(
      any.intInRange(0, 1 << 30),
      ExploreConfig(numRuns: 100),
    ).test(
      'mock deleteImage 入参集合 == extractLocalPaths(before).difference(extractLocalPaths(after))',
      (seed) async {
        final db = _createTestDb();
        ProviderContainer? container;
        try {
          // 1) 由 seed 派生 currentImagePath / newPath(均为本地资产路径)
          final currentImagePath = '/local/seed-$seed/current.png';
          final newPath = '/local/seed-$seed/new.png';

          // 2) 构造 beforeMeta 并写入 db
          final beforeMeta = _buildBeforeMeta(seed, currentImagePath);
          await _seedScenario(db, beforeMeta);

          // 3) 从 db 读出 metadata(以 JSON round-trip 后的形态对齐 regenerateImage
          //    内部 jsonDecode 的语义)并计算 beforePaths
          final preRow = await (db.select(db.messages)
                ..where((t) => t.id.equals(_msgId)))
              .getSingle();
          final preMeta = jsonDecode(preRow.metadata) as Map<String, dynamic>;
          final beforePaths = extractLocalPaths(preMeta);

          // 4) 注入 spy:工厂始终返回同一个实例,
          //    主生成路径与差集清理路径的所有调用都被 spy 收集
          final spy = _SpyImageGenService(newPath: newPath);

          // 5) 构造 ProviderContainer 覆盖 databaseProvider,从中拿到
          //    对应 conversationId 的 ChatController
          container = ProviderContainer(overrides: [
            databaseProvider.overrideWithValue(db),
          ]);
          final controller = container.read(
            chatControllerProvider(_convId).notifier,
          );

          // 6) 执行 regenerateImage(注入 spy 工厂)
          await controller.regenerateImage(
            messageId: _msgId,
            currentImagePath: currentImagePath,
            settings: const AppSettings(),
            imageGenServiceFactory: () => spy,
          );

          // 7) 读出事务后 metadata 并计算 afterPaths
          final postRow = await (db.select(db.messages)
                ..where((t) => t.id.equals(_msgId)))
              .getSingle();
          final postMeta =
              jsonDecode(postRow.metadata) as Map<String, dynamic>;
          final afterPaths = extractLocalPaths(postMeta);

          // 8) 断言 Property 6:spy 收到的入参集合 == 差集
          final expectedRemoved = beforePaths.difference(afterPaths);
          final actualSet = spy.deleteCalls.toSet();
          expect(
            actualSet,
            equals(expectedRemoved),
            reason:
                'mock deleteImage 调用入参集合应等于 extractLocalPaths(before) - extractLocalPaths(after)\n'
                '  before  = $beforePaths\n'
                '  after   = $afterPaths\n'
                '  removed = $expectedRemoved\n'
                '  actual  = $actualSet\n'
                '  seed    = $seed',
          );

          // 9) 二级断言:每个差集元素恰好被调用一次(无重复、无遗漏)
          expect(
            spy.deleteCalls.length,
            expectedRemoved.length,
            reason: 'mock deleteImage 调用次数应恰好等于差集元素个数',
          );
        } finally {
          container?.dispose();
          await db.close();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────
    // 例测:典型的「常规归档」与「覆盖而非归档」场景,与属性测试形成双层保护
    // ─────────────────────────────────────────────────────────────

    test('常规归档场景:旧 path 被归档到 image_versions[].path → 差集为空,deleteImage 不被调用',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const currentPath = '/local/regen-norm/current.png';
      const newPath = '/local/regen-norm/new.png';

      // 仅含 path 字段的 generatedImages,无 url:before 与 after 都没有
      // 任何 url 字段会进入 extractLocalPaths,差集恒为空
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {'id': 'img-1', 'path': currentPath, 'prompt': 'p'},
        ],
        'image_versions': <Map<String, dynamic>>[],
      };
      await _seedScenario(db, beforeMeta);

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: currentPath,
        settings: const AppSettings(),
        imageGenServiceFactory: () => spy,
      );

      expect(spy.deleteCalls, isEmpty,
          reason: 'before/after 都不含 url 字段 → 差集为空 → deleteImage 不应被调用');
    });

    test('覆盖而非归档场景:替换的 generatedImages 项含 url → 该 url 进入差集,deleteImage 被调用一次',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const currentPath = '/local/regen-edge/current.png';
      const newPath = '/local/regen-edge/new.png';
      const orphanUrl = '/local/regen-edge/orphan.png';

      // generatedImages 第一项同时含 path(用于匹配 currentImagePath)与 url
      // (会在替换后丢失,进入差集)
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {
            'id': 'img-1',
            'path': currentPath,
            'url': orphanUrl,
            'prompt': 'p',
          },
        ],
        'image_versions': <Map<String, dynamic>>[],
      };
      await _seedScenario(db, beforeMeta);

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: currentPath,
        settings: const AppSettings(),
        imageGenServiceFactory: () => spy,
      );

      expect(
        spy.deleteCalls,
        equals(<String>[orphanUrl]),
        reason: '覆盖而非归档:被替换项的 url=$orphanUrl 应作为差集唯一元素被传给 deleteImage',
      );
    });

    test('保留分支:image_versions 中已有的 url 在事务后仍存在 → 不进入差集',
        () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const currentPath = '/local/regen-keep/current.png';
      const newPath = '/local/regen-keep/new.png';
      const keepUrl = '/local/regen-keep/v0.png';

      // image_versions 已有一条 url 项;regenerateImage 不会移除它,只会追加新项
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {'id': 'img-1', 'path': currentPath, 'prompt': 'p'},
        ],
        'image_versions': [
          {'id': 'iv-0', 'url': keepUrl},
        ],
      };
      await _seedScenario(db, beforeMeta);

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: currentPath,
        settings: const AppSettings(),
        imageGenServiceFactory: () => spy,
      );

      expect(spy.deleteCalls, isEmpty,
          reason: 'image_versions 中的 keepUrl 在事务后仍存在 → 不应进入差集');
    });

    test('失败图片重试时使用失败条目当前 prompt，而不是角色 image_tags', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const newPath = '/local/regen-failed/new.png';
      const currentPrompt = 'current failed prompt, blue dress';
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {
            'id': 'img-failed',
            'url': '',
            'path': '',
            'prompt': currentPrompt,
            'status': 'failed',
          },
        ],
      };
      await _seedScenario(db, beforeMeta);
      await (db.update(db.characters)..where((t) => t.id.equals(_charId)))
          .write(
        const CharactersCompanion(
          imageTags: Value('old character tags, red dress'),
        ),
      );

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: '',
        settings: const AppSettings(),
        imageGenServiceFactory: () => spy,
      );

      expect(spy.generatePrompts, equals(<String>[currentPrompt]));

      final row = await (db.select(db.messages)..where((t) => t.id.equals(_msgId)))
          .getSingle();
      final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
      final images = (meta['generatedImages'] as List).cast<Map>();
      expect(images.single['prompt'], currentPrompt);
    });

    test('成功图片重新生成时使用当前图片 prompt，而不是角色 image_tags', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const currentPath = '/local/regen-ready/current.png';
      const newPath = '/local/regen-ready/new.png';
      const currentPrompt = 'current ready prompt, white coat';
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {
            'id': 'img-ready',
            'url': currentPath,
            'path': currentPath,
            'prompt': currentPrompt,
            'status': 'ready',
          },
        ],
      };
      await _seedScenario(db, beforeMeta);
      await (db.update(db.characters)..where((t) => t.id.equals(_charId)))
          .write(
        const CharactersCompanion(
          imageTags: Value('old character tags, black coat'),
        ),
      );

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: currentPath,
        settings: const AppSettings(),
        imageGenServiceFactory: () => spy,
      );

      expect(spy.generatePrompts, equals(<String>[currentPrompt]));

      final row = await (db.select(db.messages)..where((t) => t.id.equals(_msgId)))
          .getSingle();
      final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
      final images = (meta['generatedImages'] as List).cast<Map>();
      expect(images.single['prompt'], currentPrompt);
      expect(images.single['path'], newPath);
    });

    test('成功图片重新生成时优先使用当前激活版本 prompt，而不是顶层旧 prompt', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());

      const oldPath = '/local/regen-version/old.png';
      const currentPath = '/local/regen-version/current.png';
      const newPath = '/local/regen-version/new.png';
      const oldTopPrompt = 'old top prompt, red cloak';
      const activePrompt = 'active version prompt, silver cloak';
      final beforeMeta = <String, dynamic>{
        'generatedImages': [
          {
            'id': 'img-ready',
            'url': currentPath,
            'path': currentPath,
            'prompt': oldTopPrompt,
            'status': 'ready',
            'activeVersion': 1,
            'versions': [
              {
                'id': 'v0',
                'url': oldPath,
                'path': oldPath,
                'prompt': oldTopPrompt,
              },
              {
                'id': 'v1',
                'url': currentPath,
                'path': currentPath,
                'prompt': activePrompt,
              },
            ],
          },
        ],
      };
      await _seedScenario(db, beforeMeta);
      await (db.update(db.characters)..where((t) => t.id.equals(_charId)))
          .write(
        const CharactersCompanion(
          imageTags: Value('old character tags, black cloak'),
        ),
      );

      final spy = _SpyImageGenService(newPath: newPath);
      final container = ProviderContainer(overrides: [
        databaseProvider.overrideWithValue(db),
      ]);
      addTearDown(container.dispose);

      final controller =
          container.read(chatControllerProvider(_convId).notifier);
      await controller.regenerateImage(
        messageId: _msgId,
        currentImagePath: currentPath,
        settings: const AppSettings(),
        prompt: oldTopPrompt,
        imageGenServiceFactory: () => spy,
      );

      expect(spy.generatePrompts, equals(<String>[activePrompt]));

      final row =
          await (db.select(db.messages)..where((t) => t.id.equals(_msgId)))
              .getSingle();
      final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
      final images = (meta['generatedImages'] as List).cast<Map>();
      final versions = (images.single['versions'] as List).cast<Map>();
      expect(images.single['prompt'], activePrompt);
      expect(versions.last['prompt'], activePrompt);
    });
  });
}
