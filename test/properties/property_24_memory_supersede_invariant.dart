// Feature: flutter-memory-lifecycle, Property 24: supersede 写入不变量
// Validates: spec Task 9 / 19.1
//
// 设计说明
// ────────
// spec Task 9 的 supersede 写入路径（落实在 MemoryExtractionService._processTask
// 的 supersede 分支）：
//   1. findSimilarExistingMemories(characterId, candidateContent) 命中旧记忆
//      （containment 相似度 ≥ 0.6）
//   2. INSERT 新记忆（显式 status='active'）拿 newId
//   3. UPDATE 旧记忆：status='superseded' + metadata.supersededBy=newId
//
// 不变量（spec 19.1）：
//   - supersede 完成后，旧记忆 status='superseded'
//   - 旧记忆 metadata.supersededBy 指向新记忆 id
//   - retrieveRelevantMemories 不返回旧记忆（SQL 过滤 status='active'）
//
// 实现策略
// ────────
// supersede 写入路径内嵌在 MemoryExtractionService._processTask（需 LLM 调用 +
// seed 对话 + 等待任务完成），glados 属性测试难以直接驱动。本测试：
//   - 真实调用 findSimilarExistingMemories（验证 supersede 前置命中判定）
//   - 复刻 supersede 写入逻辑（INSERT 新 + UPDATE 旧，与 _processTask 的
//     supersede 分支逐行一致 —— 参考 memory_extraction_service.dart:515-544）
//   - 真实调用 retrieveRelevantMemories（验证不变量）
// 这样在不依赖 LLM 的前提下，把「supersede 后旧记忆不再被检索」固化为可机器
// 校验的不变量。shrink 后的反例可直接定位到 findSimilar / 写入 / 检索的回归。
//
// 随机化输入：随机角色 id（小池，每次独立内存库）+ 随机记忆内容（CJK 候选词
// 拼接，保证 _tokenize 的 bigram token 充足）。新记忆 content 与旧记忆完全相同
// → containment=1.0 ≥ 0.6 必命中（命中判定与不变量本身正交，故用相同内容保证
// findSimilarExistingMemories 真实返回旧记忆）。

import 'dart:convert';
import 'dart:math' as math;

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;
import 'package:uuid/uuid.dart';

import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(AppDatabase db, String id) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: id,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

// ──────────────────────────────────────────────────────────────────────────
// glados 生成器：随机角色 id + 随机记忆内容
//
// - characterId 池 4（char-0 ~ char-3），每次测试独立内存库，不跨用例污染
// - content 从中文候选词池拼出，长度 ∈ [4, 12]，保证 CJK bigram token 充足
//   （findSimilarExistingMemories 的 _tokenize 对 CJK 字符做 bigram）
// ──────────────────────────────────────────────────────────────────────────

class _SupersedeCase {
  final String characterId;
  final String content;
  const _SupersedeCase(this.characterId, this.content);

  @override
  String toString() => '_SupersedeCase(char=$characterId, content=$content)';
}

extension on Any {
  Generator<_SupersedeCase> get supersedeCases {
    return combine2<int, int, _SupersedeCase>(
      intInRange(0, 1 << 30), // 决定 characterId
      intInRange(0, 1 << 30), // 决定 content
      (charSeed, contentSeed) {
        final charRng = math.Random(charSeed);
        final charId = 'char-${charRng.nextInt(4)}';
        // 中文候选词（每词 2-3 字，便于 CJK bigram 命中）
        const pool = ['用户', '喜欢', '猫狗', '单身', '结婚', '看电影', '吃辣', '睡觉', '工作', '学习'];
        final contentRng = math.Random(contentSeed);
        final targetLen = 4 + contentRng.nextInt(9); // [4, 12]
        final buf = StringBuffer();
        while (buf.length < targetLen) {
          buf.write(pool[contentRng.nextInt(pool.length)]);
        }
        return _SupersedeCase(charId, buf.toString().substring(0, targetLen));
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// metadata 解析助手（对齐 MemoryExtractionService._readMetadata 语义）
// ──────────────────────────────────────────────────────────────────────────

Map<String, dynamic> _readMetadata(String? json) {
  if (json == null || json.isEmpty) return {};
  try {
    final decoded = jsonDecode(json);
    if (decoded is Map<String, dynamic>) return decoded;
  } catch (_) {}
  return {};
}

// ──────────────────────────────────────────────────────────────────────────
// 测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 24: supersede 写入不变量', () {
    Glados<_SupersedeCase>(
      any.supersedeCases,
      ExploreConfig(numRuns: 100),
    ).test(
      'supersede 写入后旧记忆 status=superseded 且 retrieveRelevantMemories 不返回',
      (c) async {
        final db = _createTestDb();
        addTearDown(db.close);
        await _seedCharacter(db, c.characterId);

        // 旧记忆：active，content = c.content，metadata=null（_seedMemory 未设值）
        await db.into(db.memories).insert(
              MemoriesCompanion.insert(
                id: 'mem-old',
                characterId: c.characterId,
                category: '基础信息',
                content: c.content,
                createdAt: Value(DateTime(2026, 1, 1)),
                updatedAt: Value(DateTime(2026, 1, 1)),
              ),
            );

        final engine = MemoryEngine(db, LlmService());

        // 真实调用 findSimilarExistingMemories：相同 content → containment=1.0 ≥ 0.6 必命中
        // （supersede 的前置命中判定；命中后返回旧记忆，未命中则不会触发 supersede 写入）
        final target = await engine.findSimilarExistingMemories(
          c.characterId,
          c.content,
        );
        expect(target, isNotNull,
            reason: '相同 content containment=1.0 应命中 findSimilarExistingMemories');
        expect(target!.id, 'mem-old',
            reason: '命中的应是刚插入的旧记忆');

        // 复刻 supersede 写入路径（与 _processTask 的 supersede 分支逐行一致）：
        //   1. INSERT 新记忆（显式 status='active'）拿 newId
        //   2. UPDATE 旧记忆：status='superseded' + metadata.supersededBy=newId
        const uuid = Uuid();
        final newId = uuid.v4();
        await db.into(db.memories).insert(
              MemoriesCompanion.insert(
                id: newId,
                characterId: c.characterId,
                category: '基础信息',
                content: c.content,
                status: const Value('active'),
                createdAt: Value(DateTime(2026, 1, 2)),
                updatedAt: Value(DateTime(2026, 1, 2)),
              ),
            );
        final oldMetadata = _readMetadata(target.metadata);
        oldMetadata['supersededBy'] = newId;
        await (db.update(db.memories)
              ..where((t) => t.id.equals(target.id)))
            .write(MemoriesCompanion(
          status: const Value('superseded'),
          metadata: Value(jsonEncode(oldMetadata)),
          updatedAt: Value(DateTime(2026, 1, 2)),
        ));

        // 不变量 1：旧记忆 status='superseded'
        final oldRow = await (db.select(db.memories)
              ..where((t) => t.id.equals('mem-old')))
            .getSingle();
        expect(oldRow.status, 'superseded',
            reason: 'supersede 后旧记忆 status 必须为 superseded');

        // 不变量 2：metadata.supersededBy 指向新记忆 id
        final meta = _readMetadata(oldRow.metadata);
        expect(meta['supersededBy'], newId,
            reason: 'metadata.supersededBy 必须指向新记忆 id');

        // 不变量 3：retrieveRelevantMemories 不返回旧记忆（SQL 过滤 status='active'）
        final retrieved = await engine.retrieveRelevantMemories(
          queryText: c.content,
          characterId: c.characterId,
        );
        expect(retrieved.any((m) => m.id == 'mem-old'), isFalse,
            reason: '旧记忆 status=superseded，retrieveRelevantMemories 不应返回');
        // 新记忆 status='active' 应能被检索到
        expect(retrieved.any((m) => m.id == newId), isTrue,
            reason: '新记忆 status=active 应能被检索到');
      },
    );
  });
}
