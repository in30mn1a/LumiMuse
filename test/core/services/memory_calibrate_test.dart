import 'package:drift/drift.dart' hide isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/database/database.dart';
import 'package:lumimuse/core/services/llm_service.dart';
import 'package:lumimuse/core/services/memory_engine.dart';

AppDatabase _createTestDb() {
  driftRuntimeOptions.dontWarnAboutMultipleDatabases = true;
  return AppDatabase.forTesting(NativeDatabase.memory());
}

void main() {
  // 对齐主项目 src/lib/memory-engine.ts:383-418 的 calibrateRawMemoryItem 行为
  // spec Task 13：承诺信号词触发 character_promise 升级 + importance/emotional_weight 兜底

  test('命中承诺：user_fact + 承诺词 → 升级 character_promise, importance≥0.8, emotional_weight≥0.7',
      () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    final raw = <String, dynamic>{
      'content': '我答应以后每天陪用户散步',
      'memory_kind': 'user_fact',
      'category': '基础信息',
      'importance': 0.5,
      'emotional_weight': 0.5,
      'confidence': 0.8,
      'tags': <String>[],
      'lifecycle_action': 'upsert',
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect(result['memory_kind'], 'character_promise');
    expect(result['category'], '关系动态');
    expect((result['importance'] as num).toDouble(), greaterThanOrEqualTo(0.8));
    expect((result['emotional_weight'] as num).toDouble(), greaterThanOrEqualTo(0.7));
    // 原 Map 不被修改（无副作用）
    expect(raw['memory_kind'], 'user_fact');
    expect(raw['category'], '基础信息');
    expect(raw['importance'], 0.5);
  });

  test('非承诺不修改：user_preference + 普通内容 → 原样返回', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    final raw = <String, dynamic>{
      'content': '用户喜欢猫',
      'memory_kind': 'user_preference',
      'category': '偏好习惯',
      'importance': 0.5,
      'emotional_weight': 0.5,
      'confidence': 0.8,
      'tags': <String>[],
      'lifecycle_action': 'upsert',
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect(result['memory_kind'], 'user_preference');
    expect(result['category'], '偏好习惯');
    expect((result['importance'] as num).toDouble(), 0.5);
    expect((result['emotional_weight'] as num).toDouble(), 0.5);
  });

  test('importance 已高于 0.8 时不降级：raw importance=0.9 → 校准后仍 0.9', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    final raw = <String, dynamic>{
      'content': '我承诺以后会更细心',
      'memory_kind': 'user_preference',
      'category': '偏好习惯',
      'importance': 0.9,
      'emotional_weight': 0.9,
      'confidence': 0.8,
      'tags': <String>[],
      'lifecycle_action': 'upsert',
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect(result['memory_kind'], 'character_promise');
    expect((result['importance'] as num).toDouble(), 0.9);
    expect((result['emotional_weight'] as num).toDouble(), 0.9);
  });

  // 以下用例验证主项目完整校准逻辑（对齐 memory-engine.ts:401-409 的其他分支）

  test('承诺词覆盖完整：我会记得/我会记住/以后我会/以后会/不会忘 均触发升级', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    const contents = <String>[
      '我会记得用户的生日',
      '我会记住用户的偏好',
      '以后我会更加体贴',
      '以后会更加努力',
      '不会忘记这个约定',
    ];
    for (final content in contents) {
      final raw = <String, dynamic>{
        'content': content,
        'memory_kind': 'user_fact',
        'category': '基础信息',
        'importance': 0.5,
        'emotional_weight': 0.5,
      };
      final result = engine.calibrateRawMemoryItem(raw);
      expect(result['memory_kind'], 'character_promise', reason: '内容「$content」应触发承诺升级');
    }
  });

  test('承诺词命中但 memory_kind 非 user_fact/user_preference：不升级', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    // general + 话题历史：命中承诺词但不升级，走「话题历史/general」分支 importance<=0.6
    final raw = <String, dynamic>{
      'content': '我答应以后会更好',
      'memory_kind': 'general',
      'category': '话题历史',
      'importance': 0.9,
      'emotional_weight': 0.5,
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect(result['memory_kind'], 'general');
    expect((result['importance'] as num).toDouble(), lessThanOrEqualTo(0.6));
  });

  test('relationship_event 分支：emotional_weight 兜底 0.6', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    final raw = <String, dynamic>{
      'content': '用户与角色发生了一次重要对话',
      'memory_kind': 'relationship_event',
      'category': '基础信息',
      'importance': 0.5,
      'emotional_weight': 0.3,
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect((result['emotional_weight'] as num).toDouble(), greaterThanOrEqualTo(0.6));
  });

  test('toBoundedNumber 兜底：importance 超出 [0,1] 被 clamp', () {
    final db = _createTestDb();
    addTearDown(() => db.close());
    final engine = MemoryEngine(db, LlmService());

    final raw = <String, dynamic>{
      'content': '测试 clamp',
      'memory_kind': 'general',
      'category': '话题历史',
      'importance': 5.0,
      'emotional_weight': -1.0,
    };

    final result = engine.calibrateRawMemoryItem(raw);

    expect((result['importance'] as num).toDouble(), 0.6); // min(1.0, 0.6) = 0.6
    expect((result['emotional_weight'] as num).toDouble(), 0.0); // clamp(-1, 0, 1) = 0
  });
}
