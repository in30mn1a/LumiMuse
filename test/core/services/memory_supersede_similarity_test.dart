import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-supersede';

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

Future<void> _seedMemory(
  AppDatabase db, {
  required String id,
  required String content,
  String status = 'active',
}) async {
  await db.into(db.memories).insert(
        MemoriesCompanion.insert(
          id: id,
          characterId: _charId,
          category: '基础信息',
          content: content,
          status: Value(status),
          createdAt: Value(DateTime(2026, 1, 1)),
          updatedAt: Value(DateTime(2026, 1, 1)),
        ),
      );
}

void main() {
  // 这些测试对应 spec Task 8 的 supersede 相似度查找。
  // 简化接口：单 threshold + containment 相似度（Set<String> 入参）。
  // 阈值判定对齐主项目 memory-engine.ts:303-316 的 `>=` 语义。

  test('找到目标：候选与现有 bigram 重叠高于阈值，返回现有记忆', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 现有 "cat dog fish" → tokens {cat, dog, fish}
    await _seedMemory(db, id: 'mem-existing', content: 'cat dog fish');

    // 候选 "cat dog bird" → tokens {cat, dog, bird}
    // 交集 {cat, dog} = 2，containment = 2/3 ≈ 0.667 >= 0.6 → 命中
    final result = await engine.findSimilarExistingMemories(
      _charId,
      'cat dog bird',
      threshold: 0.6,
    );

    expect(result, isNotNull);
    expect(result!.id, 'mem-existing');
  });

  test('找不到目标：候选与现有完全不相关，返回 null', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 现有 "fish lion tiger" → tokens {fish, lion, tiger}，与候选无交集
    await _seedMemory(db, id: 'mem-unrelated', content: 'fish lion tiger');

    // 候选 "cat dog bird" → tokens {cat, dog, bird}
    // 交集 {} = 0，containment = 0 < 0.6 → null
    final result = await engine.findSimilarExistingMemories(
      _charId,
      'cat dog bird',
      threshold: 0.6,
    );

    expect(result, isNull);
  });

  test('阈值边界：相似度恰等于阈值时返回（对齐主项目 >= 语义）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 现有 "cat fish" → tokens {cat, fish}
    await _seedMemory(db, id: 'mem-boundary', content: 'cat fish');

    // 候选 "cat dog" → tokens {cat, dog}
    // 交集 {cat} = 1，containment = 1/2 = 0.5
    // threshold = 0.5 → 0.5 >= 0.5 → 命中（验证 >= 而非 >）
    final result = await engine.findSimilarExistingMemories(
      _charId,
      'cat dog',
      threshold: 0.5,
    );

    expect(result, isNotNull,
        reason: '相似度 0.5 == 阈值 0.5，按主项目 >= 语义应返回');
    expect(result!.id, 'mem-boundary');
  });

  test('status=superseded 的记忆不参与查找', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 现有内容与候选高度相似，但 status=superseded → SQL 过滤后不返回
    await _seedMemory(
      db,
      id: 'mem-superseded',
      content: 'cat dog fish',
      status: 'superseded',
    );

    final result = await engine.findSimilarExistingMemories(
      _charId,
      'cat dog bird',
      threshold: 0.6,
    );

    expect(result, isNull, reason: 'superseded 记忆已被过滤，不应参与查找');
  });

  test('多个候选时返回相似度最高的活跃记忆', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 候选 "cat dog" → tokens {cat, dog}
    // mem-low "cat fish" → 交集 {cat} = 1，containment = 1/2 = 0.5
    await _seedMemory(db, id: 'mem-low', content: 'cat fish');
    // mem-high "cat dog" → 交集 {cat, dog} = 2，containment = 2/2 = 1.0
    await _seedMemory(db, id: 'mem-high', content: 'cat dog');

    final result = await engine.findSimilarExistingMemories(
      _charId,
      'cat dog',
      threshold: 0.5,
    );

    expect(result, isNotNull);
    expect(result!.id, 'mem-high', reason: '应返回相似度最高的 mem-high (1.0)');
  });

  test('CJK bigram 中文场景：containment 命中阈值', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 现有 "猫猫狗狗鱼鱼" → bigrams {猫猫, 猫狗, 狗狗, 狗鱼, 鱼鱼}
    await _seedMemory(db, id: 'mem-cjk', content: '猫猫狗狗鱼鱼');

    // 候选 "猫猫狗狗猪猪" → bigrams {猫猫, 猫狗, 狗狗, 狗猪, 猪猪}
    // 交集 {猫猫, 猫狗, 狗狗} = 3，containment = 3/5 = 0.6
    // threshold = 0.6 → 0.6 >= 0.6 → 命中
    final result = await engine.findSimilarExistingMemories(
      _charId,
      '猫猫狗狗猪猪',
      threshold: 0.6,
    );

    expect(result, isNotNull);
    expect(result!.id, 'mem-cjk');
  });

  test('候选内容为空时返回 null（_tokenize 返回空集的早退分支）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    await _seedMemory(db, id: 'mem-any', content: 'cat dog fish');

    final result = await engine.findSimilarExistingMemories(
      _charId,
      '',
      threshold: 0.6,
    );

    expect(result, isNull, reason: '候选内容为空时 _tokenize 返回空集，应返回 null');
  });
}
