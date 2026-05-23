// Feature: flutter-parity-completion, Property 17: 角色级联拷贝完整性
//
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9**
//
// 配置 50 次迭代（design.md 已说明：复杂结构性质测试用 50 次迭代以平衡时长）。
//
// 性质（与 tasks.md 11.4 任务说明对齐）：对随机生成的 (角色, 多对话, 多消息含
// 本地资产, 多记忆) 场景，调用 `CharacterActions.duplicate(c.id)` 后必须满足
// 以下不变量：
//   1. 字段相等：`name == '${original.name}（副本）'`，其余 personality /
//      scenario / greeting / example_dialogue / system_prompt / image_tags /
//      basic_info / other_info 完全等同；avatar_url 本地路径 → 新路径
//   2. 外键重写：所有新对话 character_id 指向新 newCharId；所有新消息
//      conversation_id 指向新对话 ID；所有新记忆 character_id 指向 newCharId
//   3. 资产去重双射：每个旧本地路径对应唯一新路径（双射），且新路径文件实际存在
//   4. source_msg_ids 重写：每条记忆的 source_msg_ids JSON 数组中的旧 msgId
//      被映射成对应的新 msgId
//   5. 头像分支：原 http(s) → 新角色 avatar_url 沿用原值；原本地路径 → 新角色
//      avatar_url 是新文件路径且文件存在
//   6. 事务原子性：模拟事务失败时所有插入回滚 + 新文件被清理
//
// 测试基础设施：
// - 使用内存 Drift（`AppDatabase.forTesting(NativeDatabase.memory())`）。
// - 通过 `TestDefaultBinaryMessengerBinding` mock `plugins.flutter.io/path_provider`
//   把 `getApplicationDocumentsDirectory` 重定向到测试自己创建的临时目录，
//   避免污染真实路径。
// - `copyLocalAsset` 实现使用 `p.dirname(sourcePath)` 作为新文件目录，因此每次
//   迭代用独立子目录承载源文件，所有副本也会落在同一目录内，便于按目录列出
//   文件做断言。

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart'
    hide expect, group, test, setUpAll, tearDownAll;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/providers/character_provider.dart';
import 'package:path/path.dart' as p;

/// 测试根目录 — `setUpAll` 创建，`tearDownAll` 清理。
late Directory _tmpRoot;

/// 自增计数器，确保每次属性迭代获得独立的子目录路径，互不干扰。
int _iterationCounter = 0;

/// 创建用于测试的内存 Drift 数据库 — 与项目其他 PBT 保持一致。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 一个属性迭代生成的「角色 + 多对话 + 多消息含本地资产 + 多记忆」场景快照。
///
/// 场景在 [_seedScenario] 内部按确定性 RNG 构造，外部只读取这些字段做断言。
class _Scenario {
  final String originalCharId;

  /// 期望角色字段值（用于断言「字段相等」）。
  final String name;
  final String personality;
  final String scenario;
  final String greeting;
  final String exampleDialogue;
  final String systemPrompt;
  final String basicInfo;
  final String otherInfo;
  final String imageTags;

  /// avatar_url 的原值。`null` / 空 / `http(s)://` / 本地路径四种分支都可能。
  final String? avatarUrl;

  /// 三态：'local' / 'http' / 'empty'，用于在断言阶段决定头像分支预期。
  final String avatarKind;

  /// 原对话 ID 集合，按插入顺序。
  final List<String> originalConvIds;

  /// 每条对话的 (title, ignoreMemory)，与 [originalConvIds] 一一对应。
  final List<({String title, int ignoreMemory})> originalConvSpecs;

  /// 原消息 ID 集合（跨所有对话），按插入顺序。
  final List<String> originalMsgIds;

  /// 每条原消息的 (conversationId, role, content)，与 [originalMsgIds] 一一对应。
  final List<({String convId, String role, String content})> originalMsgSpecs;

  /// 原记忆 ID 集合，按插入顺序。
  final List<String> originalMemIds;

  /// 每条记忆的 source_msg_ids（JSON 解析后的字符串列表）。
  /// 元素可能是「真实存在的旧 msgId」也可能是「外部 ID」（用于覆盖未命中映射的兜底分支）。
  final List<List<String>> originalMemSourceMsgIds;

  /// 该场景实际涉及的所有「本地资产」旧路径集合（不重复）。
  ///
  /// 包含：本地头像（若有）+ 所有消息 metadata 内引用的本地路径。
  /// 用于断言「每个旧本地路径对应唯一新路径（双射）」的基数关系。
  final Set<String> localAssetPaths;

  const _Scenario({
    required this.originalCharId,
    required this.name,
    required this.personality,
    required this.scenario,
    required this.greeting,
    required this.exampleDialogue,
    required this.systemPrompt,
    required this.basicInfo,
    required this.otherInfo,
    required this.imageTags,
    required this.avatarUrl,
    required this.avatarKind,
    required this.originalConvIds,
    required this.originalConvSpecs,
    required this.originalMsgIds,
    required this.originalMsgSpecs,
    required this.originalMemIds,
    required this.originalMemSourceMsgIds,
    required this.localAssetPaths,
  });
}

/// 写出 32 字节确定性内容的本地文件，返回绝对路径。
///
/// 不同 `bytesSeed` 产生不同字节序列，便于副本字节级相等断言。
Future<String> _writeAsset(
  Directory baseDir,
  String relativePath, {
  required int bytesSeed,
}) async {
  final fullPath = p.join(baseDir.path, relativePath);
  final f = File(fullPath);
  await f.parent.create(recursive: true);
  final bytes = Uint8List(32);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = (bytesSeed + i * 11) & 0xFF;
  }
  await f.writeAsBytes(bytes, flush: true);
  return fullPath;
}

/// 列出某目录下当前存在的所有普通文件。
Future<Set<String>> _listFiles(Directory dir) async {
  if (!await dir.exists()) return <String>{};
  final out = <String>{};
  await for (final entity in dir.list(recursive: true, followLinks: false)) {
    if (entity is File) out.add(entity.path);
  }
  return out;
}

/// 由确定性 RNG 构造一份场景，把所有数据写入 [db] 与 [caseDir]，并返回快照。
///
/// 场景规模（小而完整，覆盖 6 项验收要点）：
/// - 1–3 对话，每对话 1–3 消息（user/assistant 混合）
/// - assistant 消息可能带 `generatedImages` (含 versions)、可能带 `image_versions`
/// - user 消息可能带 `attachments`，可能混入 http(s) 远程路径
/// - 0–3 记忆，`source_msg_ids` 元素从「真实旧 msgId」与「外部 ID」中按概率抽取
/// - 头像分支：`local` / `http` / `empty` 三态等概率
Future<_Scenario> _seedScenario(
  AppDatabase db,
  int seed,
  Directory caseDir,
) async {
  final rng = math.Random(seed);

  // ── 1. 资产池：构造 1–4 个本地资产文件 ────────────────────────────
  final assetPoolSize = 1 + rng.nextInt(4); // 1..4
  final assetPool = <String>[];
  for (var i = 0; i < assetPoolSize; i++) {
    final pth = await _writeAsset(
      caseDir,
      p.join('asset_$i.bin'),
      bytesSeed: seed + i * 97,
    );
    assetPool.add(pth);
  }

  // ── 2. 头像三态：local / http / empty ────────────────────────────
  final avatarKindIdx = rng.nextInt(3);
  final String? avatarUrl;
  final String avatarKind;
  String? localAvatarPath;
  switch (avatarKindIdx) {
    case 0:
      // 本地头像：单独写一个文件（与资产池区分），保证「头像本地分支」必有覆盖
      localAvatarPath = await _writeAsset(
        caseDir,
        'avatar_origin.png',
        bytesSeed: seed * 7 + 13,
      );
      avatarUrl = localAvatarPath;
      avatarKind = 'local';
      break;
    case 1:
      avatarUrl = 'https://example.com/avatar_${seed.abs() % 1000}.png';
      avatarKind = 'http';
      break;
    default:
      // empty 分支：null（与 design.md「http(s) 或为空 → 沿用原值」对齐）
      avatarUrl = null;
      avatarKind = 'empty';
  }

  // ── 3. 角色字段：从固定字面量集合中按 RNG 抽样，覆盖中文 / ASCII / 标点 ──
  const namePalette = <String>['月读', '茉莉', '夜光', '凡音'];
  const personalityPalette = <String>['温柔暖光', '安静理性', '俏皮活泼'];
  const scenarioPalette = <String>['客厅', '深夜书房', '茶馆'];
  const greetingPalette = <String>['你回来啦', '今天怎么样', '坐下喝茶呀'];
  const exDialoguePalette = <String>[
    '{{user}}: 你好\n{{char}}: 你好呀',
    '',
    '{{user}}: 在吗\n{{char}}: 在的',
  ];
  const sysPromptPalette = <String>['请保持温柔', '', '请简短回复'];
  const basicInfoPalette = <String>['猫娘', '雏菊花精', ''];
  const otherInfoPalette = <String>['偏爱晚风', '', '会下棋'];
  const imageTagsPalette = <String>['1girl, soft', '1girl, cat ears', ''];

  String pick(List<String> pool) => pool[rng.nextInt(pool.length)];

  final charName = pick(namePalette);
  final personality = pick(personalityPalette);
  final scenario = pick(scenarioPalette);
  final greeting = pick(greetingPalette);
  final exampleDialogue = pick(exDialoguePalette);
  final systemPrompt = pick(sysPromptPalette);
  final basicInfo = pick(basicInfoPalette);
  final otherInfo = pick(otherInfoPalette);
  final imageTags = pick(imageTagsPalette);

  // 用迭代计数器避免不同迭代之间数据库字符串主键冲突（虽然每次都新建 db，但
  // 字符串里包含 iter 信息也便于失败时的调试输出）。
  final iter = _iterationCounter++;
  final originalCharId = 'oc-$iter';

  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: originalCharId,
          name: Value(charName),
          avatarUrl: Value(avatarUrl),
          personality: Value(personality),
          scenario: Value(scenario),
          greeting: Value(greeting),
          exampleDialogue: Value(exampleDialogue),
          systemPrompt: Value(systemPrompt),
          basicInfo: Value(basicInfo),
          otherInfo: Value(otherInfo),
          imageTags: Value(imageTags),
        ),
      );

  // ── 4. 对话与消息：1–3 对话，每对话 1–3 消息 ─────────────────────
  final convCount = 1 + rng.nextInt(3); // 1..3
  final originalConvIds = <String>[];
  final originalConvSpecs =
      <({String title, int ignoreMemory})>[];
  final originalMsgIds = <String>[];
  final originalMsgSpecs =
      <({String convId, String role, String content})>[];

  // 收集消息 metadata 中实际引用过的本地资产路径
  final referencedLocalAssets = <String>{};
  // 头像若是本地路径，也属于资产集合
  if (localAvatarPath != null) {
    referencedLocalAssets.add(localAvatarPath);
  }

  var seqCounter = 0; // 全局 seq，便于排序稳定
  for (var c = 0; c < convCount; c++) {
    final convId = 'oconv-$iter-$c';
    final ignoreMem = rng.nextInt(2);
    final title = 'conv-${rng.nextInt(1000)}';
    await db.into(db.conversations).insert(
          ConversationsCompanion.insert(
            id: convId,
            characterId: originalCharId,
            title: Value(title),
            ignoreMemory: Value(ignoreMem),
            createdAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000000000 + c * 1000),
            ),
            updatedAt: Value(
              DateTime.fromMillisecondsSinceEpoch(1700000000000 + c * 1000),
            ),
          ),
        );
    originalConvIds.add(convId);
    originalConvSpecs.add((title: title, ignoreMemory: ignoreMem));

    final msgCount = 1 + rng.nextInt(3); // 1..3
    for (var m = 0; m < msgCount; m++) {
      final msgId = 'omsg-$iter-$c-$m';
      // 偶数位 user，奇数位 assistant，保证两类 metadata 都被覆盖
      final role = m.isEven ? 'user' : 'assistant';
      final content = 'msg-content-$iter-$c-$m';
      // 构造 metadata：根据 role 与随机 dice 决定具体形态
      final meta = <String, dynamic>{};
      if (role == 'user') {
        // user：可能带 attachments（本地 + http 混合）
        final dice = rng.nextInt(4);
        if (dice >= 1) {
          final atts = <Map<String, dynamic>>[];
          // 1–2 个本地附件，url 从资产池中抽取（允许重复以触发去重）
          final attCount = 1 + rng.nextInt(2);
          for (var a = 0; a < attCount; a++) {
            final url = assetPool[rng.nextInt(assetPool.length)];
            atts.add({'url': url, 'name': 'a$a.bin'});
            referencedLocalAssets.add(url);
          }
          // 50% 概率追加一个 http 附件（验证 remap 不改 http URL）
          if (rng.nextBool()) {
            atts.add({
              'url': 'https://example.com/r-${rng.nextInt(1000)}.png',
              'name': 'remote',
            });
          }
          meta['attachments'] = atts;
        }
      } else {
        // assistant：可能带 generatedImages (含 versions) 与 image_versions
        final dice = rng.nextInt(4);
        if (dice >= 1) {
          final genCount = 1 + rng.nextInt(2); // 1..2 张图
          final gens = <Map<String, dynamic>>[];
          for (var g = 0; g < genCount; g++) {
            final verCount = 1 + rng.nextInt(2); // 1..2 个版本
            final versions = <Map<String, dynamic>>[];
            for (var v = 0; v < verCount; v++) {
              final url = assetPool[rng.nextInt(assetPool.length)];
              versions.add({'id': 'v$v', 'url': url, 'prompt': 'p$v'});
              referencedLocalAssets.add(url);
            }
            // 当前展示 url 用最后一个版本的 url（与生产一致）
            gens.add({
              'id': 'img-$g',
              'url': versions.last['url'],
              'prompt': 'p',
              'activeVersion': verCount - 1,
              'versions': versions,
            });
          }
          meta['generatedImages'] = gens;
        }
        if (rng.nextBool()) {
          // 30% 概率额外加 image_versions
          final ivCount = 1 + rng.nextInt(2);
          final ivs = <Map<String, dynamic>>[];
          for (var i = 0; i < ivCount; i++) {
            final url = assetPool[rng.nextInt(assetPool.length)];
            ivs.add({'id': 'iv$i', 'url': url, 'prompt': 'iv'});
            referencedLocalAssets.add(url);
          }
          meta['image_versions'] = ivs;
        }
      }
      await db.into(db.messages).insert(
            MessagesCompanion.insert(
              id: msgId,
              conversationId: convId,
              role: role,
              content: Value(content),
              tokenCount: const Value(1),
              seq: Value(seqCounter++),
              createdAt: Value(
                DateTime.fromMillisecondsSinceEpoch(
                  1700000000000 + seqCounter * 100,
                ),
              ),
              metadata: Value(jsonEncode(meta)),
            ),
          );
      originalMsgIds.add(msgId);
      originalMsgSpecs
          .add((convId: convId, role: role, content: content));
    }
  }

  // ── 5. 记忆：0–3 条，source_msg_ids 元素从真实旧 msgId / 外部 ID 中抽取 ──
  final memCount = rng.nextInt(4); // 0..3
  final originalMemIds = <String>[];
  final originalMemSourceMsgIds = <List<String>>[];
  for (var k = 0; k < memCount; k++) {
    final memId = 'omem-$iter-$k';
    final srcLen = rng.nextInt(4); // 0..3
    final srcIds = <String>[];
    for (var s = 0; s < srcLen; s++) {
      // 80% 概率取真实旧 msgId（让映射重写分支被高概率覆盖）；
      // 20% 概率塞一个外部 ID 来覆盖「未命中映射保留原值」分支
      if (originalMsgIds.isNotEmpty && rng.nextInt(5) != 0) {
        srcIds.add(originalMsgIds[rng.nextInt(originalMsgIds.length)]);
      } else {
        srcIds.add('ext-${rng.nextInt(10000)}');
      }
    }
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: memId,
            characterId: originalCharId,
            category: 'cat-${rng.nextInt(3)}',
            content: 'mem-$iter-$k',
            tags: const Value('[]'),
            sourceMsgIds: Value(jsonEncode(srcIds)),
          ),
        );
    originalMemIds.add(memId);
    originalMemSourceMsgIds.add(srcIds);
  }

  return _Scenario(
    originalCharId: originalCharId,
    name: charName,
    personality: personality,
    scenario: scenario,
    greeting: greeting,
    exampleDialogue: exampleDialogue,
    systemPrompt: systemPrompt,
    basicInfo: basicInfo,
    otherInfo: otherInfo,
    imageTags: imageTags,
    avatarUrl: avatarUrl,
    avatarKind: avatarKind,
    originalConvIds: originalConvIds,
    originalConvSpecs: originalConvSpecs,
    originalMsgIds: originalMsgIds,
    originalMsgSpecs: originalMsgSpecs,
    originalMemIds: originalMemIds,
    originalMemSourceMsgIds: originalMemSourceMsgIds,
    localAssetPaths: referencedLocalAssets,
  );
}

/// 从消息 metadata 字符串中抽取所有 url 字段（不区分本地 / 远程）。
Set<String> _collectAllUrls(String metadataJson) {
  final result = <String>{};
  Map<String, dynamic> meta;
  try {
    final decoded = jsonDecode(metadataJson);
    meta = decoded is Map<String, dynamic>
        ? decoded
        : (decoded is Map
            ? Map<String, dynamic>.from(decoded)
            : <String, dynamic>{});
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

/// 判断是否本地路径（与 `local_asset_utils.isLocalAssetPath` 同义，避免依赖循环）。
bool _isLocalPath(String? url) {
  if (url == null) return false;
  final t = url.trim();
  if (t.isEmpty) return false;
  final lower = t.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return false;
  if (lower.startsWith('data:')) return false;
  return true;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    _tmpRoot = await Directory.systemTemp.createTemp('lumimuse_dup_prop_');
    // 把 path_provider 重定向到测试自己的临时目录，避免污染真实路径。
    // copyLocalAsset 主要使用 p.dirname(sourcePath) 落盘，path_provider
    // 影响的是「源路径无父目录」的极端兜底分支；这里仍设置以保证安全。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async {
        if (methodCall.method == 'getApplicationDocumentsDirectory' ||
            methodCall.method == 'getApplicationSupportDirectory' ||
            methodCall.method == 'getTemporaryDirectory') {
          return _tmpRoot.path;
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
    if (await _tmpRoot.exists()) {
      try {
        await _tmpRoot.delete(recursive: true);
      } catch (_) {/* 忽略残余文件锁（Windows） */}
    }
  });

  group('Property 17: 角色级联拷贝完整性 — 成功路径（criteria 1–5）', () {
    Glados<int>(
      any.intInRange(0, 1 << 30),
      ExploreConfig(numRuns: 50),
    ).test(
      'duplicate 后字段相等 / 外键重写 / 资产去重双射 / source_msg_ids 重写 / 头像分支正确',
      (seed) async {
        // 每次迭代独立子目录与独立内存数据库，互不污染
        final caseDir = await Directory(
          p.join(_tmpRoot.path, 'iter_${_iterationCounter}_$seed'),
        ).create(recursive: true);
        final db = _createTestDb();
        try {
          final scenario = await _seedScenario(db, seed, caseDir);

          // 复制前文件快照：旧资产数（不含未命中本地路径，只数我们写出的）
          final filesBefore = await _listFiles(caseDir);
          // 期望旧资产数 = scenario.localAssetPaths.length（所有写出的本地资产）
          // 因 _writeAsset 实际写出的文件是 assetPool 全部 + 本地头像（如有），
          // 资产池中未被任何消息引用的文件不会进 localAssetPaths，故 filesBefore
          // 可能 ≥ scenario.localAssetPaths.length。
          expect(
            filesBefore.length >= scenario.localAssetPaths.length,
            isTrue,
            reason: 'localAssetPaths 是 referenced 子集，写出文件数应不小于它',
          );

          final actions = CharacterActions(db, CharacterImagesActions(db));
          final newCharId = await actions.duplicate(scenario.originalCharId);

          // ── 验收 1：字段相等 ────────────────────────────────────
          final newChar = await (db.select(db.characters)
                ..where((t) => t.id.equals(newCharId)))
              .getSingle();
          expect(newChar.name, '${scenario.name}（副本）',
              reason: 'name 应为「{原 name}（副本）」');
          expect(newChar.personality, scenario.personality);
          expect(newChar.scenario, scenario.scenario);
          expect(newChar.greeting, scenario.greeting);
          expect(newChar.exampleDialogue, scenario.exampleDialogue);
          expect(newChar.systemPrompt, scenario.systemPrompt);
          expect(newChar.basicInfo, scenario.basicInfo);
          expect(newChar.otherInfo, scenario.otherInfo);
          expect(newChar.imageTags, scenario.imageTags);

          // ── 验收 5：头像分支 ────────────────────────────────────
          switch (scenario.avatarKind) {
            case 'local':
              expect(newChar.avatarUrl, isNotNull);
              expect(newChar.avatarUrl, isNot(scenario.avatarUrl),
                  reason: '本地头像必须指向新副本路径');
              expect(_isLocalPath(newChar.avatarUrl), isTrue);
              expect(File(newChar.avatarUrl!).existsSync(), isTrue,
                  reason: '本地头像副本文件必须真实存在');
              // 字节级相等
              final oldBytes = await File(scenario.avatarUrl!).readAsBytes();
              final newBytes = await File(newChar.avatarUrl!).readAsBytes();
              expect(newBytes, oldBytes, reason: '头像副本字节内容必须一致');
              break;
            case 'http':
              expect(newChar.avatarUrl, scenario.avatarUrl,
                  reason: 'http(s) 头像必须沿用原值');
              break;
            case 'empty':
              expect(newChar.avatarUrl, isNull,
                  reason: '空头像副本仍应为 null');
              break;
          }

          // ── 验收 2：外键重写 — 对话 / 消息 / 记忆 ────────────────
          final newConvs = await (db.select(db.conversations)
                ..where((t) => t.characterId.equals(newCharId)))
              .get();
          expect(newConvs.length, scenario.originalConvIds.length,
              reason: '副本对话数应与原对话数一致');
          for (final c in newConvs) {
            expect(c.characterId, newCharId,
                reason: '所有新对话 character_id 应指向新角色');
            expect(scenario.originalConvIds.contains(c.id), isFalse,
                reason: '新对话 id 必须重新生成');
          }
          final newConvIdSet = newConvs.map((c) => c.id).toSet();

          // ignore_memory 与 title 集合（按多重集合断言，处理同名对话情况）
          final originalIgnoreMems = scenario.originalConvSpecs
              .map((s) => s.ignoreMemory)
              .toList()
            ..sort();
          final newIgnoreMems = newConvs.map((c) => c.ignoreMemory).toList()
            ..sort();
          expect(newIgnoreMems, originalIgnoreMems,
              reason: 'ignore_memory 多重集应与原对话一致');

          final newMsgs = await (db.select(db.messages)
                ..where((t) => t.conversationId.isIn(newConvIdSet))
                ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
              .get();
          expect(newMsgs.length, scenario.originalMsgIds.length,
              reason: '副本消息数应与原消息数一致');
          for (final m in newMsgs) {
            expect(newConvIdSet.contains(m.conversationId), isTrue,
                reason: '所有新消息 conversation_id 应指向新对话');
            expect(scenario.originalMsgIds.contains(m.id), isFalse,
                reason: '新消息 id 必须重新生成');
          }

          final newMems = await (db.select(db.memories)
                ..where((t) => t.characterId.equals(newCharId)))
              .get();
          expect(newMems.length, scenario.originalMemIds.length,
              reason: '副本记忆数应与原记忆数一致');
          for (final m in newMems) {
            expect(m.characterId, newCharId,
                reason: '所有新记忆 character_id 应指向新角色');
            expect(scenario.originalMemIds.contains(m.id), isFalse,
                reason: '新记忆 id 必须重新生成');
          }

          // 旧角色 + 旧对话 + 旧消息 + 旧记忆都应仍然存在（duplicate 不动原数据）
          final stillOldChar = await (db.select(db.characters)
                ..where((t) => t.id.equals(scenario.originalCharId)))
              .getSingleOrNull();
          expect(stillOldChar, isNotNull, reason: '原角色不应被删除');

          // ── 验收 3：资产去重双射 ────────────────────────────────
          // 收集新消息 metadata 中的所有 url
          final newLocalUrls = <String>{};
          final newHttpUrls = <String>{};
          for (final m in newMsgs) {
            for (final u in _collectAllUrls(m.metadata)) {
              if (_isLocalPath(u)) {
                newLocalUrls.add(u);
                // 副本本地 url 必须不再是任一旧本地路径
                expect(scenario.localAssetPaths.contains(u), isFalse,
                    reason: '新消息 metadata 不应再引用任一旧本地路径：$u');
              } else {
                newHttpUrls.add(u);
              }
            }
          }
          // 收集所有「应被 remap」的旧本地路径（消息 metadata 引用过的子集）
          final referencedLocalInMessages = <String>{};
          for (final id in scenario.originalMsgIds) {
            final row = await (db.select(db.messages)
                  ..where((t) => t.id.equals(id)))
                .getSingle();
            for (final u in _collectAllUrls(row.metadata)) {
              if (_isLocalPath(u)) referencedLocalInMessages.add(u);
            }
          }
          // 双射性质：旧本地路径数 == 新本地路径数（每个旧路径只复制一次）
          expect(newLocalUrls.length, referencedLocalInMessages.length,
              reason: '资产应满足双射：每个旧本地路径对应唯一新路径');
          // 每个新本地路径都对应一个真实存在的文件
          for (final u in newLocalUrls) {
            expect(File(u).existsSync(), isTrue,
                reason: '新本地路径必须对应存在的文件：$u');
          }

          // 同时验证：同一旧路径在多处出现时副本一致（双射的构造性证据）
          final pathMapping = <String, String>{};
          for (final newMsg in newMsgs) {
            // 找到对应的旧消息（按 content 唯一匹配）
            final matches = scenario.originalMsgSpecs
                .asMap()
                .entries
                .where((e) => e.value.content == newMsg.content)
                .toList();
            // 同 seed 下 content 唯一（因为我们用 $iter-$c-$m 做 content 后缀）
            expect(matches.length, 1,
                reason: 'content 在同一场景内应唯一对应一条原消息');
            final oldMsgId = scenario.originalMsgIds[matches.first.key];
            final oldMsg = await (db.select(db.messages)
                  ..where((t) => t.id.equals(oldMsgId)))
                .getSingle();
            final oldUrls = _collectAllUrls(oldMsg.metadata).toList();
            final newUrls = _collectAllUrls(newMsg.metadata).toList();
            expect(newUrls.length, oldUrls.length,
                reason: '副本 metadata url 数量应与原 metadata 一致（remap 不增不减）');
            // 注意：一条消息内同一 url 可能出现多次（如 generatedImages.url 与
            // versions[last].url 共指），_collectAllUrls 是 Set，因此可能去重。
            // 这里只断言 Set 大小相等。
          }

          // 反向：每个旧本地路径在 mapping 内都有对应新路径
          for (final newMsg in newMsgs) {
            final newMeta = jsonDecode(newMsg.metadata) as Map<String, dynamic>;
            final oldMatches = scenario.originalMsgSpecs
                .asMap()
                .entries
                .where((e) => e.value.content == newMsg.content)
                .toList();
            final oldMsgId = scenario.originalMsgIds[oldMatches.first.key];
            final oldMsg = await (db.select(db.messages)
                  ..where((t) => t.id.equals(oldMsgId)))
                .getSingle();
            final oldMeta = jsonDecode(oldMsg.metadata) as Map<String, dynamic>;

            // attachments：逐元素位置映射
            final oldAtts = oldMeta['attachments'];
            final newAtts = newMeta['attachments'];
            if (oldAtts is List) {
              expect(newAtts, isA<List>(),
                  reason: 'attachments 数组应被保留');
              expect((newAtts as List).length, oldAtts.length);
              for (var i = 0; i < oldAtts.length; i++) {
                final ou = (oldAtts[i] as Map)['url'];
                final nu = (newAtts[i] as Map)['url'];
                if (ou is String && _isLocalPath(ou)) {
                  // 本地：新路径必须不同于旧路径
                  expect(nu, isNot(ou),
                      reason: '本地 attachment 应被 remap 到新路径');
                  if (pathMapping.containsKey(ou)) {
                    expect(pathMapping[ou], nu,
                        reason: '同一旧路径应映射到同一新路径（双射约束）');
                  } else {
                    pathMapping[ou] = nu as String;
                  }
                } else {
                  // http(s) / data: → 沿用原值
                  expect(nu, ou, reason: 'http(s) attachment url 不应被改写');
                }
              }
            }

            // generatedImages：当前 url + versions[*].url 全部按位置对照
            final oldGens = oldMeta['generatedImages'];
            final newGens = newMeta['generatedImages'];
            if (oldGens is List) {
              expect(newGens, isA<List>());
              expect((newGens as List).length, oldGens.length);
              for (var g = 0; g < oldGens.length; g++) {
                final og = oldGens[g] as Map;
                final ng = newGens[g] as Map;
                final ogu = og['url'];
                final ngu = ng['url'];
                if (ogu is String && _isLocalPath(ogu)) {
                  if (pathMapping.containsKey(ogu)) {
                    expect(pathMapping[ogu], ngu);
                  } else {
                    pathMapping[ogu] = ngu as String;
                  }
                }
                final ovs = og['versions'];
                final nvs = ng['versions'];
                if (ovs is List) {
                  expect(nvs, isA<List>());
                  expect((nvs as List).length, ovs.length);
                  for (var v = 0; v < ovs.length; v++) {
                    final ovu = (ovs[v] as Map)['url'];
                    final nvu = (nvs[v] as Map)['url'];
                    if (ovu is String && _isLocalPath(ovu)) {
                      if (pathMapping.containsKey(ovu)) {
                        expect(pathMapping[ovu], nvu);
                      } else {
                        pathMapping[ovu] = nvu as String;
                      }
                    }
                  }
                }
              }
            }

            // image_versions：按位置对照
            final oldIvs = oldMeta['image_versions'];
            final newIvs = newMeta['image_versions'];
            if (oldIvs is List) {
              expect(newIvs, isA<List>());
              expect((newIvs as List).length, oldIvs.length);
              for (var i = 0; i < oldIvs.length; i++) {
                final ovu = (oldIvs[i] as Map)['url'];
                final nvu = (newIvs[i] as Map)['url'];
                if (ovu is String && _isLocalPath(ovu)) {
                  if (pathMapping.containsKey(ovu)) {
                    expect(pathMapping[ovu], nvu);
                  } else {
                    pathMapping[ovu] = nvu as String;
                  }
                }
              }
            }
          }

          // 字节级相等：对每个 mapping 确认新旧文件内容一致
          for (final entry in pathMapping.entries) {
            final oldBytes = await File(entry.key).readAsBytes();
            final newBytes = await File(entry.value).readAsBytes();
            expect(newBytes, oldBytes,
                reason: '副本与原始资产字节内容必须一致：${entry.key}');
          }
          // 双射：mapping 的 key/value 集合一一对应（无 value 重复）
          expect(pathMapping.values.toSet().length, pathMapping.length,
              reason: '不同旧路径不应映射到同一新路径（双射）');

          // ── 验收 4：source_msg_ids 重写 ─────────────────────────
          // 构造「旧 msgId → 新 msgId」映射（按 content 唯一匹配）
          final msgIdMap = <String, String>{};
          for (var i = 0; i < scenario.originalMsgIds.length; i++) {
            final spec = scenario.originalMsgSpecs[i];
            final newMsg = newMsgs.firstWhere((m) => m.content == spec.content);
            msgIdMap[scenario.originalMsgIds[i]] = newMsg.id;
          }
          // 按 content 唯一匹配新记忆与原记忆 —— `_seedScenario` 给每条记忆
          // 写入了形如 `mem-<iter>-<k>` 的 content，同一场景内必唯一。
          for (var k = 0; k < scenario.originalMemIds.length; k++) {
            final origIds = scenario.originalMemSourceMsgIds[k];
            final origMem = await (db.select(db.memories)
                  ..where((t) => t.id.equals(scenario.originalMemIds[k])))
                .getSingle();
            final newMem =
                newMems.firstWhere((m) => m.content == origMem.content);
            final newSrc = jsonDecode(newMem.sourceMsgIds) as List;
            expect(newSrc.length, origIds.length,
                reason: 'source_msg_ids 长度应保持一致（包括空数组）');
            for (var i = 0; i < origIds.length; i++) {
              final old = origIds[i];
              final mappedExpected = msgIdMap[old] ?? old;
              expect(newSrc[i], mappedExpected,
                  reason: 'source_msg_ids[$i] 应按 msgIdMap 重写或保留原值');
            }
          }
        } finally {
          await db.close();
          // 每次迭代完成后清理子目录，避免 _tmpRoot 暴涨
          if (await caseDir.exists()) {
            try {
              await caseDir.delete(recursive: true);
            } catch (_) {/* Windows 文件锁兜底，忽略 */}
          }
        }
      },
    );
  });

  group('Property 17: 角色级联拷贝完整性 — 事务原子性（criterion 6）', () {
    Glados<int>(
      any.intInRange(0, 1 << 30),
      ExploreConfig(numRuns: 50),
    ).test(
      '事务失败时所有插入回滚 + 新文件被清理 + 原始数据完整',
      (seed) async {
        final caseDir = await Directory(
          p.join(_tmpRoot.path, 'fail_${_iterationCounter}_$seed'),
        ).create(recursive: true);
        final db = _createTestDb();
        try {
          final scenario = await _seedScenario(db, seed, caseDir);

          // 复制前文件快照（仅原始资产）
          final filesBefore = await _listFiles(caseDir);
          final filesBeforeSet = filesBefore.toSet();

          // 用 SQLite trigger 让 messages 插入抛错：duplicate 内事务先成功插入新角色 +
          // 新对话，再尝试插入新消息时被触发器中断 → 整个事务回滚 → 11.3 finally
          // 兜底删除已复制出的新文件。
          //
          // 若该场景不含任何消息（极小场景，message 数 = 0），触发器永远不被触发，
          // duplicate 会成功提交。此时事务原子性的「失败回滚」分支无法被触发，
          // 我们把这种迭代识别出来并放过即可（仍是合法情形，不算反例）。
          if (scenario.originalMsgIds.isEmpty) {
            return;
          }

          await db.customStatement(
            "CREATE TRIGGER fail_on_msg_insert "
            "BEFORE INSERT ON messages "
            "BEGIN SELECT RAISE(FAIL, '强制失败用于测试'); END",
          );

          final actions = CharacterActions(db, CharacterImagesActions(db));
          Object? caught;
          try {
            await actions.duplicate(scenario.originalCharId);
          } catch (e) {
            caught = e;
          }
          expect(caught, isNotNull,
              reason: 'duplicate 在事务失败时必须把异常透传给上层');

          // 文件断言：所有新复制出的文件必须被清理
          final filesAfter = await _listFiles(caseDir);
          expect(filesAfter.toSet(), filesBeforeSet,
              reason: '事务失败时新复制出的文件必须被清理，仅保留原始资产');
          // 原始文件不应被误删
          for (final original in scenario.localAssetPaths) {
            expect(File(original).existsSync(), isTrue,
                reason: '原始资产不应被影响：$original');
          }

          // 数据库断言：仅原始数据存在
          final allChars = await db.select(db.characters).get();
          expect(allChars.length, 1,
              reason: '失败回滚后角色表只应含原角色');
          expect(allChars.single.id, scenario.originalCharId);
          expect(allChars.single.name, scenario.name,
              reason: '原角色 name 不应被改写');

          final allConvs = await db.select(db.conversations).get();
          expect(allConvs.length, scenario.originalConvIds.length);
          expect(allConvs.map((c) => c.id).toSet(),
              scenario.originalConvIds.toSet());

          final allMsgs = await db.select(db.messages).get();
          expect(allMsgs.length, scenario.originalMsgIds.length);
          expect(allMsgs.map((m) => m.id).toSet(),
              scenario.originalMsgIds.toSet());

          final allMems = await db.select(db.memories).get();
          expect(allMems.length, scenario.originalMemIds.length);
          for (final m in allMems) {
            expect(m.characterId, scenario.originalCharId);
          }

          // 释放触发器（每次迭代独立 db 会随 close 一同释放，但显式 DROP 更稳）
          try {
            await db.customStatement(
                'DROP TRIGGER IF EXISTS fail_on_msg_insert');
          } catch (_) {/* ignore */}
        } finally {
          await db.close();
          if (await caseDir.exists()) {
            try {
              await caseDir.delete(recursive: true);
            } catch (_) {/* ignore */}
          }
        }
      },
    );
  });
}
