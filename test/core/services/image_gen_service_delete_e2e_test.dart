// Feature: flutter-platform-polish, Property 4
// Property 4: 删文件 ⇔ 无引用（端到端不变量）
//
// **Validates: Requirements 1.9, 1.10**
//
// 用内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）+ 临时目录
// 构造真实文件，覆盖三类引用位置：
//   1. messages.metadata.generatedImages[].url（含 versions[].url）
//   2. messages.metadata.image_versions[].url
//   3. characters.avatar_url
//
// 对每个真实文件 f 调用 `ImageGenService.deleteImage(f, imagesActions: actions)`
// 后断言：`File(f).existsSync() == R.contains(f)`，其中 R 是上述三类位置的引用集合。
//
// 即「文件存在 ⇔ 仍被引用」恒成立：
//   - f ∈ R → 文件应仍存在（被引用 → 不删）
//   - f ∉ R → 文件应已被删除（无引用 → 真删）
//
// 依赖说明：
//   - `ImageGenService.deleteImage` 内部调用
//     `CharacterImagesActions.scanAndDeleteOrphanFiles({f})`，由其负责扫描全库
//     引用并仅在「无引用」时调用底层 `_safeDeleteFile`。
//   - 同目录 `character_images_actions_test.dart` 的 Property 19 已经覆盖了
//     `scanAndDeleteOrphanFiles` 的引用扫描细节，本文件用更简单的随机模式从
//     `ImageGenService.deleteImage` 这一外部入口端到端验证不变量。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';
import 'package:path/path.dart' as p;

const _charId = 'char-e2e-delete';
const _otherCharId = 'char-e2e-avatar';
const _convId = 'conv-e2e-delete';
const _msgGeneratedId = 'msg-e2e-generated';
const _msgImageVersionsId = 'msg-e2e-image-versions';

/// 创建内存数据库 — 与同目录 `character_images_actions_test.dart` 保持一致。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 一次属性迭代生成的「场景快照」。
class _Scenario {
  /// 临时目录中所有真实落盘文件的绝对路径列表。
  final List<String> allPaths;

  /// 引用集合 R：这些路径在 `messages.metadata` 或 `characters.avatar_url`
  /// 中仍被引用，事务后应仍存在于磁盘。
  final Set<String> referenced;

  const _Scenario({required this.allPaths, required this.referenced});
}

/// 写一个 32 字节确定性内容的本地文件。
Future<void> _writeAsset(String path, int seed) async {
  final f = File(path);
  await f.parent.create(recursive: true);
  final bytes = List<int>.generate(32, (i) => (seed + i * 13) & 0xFF);
  await f.writeAsBytes(bytes, flush: true);
}

/// 由 `(seed, fileCount)` 派生场景：
///
/// - 在 [tmp] 内创建 [fileCount] 个真实文件 `f_0 .. f_{fileCount-1}`
/// - 对每个文件随机决定它是否出现在三类引用位置之一，得到引用集合 R
/// - 把引用写入 messages.metadata / characters.avatar_url
/// - 返回包含「全部文件路径 + 引用集合」的快照
Future<_Scenario> _seedScenario(
  AppDatabase db,
  Directory tmp,
  int fileCount,
  int seed,
) async {
  final rng = math.Random(seed);

  // 1) 创建两个角色：本角色 + 用于 avatar_url 引用的另一角色
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('端到端删除测试角色'),
        ),
      );
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _otherCharId,
          name: const Value('avatar 引用角色'),
        ),
      );

  // 2) 创建对话
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: _convId,
          characterId: _charId,
          title: const Value('端到端删除测试对话'),
        ),
      );

  // 3) 创建 fileCount 个真实文件
  final allPaths = <String>[];
  for (var i = 0; i < fileCount; i++) {
    final path = p.join(tmp.path, 'asset-$i.png');
    await _writeAsset(path, seed + i);
    allPaths.add(path);
  }

  // 4) 对每个文件随机分配到一类引用位置之一（或不引用）
  //    用 4 态决策：0=不引用 / 1=generatedImages / 2=image_versions / 3=avatar_url
  //    avatar_url 仅一个槽位，多个候选时取最后一个被分配到 avatar 的文件
  final referenced = <String>{};
  final generatedRefs = <String>[];
  final imageVersionRefs = <String>[];
  String? avatarRef;

  for (final path in allPaths) {
    final bucket = rng.nextInt(4);
    switch (bucket) {
      case 0:
        // 不引用
        break;
      case 1:
        generatedRefs.add(path);
        referenced.add(path);
        break;
      case 2:
        imageVersionRefs.add(path);
        referenced.add(path);
        break;
      case 3:
        // avatar_url 槽位多次分配时仅最后一个生效；早先的回退为不引用
        if (avatarRef != null) {
          referenced.remove(avatarRef);
        }
        avatarRef = path;
        referenced.add(path);
        break;
    }
  }

  // 5) 写 messages.metadata.generatedImages（覆盖含 versions 的形态）
  if (generatedRefs.isNotEmpty) {
    final imgs = <Map<String, dynamic>>[];
    // 把引用切成两半：一半作为 image.url 顶层引用（通过 versions[0].url 表达）
    // 另一半放到同一个 image 的 versions[] 中，覆盖「versions[].url」分支
    for (var i = 0; i < generatedRefs.length; i++) {
      final path = generatedRefs[i];
      imgs.add({
        'id': 'img-$i',
        'url': path,
        'prompt': 'p',
        'activeVersion': 0,
        'versions': [
          {'id': 'img-$i-v-0', 'url': path, 'prompt': 'p'},
        ],
      });
    }
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: _msgGeneratedId,
            conversationId: _convId,
            role: 'assistant',
            content: const Value('生图引用消息'),
            seq: const Value(1),
            createdAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000000 * 1000),
            ),
            metadata: Value(jsonEncode({'generatedImages': imgs})),
          ),
        );
  }

  // 6) 写 messages.metadata.image_versions
  if (imageVersionRefs.isNotEmpty) {
    final versions = <Map<String, dynamic>>[];
    for (var i = 0; i < imageVersionRefs.length; i++) {
      versions.add({
        'id': 'iv-$i',
        'url': imageVersionRefs[i],
      });
    }
    await db.into(db.messages).insert(
          MessagesCompanion.insert(
            id: _msgImageVersionsId,
            conversationId: _convId,
            role: 'assistant',
            content: const Value('image_versions 引用消息'),
            seq: const Value(2),
            createdAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000010 * 1000),
            ),
            metadata: Value(jsonEncode({'image_versions': versions})),
          ),
        );
  }

  // 7) 写 characters.avatar_url
  if (avatarRef != null) {
    await (db.update(db.characters)
          ..where((t) => t.id.equals(_otherCharId)))
        .write(CharactersCompanion(avatarUrl: Value(avatarRef)));
  }

  return _Scenario(allPaths: allPaths, referenced: referenced);
}

void main() {
  group('Property 4: 删文件 ⇔ 无引用（端到端不变量）', () {
    Glados2<int, int>(
      any.intInRange(0, 6), // fileCount: 0..6，覆盖空集 + 小到中等规模
      any.intInRange(0, 1 << 30), // seed: 决定每个文件落入哪类引用
      ExploreConfig(numRuns: 100),
    ).test(
      '对每个文件调用 deleteImage 后 File(f).existsSync() == R.contains(f) 恒成立',
      (fileCount, seed) async {
        // 每次迭代独立的临时目录承载本地资产文件，互不污染。
        final tmp = await Directory.systemTemp
            .createTemp('lumimuse_p4_${seed}_');
        final db = _createTestDb();
        try {
          // 1. 构造场景：真实文件 + 引用关系
          final scenario = await _seedScenario(db, tmp, fileCount, seed);
          final actions = CharacterImagesActions(db);
          final service = ImageGenService();

          // 2. 对每个文件依次调用 deleteImage
          //    设计语义：调用前 metadata 已经反映「引用关系」；deleteImage 仅在
          //    无任何引用时真正删文件。
          for (final path in scenario.allPaths) {
            await service.deleteImage(path, imagesActions: actions);
          }

          // 3. 断言不变量：File(f).existsSync() == R.contains(f)
          for (final path in scenario.allPaths) {
            final exists = File(path).existsSync();
            final shouldExist = scenario.referenced.contains(path);
            expect(
              exists,
              shouldExist,
              reason: shouldExist
                  ? '路径仍被引用（generatedImages / image_versions / avatar_url 之一），不应被删除；path=$path'
                  : '路径已无任何引用，调用结束后应被删除；path=$path',
            );
          }

          service.dispose();
        } finally {
          await db.close();
          // 每次迭代后清理临时目录
          try {
            if (await tmp.exists()) {
              await tmp.delete(recursive: true);
            }
          } catch (_) {
            // Windows 上偶发文件锁，忽略残余清理失败
          }
        }
      },
    );

    // ─────────────────────────────────────────────────────────────
    // 例测：三类引用位置的最小可复现场景，与属性测试形成双层保护
    // ─────────────────────────────────────────────────────────────

    test('被 generatedImages[].url 引用 → 文件应仍存在', () async {
      final tmp = await Directory.systemTemp
          .createTemp('lumimuse_p4_ex_gen_');
      final db = _createTestDb();
      addTearDown(() async {
        await db.close();
        try {
          if (await tmp.exists()) await tmp.delete(recursive: true);
        } catch (_) {}
      });

      // 准备 1 个被引用的文件
      final path = p.join(tmp.path, 'gen.png');
      await _writeAsset(path, 1);

      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: _charId,
              name: const Value('例测角色'),
            ),
          );
      await db.into(db.conversations).insert(
            ConversationsCompanion.insert(
              id: _convId,
              characterId: _charId,
            ),
          );
      await db.into(db.messages).insert(
            MessagesCompanion.insert(
              id: _msgGeneratedId,
              conversationId: _convId,
              role: 'assistant',
              content: const Value(''),
              seq: const Value(1),
              metadata: Value(jsonEncode({
                'generatedImages': [
                  {
                    'id': 'img-1',
                    'url': path,
                    'prompt': 'p',
                    'versions': [
                      {'id': 'v-0', 'url': path, 'prompt': 'p'},
                    ],
                  }
                ],
              })),
            ),
          );

      final service = ImageGenService();
      final actions = CharacterImagesActions(db);
      await service.deleteImage(path, imagesActions: actions);
      service.dispose();

      expect(File(path).existsSync(), isTrue,
          reason: 'generatedImages[].url 仍引用 → 文件不应被删除');
    });

    test('被 image_versions[].url 引用 → 文件应仍存在', () async {
      final tmp = await Directory.systemTemp
          .createTemp('lumimuse_p4_ex_iv_');
      final db = _createTestDb();
      addTearDown(() async {
        await db.close();
        try {
          if (await tmp.exists()) await tmp.delete(recursive: true);
        } catch (_) {}
      });

      final path = p.join(tmp.path, 'iv.png');
      await _writeAsset(path, 2);

      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: _charId,
              name: const Value('例测角色'),
            ),
          );
      await db.into(db.conversations).insert(
            ConversationsCompanion.insert(
              id: _convId,
              characterId: _charId,
            ),
          );
      await db.into(db.messages).insert(
            MessagesCompanion.insert(
              id: _msgImageVersionsId,
              conversationId: _convId,
              role: 'assistant',
              content: const Value(''),
              seq: const Value(1),
              metadata: Value(jsonEncode({
                'image_versions': [
                  {'id': 'iv-0', 'url': path},
                ],
              })),
            ),
          );

      final service = ImageGenService();
      final actions = CharacterImagesActions(db);
      await service.deleteImage(path, imagesActions: actions);
      service.dispose();

      expect(File(path).existsSync(), isTrue,
          reason: 'image_versions[].url 仍引用 → 文件不应被删除');
    });

    test('被 characters.avatar_url 引用 → 文件应仍存在', () async {
      final tmp = await Directory.systemTemp
          .createTemp('lumimuse_p4_ex_avatar_');
      final db = _createTestDb();
      addTearDown(() async {
        await db.close();
        try {
          if (await tmp.exists()) await tmp.delete(recursive: true);
        } catch (_) {}
      });

      final path = p.join(tmp.path, 'avatar.png');
      await _writeAsset(path, 3);

      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: _charId,
              name: const Value('avatar 角色'),
              avatarUrl: Value(path),
            ),
          );

      final service = ImageGenService();
      final actions = CharacterImagesActions(db);
      await service.deleteImage(path, imagesActions: actions);
      service.dispose();

      expect(File(path).existsSync(), isTrue,
          reason: 'characters.avatar_url 仍引用 → 文件不应被删除');
    });

    test('无任何引用 → 文件应被删除', () async {
      final tmp = await Directory.systemTemp
          .createTemp('lumimuse_p4_ex_orphan_');
      final db = _createTestDb();
      addTearDown(() async {
        await db.close();
        try {
          if (await tmp.exists()) await tmp.delete(recursive: true);
        } catch (_) {}
      });

      final path = p.join(tmp.path, 'orphan.png');
      await _writeAsset(path, 4);

      // 库里完全没有引用
      await db.into(db.characters).insert(
            CharactersCompanion.insert(
              id: _charId,
              name: const Value('空角色'),
            ),
          );

      final service = ImageGenService();
      final actions = CharacterImagesActions(db);
      await service.deleteImage(path, imagesActions: actions);
      service.dispose();

      expect(File(path).existsSync(), isFalse,
          reason: '无任何引用 → 文件应被删除');
    });
  });
}
