import 'package:drift/drift.dart' hide isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

const _charId = 'char-retrieve';

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
  // 三个 Scenario 对应 spec sync-memory-engine-core-parity 的
  // Requirement: retrieveRelevantMemories TF-IDF 评分。

  test('Scenario 1: 短而精确的记忆评分高于冗长记忆（TF-IDF 余弦近似）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 记忆 A：3 个英文 token，与查询全命中
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-short',
            characterId: _charId,
            category: '基础信息',
            content: 'cat dog bird',
            importance: const Value(0.5),
            createdAt: Value(DateTime(2026, 1, 1)),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );
    // 记忆 B：8 个英文 token，与查询同样命中 2 个，但分母更大 → TF-IDF 评分更低
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-long',
            characterId: _charId,
            category: '基础信息',
            content: 'cat dog bird fish lion tiger bear ant',
            importance: const Value(0.5),
            createdAt: Value(DateTime(2026, 1, 1)),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );

    final result = await engine.retrieveRelevantMemories(
      queryText: 'cat dog',
      characterId: _charId,
      maxMemories: 1,
    );

    expect(result, hasLength(1));
    expect(result.first.id, 'mem-short',
        reason: '短而精确的 A 评分 2/sqrt(7*3)≈0.436 应高于冗长 B 评分 2/sqrt(12*3)=0.333');
  });

  test('Scenario 2: 非活跃记忆被过滤（status=superseded 不返回）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 两条内容相同，仅 status 不同
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-active',
            characterId: _charId,
            category: '基础信息',
            content: 'cat dog bird',
            status: const Value('active'),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-superseded',
            characterId: _charId,
            category: '基础信息',
            content: 'cat dog bird',
            status: const Value('superseded'),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );

    final result = await engine.retrieveRelevantMemories(
      queryText: 'cat dog',
      characterId: _charId,
      maxMemories: 10,
    );

    expect(result, hasLength(1));
    expect(result.first.id, 'mem-active',
        reason: "SQL 过滤 status='active'，superseded 记忆不应返回");
  });

  test('Scenario 3: pinned 优先于 importance（评分相同时 tie-breaker）', () async {
    final db = _createTestDb();
    addTearDown(() => db.close());
    await _seedCharacter(db);
    final engine = MemoryEngine(db, LlmService());

    // 两条内容相同 → TF-IDF 评分相同；A pinned=true 但 importance 低
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-pinned',
            characterId: _charId,
            category: '基础信息',
            content: 'shared content cat dog',
            pinned: const Value(true),
            importance: const Value(0.3),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );
    await db.into(db.memories).insert(
          MemoriesCompanion.insert(
            id: 'mem-important',
            characterId: _charId,
            category: '基础信息',
            content: 'shared content cat dog',
            pinned: const Value(false),
            importance: const Value(0.9),
            updatedAt: Value(DateTime(2026, 1, 1)),
          ),
        );

    final result = await engine.retrieveRelevantMemories(
      queryText: 'cat dog',
      characterId: _charId,
      maxMemories: 1,
    );

    expect(result, hasLength(1));
    expect(result.first.id, 'mem-pinned',
        reason: '评分相同时 pinned 优先于 importance');
  });
}
