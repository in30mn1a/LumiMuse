// Feature: flutter-parity-completion, Property 18: listImages 展开正确
// Feature: flutter-parity-completion, Property 19: deleteImages 局部更新与稳定 imageId
//
// **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6**
//
// Property 18：通过内存 Drift（`AppDatabase.forTesting`）+ `package:glados`
// 生成「同一角色 + 多 assistant 消息 + 各消息 metadata.generatedImages」的随机
// 场景，调用 `CharacterImagesActions.listImages(characterId)` 后断言以下两条不变量
// （与 design.md「P1 / R11」对齐）：
//
//   1. 条目数 == sum(image.versions.length)，其中 `versions` 为空或缺失按 1 计
//      （兼容旧消息：image.versions 缺失时归一化为单版本）；同时本地路径为空
//      的版本会被 listImages 跳过，因此这里固定为「每个 version 都给非空 url」。
//   2. 排序：消息层按 `created_at DESC, seq DESC`（与 SQL 完全一致）；同一 image
//      内多版本按数组反向展开（最新版本即数组末尾排在前）。
//
// 默认 100 次迭代（glados 默认值）。Drift `DateTime` 默认按 Unix 秒存储，因此
// 生成器使用秒级互不重复的 `created_at` 避免最新一条歧义；为模拟「同一秒内
// 多条消息」的场景，又额外让若干消息共享同 `created_at` 但 `seq` 不同，覆盖
// 二级排序键 `seq DESC` 的分支。
//
// Property 19：在临时目录内为目标消息的每个 version 实际落盘一个文件，构造
// 「另一条消息的 image_versions / 另一个角色的 avatar_url」对部分待删路径产生
// 引用，调用 `CharacterImagesActions.deleteImages(charId, items)` 后断言以下五条
// 不变量（与 design.md「Property 19」对齐）：
//
//   1. 全删：某 image 的所有 version 都在删除集合 → 整条从 metadata.generatedImages
//      移除。
//   2. 部分删：image.id 不变，versions 长度减少恰好被删数量；剩余 versions 顺序
//      与原数组一致，且不含被删 versionId。
//   3. activeVersion 在被删 version 上时重新指向 `min(prevActive, remaining.length-1)`，
//      且永远在 `[0, remaining.length-1]` 范围内（永不为负、永不越界）。
//   4. 返回 `deletedCount` 等于命中删除的 (imageId, versionId) 对数（生成器仅生成
//      实际存在的目标，因此 == items.length）。
//   5. 事务后：被删 version 的本地路径仅当不被任何其它消息 metadata 或角色 avatar
//      引用时才真正从磁盘删除；其余路径必须仍然存在。
//
// 默认 100 次迭代。每次迭代独立的子目录承载本地资产文件，互不污染。
//
// 注意：项目其它属性测试已有「Property 17 角色级联拷贝」与本文件 Property 18，
// 故此处只新增 Property 19 一组测试。

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:path/path.dart' as p;

const _charId = 'char-list-images';
const _otherCharId = 'char-other';

/// 创建内存数据库 — 与同目录其它属性测试保持一致。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 一次属性迭代生成的「场景快照」—— 全部数据由 `(seed, msgCount)` 派生。
///
/// 不同消息：
/// - `created_at` 大概率互不相同（秒级），少量场景刻意复用同一秒触发 `seq DESC`
///   二级排序；
/// - 每条消息有 0..3 张 image，每张 image 0..3 个 version；
/// - 第 0 张 image 的 `versions` 字段被随机挑出来「整段缺失」，覆盖归一化为
///   单版本（按 1 计）的兼容路径。
class _Scenario {
  /// 期望条目顺序：先按 (createdAt DESC, seq DESC) 排序消息，再每条消息内按
  /// 版本数组反向展开（最新版本在前）。每个元素为
  /// `(messageId, imageId, versionId, url)`。
  final List<({String messageId, String imageId, String versionId, String url})>
  expectedItems;

  /// 期望条目总数 == 所有 image 的 `versions.length`（缺失按 1 计），
  /// 与不变量 1 严格对应。
  final int expectedCount;

  const _Scenario({required this.expectedItems, required this.expectedCount});
}

/// 写入一份场景到 [db] 并返回快照。
Future<_Scenario> _seedScenario(AppDatabase db, int msgCount, int seed) async {
  final rng = math.Random(seed);

  // 1. 角色：本角色 + 一个干扰角色（用于断言 listImages 不会越权）
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(id: _charId, name: const Value('图片管理测试角色')),
      );
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(id: _otherCharId, name: const Value('干扰角色')),
      );

  // 2. 对话：1 个本角色对话 + 1 个干扰角色对话
  const convId = 'conv-list-images';
  const otherConvId = 'conv-other';
  await db
      .into(db.conversations)
      .insert(
        ConversationsCompanion.insert(
          id: convId,
          characterId: _charId,
          title: const Value('测试对话'),
        ),
      );
  await db
      .into(db.conversations)
      .insert(
        ConversationsCompanion.insert(
          id: otherConvId,
          characterId: _otherCharId,
          title: const Value('干扰对话'),
        ),
      );

  // 3. 干扰角色消息 + generatedImages：listImages 不应返回任何这条
  await db
      .into(db.messages)
      .insert(
        MessagesCompanion.insert(
          id: 'omsg-other',
          conversationId: otherConvId,
          role: 'assistant',
          content: const Value('其他角色的消息'),
          seq: const Value(0),
          createdAt: Value(
            DateTime.fromMillisecondsSinceEpoch(1700000000 * 1000),
          ),
          metadata: Value(
            jsonEncode({
              'generatedImages': [
                {
                  'id': 'oimg-0',
                  'url': '/should/not/appear.png',
                  'prompt': 'p',
                  'versions': [
                    {
                      'id': 'ov-0',
                      'url': '/should/not/appear.png',
                      'prompt': 'p',
                    },
                  ],
                },
              ],
            }),
          ),
        ),
      );

  // 4. 本角色 user 消息（带 generatedImages 也不应被 listImages 选中，因为只取 assistant）
  if (rng.nextBool()) {
    await db
        .into(db.messages)
        .insert(
          MessagesCompanion.insert(
            id: 'umsg-user',
            conversationId: convId,
            role: 'user',
            content: const Value('user 消息'),
            seq: const Value(-1),
            createdAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000010 * 1000),
            ),
            metadata: Value(
              jsonEncode({
                'generatedImages': [
                  {
                    'id': 'uimg-0',
                    'url': '/user/should-skip.png',
                    'prompt': 'q',
                    'versions': [
                      {
                        'id': 'uv-0',
                        'url': '/user/should-skip.png',
                        'prompt': 'q',
                      },
                    ],
                  },
                ],
              }),
            ),
          ),
        );
  }

  // 5. 本角色 assistant 消息：随机生成 msgCount 条
  // 每条带 0..3 张 image；每张 image 0..3 个 version（覆盖归一化分支）；
  // 部分消息共享 `createdAt` 触发二级排序键 `seq DESC`。
  // 用「时间戳 + seq」做排序键 —— 与 SQL `ORDER BY messages.created_at DESC,
  // messages.seq DESC` 严格对齐。
  final base = DateTime(2026, 1, 1);
  final perMessage =
      <
        ({
          String msgId,
          DateTime createdAt,
          int seq,
          List<Map<String, dynamic>> imgs,
        })
      >[];
  for (var m = 0; m < msgCount; m++) {
    final msgId = 'amsg-$m';
    // 60% 概率独立秒，40% 概率与上一条共享秒（覆盖 seq DESC 二级排序）
    final shareSec = m > 0 && rng.nextInt(5) < 2;
    final createdAt = shareSec
        ? perMessage.last.createdAt
        : base.add(Duration(seconds: rng.nextInt(1 << 20) + m));
    final seqVal = m + 1; // 单调递增便于断言

    // 0..3 张图片
    final imgCount = rng.nextInt(4);
    final imgs = <Map<String, dynamic>>[];
    for (var i = 0; i < imgCount; i++) {
      final imageId = 'amsg-$m-img-$i';
      // 0..3 个版本
      final verCount = rng.nextInt(4);
      // 30% 概率「versions 缺失」：覆盖归一化为单版本的分支
      final missingVersions = rng.nextInt(10) < 3;
      if (verCount == 0 || missingVersions) {
        // 单版本：image 顶层 url 作为唯一版本
        imgs.add({
          'id': imageId,
          'url': '/local/$imageId.png',
          'prompt': 'prompt-$imageId',
          // 故意不写 versions：覆盖 _normalizeVersions 缺失分支
        });
      } else {
        final versions = <Map<String, dynamic>>[];
        for (var v = 0; v < verCount; v++) {
          versions.add({
            'id': 'amsg-$m-img-$i-v-$v',
            'url': '/local/amsg-$m-img-$i-v-$v.png',
            'prompt': 'prompt-v-$v',
          });
        }
        imgs.add({
          'id': imageId,
          'url': versions.last['url'],
          'prompt': 'prompt-$imageId',
          'activeVersion': verCount - 1,
          'versions': versions,
        });
      }
    }

    perMessage.add((
      msgId: msgId,
      createdAt: createdAt,
      seq: seqVal,
      imgs: imgs,
    ));

    await db
        .into(db.messages)
        .insert(
          MessagesCompanion.insert(
            id: msgId,
            conversationId: convId,
            role: 'assistant',
            content: Value('assistant 消息 $m'),
            seq: Value(seqVal),
            createdAt: Value(createdAt),
            metadata: Value(jsonEncode({'generatedImages': imgs})),
          ),
        );
  }

  // 6. 计算期望顺序：先按 (createdAt DESC, seq DESC) 对消息排序
  //   —— 与 listImages SQL 一致；同消息内 image 顺序保持插入顺序（与 SQL/JSON
  //   一致），同 image 内版本反向展开。
  final sortedMsgs = perMessage.toList()
    ..sort((a, b) {
      final byCreated = b.createdAt.compareTo(a.createdAt);
      if (byCreated != 0) return byCreated;
      return b.seq.compareTo(a.seq);
    });

  final expectedItems =
      <({String messageId, String imageId, String versionId, String url})>[];
  for (final entry in sortedMsgs) {
    for (final img in entry.imgs) {
      final imageId = img['id'] as String;
      final versions = img['versions'];
      List<Map<String, dynamic>> normalized;
      if (versions is List && versions.isNotEmpty) {
        normalized = versions
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
      } else {
        // 归一化：单版本，id 退化为 image.id，url 退化为 image.url
        normalized = [
          {'id': img['id'], 'url': img['url'], 'prompt': img['prompt'] ?? ''},
        ];
      }
      // 反向展开：最新版本（数组末尾）排在前
      for (var i = normalized.length - 1; i >= 0; i--) {
        final v = normalized[i];
        expectedItems.add((
          messageId: entry.msgId,
          imageId: imageId,
          versionId: (v['id'] as String?) ?? imageId,
          url: (v['url'] as String?) ?? '',
        ));
      }
    }
  }

  return _Scenario(
    expectedItems: expectedItems,
    expectedCount: expectedItems.length,
  );
}

void main() {
  group('Property 18: listImages 展开正确', () {
    Glados2<int, int>(
      any.intInRange(0, 7), // assistant 消息数：0~6，覆盖空集 + 小到中等规模
      any.intInRange(0, 1 << 30), // seed：决定 image / version 数与时间戳
    ).test(
      '条目数 == sum(versions.length)（缺失按 1 计），且按 (createdAt DESC, seq DESC) + 版本反向展开排序',
      (msgCount, seed) async {
        final db = _createTestDb();
        try {
          final scenario = await _seedScenario(db, msgCount, seed);
          final actions = CharacterImagesActions(db);

          final actual = await actions.listImages(_charId);

          // 不变量 1：条目数等于 sum(versions.length)，缺失按 1 计
          expect(
            actual.length,
            scenario.expectedCount,
            reason:
                '返回条目数应等于 sum(image.versions.length)（versions 为空按 1 计），实际 ${actual.length} 期望 ${scenario.expectedCount}',
          );

          // 不变量 2：顺序与场景预期完全一致
          expect(
            actual.length,
            scenario.expectedItems.length,
            reason: '断言长度时已校验，但再次显式确保排序步骤前后长度一致',
          );
          for (var i = 0; i < actual.length; i++) {
            final a = actual[i];
            final e = scenario.expectedItems[i];
            expect(
              (
                messageId: a.messageId,
                imageId: a.imageId,
                versionId: a.versionId,
                url: a.localPath,
              ),
              e,
              reason: '第 $i 条条目顺序应与 (createdAt DESC, seq DESC) + 版本反向展开 一致',
            );
          }

          // 跨界断言：listImages 不应返回任何干扰角色 / 干扰对话的条目
          for (final item in actual) {
            expect(
              item.messageId.startsWith('omsg-'),
              isFalse,
              reason: '干扰角色的消息不应出现在结果中：${item.messageId}',
            );
            expect(
              item.messageId.startsWith('umsg-'),
              isFalse,
              reason: 'user 消息不应出现在结果中：${item.messageId}',
            );
            expect(
              item.conversationId,
              'conv-list-images',
              reason: '所有条目都应来自本角色的对话，实际 ${item.conversationId}',
            );
          }
        } finally {
          await db.close();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────
    // 例测：边界场景显式断言，与属性测试形成双层保护
    // ─────────────────────────────────────────────────────────────

    test('空角色（无 assistant 消息）→ 返回空列表', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db
          .into(db.characters)
          .insert(
            CharactersCompanion.insert(id: _charId, name: const Value('空角色')),
          );
      await db
          .into(db.conversations)
          .insert(
            ConversationsCompanion.insert(
              id: 'conv-empty',
              characterId: _charId,
            ),
          );
      final actions = CharacterImagesActions(db);
      final result = await actions.listImages(_charId);
      expect(result, isEmpty);
    });

    test('单消息单 image 单 version → 返回 1 条', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      final createdAt = DateTime(2026, 1, 1, 12, 34, 56, 789);
      await db
          .into(db.characters)
          .insert(
            CharactersCompanion.insert(id: _charId, name: const Value('单图角色')),
          );
      await db
          .into(db.conversations)
          .insert(
            ConversationsCompanion.insert(
              id: 'conv-single',
              characterId: _charId,
            ),
          );
      await db
          .into(db.messages)
          .insert(
            MessagesCompanion.insert(
              id: 'msg-single',
              conversationId: 'conv-single',
              role: 'assistant',
              content: const Value('hi'),
              seq: const Value(1),
              createdAt: Value(createdAt),
              metadata: Value(
                jsonEncode({
                  'generatedImages': [
                    {
                      'id': 'img-1',
                      'url': '/local/img-1.png',
                      'prompt': 'p',
                      'versions': [
                        {'id': 'v-1', 'url': '/local/img-1.png', 'prompt': 'p'},
                      ],
                    },
                  ],
                }),
              ),
            ),
          );

      final actions = CharacterImagesActions(db);
      final result = await actions.listImages(_charId);
      expect(result.length, 1);
      expect(result[0].imageId, 'img-1');
      expect(result[0].versionId, 'v-1');
      expect(result[0].localPath, '/local/img-1.png');
      expect(result[0].createdAt, DateTime(2026, 1, 1, 12, 34, 56));
    });

    test('versions 缺失 → 归一化为单版本（按 1 计），versionId 退化为 imageId', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db
          .into(db.characters)
          .insert(
            CharactersCompanion.insert(id: _charId, name: const Value('旧消息角色')),
          );
      await db
          .into(db.conversations)
          .insert(
            ConversationsCompanion.insert(id: 'conv-old', characterId: _charId),
          );
      await db
          .into(db.messages)
          .insert(
            MessagesCompanion.insert(
              id: 'msg-old',
              conversationId: 'conv-old',
              role: 'assistant',
              content: const Value('旧消息'),
              seq: const Value(1),
              metadata: Value(
                jsonEncode({
                  'generatedImages': [
                    // 故意不写 versions：覆盖归一化分支
                    {'id': 'img-old', 'url': '/local/old.png', 'prompt': ''},
                  ],
                }),
              ),
            ),
          );

      final actions = CharacterImagesActions(db);
      final result = await actions.listImages(_charId);
      expect(result.length, 1);
      expect(result[0].imageId, 'img-old');
      expect(
        result[0].versionId,
        'img-old',
        reason: 'versions 缺失时 versionId 应退化为 image.id',
      );
      expect(result[0].localPath, '/local/old.png');
    });

    test('多版本按数组反向展开（最新版本即数组末尾排在前）', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db
          .into(db.characters)
          .insert(
            CharactersCompanion.insert(id: _charId, name: const Value('多版本角色')),
          );
      await db
          .into(db.conversations)
          .insert(
            ConversationsCompanion.insert(
              id: 'conv-multi',
              characterId: _charId,
            ),
          );
      await db
          .into(db.messages)
          .insert(
            MessagesCompanion.insert(
              id: 'msg-multi',
              conversationId: 'conv-multi',
              role: 'assistant',
              content: const Value('多版本'),
              seq: const Value(1),
              metadata: Value(
                jsonEncode({
                  'generatedImages': [
                    {
                      'id': 'img-multi',
                      'url': '/local/v2.png',
                      'prompt': 'p',
                      'activeVersion': 2,
                      'versions': [
                        {'id': 'v-0', 'url': '/local/v0.png', 'prompt': 'p0'},
                        {'id': 'v-1', 'url': '/local/v1.png', 'prompt': 'p1'},
                        {'id': 'v-2', 'url': '/local/v2.png', 'prompt': 'p2'},
                      ],
                    },
                  ],
                }),
              ),
            ),
          );

      final actions = CharacterImagesActions(db);
      final result = await actions.listImages(_charId);
      expect(
        result.map((e) => e.versionId).toList(),
        ['v-2', 'v-1', 'v-0'],
        reason: '同一 image 内多版本应反向展开（最新版本在前）',
      );
    });

    test('两条消息 createdAt 相同时按 seq DESC 排序', () async {
      final db = _createTestDb();
      addTearDown(() => db.close());
      await db
          .into(db.characters)
          .insert(
            CharactersCompanion.insert(id: _charId, name: const Value('同秒角色')),
          );
      await db
          .into(db.conversations)
          .insert(
            ConversationsCompanion.insert(
              id: 'conv-same-sec',
              characterId: _charId,
            ),
          );
      final sameSec = DateTime(2026, 1, 1, 10, 0, 0);
      await db
          .into(db.messages)
          .insert(
            MessagesCompanion.insert(
              id: 'msg-low-seq',
              conversationId: 'conv-same-sec',
              role: 'assistant',
              content: const Value('seq 较小'),
              seq: const Value(1),
              createdAt: Value(sameSec),
              metadata: Value(
                jsonEncode({
                  'generatedImages': [
                    {
                      'id': 'img-low',
                      'url': '/local/low.png',
                      'prompt': '',
                      'versions': [
                        {'id': 'lv-0', 'url': '/local/low.png', 'prompt': ''},
                      ],
                    },
                  ],
                }),
              ),
            ),
          );
      await db
          .into(db.messages)
          .insert(
            MessagesCompanion.insert(
              id: 'msg-high-seq',
              conversationId: 'conv-same-sec',
              role: 'assistant',
              content: const Value('seq 较大'),
              seq: const Value(2),
              createdAt: Value(sameSec),
              metadata: Value(
                jsonEncode({
                  'generatedImages': [
                    {
                      'id': 'img-high',
                      'url': '/local/high.png',
                      'prompt': '',
                      'versions': [
                        {'id': 'hv-0', 'url': '/local/high.png', 'prompt': ''},
                      ],
                    },
                  ],
                }),
              ),
            ),
          );

      final actions = CharacterImagesActions(db);
      final result = await actions.listImages(_charId);
      expect(
        result.map((e) => e.messageId).toList(),
        ['msg-high-seq', 'msg-low-seq'],
        reason: 'createdAt 相同 → seq DESC 决定顺序',
      );
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Property 19: deleteImages 局部更新与稳定 imageId
  // ════════════════════════════════════════════════════════════════
  group('Property 19: deleteImages 局部更新与稳定 imageId', () {
    Glados<int>(
      any.intInRange(0, 1 << 30),
      ExploreConfig(numRuns: 100),
    ).test('全删/部分删/activeVersion 重指向/deletedCount/事务后仅删除无引用本地路径', (seed) async {
      // 每次迭代独立的临时目录承载本地资产文件，互不污染。
      final tmp = await Directory.systemTemp.createTemp(
        'lumimuse_p19_${seed}_',
      );
      final db = _createTestDb();
      try {
        // ── 1. 构造场景：随机若干 image，每 image 随机 versions ──────
        final scenario = await _seedDeleteScenario(db, tmp, seed);

        // ── 2. 调用 deleteImages ──────────────────────────────────
        final actions = CharacterImagesActions(db);
        final result = await actions.deleteImages(_charId, scenario.items);

        // ── 3. 断言不变量 ─────────────────────────────────────────
        // 不变量 4：deletedCount == items 命中删除对数（生成器仅生成实际存在的目标）
        expect(
          result.deletedCount,
          scenario.expectedDeletedCount,
          reason: '返回 deletedCount 应等于命中删除的 (imageId, versionId) 对数',
        );

        // 重新读取目标消息 metadata，验证不变量 1/2/3
        final updatedRow = await (db.select(
          db.messages,
        )..where((t) => t.id.equals(_targetMsgId))).getSingle();
        final updatedMeta =
            jsonDecode(updatedRow.metadata) as Map<String, dynamic>;
        final updatedImgs =
            (updatedMeta['generatedImages'] as List? ?? const []).cast<Map>();

        // 不变量 1：被全删的 image 整条移除
        final survivingImageIds = updatedImgs
            .map((m) => m['id'] as String)
            .toSet();
        for (final imageId in scenario.fullyDeletedImageIds) {
          expect(
            survivingImageIds.contains(imageId),
            isFalse,
            reason: 'image $imageId 的所有 version 都被删 → 应整条移除',
          );
        }

        // 不变量 2：仅部分删除的 image，image.id 不变、versions 长度恰好减少
        //          被删数量、剩余 versions 顺序与原数组一致
        for (final entry in scenario.partiallyDeleted.entries) {
          final imageId = entry.key;
          final spec = entry.value;
          expect(
            survivingImageIds.contains(imageId),
            isTrue,
            reason: '部分删除时 image.id 必须保持不变，仍存在于 generatedImages',
          );
          final survived = updatedImgs.firstWhere((m) => m['id'] == imageId);
          final survivedVersions = (survived['versions'] as List).cast<Map>();
          expect(
            survivedVersions.length,
            spec.originalVersions.length - spec.deletedVersionIds.length,
            reason: '部分删除后 versions 长度应等于 原长度 - 被删数量；image=$imageId',
          );
          // 剩余 versions 顺序与原数组（去除被删后）一致
          final expectedRemainingIds = spec.originalVersions
              .map((v) => v['id'] as String)
              .where((id) => !spec.deletedVersionIds.contains(id))
              .toList();
          expect(
            survivedVersions.map((v) => v['id'] as String).toList(),
            expectedRemainingIds,
            reason: '剩余 versions 顺序应与原数组（去除被删）一致；image=$imageId',
          );
          // 剩余 versions 不应包含任一被删 versionId
          for (final v in survivedVersions) {
            expect(
              spec.deletedVersionIds.contains(v['id'] as String),
              isFalse,
              reason: '剩余 versions 不应再含被删 versionId；image=$imageId',
            );
          }

          // 不变量 3：activeVersion 在 [0, remaining.length-1] 范围内；当原
          //         activeVersion 指向被删 version 时应重新指向
          //         min(prevActive, remaining.length-1)
          final newActive = survived['activeVersion'] as int;
          expect(
            newActive >= 0 && newActive < survivedVersions.length,
            isTrue,
            reason:
                'activeVersion=$newActive 应在 [0, ${survivedVersions.length - 1}]；image=$imageId',
          );

          final prevActive = spec.prevActiveVersion;
          final prevActiveId =
              spec.originalVersions[prevActive]['id'] as String;
          if (spec.deletedVersionIds.contains(prevActiveId)) {
            // 原 activeVersion 指向被删 → 新 activeVersion 必须 ==
            // min(prevActive, remaining.length-1)（且非负）
            final clampedPrev = prevActive < 0 ? 0 : prevActive;
            final expectedNext = clampedPrev >= survivedVersions.length
                ? survivedVersions.length - 1
                : clampedPrev;
            expect(
              newActive,
              expectedNext,
              reason:
                  '原 activeVersion 指向被删 version 时，新值应等于 min(prevActive, remaining.length-1)；image=$imageId',
            );
          }
        }

        // 不变量 5：事务后仅删除「无引用」的本地路径
        for (final entry in scenario.expectedFileExistence.entries) {
          final path = entry.key;
          final shouldExist = entry.value;
          expect(
            await File(path).exists(),
            shouldExist,
            reason: shouldExist
                ? '路径仍被引用（同库另一消息 image_versions 或另一角色 avatar），不应被删；path=$path'
                : '路径已无任何引用，事务后应被删除；path=$path',
          );
        }
      } finally {
        await db.close();
        try {
          if (await tmp.exists()) {
            await tmp.delete(recursive: true);
          }
        } catch (_) {
          // Windows 上偶发文件锁，忽略残余清理失败
        }
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════
// Property 19 辅助：场景生成
// ════════════════════════════════════════════════════════════════

/// 目标消息 ID（删除发生在这条消息上）。
const _targetMsgId = 'amsg-delete-target';

/// 同一对话内的「另一条 assistant 消息」ID — 通过 `image_versions` 引用
/// 部分待删路径，构造「外部引用」分支。
const _refMsgId = 'amsg-reference-holder';

/// 另一角色 ID — 通过 `avatar_url` 引用部分待删路径，构造「avatar 外部引用」分支。
const _otherCharForRefId = 'char-avatar-reference';

/// 一个仅部分删除的 image 的预期信息，用于断言不变量 2/3。
class _PartialDeleteSpec {
  /// 删除前 image.versions 的列表（深拷贝）。顺序与原数组一致。
  final List<Map<String, dynamic>> originalVersions;

  /// 删除前 image.activeVersion 的下标值。
  final int prevActiveVersion;

  /// 本次 deleteImages 被删除的 versionId 集合（属于该 image）。
  final Set<String> deletedVersionIds;

  const _PartialDeleteSpec({
    required this.originalVersions,
    required this.prevActiveVersion,
    required this.deletedVersionIds,
  });
}

/// Property 19 单次迭代生成的场景快照。
class _DeleteScenario {
  /// 生成的 deleteImages 入参。
  final List<DeleteImageTarget> items;

  /// 期望 deletedCount（== items 中实际命中目标 metadata 的对数；本生成器仅
  /// 生成存在的 (imageId, versionId)，因此 == items.length）。
  final int expectedDeletedCount;

  /// 全部 version 都被删除的 image.id 集合 — 这些 image 应整条移除。
  final Set<String> fullyDeletedImageIds;

  /// 仅部分删除的 image 信息（imageId → spec），用于断言不变量 2/3。
  final Map<String, _PartialDeleteSpec> partiallyDeleted;

  /// 路径 → 期望事务后是否仍存在于磁盘。
  /// - true：路径在删除集合内但仍被外部引用，或路径根本不在删除集合内 → 文件应仍存在
  /// - false：路径在删除集合内且无任何外部引用 → 文件应被删除
  final Map<String, bool> expectedFileExistence;

  const _DeleteScenario({
    required this.items,
    required this.expectedDeletedCount,
    required this.fullyDeletedImageIds,
    required this.partiallyDeleted,
    required this.expectedFileExistence,
  });
}

/// 写一个 32 字节确定性内容的本地文件，返回绝对路径。
Future<String> _writeTempAsset(
  Directory baseDir,
  String relativePath,
  int bytesSeed,
) async {
  final fullPath = p.join(baseDir.path, relativePath);
  final f = File(fullPath);
  await f.parent.create(recursive: true);
  final bytes = List<int>.generate(32, (i) => (bytesSeed + i * 11) & 0xFF);
  await f.writeAsBytes(bytes, flush: true);
  return fullPath;
}

/// 由确定性 RNG 写出场景到 [db] 与 [tmp]，并返回快照供断言使用。
///
/// 场景规模（小而完整，覆盖五条不变量）：
/// - 1 个目标角色（`_charId`）+ 1 个对话 + 1 条目标 assistant 消息（`_targetMsgId`）
/// - 1–3 张 image，每张 1–4 个 version；activeVersion 在 [0, versions.length-1]
///   随机选取；每个 version 在 [tmp] 内有真实落盘文件
/// - 删除选择策略：每张 image 等概率落入「全删 / 部分删 / 不删」三态；部分删
///   时随机抽 1..(versions.length-1) 个 version 删除，保证 versions.length >= 2
/// - 同一对话内额外写一条 assistant 消息（`_refMsgId`），其 `image_versions` 引用
///   部分待删路径 → 提供「同库另一消息引用」分支
/// - 另一角色 `_otherCharForRefId` 的 `avatar_url` 指向部分待删路径 → 提供
///   「另一角色 avatar 引用」分支
/// - 同时也保留若干「无任何外部引用」的待删路径 → 验证「应被删」分支
Future<_DeleteScenario> _seedDeleteScenario(
  AppDatabase db,
  Directory tmp,
  int seed,
) async {
  final rng = math.Random(seed);

  // 1) 角色 + 对话
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(id: _charId, name: const Value('删除测试角色')),
      );
  await db
      .into(db.characters)
      .insert(
        CharactersCompanion.insert(
          id: _otherCharForRefId,
          name: const Value('avatar 引用角色'),
        ),
      );
  const convId = 'conv-delete-target';
  await db
      .into(db.conversations)
      .insert(
        ConversationsCompanion.insert(
          id: convId,
          characterId: _charId,
          title: const Value('删除测试对话'),
        ),
      );

  // 2) 构造目标消息的 generatedImages：每 image 写真实文件到 tmp
  final imgCount = 1 + rng.nextInt(3); // 1..3
  final originalImgs = <Map<String, dynamic>>[];
  // 收集所有 (imageId, versionId, path) 三元组，方便后续选择删除目标
  final allEntries = <({String imageId, String versionId, String path})>[];

  for (var i = 0; i < imgCount; i++) {
    final imageId = 'img-$i';
    final verCount = 1 + rng.nextInt(4); // 1..4
    final versions = <Map<String, dynamic>>[];
    for (var v = 0; v < verCount; v++) {
      final versionId = 'img-$i-v-$v';
      final path = await _writeTempAsset(
        tmp,
        p.join('img-$i-v-$v.png'),
        seed + i * 1000 + v,
      );
      versions.add({'id': versionId, 'url': path, 'prompt': 'p-$i-$v'});
      allEntries.add((imageId: imageId, versionId: versionId, path: path));
    }
    final activeVersion = rng.nextInt(verCount);
    originalImgs.add({
      'id': imageId,
      'url': versions[activeVersion]['url'],
      'prompt': versions[activeVersion]['prompt'],
      'activeVersion': activeVersion,
      'versions': versions,
    });
  }

  await db
      .into(db.messages)
      .insert(
        MessagesCompanion.insert(
          id: _targetMsgId,
          conversationId: convId,
          role: 'assistant',
          content: const Value('目标消息'),
          seq: const Value(1),
          createdAt: Value(
            DateTime.fromMillisecondsSinceEpoch(1700000000 * 1000),
          ),
          metadata: Value(jsonEncode({'generatedImages': originalImgs})),
        ),
      );

  // 3) 选择删除目标：对每张 image 三态决策（全删 / 部分删 / 不删）
  final items = <DeleteImageTarget>[];
  final fullyDeletedImageIds = <String>{};
  final partiallyDeleted = <String, _PartialDeleteSpec>{};
  // 路径 → 是否在删除集合内
  final pathInDeleteSet = <String, bool>{};

  for (var i = 0; i < imgCount; i++) {
    final imageId = 'img-$i';
    final imgEntries = allEntries.where((e) => e.imageId == imageId).toList();
    final verCount = imgEntries.length;
    final originalVersions = (originalImgs[i]['versions'] as List)
        .cast<Map<String, dynamic>>();
    final prevActive = originalImgs[i]['activeVersion'] as int;

    final mode = rng.nextInt(3); // 0: 不删，1: 部分删（仅 verCount>=2 时），2: 全删
    if (mode == 0 || (mode == 1 && verCount < 2)) {
      // 不删：所有路径默认不在删除集合
      for (final e in imgEntries) {
        pathInDeleteSet[e.path] = false;
      }
      continue;
    }
    if (mode == 2) {
      // 全删
      for (final e in imgEntries) {
        items.add(
          DeleteImageTarget(
            messageId: _targetMsgId,
            imageId: e.imageId,
            versionId: e.versionId,
          ),
        );
        pathInDeleteSet[e.path] = true;
      }
      fullyDeletedImageIds.add(imageId);
      continue;
    }
    // 部分删除：随机选择 1..(verCount-1) 个 version
    final delCount = 1 + rng.nextInt(verCount - 1); // [1, verCount-1]
    final shuffled = imgEntries.toList()..shuffle(rng);
    final toDelete = shuffled.take(delCount).toSet();
    final deletedVersionIds = <String>{};
    for (final e in imgEntries) {
      if (toDelete.contains(e)) {
        items.add(
          DeleteImageTarget(
            messageId: _targetMsgId,
            imageId: e.imageId,
            versionId: e.versionId,
          ),
        );
        pathInDeleteSet[e.path] = true;
        deletedVersionIds.add(e.versionId);
      } else {
        pathInDeleteSet[e.path] = false;
      }
    }
    partiallyDeleted[imageId] = _PartialDeleteSpec(
      originalVersions: originalVersions
          .map((v) => Map<String, dynamic>.from(v))
          .toList(growable: false),
      prevActiveVersion: prevActive,
      deletedVersionIds: deletedVersionIds,
    );
  }

  // 4) 构造外部引用：在删除集合内的路径中，随机抽 ~1/2 通过另一消息
  //    `image_versions` 引用，再随机抽至多 1 条通过另一角色 avatar 引用。
  //    其余删除路径将无任何外部引用 → 应被真实删除。
  final deletedPaths = pathInDeleteSet.entries
      .where((e) => e.value)
      .map((e) => e.key)
      .toList();
  final referencedByOtherMsg = <String>{};
  for (final p in deletedPaths) {
    if (rng.nextBool()) {
      referencedByOtherMsg.add(p);
    }
  }
  String? avatarRefPath;
  // 至多挑一条删除路径作为 avatar 引用，且该路径不必与 referencedByOtherMsg 互斥
  if (deletedPaths.isNotEmpty && rng.nextInt(3) == 0) {
    avatarRefPath = deletedPaths[rng.nextInt(deletedPaths.length)];
  }

  // 写另一条 assistant 消息：image_versions 引用 referencedByOtherMsg 中的路径
  if (referencedByOtherMsg.isNotEmpty) {
    final imageVersions = referencedByOtherMsg
        .map((path) => {'id': 'ref-${path.hashCode}', 'url': path})
        .toList();
    await db
        .into(db.messages)
        .insert(
          MessagesCompanion.insert(
            id: _refMsgId,
            conversationId: convId,
            role: 'assistant',
            content: const Value('外部引用消息'),
            seq: const Value(2),
            createdAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000010 * 1000),
            ),
            metadata: Value(jsonEncode({'image_versions': imageVersions})),
          ),
        );
  }

  // 设另一角色 avatar_url（avatarRefPath 可能为 null）
  if (avatarRefPath != null) {
    await (db.update(db.characters)
          ..where((t) => t.id.equals(_otherCharForRefId)))
        .write(CharactersCompanion(avatarUrl: Value(avatarRefPath)));
  }

  // 5) 计算「期望事务后文件存在性」
  final expectedFileExistence = <String, bool>{};
  for (final entry in pathInDeleteSet.entries) {
    final path = entry.key;
    final inDelete = entry.value;
    if (!inDelete) {
      // 未在删除集合 → 必然仍存在
      expectedFileExistence[path] = true;
    } else {
      // 在删除集合 → 仅当被外部引用时仍存在
      final refByMsg = referencedByOtherMsg.contains(path);
      final refByAvatar = avatarRefPath == path;
      expectedFileExistence[path] = refByMsg || refByAvatar;
    }
  }

  return _DeleteScenario(
    items: items,
    expectedDeletedCount: items.length,
    fullyDeletedImageIds: fullyDeletedImageIds,
    partiallyDeleted: partiallyDeleted,
    expectedFileExistence: expectedFileExistence,
  );
}
