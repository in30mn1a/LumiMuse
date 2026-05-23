// Feature: flutter-parity-completion, Task 11.5: 集成测试 — 完整 duplicate 流程
//
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9**
//
// 与 Property 17（`character_duplicate_cascade_test.dart`）互补：
// - Property 17 用 `package:glados` 在小规模随机入参上反复检查级联拷贝的一般性质。
// - 本集成测试构造一个相对完整、贴近真实业务的场景（角色 + 多对话 + 多消息含
//   本地图片 metadata + 多记忆），跑完整 `CharacterActions.duplicate` 流程，
//   再加一个「事务失败回滚」场景验证兜底清理逻辑。
//
// 关键约束（与 design.md「P1 / R10」与 tasks.md 11.1 / 11.2 / 11.3 一致）：
// - 文件复制发生在 Drift 事务**之外**：先扫描所有本地资产路径，再在事务内
//   级联写入数据库；
// - 任一资产 fs 复制只发生一次：同一旧路径在 metadata 多处被引用时复用同一新路径；
// - 事务失败时调用 `_safeDeletePendingFiles` 兜底清理已复制出的新文件，
//   保证不留下孤儿文件，同时数据库保持原始数据完整（事务回滚）。
//
// 测试基础设施：
// - 使用内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）；
// - 通过 `TestDefaultBinaryMessengerBinding` mock `plugins.flutter.io/path_provider`
//   把 `getApplicationDocumentsDirectory` 重定向到一个临时目录，避免污染真实路径。
//   `copyLocalAsset` 的实现使用 `p.dirname(sourcePath)` 作为新文件目录，因此只要
//   原始文件位于临时目录内，所有新文件也会落在同一临时目录内，便于断言清理。

import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:path/path.dart' as p;

/// 创建用于测试的内存 Drift 数据库，与项目内其他 PBT 测试保持一致。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 用确定性内容写出一个本地资产文件，返回绝对路径。
///
/// `bytesSeed` 仅用于让不同文件的字节序列不同，便于「字节级相等」断言能区分文件。
Future<String> _writeAsset(
  Directory baseDir,
  String relativePath, {
  required int bytesSeed,
}) async {
  final fullPath = p.join(baseDir.path, relativePath);
  final f = File(fullPath);
  await f.parent.create(recursive: true);
  // 32 字节的确定性内容：足够区分不同文件，又不至于让磁盘 IO 成为瓶颈
  final bytes = Uint8List(32);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = (bytesSeed + i * 7) & 0xFF;
  }
  await f.writeAsBytes(bytes, flush: true);
  return fullPath;
}

/// 完整种子：角色 + 2 对话 + 3 消息（含本地图片 metadata）+ 3 记忆。
///
/// 返回值：
/// - originalCharId：原角色 id
/// - msgIds：按种子顺序记录的 3 条原消息 id（用于断言 source_msg_ids 重写）
/// - assetPaths：所有本地资产的旧路径（用于断言新文件存在 + 字节级相等）
class _SeededCase {
  final String originalCharId;
  final String avatarPath;
  final String conv1Id;
  final String conv2Id;
  final String msgUserId;
  final String msgAssistant1Id;
  final String msgAssistant2Id;
  final String attachmentPath;
  final String genImage1CurrentPath;
  final String genImage1V1Path;
  final String imageVersion2Path;
  final String mem1Id;
  final String mem2Id;
  final String mem3Id;
  final Set<String> assetPaths;

  const _SeededCase({
    required this.originalCharId,
    required this.avatarPath,
    required this.conv1Id,
    required this.conv2Id,
    required this.msgUserId,
    required this.msgAssistant1Id,
    required this.msgAssistant2Id,
    required this.attachmentPath,
    required this.genImage1CurrentPath,
    required this.genImage1V1Path,
    required this.imageVersion2Path,
    required this.mem1Id,
    required this.mem2Id,
    required this.mem3Id,
    required this.assetPaths,
  });
}

Future<_SeededCase> _seedFullCase(AppDatabase db, Directory baseDir) async {
  // 1) 头像：本地路径
  final avatarPath = await _writeAsset(
    baseDir,
    p.join('avatars', 'avatar_origin.png'),
    bytesSeed: 11,
  );

  // 2) 用户附件 + 助手生图（含 versions）+ 第二条助手 image_versions
  final attachmentPath = await _writeAsset(
    baseDir,
    p.join('attachments', 'file_origin.bin'),
    bytesSeed: 23,
  );
  final genImage1CurrentPath = await _writeAsset(
    baseDir,
    p.join('generated', 'gen1_current.png'),
    bytesSeed: 47,
  );
  final genImage1V1Path = await _writeAsset(
    baseDir,
    p.join('generated', 'gen1_v1.png'),
    bytesSeed: 89,
  );
  final imageVersion2Path = await _writeAsset(
    baseDir,
    p.join('generated', 'gen2_v0.png'),
    bytesSeed: 131,
  );

  const originalCharId = 'origchar';
  const conv1Id = 'orig-c1';
  const conv2Id = 'orig-c2';
  const msgUserId = 'orig-m1';
  const msgAssistant1Id = 'orig-m2';
  const msgAssistant2Id = 'orig-m3';
  const mem1Id = 'orig-mem1';
  const mem2Id = 'orig-mem2';
  const mem3Id = 'orig-mem3';

  // 3) 角色（含全部字段）
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: originalCharId,
          name: const Value('原角色喵'),
          avatarUrl: Value(avatarPath),
          personality: const Value('温柔暖光'),
          scenario: const Value('安静的客厅'),
          greeting: const Value('你回来啦'),
          exampleDialogue: const Value('{{user}}: 你好\n{{char}}: 你好呀'),
          systemPrompt: const Value('请保持温柔暖光体系'),
          basicInfo: const Value('猫娘 / 月色'),
          otherInfo: const Value('喜欢茉莉花茶'),
          imageTags: const Value('1girl, cat ears, soft lighting'),
        ),
      );

  // 4) 对话 1：保留 ignore_memory == 1 用于校验副本继承
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: conv1Id,
          characterId: originalCharId,
          title: const Value('安静的傍晚'),
          ignoreMemory: const Value(1),
        ),
      );
  // 对话 2：默认 ignore_memory == 0
  await db.into(db.conversations).insert(
        ConversationsCompanion.insert(
          id: conv2Id,
          characterId: originalCharId,
          title: const Value('窗外有星'),
        ),
      );

  // 5) 消息 metadata：覆盖 attachments / generatedImages.url + versions / image_versions
  final userMeta = jsonEncode({
    'attachments': [
      {'url': attachmentPath, 'name': 'file_origin.bin', 'mime': 'application/octet-stream'},
    ],
  });
  final assistant1Meta = jsonEncode({
    'generatedImages': [
      {
        'id': 'img-1',
        'url': genImage1CurrentPath,
        'prompt': '1girl, cat ears',
        'activeVersion': 1,
        'versions': [
          {'id': 'v0', 'url': genImage1V1Path, 'prompt': 'old prompt'},
          {'id': 'v1', 'url': genImage1CurrentPath, 'prompt': '1girl, cat ears'},
        ],
      },
    ],
  });
  final assistant2Meta = jsonEncode({
    'image_versions': [
      {'id': 'iv0', 'url': imageVersion2Path, 'prompt': 'starry'},
    ],
    // 同时混入一个 http 远程路径，断言 remap 不会改 http 链接
    'attachments': [
      {'url': 'https://example.com/remote.png', 'name': 'remote.png'},
    ],
  });

  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: msgUserId,
          conversationId: conv1Id,
          role: 'user',
          content: const Value('你好，看看这张图'),
          tokenCount: const Value(7),
          seq: const Value(0),
          metadata: Value(userMeta),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: msgAssistant1Id,
          conversationId: conv1Id,
          role: 'assistant',
          content: const Value('好哦，给你画了一张'),
          tokenCount: const Value(8),
          seq: const Value(1),
          metadata: Value(assistant1Meta),
        ),
      );
  await db.into(db.messages).insert(
        MessagesCompanion.insert(
          id: msgAssistant2Id,
          conversationId: conv2Id,
          role: 'assistant',
          content: const Value('窗外有星呢'),
          tokenCount: const Value(6),
          seq: const Value(0),
          metadata: Value(assistant2Meta),
        ),
      );

  // 6) 记忆：source_msg_ids 覆盖「跨对话引用 / 单条引用 / 空数组」三种场景
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: mem1Id,
          characterId: originalCharId,
          category: 'preference',
          content: '喜欢茉莉花茶',
          tags: const Value('["茶","偏好"]'),
          sourceMsgIds: Value(jsonEncode([msgUserId, msgAssistant1Id])),
        ),
      );
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: mem2Id,
          characterId: originalCharId,
          category: 'observation',
          content: '窗外有星',
          tags: const Value('[]'),
          sourceMsgIds: Value(jsonEncode([msgAssistant2Id])),
        ),
      );
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: mem3Id,
          characterId: originalCharId,
          category: 'misc',
          content: '没有来源消息的记忆',
          sourceMsgIds: const Value('[]'),
        ),
      );

  return _SeededCase(
    originalCharId: originalCharId,
    avatarPath: avatarPath,
    conv1Id: conv1Id,
    conv2Id: conv2Id,
    msgUserId: msgUserId,
    msgAssistant1Id: msgAssistant1Id,
    msgAssistant2Id: msgAssistant2Id,
    attachmentPath: attachmentPath,
    genImage1CurrentPath: genImage1CurrentPath,
    genImage1V1Path: genImage1V1Path,
    imageVersion2Path: imageVersion2Path,
    mem1Id: mem1Id,
    mem2Id: mem2Id,
    mem3Id: mem3Id,
    assetPaths: <String>{
      avatarPath,
      attachmentPath,
      genImage1CurrentPath,
      genImage1V1Path,
      imageVersion2Path,
    },
  );
}

/// 列出某目录下当前存在的所有普通文件，便于「文件清理」断言。
Future<Set<String>> _listFiles(Directory dir) async {
  if (!await dir.exists()) return <String>{};
  final out = <String>{};
  await for (final entity in dir.list(recursive: true, followLinks: false)) {
    if (entity is File) out.add(entity.path);
  }
  return out;
}

/// 从 metadata JSON 字符串中抽取所有可能承载本地路径的 `url` 字段，
/// 用于断言新消息 metadata 不再引用任一旧路径。
Set<String> _collectAllUrls(String metadataJson) {
  final result = <String>{};
  Map<String, dynamic> meta;
  try {
    final decoded = jsonDecode(metadataJson);
    meta = decoded is Map<String, dynamic>
        ? decoded
        : (decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{});
  } catch (_) {
    return result;
  }

  void addIfString(dynamic v) {
    if (v is String) result.add(v);
  }

  final gens = meta['generatedImages'];
  if (gens is List) {
    for (final img in gens) {
      if (img is Map) {
        addIfString(img['url']);
        final versions = img['versions'];
        if (versions is List) {
          for (final v in versions) {
            if (v is Map) addIfString(v['url']);
          }
        }
      }
    }
  }
  final imgVer = meta['image_versions'];
  if (imgVer is List) {
    for (final v in imgVer) {
      if (v is Map) addIfString(v['url']);
    }
  }
  final atts = meta['attachments'];
  if (atts is List) {
    for (final a in atts) {
      if (a is Map) addIfString(a['url']);
    }
  }
  return result;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // 把 path_provider 重定向到测试自己创建的临时目录，避免污染真实用户目录。
  // `copyLocalAsset` 实际只在 `p.dirname(sourcePath)` 下落盘，因此 path_provider
  // 主要影响「源路径无父目录」的极端兜底分支；这里仍设置为同一临时目录以保证
  // 即便兜底也会落在测试可控的范围内。
  late Directory tmpRoot;

  setUpAll(() async {
    tmpRoot = await Directory.systemTemp.createTemp('lumimuse_dup_full_');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async {
        if (methodCall.method == 'getApplicationDocumentsDirectory' ||
            methodCall.method == 'getApplicationSupportDirectory' ||
            methodCall.method == 'getTemporaryDirectory') {
          return tmpRoot.path;
        }
        return null;
      },
    );
  });

  tearDownAll(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    if (await tmpRoot.exists()) {
      await tmpRoot.delete(recursive: true);
    }
  });

  group('集成测试：CharacterActions.duplicate 完整流程', () {
    test(
      '成功路径：新角色/对话/消息/记忆全部落库，metadata 路径被 remap，'
      '记忆 source_msg_ids 被重写，每个本地资产都有字节级相等的副本',
      () async {
        // 每个用例独立一个子目录，避免互相干扰
        final caseDir = await Directory(
          p.join(tmpRoot.path, 'case_success'),
        ).create(recursive: true);
        addTearDown(() async {
          if (await caseDir.exists()) {
            await caseDir.delete(recursive: true);
          }
        });

        final db = _createTestDb();
        addTearDown(db.close);

        final seed = await _seedFullCase(db, caseDir);

        // 记录复制前文件快照（仅 5 个原始资产）
        final filesBefore = await _listFiles(caseDir);
        expect(
          filesBefore.length,
          5,
          reason: '复制前应只有 5 个原始资产',
        );

        final actions = CharacterActions(db, CharacterImagesActions(db));
        final newCharId = await actions.duplicate(seed.originalCharId);

        // ── 数据库断言 ──────────────────────────────────────────────

        // 1) 新角色：name 末尾追加「（副本）」，全部字段沿用，avatar_url 指向新文件
        final newChar = await (db.select(db.characters)
              ..where((t) => t.id.equals(newCharId)))
            .getSingle();
        expect(newChar.name, '原角色喵（副本）');
        expect(newChar.personality, '温柔暖光');
        expect(newChar.scenario, '安静的客厅');
        expect(newChar.greeting, '你回来啦');
        expect(newChar.exampleDialogue, '{{user}}: 你好\n{{char}}: 你好呀');
        expect(newChar.systemPrompt, '请保持温柔暖光体系');
        expect(newChar.basicInfo, '猫娘 / 月色');
        expect(newChar.otherInfo, '喜欢茉莉花茶');
        expect(newChar.imageTags, '1girl, cat ears, soft lighting');
        expect(newChar.avatarUrl, isNotNull);
        expect(
          newChar.avatarUrl,
          isNot(seed.avatarPath),
          reason: '头像 url 必须指向新副本，不能复用原路径',
        );

        // 2) 新对话：数量 / 外键 / title / ignore_memory 一致
        final newConvs = await (db.select(db.conversations)
              ..where((t) => t.characterId.equals(newCharId))
              ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
            .get();
        expect(newConvs.length, 2);
        for (final c in newConvs) {
          expect(c.id, isNot(seed.conv1Id));
          expect(c.id, isNot(seed.conv2Id));
        }
        // 标题集合应与原对话一致
        final newTitles = newConvs.map((c) => c.title).toSet();
        expect(newTitles, {'安静的傍晚', '窗外有星'});
        // 「安静的傍晚」副本应继承 ignore_memory == 1
        final dupQuiet = newConvs.firstWhere((c) => c.title == '安静的傍晚');
        expect(dupQuiet.ignoreMemory, 1);
        final dupStar = newConvs.firstWhere((c) => c.title == '窗外有星');
        expect(dupStar.ignoreMemory, 0);

        final newConvIds = newConvs.map((c) => c.id).toSet();

        // 3) 新消息：数量 / 外键 / metadata 路径 remap
        final newMsgs = await (db.select(db.messages)
              ..where((t) => t.conversationId.isIn(newConvIds))
              ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
            .get();
        expect(newMsgs.length, 3, reason: '原本 3 条消息全部应有副本');
        for (final m in newMsgs) {
          expect(
            m.id,
            isNot(anyOf(
              seed.msgUserId,
              seed.msgAssistant1Id,
              seed.msgAssistant2Id,
            )),
            reason: '所有新消息 id 必须重新生成',
          );
          expect(newConvIds.contains(m.conversationId), isTrue,
              reason: '消息 conversation_id 必须指向新对话');
        }

        // metadata 中所有 url 必须不再是任一旧本地路径，
        // 且若是本地路径则必须落在 caseDir 范围内
        for (final m in newMsgs) {
          final urls = _collectAllUrls(m.metadata);
          for (final url in urls) {
            expect(
              seed.assetPaths.contains(url),
              isFalse,
              reason: 'metadata url 不应再引用任一旧本地路径，发现：$url',
            );
            // http(s) 链接保持原值，不应被改写
            if (url.startsWith('http://') || url.startsWith('https://')) {
              continue;
            }
            // 本地路径应落在 caseDir 内（来自 copyLocalAsset 的副本）
            expect(
              p.isWithin(caseDir.path, url),
              isTrue,
              reason: '新本地路径必须位于测试临时目录内：$url',
            );
          }
        }

        // 验证 http(s) 链接被保留：assistant2 的远程附件
        final newAssistant2 = newMsgs
            .firstWhere((m) => m.content == '窗外有星呢');
        final newA2Meta = jsonDecode(newAssistant2.metadata) as Map<String, dynamic>;
        final newA2Att = (newA2Meta['attachments'] as List).first as Map;
        expect(newA2Att['url'], 'https://example.com/remote.png');

        // 旧消息 → 新消息 id 的映射（按 content 唯一对应）
        final originalById = {
          seed.msgUserId: '你好，看看这张图',
          seed.msgAssistant1Id: '好哦，给你画了一张',
          seed.msgAssistant2Id: '窗外有星呢',
        };
        final msgIdMap = <String, String>{};
        for (final entry in originalById.entries) {
          final newMsg = newMsgs.firstWhere((m) => m.content == entry.value);
          msgIdMap[entry.key] = newMsg.id;
        }

        // 4) 新记忆：character_id 重写 + source_msg_ids 重写
        final newMems = await (db.select(db.memories)
              ..where((t) => t.characterId.equals(newCharId)))
            .get();
        expect(newMems.length, 3);

        final newMemByContent = {
          for (final m in newMems) m.content: m,
        };
        // mem1: source_msg_ids 应被映射成新 msg id 列表
        final mem1Ids =
            (jsonDecode(newMemByContent['喜欢茉莉花茶']!.sourceMsgIds) as List)
                .cast<String>();
        expect(mem1Ids, [msgIdMap[seed.msgUserId], msgIdMap[seed.msgAssistant1Id]]);
        // mem2: 单元素映射
        final mem2Ids =
            (jsonDecode(newMemByContent['窗外有星']!.sourceMsgIds) as List)
                .cast<String>();
        expect(mem2Ids, [msgIdMap[seed.msgAssistant2Id]]);
        // mem3: 空数组保持空
        final mem3Ids =
            (jsonDecode(newMemByContent['没有来源消息的记忆']!.sourceMsgIds) as List);
        expect(mem3Ids, isEmpty);
        // 所有新记忆 id 必须重新生成
        for (final m in newMems) {
          expect(
            m.id,
            isNot(anyOf(seed.mem1Id, seed.mem2Id, seed.mem3Id)),
            reason: '记忆 id 必须重新生成',
          );
        }

        // ── 文件系统断言 ────────────────────────────────────────────

        // 复制后总文件数 = 原始 5 + 新增 5（每个旧路径只复制一次）
        final filesAfter = await _listFiles(caseDir);
        expect(
          filesAfter.length,
          10,
          reason: '5 个原始资产去重后应额外产生 5 个副本',
        );

        // 原始文件仍存在
        for (final original in seed.assetPaths) {
          expect(File(original).existsSync(), isTrue,
              reason: '原始资产不应被改动：$original');
        }

        // 收集新角色 + 新消息 metadata 中引用的所有本地路径，
        // 它们都应是真实存在的新文件，且字节内容与旧路径一致
        final newAvatar = newChar.avatarUrl!;
        expect(File(newAvatar).existsSync(), isTrue);
        await _assertBytesEqual(seed.avatarPath, newAvatar);

        // 解析新消息 metadata 中的「旧路径 → 新路径」映射并断言字节级相等
        final pathMappingFromMetadata = <String, String>{};
        for (final m in newMsgs) {
          final newMeta = jsonDecode(m.metadata) as Map<String, dynamic>;
          // user 消息：attachments[0].url
          if (m.content == '你好，看看这张图') {
            final att = (newMeta['attachments'] as List).first as Map;
            pathMappingFromMetadata[seed.attachmentPath] = att['url'] as String;
          }
          // assistant1：generatedImages[0] 当前 url 与 versions[*]
          if (m.content == '好哦，给你画了一张') {
            final img = (newMeta['generatedImages'] as List).first as Map;
            // 当前 url 对应 v1 副本（与原 v1 一致）
            pathMappingFromMetadata[seed.genImage1CurrentPath] =
                img['url'] as String;
            final versions = (img['versions'] as List).cast<Map>();
            // versions[0] = v0 副本
            pathMappingFromMetadata[seed.genImage1V1Path] =
                versions[0]['url'] as String;
            // versions[1] 应与当前 url 一致（同一旧路径只复制一次）
            expect(
              versions[1]['url'],
              img['url'],
              reason: '同一旧路径在 metadata 多处出现时副本应一致',
            );
          }
          // assistant2：image_versions[0]
          if (m.content == '窗外有星呢') {
            final iv = (newMeta['image_versions'] as List).first as Map;
            pathMappingFromMetadata[seed.imageVersion2Path] = iv['url'] as String;
          }
        }

        // 期望覆盖头像 + 4 个消息内资产 = 5 条映射
        expect(pathMappingFromMetadata.length, 4,
            reason: '4 个消息相关旧路径应都被映射');
        for (final entry in pathMappingFromMetadata.entries) {
          await _assertBytesEqual(entry.key, entry.value);
        }
      },
    );

    test(
      '事务失败：新文件被清理；新角色/对话/消息/记忆均未进入数据库；原始数据完整保留',
      () async {
        final caseDir = await Directory(
          p.join(tmpRoot.path, 'case_failure'),
        ).create(recursive: true);
        addTearDown(() async {
          if (await caseDir.exists()) {
            await caseDir.delete(recursive: true);
          }
        });

        final db = _createTestDb();
        addTearDown(db.close);

        final seed = await _seedFullCase(db, caseDir);

        // 复制前快照
        final filesBefore = await _listFiles(caseDir);
        final filesBeforeSet = filesBefore.toSet();
        expect(filesBefore.length, 5);

        // 用 SQLite trigger 强制让任何新增 messages 行的插入抛错。
        // duplicate 内事务会先成功插入新角色 + 新对话(两条)，再尝试插入新消息 ——
        // 此时触发器抛错，整个事务被回滚（11.3 finally 兜底删除已复制出的文件）。
        await db.customStatement(
          "CREATE TRIGGER fail_on_msg_insert "
          "BEFORE INSERT ON messages "
          "BEGIN SELECT RAISE(FAIL, '强制失败用于测试'); END",
        );
        addTearDown(() async {
          // 兜底：测试结束时移除触发器，避免影响其他用例
          try {
            await db.customStatement('DROP TRIGGER IF EXISTS fail_on_msg_insert');
          } catch (_) {/* ignore */}
        });

        final actions = CharacterActions(db, CharacterImagesActions(db));

        Object? caught;
        try {
          await actions.duplicate(seed.originalCharId);
        } catch (e) {
          caught = e;
        }
        expect(
          caught,
          isNotNull,
          reason: 'duplicate 在事务失败时必须把异常透传给上层',
        );

        // ── 文件系统断言 ────────────────────────────────────────────
        // 11.3：所有「复制阶段已经落盘的新文件」必须被 finally / catch 兜底清理
        final filesAfter = await _listFiles(caseDir);
        expect(
          filesAfter.toSet(),
          filesBeforeSet,
          reason: '事务失败时新复制出的文件必须被清理，仅保留 5 个原始资产',
        );
        // 原始文件不应被误删
        for (final original in seed.assetPaths) {
          expect(File(original).existsSync(), isTrue,
              reason: '原始资产不应被影响：$original');
        }

        // ── 数据库断言 ──────────────────────────────────────────────
        // 角色：仅原角色一条
        final allChars = await db.select(db.characters).get();
        expect(allChars.length, 1);
        expect(allChars.single.id, seed.originalCharId);
        expect(allChars.single.name, '原角色喵');

        // 对话：仅原 2 条
        final allConvs = await db.select(db.conversations).get();
        expect(allConvs.length, 2);
        expect(
          allConvs.map((c) => c.id).toSet(),
          {seed.conv1Id, seed.conv2Id},
        );

        // 消息：仅原 3 条
        final allMsgs = await db.select(db.messages).get();
        expect(allMsgs.length, 3);
        expect(
          allMsgs.map((m) => m.id).toSet(),
          {seed.msgUserId, seed.msgAssistant1Id, seed.msgAssistant2Id},
        );

        // 记忆：仅原 3 条，character_id 全部为原角色
        final allMems = await db.select(db.memories).get();
        expect(allMems.length, 3);
        for (final m in allMems) {
          expect(m.characterId, seed.originalCharId);
        }
      },
    );
  });
}

/// 断言两个文件字节级相等 — duplicate 既不应该改源文件也不应改副本。
Future<void> _assertBytesEqual(String oldPath, String newPath) async {
  final oldBytes = await File(oldPath).readAsBytes();
  final newBytes = await File(newPath).readAsBytes();
  expect(
    newBytes,
    oldBytes,
    reason: '$newPath 与 $oldPath 字节级内容必须一致',
  );
}
