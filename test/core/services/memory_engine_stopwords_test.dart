import 'package:drift/drift.dart' hide isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-stopwords';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

Future<void> _seedCharacter(AppDatabase db) async {
  await db.into(db.characters).insert(
        CharactersCompanion.insert(
          id: _charId,
          name: const Value('测试角色'),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

void main() {
  // 验证思路：查询文本仅为停用词 bigram 时，_tokenize 应返回空集，
  // retrieveRelevantMemories 走「queryTokens 空」早返回分支，返回排序首位
  // （updatedAt 更晚者）。若停用词未被过滤，则会按 score 返回含该 bigram 的记忆。
  // _tokenize 为私有方法，此处通过 retrieveRelevantMemories 的可观察行为间接验证。

  test('扩充停用词「今天」不参与 bigram 匹配', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // A 含「今天」bigram；B 不含，且 updatedAt 更晚以排在 A 前
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-today',
            characterId: _charId,
            category: '基础信息',
            content: '今天好心情',
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-other',
            characterId: _charId,
            category: '基础信息',
            content: '狗狗可爱',
            updatedAt: Value(DateTime(2026, 1, 2)),
          ),
        );

    final result = await engine.retrieveRelevantMemories(
      queryText: '今天',
      characterId: _charId,
      maxMemories: 1,
    );

    expect(result, hasLength(1));
    expect(result.first.id, 'mem-other',
        reason: '「今天」应被停用词过滤使 queryTokens 为空，走早返回返回排序首位 mem-other');
  });

  test('原停用词「喜欢」仍被过滤', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-like',
            characterId: _charId,
            category: '基础信息',
            content: '喜欢猫猫',
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-other',
            characterId: _charId,
            category: '基础信息',
            content: '狗狗可爱',
            updatedAt: Value(DateTime(2026, 1, 2)),
          ),
        );

    final result = await engine.retrieveRelevantMemories(
      queryText: '喜欢',
      characterId: _charId,
      maxMemories: 1,
    );

    expect(result, hasLength(1));
    expect(result.first.id, 'mem-other',
        reason: '「喜欢」应被停用词过滤使 queryTokens 为空，走早返回返回排序首位 mem-other');
  });
}
