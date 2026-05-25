// Feature: flutter-parity-completion, Property 15: editContent 与 versions 一致
//
// **Validates: Requirements 8.1, 8.2, 8.5**
//
// 通过 `package:glados` 生成含合法 `versions` 与 `activeVersion` 的消息，在
// 内存 Drift 数据库（`AppDatabase.forTesting(NativeDatabase.memory())`）上
// 调用 `editContent(m.id, newContent)` + `switchVersion(m.id, m.activeVersion)`，
// 断言以下四项同步成立：
//   - messages.content == newContent
//   - messages.token_count == estimateTokens(newContent)
//   - metadata.versions[activeVersion].content == newContent
//   - metadata.versions[activeVersion].token_count == estimateTokens(newContent)
//
// 这是 R8（消息编辑与版本同步）的核心 round-trip 性质：编辑当前版本后，
// 顶层 content / token_count 与 metadata.versions[active] 必须保持一致，
// 否则下一次切换版本会用旧内容覆盖编辑结果。
//
// 默认 100 次迭代（glados ExploreConfig 默认值）。

import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/providers/character_images_actions.dart';
import 'package:lumimuse/core/providers/message_provider.dart';
import 'package:lumimuse/core/utils/token_counter.dart';

/// 创建内存数据库 — 与现有 PBT 测试保持一致的工厂用法。
AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

/// 字符样本：覆盖 ASCII / CJK / 空白与标点，用于由种子拼装确定性文本。
const _charPalette = <String>[
  'a',
  'B',
  '7',
  ' ',
  '\n',
  '猫',
  '光',
  '星',
  '夜',
  '茶',
  '。',
  '：',
  ',',
  '!',
  '?',
];

/// 由整数种子拼装一段确定性文本，长度 ∈ [0, 16]。
///
/// 用线性同余推进伪随机序列，保证同种子始终产出同样字符串，便于属性测试
/// 失败时复现。
String _contentFromSeed(int seed) {
  final length = seed.abs() % 17; // [0, 16]
  if (length == 0) return '';
  final buf = StringBuffer();
  var s = seed.abs();
  for (var i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf.write(_charPalette[s % _charPalette.length]);
  }
  return buf.toString();
}

/// 构造合法的 versions 列表：长度 ∈ [1, 5]，每个 version 含 content / token_count。
List<Map<String, dynamic>> _buildVersions(int seed) {
  final length = (seed.abs() % 5) + 1; // [1, 5]
  return List.generate(length, (i) {
    final content = _contentFromSeed(seed + i * 97);
    return <String, dynamic>{
      'content': content,
      'token_count': estimateTokens(content),
    };
  });
}

/// 在测试数据库中预先创建 character + conversation + message
/// （含 metadata.versions / activeVersion），消息顶层 content / token_count
/// 与活跃版本保持同步（与真实业务一致）。
Future<void> _seedMessage(
  AppDatabase db, {
  required String messageId,
  required List<Map<String, dynamic>> versions,
  required int activeVersion,
}) async {
  await db.customInsert(
    'INSERT INTO characters (id, name) VALUES (?, ?)',
    variables: [Variable.withString('char-1'), Variable.withString('测试角色')],
  );
  await db.customInsert(
    'INSERT INTO conversations (id, character_id, title) VALUES (?, ?, ?)',
    variables: [
      Variable.withString('conv-1'),
      Variable.withString('char-1'),
      Variable.withString('测试对话'),
    ],
  );
  final active = versions[activeVersion];
  final activeContent = active['content'] as String;
  final activeTokenCount = active['token_count'] as int;
  final metadata = jsonEncode({
    'versions': versions,
    'activeVersion': activeVersion,
  });
  await db.customInsert(
    'INSERT INTO messages '
    '(id, conversation_id, role, content, token_count, seq, metadata) '
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
    variables: [
      Variable.withString(messageId),
      Variable.withString('conv-1'),
      Variable.withString('assistant'),
      Variable.withString(activeContent),
      Variable.withInt(activeTokenCount),
      Variable.withInt(0),
      Variable.withString(metadata),
    ],
  );
}

void main() {
  group('Property 15: editContent 与 versions 一致', () {
    Glados3<int, int, int>(
      any.intInRange(0, 1 << 20), // versions 长度 / 各版本内容种子
      any.intInRange(0, 1 << 20), // activeVersion 选择种子
      any.intInRange(0, 1 << 20), // newContent 种子
      ExploreConfig(numRuns: 100),
    ).test('editContent + switchVersion(active) 后顶层与 versions[active] 同步', (
      versionsSeed,
      activeSeed,
      newContentSeed,
    ) async {
      final db = _createTestDb();
      try {
        final versions = _buildVersions(versionsSeed);
        final activeVersion = activeSeed.abs() % versions.length;
        final newContent = _contentFromSeed(newContentSeed);
        final expectedTokens = estimateTokens(newContent);

        const messageId = 'msg-1';
        await _seedMessage(
          db,
          messageId: messageId,
          versions: versions,
          activeVersion: activeVersion,
        );

        final actions = MessageActions(db, CharacterImagesActions(db));
        await actions.editContent(messageId, newContent);
        await actions.switchVersion(messageId, activeVersion);

        final row = await (db.select(
          db.messages,
        )..where((t) => t.id.equals(messageId))).getSingle();

        // 顶层字段：messages.content / token_count
        expect(
          row.content,
          newContent,
          reason: 'messages.content 应等于 newContent',
        );
        expect(
          row.tokenCount,
          expectedTokens,
          reason: 'messages.token_count 应等于 estimateTokens(newContent)',
        );

        // metadata.versions[active] 同步状态
        final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
        final versionsBack = meta['versions'] as List<dynamic>;
        expect(
          versionsBack.length,
          versions.length,
          reason: 'editContent 不应改变版本数量',
        );
        final activeBack = meta['activeVersion'] as int;
        expect(
          activeBack,
          activeVersion,
          reason: 'switchVersion(activeVersion) 不应改变 activeVersion',
        );
        final activeMap = versionsBack[activeBack] as Map<String, dynamic>;
        expect(
          activeMap['content'],
          newContent,
          reason: 'versions[active].content 应等于 newContent',
        );
        expect(
          activeMap['token_count'],
          expectedTokens,
          reason: 'versions[active].token_count 应等于 estimateTokens(newContent)',
        );
      } finally {
        await db.close();
      }
    });

    // 例测：单版本消息（最简边界，作双层保护）
    test('单版本消息：编辑后 versions[0] 与顶层均同步', () async {
      final db = _createTestDb();
      try {
        const original = '原文';
        const newContent = '新内容 hello 喵';
        await _seedMessage(
          db,
          messageId: 'msg-x',
          versions: [
            {'content': original, 'token_count': estimateTokens(original)},
          ],
          activeVersion: 0,
        );

        final actions = MessageActions(db, CharacterImagesActions(db));
        await actions.editContent('msg-x', newContent);
        await actions.switchVersion('msg-x', 0);

        final row = await (db.select(
          db.messages,
        )..where((t) => t.id.equals('msg-x'))).getSingle();
        expect(row.content, newContent);
        expect(row.tokenCount, estimateTokens(newContent));
        final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
        expect(meta['activeVersion'], 0);
        final v0 = (meta['versions'] as List)[0] as Map<String, dynamic>;
        expect(v0['content'], newContent);
        expect(v0['token_count'], estimateTokens(newContent));
      } finally {
        await db.close();
      }
    });

    // 例测：多版本消息，活跃版本在中间，编辑只影响活跃版本
    test('多版本消息：编辑只改活跃版本，其他版本保持不变', () async {
      final db = _createTestDb();
      try {
        const newContent = '改写后的中段';
        final versions = <Map<String, dynamic>>[
          {'content': 'v0 旧', 'token_count': estimateTokens('v0 旧')},
          {'content': 'v1 旧', 'token_count': estimateTokens('v1 旧')},
          {'content': 'v2 旧', 'token_count': estimateTokens('v2 旧')},
        ];
        await _seedMessage(
          db,
          messageId: 'msg-mid',
          versions: versions,
          activeVersion: 1,
        );

        final actions = MessageActions(db, CharacterImagesActions(db));
        await actions.editContent('msg-mid', newContent);
        await actions.switchVersion('msg-mid', 1);

        final row = await (db.select(
          db.messages,
        )..where((t) => t.id.equals('msg-mid'))).getSingle();
        expect(row.content, newContent);
        expect(row.tokenCount, estimateTokens(newContent));
        final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
        final versionsBack = (meta['versions'] as List).cast<Map>();
        expect(versionsBack[0]['content'], 'v0 旧', reason: '非活跃版本 v0 不应被编辑波及');
        expect(
          versionsBack[1]['content'],
          newContent,
          reason: '活跃版本 v1 应已同步为 newContent',
        );
        expect(versionsBack[1]['token_count'], estimateTokens(newContent));
        expect(versionsBack[2]['content'], 'v2 旧', reason: '非活跃版本 v2 不应被编辑波及');
      } finally {
        await db.close();
      }
    });

    test('delete：activeVersion 越界时夹到合法范围，不抛 RangeError', () async {
      final db = _createTestDb();
      try {
        final versions = <Map<String, dynamic>>[
          {'content': 'v0', 'token_count': estimateTokens('v0')},
          {'content': 'v1', 'token_count': estimateTokens('v1')},
          {'content': 'v2', 'token_count': estimateTokens('v2')},
        ];
        await _seedMessage(
          db,
          messageId: 'msg-invalid-active',
          versions: versions,
          activeVersion: 0,
        );
        await (db.update(
          db.messages,
        )..where((t) => t.id.equals('msg-invalid-active'))).write(
          MessagesCompanion(
            metadata: Value(
              jsonEncode({'versions': versions, 'activeVersion': 99}),
            ),
          ),
        );

        final actions = MessageActions(db, CharacterImagesActions(db));
        await actions.delete('msg-invalid-active');

        final row = await (db.select(
          db.messages,
        )..where((t) => t.id.equals('msg-invalid-active'))).getSingle();
        final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
        final versionsBack = meta['versions'] as List<dynamic>;
        expect(versionsBack.length, 2);
        expect(meta['activeVersion'], 1);
        expect(row.content, 'v1');
      } finally {
        await db.close();
      }
    });

    test('deleteAttachment：被删附件无其它引用时清理本地孤儿文件', () async {
      final db = _createTestDb();
      final assetRoot = Directory(
        '${Directory.current.path}${Platform.pathSeparator}.dart_tool${Platform.pathSeparator}message_provider_assets',
      );
      try {
        if (!await assetRoot.exists()) {
          await assetRoot.create(recursive: true);
        }
        final asset = File(
          '${assetRoot.path}${Platform.pathSeparator}orphan_attachment.png',
        );
        await asset.writeAsBytes(<int>[1, 2, 3]);

        await db.customInsert(
          'INSERT INTO characters (id, name) VALUES (?, ?)',
          variables: [
            Variable.withString('char-attach'),
            Variable.withString('附件角色'),
          ],
        );
        await db.customInsert(
          'INSERT INTO conversations (id, character_id, title) VALUES (?, ?, ?)',
          variables: [
            Variable.withString('conv-attach'),
            Variable.withString('char-attach'),
            Variable.withString('附件对话'),
          ],
        );
        await db.customInsert(
          'INSERT INTO messages '
          '(id, conversation_id, role, content, token_count, seq, metadata) '
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
          variables: [
            Variable.withString('msg-attach'),
            Variable.withString('conv-attach'),
            Variable.withString('user'),
            Variable.withString('带附件'),
            Variable.withInt(1),
            Variable.withInt(0),
            Variable.withString(
              jsonEncode({
                'attachments': [
                  {
                    'type': 'image',
                    'url': asset.path,
                    'name': 'orphan_attachment.png',
                  },
                ],
              }),
            ),
          ],
        );

        final actions = MessageActions(db, CharacterImagesActions(db));
        await actions.deleteAttachment('msg-attach', 0);

        final row = await (db.select(
          db.messages,
        )..where((t) => t.id.equals('msg-attach'))).getSingle();
        final meta = jsonDecode(row.metadata) as Map<String, dynamic>;
        expect(meta.containsKey('attachments'), isFalse);
        expect(await asset.exists(), isFalse);
      } finally {
        await db.close();
        if (await assetRoot.exists()) {
          await assetRoot.delete(recursive: true);
        }
      }
    });
  });
}
